---
title: "CKAD concept notes: Services, Ingress, and NetworkPolicy"
description: "Service types and the path from selector to EndpointSlice, Service DNS names, what to check when a connection fails, Ingress rules and pathType, and NetworkPolicy default deny and selector combinations, based on the official docs."
pubDatetime: 2026-09-26T12:12:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "service", "ingress", "networkpolicy", "dns"]
order: 13
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### Service

- Pods get a new IP every time they're created or deleted. A Service provides a stable endpoint in front of the set of Pods matching its selector
- `spec.selector`: labels of the Pods to send traffic to
- `spec.ports[]`
  - `port`: the port the Service listens on
  - `targetPort`: the port on the Pod side. Defaults to the same value as `port`. A number or the **name** of a Pod `containerPort`
  - `nodePort`: the port nodes open for NodePort/LoadBalancer
  - `protocol`: defaults to `TCP`
- Service names follow RFC 1123 label rules (lowercase, digits, `-`)

### Service types

| type           | Behavior                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClusterIP`    | default. Allocates a cluster-internal IP, reachable only from inside the cluster                                                                                                           |
| `NodePort`     | on top of ClusterIP, exposes the same port on every node (default range 30000-32767)                                                                                                       |
| `LoadBalancer` | exposed through an external load balancer. Kubernetes doesn't provide one itself; it needs cloud integration or similar. Creation is asynchronous, the result is in `.status.loadBalancer` |
| `ExternalName` | no selector; returns a CNAME to the DNS name in `spec.externalName`. No proxying                                                                                                           |

- the types stack: NodePort builds on ClusterIP, LoadBalancer builds on NodePort (with an exception that turns off NodePort allocation for LoadBalancer)

### Headless Service

- `spec.clusterIP: None` (type is ClusterIP). `None` isn't the same as leaving the field empty
- no cluster IP allocated, not handled by kube-proxy, no load balancing
- with a selector, EndpointSlices are created and DNS returns **the Pod IPs** as A/AAAA records
- used when clients want to connect to specific Pods directly

### selector → EndpointSlice

- the Service controller keeps scanning for Pods matching the selector and updates the EndpointSlices
- an EndpointSlice holds a subset (slice) of the network endpoints behind a Service. By default, once a slice reaches 100 endpoints a new slice is added
- EndpointSlices carry the label `kubernetes.io/service-name=<Service name>`, which is how you query them
- the `Endpoints` API is deprecated since v1.33. The official docs recommend EndpointSlice
- a Service without a selector doesn't get EndpointSlices automatically. To point at an external backend, write the EndpointSlice yourself

### Service DNS

| Target           | Record name                                                | Result               |
| ---------------- | ---------------------------------------------------------- | -------------------- |
| regular Service  | `<svc>.<ns>.svc.<cluster-domain>`                          | cluster IP           |
| headless Service | `<svc>.<ns>.svc.<cluster-domain>`                          | all selected Pod IPs |
| named port (SRV) | `_<port-name>._<protocol>.<svc>.<ns>.svc.<cluster-domain>` | port number + name   |

- cluster-domain is usually `cluster.local`
- a Pod's `/etc/resolv.conf` search list: `<ns>.svc.cluster.local svc.cluster.local cluster.local`
- so within the same namespace `<svc>` alone works; from another namespace you need at least `<svc>.<ns>`
- example: from a Pod in the `test` namespace to the `data` Service in `prod` → `data` fails, `data.prod` or `data.prod.svc.cluster.local` works

### Ingress

- routes HTTP(S) traffic coming from outside the cluster to Services based on host/path rules
- `apiVersion: networking.k8s.io/v1` (stable in v1.19)
- **needs an Ingress controller to do anything**. Creating just the Ingress resource has no effect
- the Kubernetes project recommends Gateway API over Ingress; the Ingress API is frozen (it stays GA with no plans for removal, but gets no new features)
- HTTP(S) only. TLS on port 443 only, terminated at the Ingress

Rule structure

- `host` (optional): without it the rule applies to every host. Wildcards like `*.foo.com` work
- `http.paths[]`: `path` + `pathType` + `backend.service.name` + `backend.service.port.number` (or `.name`)
- both host and path have to match to reach that backend
- `spec.defaultBackend`: where requests that match no rule go. Required if there are no rules

pathType (required; validation fails without it)

| pathType                 | Matching                                                   |
| ------------------------ | ---------------------------------------------------------- |
| `Exact`                  | the URL path matches exactly, case-sensitive               |
| `Prefix`                 | prefix match on path elements split by `/`, case-sensitive |
| `ImplementationSpecific` | up to the IngressClass (controller)                        |

`Prefix` examples (excerpt from the table in the official docs)

| path        | Request         | Match                          |
| ----------- | --------------- | ------------------------------ |
| `/foo`      | `/foo`, `/foo/` | yes                            |
| `/aaa/bbb`  | `/aaa/bbb/ccc`  | yes (subpath)                  |
| `/aaa/bbb`  | `/aaa/bbbxyz`   | no (not a string prefix match) |
| `/aaa/bbb/` | `/aaa/bbb`      | yes (trailing slash ignored)   |

- if several paths match, the longest path wins; for equal length, `Exact` beats `Prefix`

IngressClass

- `spec.ingressClassName`: references an IngressClass resource by name. The IngressClass's `spec.controller` names the controller in charge
- the old `kubernetes.io/ingress.class` annotation is deprecated. `ingressClassName` replaces it, though it doesn't mean exactly the same thing
- if an IngressClass has `ingressclass.kubernetes.io/is-default-class: "true"`, it's assigned to Ingresses with no `ingressClassName`
- with more than one default, the admission controller blocks creating Ingresses with no `ingressClassName`

### NetworkPolicy

- `apiVersion: networking.k8s.io/v1`, namespaced
- only works if the network plugin supports it. Without support, creating one has no effect
- L4 (TCP, UDP, optionally SCTP). Behavior for other protocols like ICMP depends on the plugin

Isolation rules

- by default Pods are non-isolated for both ingress and egress (everything allowed)
- once any NetworkPolicy selects a Pod and has `Ingress` in `policyTypes`, that Pod is ingress-isolated. From then on the only allowed connections are **the union of the `ingress` lists of the policies that apply**, plus connections from the node the Pod runs on
- egress works the same way
- policies don't conflict. They all add up (a union of allows), so evaluation order doesn't matter. There are no deny rules
- reply traffic for an allowed connection is allowed automatically
- a connection from A → B only works if **both A's egress and B's ingress** allow it

spec fields

- `podSelector`: the Pods the policy applies to. `{}` means every Pod in the namespace
- `policyTypes`: `Ingress`, `Egress`, or both. If omitted, `Ingress` is always set and `Egress` only when there are egress rules
- `ingress[].from[]` / `egress[].to[]`: who the other side is
- `ingress[].ports[]` / `egress[].ports[]`: ports to allow. **Both** `from`/`to` and `ports` have to match

Selectors used in `from`/`to`

| selector                                           | Selects                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `podSelector`                                      | Pods in the **same namespace** as the NetworkPolicy                                             |
| `namespaceSelector`                                | every Pod in the matching namespaces                                                            |
| `namespaceSelector` + `podSelector` (in one entry) | specific Pods in specific namespaces (AND)                                                      |
| `ipBlock`                                          | a CIDR range, with exclusions via `except`. Pod IPs change, so it's for IPs outside the cluster |

- there's no field to pick a namespace by name. Use the immutable label `kubernetes.io/metadata.name: <name>`, which the control plane adds to every namespace, in a `namespaceSelector`

## How it works

### The path a request takes to a Pod

```
external client
  └─ Ingress controller (host/path matching, Ingress rules)
       └─ Service (ClusterIP)
            └─ EndpointSlice (IP:targetPort of ready Pods matching the selector)
                 └─ Pod  ← only reached if a NetworkPolicy allows the ingress
```

- NodePort skips Ingress: `<node IP>:<nodePort>` → Service → Pod
- between Pods inside the cluster: DNS name → cluster IP → Pod

### AND vs OR: one level of YAML indentation

```yaml
# (1) one entry: namespace label user=alice AND Pod label role=client
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
        podSelector:
          matchLabels:
            role: client
```

```yaml
# (2) two entries: every Pod in namespaces with user=alice, OR role=client Pods in the same namespace
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
      - podSelector:
          matchLabels:
            role: client
```

The difference is a single `-` before `podSelector`. The official docs say that if you're unsure, check how Kubernetes interpreted it with `kubectl describe networkpolicy`.

## Examples

### Exposing a Deployment with a Service

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80
kubectl expose deployment web --port=80 --target-port=80              # ClusterIP
kubectl expose deployment web --name=web-np --port=80 --type=NodePort
kubectl create service clusterip web2 --tcp=80:8080 --dry-run=client -o yaml
```

- `kubectl expose` reuses the target resource's selector as the Service selector (for a Deployment, only when its selector is `matchLabels` only)
- `kubectl create service` doesn't read any existing resource's selector; it fills the selector in as `app: <Service name>` (`app: web2` for the `web2` above) → check with `-o yaml` that the selector matches your Pod labels

### Named targetPort

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http-web
---
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: nginx
      image: nginx:1.27
      ports:
        - containerPort: 80
          name: http-web
```

Even if the port number on the Pod side changes, you don't have to touch the Service as long as the name stays the same.

### Headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-headless
spec:
  clusterIP: None
  selector:
    app: web
  ports:
    - port: 80
```

### Ingress: one host, two paths

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: nginx
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 8080
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

The same thing imperatively:

```bash
kubectl create ingress shop --class=nginx \
  --rule="shop.example.com/api*=api:8080" \
  --rule="shop.example.com/*=web:80"
```

Going by the kubectl reference examples, a trailing `*` on the path gives `pathType: Prefix`, and without it you get `Exact`. It's safer to check the pathType with `-o yaml` after creating it.

### NetworkPolicy: default deny + allow only what's needed

```yaml
# make every Pod in the namespace ingress-isolated
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# role=db Pods only accept TCP 5432 from role=backend Pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-backend
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: backend
      ports:
        - protocol: TCP
          port: 5432
```

A default deny on egress blocks DNS too. As the official docs warn, you have to open egress to the cluster DNS separately.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

Where the DNS Pods live and how they're labeled can differ per cluster, so `kube-system` is an example value.

### What to check when a connection fails

A condensed version of the "Debug Services" flow in the official docs.

```bash
# 1. does the Service exist, and do port/targetPort line up
kubectl get svc web -o yaml

# 2. did the selector pick up any Pods (ENDPOINTS <none> means a selector/label mismatch)
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl get pods -l app=web --show-labels

# 3. does DNS resolve (from a temporary Pod inside the cluster, using the FQDN)
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- nslookup web.default.svc.cluster.local

# 4. can you connect by IP/port directly
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- http://web.default:80

# 5. is there a NetworkPolicy on the target Pod
kubectl get networkpolicy -n default
kubectl describe networkpolicy -n default
```

busybox's `nslookup` doesn't apply the search list properly, so `nslookup web.default` fails with `NXDOMAIN` even when the Service is fine (seen with busybox:1.36 on v1.35 kind). `wget` resolves the same name through the search list, so it's only the DNS check that needs the FQDN.

`targetPort` checklist (official docs): is the port you're trying to reach in the Service's `spec.ports[]`, is `targetPort` the port the Pod actually listens on, if it's a named port does the Pod have a port with that name, and is the `protocol` right.

## Easily confused

| Item       | `port`                          | `targetPort`                         | `nodePort`                     | `containerPort`                                                                                    |
| ---------- | ------------------------------- | ------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Where      | Service                         | Service                              | Service                        | Pod                                                                                                |
| Meaning    | the port the Service listens on | the Pod port traffic is forwarded to | the port the node opens        | the port the container declares it opens                                                           |
| If omitted | required                        | same value as `port`                 | auto-assigned within the range | even without it, a port the container listens on is reachable over the network (Pod API reference) |

| Easily confused pair                                     | Difference                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ClusterIP vs headless                                    | load balancing through a virtual IP vs no IP, DNS returns the list of Pod IPs |
| Service vs Ingress                                       | L4, any TCP/UDP vs HTTP(S) only, host/path routing, needs a controller        |
| `Exact` vs `Prefix`                                      | `/foo` doesn't match `/foo/` vs prefix by path element                        |
| `ingressClassName` vs `kubernetes.io/ingress.class`      | references an IngressClass resource vs deprecated annotation                  |
| NetworkPolicy `podSelector` (spec) vs `from.podSelector` | the Pods the policy applies to vs the peer Pods allowed in                    |
| two selectors in one `from` entry vs two entries         | AND vs OR                                                                     |
| default deny ingress vs egress                           | blocks incoming connections vs blocks outgoing connections (DNS included)     |

## Exam tips

### Quick commands

- `kubectl expose deployment <name> --port=<p> --target-port=<tp> [--type=NodePort]`
- `kubectl create service nodeport <name> --tcp=<port>:<targetPort> --node-port=<np>`
- `kubectl create ingress <name> --class=<c> --rule="host/path*=svc:port"`
- NetworkPolicy has no imperative command → copy the YAML from the official docs
- throwaway test Pod: `kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- <cmd>`

### kubectl explain

```bash
kubectl explain service.spec.ports               # port, targetPort, nodePort, name
kubectl explain service.spec.type
kubectl explain ingress.spec.rules.http.paths    # path, pathType, backend
kubectl explain ingress.spec.ingressClassName
kubectl explain networkpolicy.spec.ingress.from  # podSelector, namespaceSelector, ipBlock
kubectl explain networkpolicy.spec.egress
kubectl explain networkpolicy.spec.policyTypes
```

## References

- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Pod API reference](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/) (`containers[].ports`)
- [kubectl expose](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_expose/)
- [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)
- [kubectl create service nodeport](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_service_nodeport/)
