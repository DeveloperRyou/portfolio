---
title: "CKA concept notes: Gateway API and Ingress"
description: "The split of roles between GatewayClass, Gateway, and HTTPRoute, host/path/header matching and weighted splitting, allowedRoutes and ReferenceGrant for Routes and backends in other namespaces, and how it differs from Ingress, checked on a kubeadm cluster with NGINX Gateway Fabric and ingress-nginx installed."
pubDatetime: 2026-10-14T01:10:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "gateway-api", "ingress", "httproute"]
order: 10
---

> Based on: commands checked on a kubeadm cluster v1.35.9, Gateway API v1.6.1 CRDs (standard channel), NGINX Gateway Fabric v2.7.2, ingress-nginx chart 4.15.1 (controller 1.15.1)

Ingress resource basics (host/path rules, pathType, TLS) are in [CKAD concept notes: Service, Ingress, NetworkPolicy](/posts/ckad-services-ingress-networkpolicy).

## Contents

## Gateway API

An official Kubernetes API (`gateway.networking.k8s.io`) built as Ingress's successor. It isn't part of Kubernetes itself, so you install its CRDs separately.

| Resource                    | Managed by                       | Contents                                                                      |
| --------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| GatewayClass                | infrastructure provider          | which controller handles it (`controllerName`). Cluster-scoped                |
| Gateway                     | cluster operator                 | listeners (port, protocol, hostname, TLS), which namespaces' Routes to accept |
| HTTPRoute (GRPCRoute, etc.) | app developer                    | matching rules and backend Services                                           |
| ReferenceGrant              | owner of the backend's namespace | permission for other namespaces to reference my Services                      |

It splits what used to be crammed into one Ingress into resources by role.

```text
GatewayClass (nginx) ◀── Gateway (web-gw, :80) ◀── HTTPRoute (app) ──▶ Service app-v1, app-v2
```

## Installation

1. the Gateway API CRDs
2. a Gateway controller (an implementation). The controller creates the GatewayClass, or you create it yourself

```bash
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=v2.7.2" \
  | kubectl apply -f -
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric --version 2.7.2 \
  --create-namespace -n nginx-gateway --set nginx.service.type=NodePort
```

```text
$ kubectl get gatewayclass
NAME    CONTROLLER                                   ACCEPTED
nginx   gateway.nginx.org/nginx-gateway-controller   True
```

- the CRDs come in a standard channel (GA and beta) and an experimental channel. The kustomization above is standard (`bundle-version: v1.6.1`)
- I had already installed the v1.6.3 CRDs and then applied v1.6.1, and it went through as is. A ValidatingAdmissionPolicy `safe-upgrades.gateway.networking.k8s.io` is installed along with the CRDs
- `--set nginx.service.type=NodePort`: the default is LoadBalancer, so on a cluster without an LB implementation I changed it to NodePort

## Gateway and HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gw
  namespace: gw
spec:
  gatewayClassName: nginx
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: "*.example.com"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app
  namespace: gw
spec:
  parentRefs:
    - name: web-gw
  hostnames: [app.example.com]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v2 }
      backendRefs:
        - { name: app-v2, port: 80 }
    - matches:
        - headers:
            - { name: x-canary, value: "true" }
      backendRefs:
        - { name: app-v2, port: 80 }
    - backendRefs:
        - { name: app-v1, port: 80, weight: 80 }
        - { name: app-v2, port: 80, weight: 20 }
```

When you create a Gateway, NGINX Gateway Fabric creates a data plane per Gateway (a Deployment + Service `web-gw-nginx`).

```text
$ kubectl get gateway,httproute
gateway.gateway.networking.k8s.io/web-gw   nginx   10.111.208.129   True (PROGRAMMED)
httproute.gateway.networking.k8s.io/app    ["app.example.com"]
```

Request results (`Host: app.example.com`):

| Request                                            | Result                                      |
| -------------------------------------------------- | ------------------------------------------- |
| `/v2/x`                                            | `v2` (PathPrefix)                           |
| `/` + `x-canary: true`                             | `v2` (header match)                         |
| `/` 100 times                                      | `v1` 75 times, `v2` 25 times (weight 80:20) |
| `Host: foo.example.com` (no Route)                 | 404                                         |
| `Host: app.other.org` (listener hostname mismatch) | 404                                         |

- `weight` is a ratio, so 100 requests won't split exactly 80:20
- matching: `path` (Exact, PathPrefix, RegularExpression), `headers`, `queryParams`, `method`. Within one `matches` item it's AND; multiple items are OR
- `filters` for header modification, redirects, URL rewrites, mirroring

## Reading status

With the Gateway API, when something goes wrong the reason almost always ends up in a status condition.

```bash
kubectl get gateway web-gw -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}'
# Accepted=True Programmed=True

kubectl get httproute app -o jsonpath='{range .status.parents[0].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
# Accepted=True Accepted
# ResolvedRefs=True ResolvedRefs
```

After changing a backend name to a Service that doesn't exist (`app-v3`):

```text
Accepted=True Accepted
ResolvedRefs=False BackendNotFound: spec.rules[0].backendRefs[0].name: Not found: "app-v3"
```

That path (`/v2`) returns 500. The other rules keep working.

## Other namespaces

### When the Route is in another namespace: allowedRoutes

A listener's `allowedRoutes` defaults to `{"namespaces":{"from":"Same"}}`. If an HTTPRoute in the `other` namespace names `gw/web-gw` as its parent:

```text
Accepted=False NotAllowedByListeners: The Route is not allowed by any listener
```

```yaml
  listeners:
  - name: http
    ...
    allowedRoutes:
      namespaces:
        from: All        # Same | All | Selector
```

After the change, `Accepted=True`.

### When the backend is in another namespace: ReferenceGrant

If an HTTPRoute in the `gw` namespace names a Service in the `other` namespace as its backend:

```text
ResolvedRefs=False RefNotPermitted: spec.rules[0].backendRefs[0].namespace: Forbidden:
Backend ref to Service other/echo not permitted by any ReferenceGrant
```

The permission goes in the backend's (`other`) namespace.

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gw-routes
  namespace: other
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: gw
  to:
    - group: ""
      kind: Service
```

After applying it, `ResolvedRefs=True`, and `/v2` requests go to the Service in `other`. The v1.6 CRDs also have ReferenceGrant `v1`, but I verified with `v1beta1` here.

| Direction                            | Who grants it | Resource                    |
| ------------------------------------ | ------------- | --------------------------- |
| Route → Gateway in another namespace | Gateway side  | `listeners[].allowedRoutes` |
| Route → Service in another namespace | Service side  | ReferenceGrant              |

## NodePort and externalTrafficPolicy

The Gateway data plane Service was created with `externalTrafficPolicy: Local`. The data plane Pod was only on cka-w2, so requests to cka-w1's NodePort timed out with no response (`000`), and only requests to cka-w2 got 200.

| externalTrafficPolicy | Behavior                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `Cluster` (default)   | traffic coming in on any node is forwarded to Pods on other nodes. The client IP is SNAT'd |
| `Local`               | only to Pods on that node. Dropped if there are none. Client IP preserved                  |

## Ingress controllers

An Ingress resource on its own does nothing. You need a controller. I installed ingress-nginx with Helm.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.service.type=NodePort
kubectl get ingressclass
# nginx   k8s.io/ingress-nginx

kubectl create ingress a --class=nginx --rule="a.example.com/*=a:80"
```

- this chart's controller Service is `externalTrafficPolicy: Cluster`. Both workers' NodePorts responded
- with `Host: a.example.com` you get the backend's response; with no Host, the controller's default 404
- an Ingress created without `--class` (`b`) has CLASS `<none>` and returns 404. Without a default IngressClass (the `ingressclass.kubernetes.io/is-default-class: "true"` annotation), no controller handles it

## Ingress vs Gateway API

|                                 | Ingress                                   | Gateway API                                                                                               |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Resources                       | one Ingress (+ IngressClass)              | GatewayClass, Gateway, *Route, ReferenceGrant                                                             |
| Protocols                       | HTTP/HTTPS                                | HTTPRoute, GRPCRoute, TCPRoute, UDPRoute, TLSRoute (all `v1` in the standard channel as of the v1.6 CRDs) |
| header matching, weighted split | not in the spec. Controller annotations   | standard fields                                                                                           |
| Other namespaces                | Services in the same namespace only       | explicitly allowed with allowedRoutes, ReferenceGrant                                                     |
| Checking status                 | `ADDRESS`, more or less                   | reasons in Gateway and Route status conditions                                                            |
| Installation                    | the API is built in, install a controller | CRDs + controller                                                                                         |

## Easily confused

| Comparison                                       | A                                                        | B                                                              |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------- |
| GatewayClass vs IngressClass                     | the controller a Gateway uses                            | the controller an Ingress uses                                 |
| `parentRefs` vs `backendRefs`                    | the Gateway to attach the Route to                       | the Services to send traffic to                                |
| Gateway listener `hostname` vs Route `hostnames` | range of names the Gateway accepts                       | names the Route handles. The two must overlap                  |
| `Accepted=False` vs `ResolvedRefs=False`         | the Gateway won't accept the Route (allowedRoutes, etc.) | backend reference problem (missing Service, no ReferenceGrant) |
| allowedRoutes vs ReferenceGrant                  | the Gateway side allows Routes                           | the Service side allows references                             |

## Exam tips

### Quick commands

```bash
kubectl get gatewayclass
kubectl get gateway,httproute -A
kubectl describe httproute <name>          # Status.Parents.Conditions
kubectl get httproute <name> -o yaml | grep -A20 "^status"
kubectl get ingressclass
kubectl create ingress <name> --class=<class> --rule="host/path*=svc:port"
```

- Gateway API YAML has no `kubectl create` generator. Copy from the examples on gateway-api.sigs.k8s.io or the Gateway API page on kubernetes.io
- Ingress → Gateway API migration tasks: move the Ingress host to `hostnames`, path to `matches.path`, backend to `backendRefs`, and connect to the Gateway with `parentRefs`
- if a Route won't attach, check the Gateway listener's `hostname`, `allowedRoutes`, and `protocol` first

### kubectl explain

```bash
kubectl explain gateway.spec.listeners
kubectl explain httproute.spec.rules.matches
kubectl explain httproute.spec.rules.backendRefs
kubectl explain referencegrant.spec
```

## References

- [Gateway API (kubernetes.io)](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Gateway API docs](https://gateway-api.sigs.k8s.io/)
- [HTTPRoute](https://gateway-api.sigs.k8s.io/api-types/httproute/)
- [ReferenceGrant](https://gateway-api.sigs.k8s.io/api-types/referencegrant/)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [NGINX Gateway Fabric: Install with Helm](https://docs.nginx.com/nginx-gateway-fabric/install/helm/)
- [Service: externalTrafficPolicy](https://kubernetes.io/docs/reference/networking/virtual-ips/#external-traffic-policy)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
