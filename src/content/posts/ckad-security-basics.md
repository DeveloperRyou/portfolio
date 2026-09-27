---
title: "CKAD concept notes: ServiceAccounts, access control, and SecurityContext"
description: "Notes on how an API request passes through authentication, authorization, and admission, plus ServiceAccounts, RBAC, SecurityContext, and Pod Security Standards, based on the official docs."
pubDatetime: 2026-09-26T12:09:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  [
    "kubernetes",
    "ckad",
    "rbac",
    "serviceaccount",
    "securitycontext",
    "security",
  ]
order: 10
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Request flow

```
kubectl / Pod
   │  (client certificate, bearer token ...)
   ▼
[1] Authentication   fail → 401 Unauthorized
   ▼
[2] Authorization    fail → 403 Forbidden
   ▼
[3] Admission        mutating → validating; if any rejects, the whole request is rejected
   ▼
stored in etcd
```

### Authentication: who are you

- two kinds of users
  - normal users: managed outside Kubernetes. There's no User object you can create through the API
  - ServiceAccounts: managed by the Kubernetes API, belong to a namespace
- methods: authentication plugins such as client certificates, bearer tokens, an authenticating proxy
- attributes attached to the request as a result: username, UID, groups, extra
- a ServiceAccount's username: `system:serviceaccount:<namespace>:<name>`
  - groups: `system:serviceaccounts`, `system:serviceaccounts:<namespace>`
- a request no method rejected is treated as `system:anonymous` / `system:unauthenticated` (if anonymous access is allowed)
- an invalid bearer token → `401 Unauthorized`

### Authorization: are you allowed to

- attributes checked: user, group, verb, resource, subresource, namespace, API group, etc.
- HTTP method → verb mapping

| HTTP      | verb                                           |
| --------- | ---------------------------------------------- |
| POST      | create                                         |
| GET, HEAD | get (single), list (collection), watch         |
| PUT       | update                                         |
| PATCH     | patch                                          |
| DELETE    | delete (single), deletecollection (collection) |

- modes: `Node`, `RBAC`, `ABAC`, `Webhook`, `AlwaysAllow`, `AlwaysDeny`
- with several authorizers, they're asked in order and the first to allow or deny decides. If all have "no opinion", it's denied
- deny by default. RBAC only has allow rules; there are no deny rules
- denied → `403 Forbidden`

### Admission: should this be accepted

- built-in kube-apiserver code that intercepts requests after authentication and authorization, right before they're stored
- two phases: mutating (can modify the object) → validating (checks only)
- read requests (get, list, watch) don't go through admission
- turning plugins on and off: `kube-apiserver --enable-admission-plugins=...` / `--disable-admission-plugins=...`
- the ones in the v1.35 default-enabled list that touch CKAD

| plugin               | Role                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `NamespaceLifecycle` | blocks creating objects in a namespace that's being deleted or doesn't exist |
| `LimitRanger`        | applies LimitRange (injects default requests/limits, checks ranges)          |
| `ResourceQuota`      | namespace-level total limits                                                 |
| `ServiceAccount`     | sets the ServiceAccount and token on Pods automatically                      |
| `PodSecurity`        | enforces Pod Security Standards                                              |

- if it's not "created, but the Pod won't start" but "the create itself is rejected", it was likely blocked at admission

## RBAC

API group `rbac.authorization.k8s.io/v1`, four objects.

| Object             | Scope     | Contents                                                                         |
| ------------------ | --------- | -------------------------------------------------------------------------------- |
| Role               | namespace | permission rules within one namespace                                            |
| ClusterRole        | cluster   | permissions on cluster-scoped resources, or rules to reuse across namespaces     |
| RoleBinding        | namespace | binds a Role or ClusterRole to subjects. The effect is limited to that namespace |
| ClusterRoleBinding | cluster   | binds a ClusterRole across the whole cluster                                     |

- subject kinds: `User`, `Group`, `ServiceAccount`
- once a binding is created, `roleRef` can't be changed. Delete and recreate to change it
- built-in user-facing ClusterRoles: `cluster-admin`, `admin`, `edit`, `view`

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
  - apiGroups: [""] # "" = core API group
    resources: ["pods"]
    verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: default
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: default
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

## ServiceAccount

- a non-human account. The identity a process inside a Pod uses when talking to the API server
- every namespace gets a `default` ServiceAccount automatically. Delete it and the control plane recreates it
- the `default` ServiceAccount has no RBAC permissions beyond API discovery
- set it on a Pod: `spec.serviceAccountName`
  - `serviceAccountName` can't be changed on an existing Pod. For Deployments and the like, change the template so Pods get replaced
  - `spec.serviceAccount` is a deprecated alias
- tokens
  - since v1.22, a short-lived, auto-rotated token obtained through the `TokenRequest` API is mounted as a projected volume
  - path: `/var/run/secrets/kubernetes.io/serviceaccount/` (`token`, `ca.crt`, `namespace`)
  - issue one by hand: `kubectl create token <sa>` (request a lifetime with `--duration`)
- turning off automount: `automountServiceAccountToken: false`
  - can be set on both the ServiceAccount and the Pod; if both are set, the Pod wins

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: default
automountServiceAccountToken: false
---
apiVersion: v1
kind: Pod
metadata:
  name: api-client
  namespace: default
spec:
  serviceAccountName: my-sa
  automountServiceAccountToken: true # the Pod setting wins
  containers:
    - name: app
      image: busybox:1.28
      command: ["sh", "-c", "sleep 1h"]
```

## SecurityContext

Settings for which user and privileges a Pod or container runs with on the node. Unlike RBAC, it has nothing to do with API permissions.

- where it goes
  - Pod level: `spec.securityContext`, applies to every container
  - container level: `spec.containers[].securityContext`
  - if both are set, the container level overrides

| Field                      | Pod | container | Meaning                                                                  |
| -------------------------- | --- | --------- | ------------------------------------------------------------------------ |
| `runAsUser` / `runAsGroup` | O   | O         | process UID / primary GID                                                |
| `runAsNonRoot`             | O   | O         | if `true`, the kubelet refuses to start it as UID 0                      |
| `seccompProfile`           | O   | O         | `RuntimeDefault`, `Localhost`, `Unconfined`                              |
| `fsGroup`                  | O   | X         | group that owns volumes                                                  |
| `supplementalGroups`       | O   | X         | additional groups                                                        |
| `sysctls`                  | O   | X         | Pod sysctls                                                              |
| `capabilities`             | X   | O         | add/drop Linux capabilities                                              |
| `readOnlyRootFilesystem`   | X   | O         | read-only root filesystem                                                |
| `allowPrivilegeEscalation` | X   | O         | whether privilege escalation via setuid etc. is allowed (`no_new_privs`) |
| `privileged`               | X   | O         | privileged mode                                                          |

- `allowPrivilegeEscalation`: always true if the container is `privileged` or has `CAP_SYS_ADMIN`
- capability names drop the `CAP_` prefix: `CAP_SYS_TIME` → `SYS_TIME`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  volumes:
    - name: tmp
      emptyDir: {}
  containers:
    - name: app
      image: busybox:1.28
      command: ["sh", "-c", "sleep 1h"]
      volumeMounts:
        - name: tmp
          mountPath: /tmp # writable path when readOnlyRootFilesystem is on
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
          add: ["NET_BIND_SERVICE"]
```

## Pod Security Standards

Pod security defined as three policy levels. Enforcement is done by the `PodSecurity` admission controller (Pod Security Admission).

| Level      | Contents                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Privileged | unrestricted. Even known privilege escalations are allowed                                     |
| Baseline   | blocks known privilege escalations. Allows the default (minimally specified) Pod configuration |
| Restricted | heavily restricted, following current Pod hardening best practices                             |

Container settings Restricted requires (excerpt):

- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`, and `runAsUser` must not be 0
- `ALL` in `capabilities.drop`; the only allowed add is `NET_BIND_SERVICE`
- `seccompProfile.type`: `RuntimeDefault` or `Localhost` (unset or `Unconfined` not allowed)
- restricted volume types: configMap, csi, downwardAPI, emptyDir, ephemeral, persistentVolumeClaim, projected, secret

Applied with namespace labels:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: secure-ns
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
```

| mode      | On violation                                     |
| --------- | ------------------------------------------------ |
| `enforce` | the Pod is rejected                              |
| `audit`   | an annotation is added to the audit log, allowed |
| `warn`    | a warning to the user, allowed                   |

## Easily confused

| Item                             | A                                                           | B                                                                                                  |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 401 vs 403                       | 401: authentication failed (we don't know who you are)      | 403: authorization denied (we know who you are, but you lack permission)                           |
| authorization vs admission       | decides from request attributes only (user, verb, resource) | looks at the object contents (field values) too, to modify or reject. Read requests aren't covered |
| Role vs ClusterRole              | namespace scope                                             | cluster scope. Can also be bound to a single namespace with a RoleBinding                          |
| RoleBinding + ClusterRole        | effect limited to the RoleBinding's namespace               | with a ClusterRoleBinding, every namespace                                                         |
| RBAC vs SecurityContext          | permissions against the API server                          | privileges the process has on the node                                                             |
| `runAsNonRoot` vs `runAsUser`    | a condition check (refuses to run as root)                  | sets the actual UID                                                                                |
| `privileged` vs capabilities     | effectively every host-level privilege                      | add/drop only the capabilities you need                                                            |
| Pod vs container securityContext | shared defaults, Pod-only fields like `fsGroup`             | overrides, container-only fields like `capabilities`                                               |

## Exam tips

### Imperative commands

```bash
# ServiceAccount
kubectl create serviceaccount my-sa -n dev
kubectl set serviceaccount deployment/web my-sa -n dev
kubectl create token my-sa -n dev

# RBAC
kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev
kubectl create rolebinding pod-reader-binding --role=pod-reader \
  --serviceaccount=dev:my-sa -n dev
kubectl create clusterrole secret-reader --verb=get,list,watch --resource=secrets
kubectl create rolebinding view-binding --clusterrole=view \
  --serviceaccount=dev:my-sa -n dev

# check permissions
kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:my-sa
kubectl auth can-i --list -n dev --as=system:serviceaccount:dev:my-sa

# Pod Security Admission
kubectl label namespace secure-ns pod-security.kubernetes.io/enforce=restricted
```

- SecurityContext has no imperative flags. Build a skeleton with `kubectl run ... --dry-run=client -o yaml`, then add it in YAML

### kubectl explain

```bash
kubectl explain pod.spec.securityContext                          # Pod level: runAsUser, fsGroup, etc.
kubectl explain pod.spec.containers.securityContext               # container level: capabilities, readOnlyRootFilesystem, etc.
kubectl explain pod.spec.containers.securityContext.capabilities  # add, drop
kubectl explain pod.spec.automountServiceAccountToken
kubectl explain role.rules                                        # apiGroups, resources, verbs
kubectl explain rolebinding.subjects                              # kind, name, namespace
```

## References

- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Authorization](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Service Accounts](https://kubernetes.io/docs/concepts/security/service-accounts/)
- [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [Pod API reference (`runAsNonRoot`)](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
