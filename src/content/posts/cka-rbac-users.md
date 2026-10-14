---
title: "CKA concept notes: RBAC, user certificates, kubeconfig"
description: "Starting from the fact that Kubernetes has no User object: issuing a user certificate with a CertificateSigningRequest and adding it to a kubeconfig, what changes when a ClusterRole is bound with a RoleBinding vs a ClusterRoleBinding, and aggregated and default ClusterRoles, checked on a kubeadm cluster."
pubDatetime: 2026-10-14T01:05:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "rbac", "csr", "kubeconfig"]
order: 5
---

> Based on: commands checked on a kubeadm cluster v1.35.9 (3 libvirt VMs)

Role, RoleBinding, ServiceAccount, and `kubectl auth can-i` basics are in [CKAD concept notes: ServiceAccount, access control, SecurityContext](/posts/ckad-security-basics). This note only covers the extra things you look at as an admin.

## Contents

## Where do users live

Kubernetes has no User object. The apiserver just pulls a username and groups out of the credentials attached to the request.

| Auth method              | username                            | group                                                   |
| ------------------------ | ----------------------------------- | ------------------------------------------------------- |
| X.509 client certificate | `CN`                                | `O` (can be several)                                    |
| ServiceAccount token     | `system:serviceaccount:<ns>:<name>` | `system:serviceaccounts`, `system:serviceaccounts:<ns>` |
| OIDC, etc.               | configured claim                    | configured claim                                        |

So "creating user jane" means getting a certificate with `CN=jane` signed by the cluster CA. The subject `kind: User`, `name: jane` in an RBAC binding is just matched against that string.

## Issuing a user certificate with a CSR

### 1. Create a key and CSR

```bash
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -out jane.csr -subj "/CN=jane/O=dev-team"
```

### 2. The CertificateSigningRequest object

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: <output of base64 < jane.csr | tr -d "\n">
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages:
    - client auth
```

| Field               | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `request`           | the PEM CSR file, base64-encoded on one line                       |
| `signerName`        | `kubernetes.io/kube-apiserver-client` for user client certificates |
| `usages`            | `client auth`                                                      |
| `expirationSeconds` | optional. 24 hours in the example above                            |

### 3. Approve and extract the certificate

```bash
kubectl get csr jane
# NAME   SIGNERNAME                            REQUESTOR          REQUESTEDDURATION   CONDITION
# jane   kubernetes.io/kube-apiserver-client   kubernetes-admin   24h                 Pending

kubectl certificate approve jane
kubectl get csr jane            # CONDITION: Approved,Issued

kubectl get csr jane -o jsonpath='{.status.certificate}' | base64 -d > jane.crt
openssl x509 -in jane.crt -noout -subject -issuer
# subject=O = dev-team, CN = jane
# issuer=CN = kubernetes
```

- to reject: `kubectl certificate deny jane`
- if it's only `Approved` with no `Issued`, the signer hasn't signed it. On a kubeadm cluster the controller-manager does the signing

## kubeconfig

A kubeconfig has three parts: `clusters` (where), `users` (as whom), `contexts` (a pairing of the two + default namespace).

```bash
kubectl config set-credentials jane \
  --client-key=jane.key --client-certificate=jane.crt --embed-certs=true
kubectl config set-context jane --cluster=kubernetes --user=jane --namespace=dev
kubectl config get-contexts
```

```text
CURRENT   NAME                          CLUSTER      AUTHINFO           NAMESPACE
          jane                          kubernetes   jane               dev
*         kubernetes-admin@kubernetes   kubernetes   kubernetes-admin
```

- `--embed-certs=true`: puts the file contents in the kubeconfig instead of the path. Without it only the path is stored
- to create a separate kubeconfig file, add `--kubeconfig=jane.kubeconfig` and also add the server address and CA with `set-cluster`
- switch with `kubectl config use-context jane`, or for a single command `kubectl --context jane ...`

```text
$ kubectl --context jane auth whoami
Username   jane
Groups     [dev-team system:authenticated]
```

Before any permissions are granted, authentication works but authorization blocks it.

```text
$ kubectl --context jane get pods
Error from server (Forbidden): pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "dev"
```

`Forbidden` (403) means authentication passed. `Unauthorized` (401) means the certificate or token is the problem.

## Combining Roles and ClusterRoles

```bash
kubectl create role pod-reader -n dev --verb=get,list,watch --resource=pods
kubectl create rolebinding jane-pod-reader -n dev --role=pod-reader --user=jane
```

| Role kind   | Binding kind       | Effect                                                           |
| ----------- | ------------------ | ---------------------------------------------------------------- |
| Role        | RoleBinding        | only within that namespace                                       |
| ClusterRole | RoleBinding        | the ClusterRole's rules, only within the RoleBinding's namespace |
| ClusterRole | ClusterRoleBinding | all namespaces + cluster-scoped resources                        |
| Role        | ClusterRoleBinding | not possible                                                     |

ClusterRole + RoleBinding can't grant cluster-scoped resources (nodes, PVs, namespaces, etc.). I tried it.

```bash
kubectl create clusterrole node-reader --verb=get,list --resource=nodes
kubectl create rolebinding jane-nodes -n dev --clusterrole=node-reader --user=jane
kubectl --context jane get nodes
# Error from server (Forbidden): nodes is forbidden: User "jane" cannot list resource "nodes" in API group "" at the cluster scope

kubectl create clusterrolebinding jane-nodes --clusterrole=node-reader --user=jane
kubectl --context jane get nodes     # works
```

Subject kinds:

```bash
kubectl create rolebinding ... --user=jane
kubectl create rolebinding ... --group=dev-team                  # the certificate's O field
kubectl create rolebinding ... --serviceaccount=dev:ci           # <namespace>:<name>
```

## Default ClusterRoles

| ClusterRole     | Purpose                | Notes                                                                             |
| --------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `cluster-admin` | everything             | the whole cluster via ClusterRoleBinding, that whole namespace via RoleBinding    |
| `admin`         | namespace admin        | can create Roles/RoleBindings. Can't modify ResourceQuota or the namespace itself |
| `edit`          | read/write most things | can't modify Roles or RoleBindings                                                |
| `view`          | read                   | excludes Secrets                                                                  |

I gave the `dev-team` group `view` through a ClusterRoleBinding:

| Request                      | Result                                              |
| ---------------------------- | --------------------------------------------------- |
| `get deploy -n kube-system`  | allowed                                             |
| `get secrets -n kube-system` | `Forbidden` (view excludes Secrets)                 |
| `get nodes`                  | `Forbidden` (view covers namespaced resources only) |

```bash
kubectl create sa ci -n dev
kubectl create rolebinding ci-edit -n dev --clusterrole=edit --serviceaccount=dev:ci
kubectl auth can-i create deploy -n dev --as=system:serviceaccount:dev:ci        # yes
kubectl auth can-i create rolebinding -n dev --as=system:serviceaccount:dev:ci   # no
```

## Aggregated ClusterRoles

For a ClusterRole with an `aggregationRule`, a controller automatically merges in the rules of other ClusterRoles matching the label selector. Any `rules` you write yourself get overwritten.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-monitoring: "true"
rules: [] # filled in by the controller
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-endpoints
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "list", "watch"]
```

```text
$ kubectl get clusterrole monitoring -o jsonpath='{.rules}'
[{"apiGroups":[""],"resources":["services","endpoints","pods"],"verbs":["get","list","watch"]}]
```

The default `admin`, `edit`, and `view` work this way too. The labels for slotting CRD permissions into the default roles:

```text
$ kubectl get clusterrole admin -o jsonpath='{.aggregationRule}'
{"clusterRoleSelectors":[{"matchLabels":{"rbac.authorization.k8s.io/aggregate-to-admin":"true"}}]}
```

`rbac.authorization.k8s.io/aggregate-to-view: "true"`, `aggregate-to-edit`, `aggregate-to-admin`.

## Checking permissions

```bash
kubectl auth can-i list pods -n dev --as jane                     # yes
kubectl auth can-i create pods -n dev --as jane                   # no
kubectl auth can-i list pods -n dev --as bob --as-group dev-team  # check group permissions only
kubectl auth can-i --list -n dev --as jane
```

```text
pods    []   []   [get list watch]
nodes   []   []   [get list]
```

The `--list` output also mixes in permissions every authenticated user gets from default bindings (`selfsubjectaccessreviews`, etc.) and ones added by the CNI.

## Modifying a binding

A RoleBinding's `roleRef` can't be changed.

```text
$ kubectl patch rolebinding jane-pod-reader -n dev --type=merge \
    -p '{"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"view"}}'
The RoleBinding "jane-pod-reader" is invalid: roleRef: Invalid value: ...: cannot change roleRef
```

To change the role, delete the binding and recreate it. `subjects` can be modified.

## Easily confused

| Comparison                                               | A                                           | B                                              |
| -------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| certificate CN vs O                                      | username                                    | group                                          |
| `kube-apiserver-client` signer vs `kubelet-serving` etc. | user/client certificates. Approved manually | for the kubelet. The kubelet requests it       |
| CSR `Approved` vs `Issued`                               | a person approved it                        | the signer signed it into `status.certificate` |
| `set-credentials` vs `set-context`                       | user entry (key, certificate)               | cluster + user + namespace pairing             |
| ClusterRole + RoleBinding vs + ClusterRoleBinding        | within that namespace. No cluster resources | everywhere + cluster resources                 |
| `edit` vs `admin`                                        | can't modify RBAC objects                   | can modify Roles/RoleBindings in the namespace |
| 401 vs 403                                               | authentication failed                       | authenticated, no permission                   |

## Exam tips

### Quick commands

```bash
openssl genrsa -out u.key 2048
openssl req -new -key u.key -out u.csr -subj "/CN=u/O=g"
cat u.csr | base64 | tr -d "\n"
kubectl certificate approve u
kubectl get csr u -o jsonpath='{.status.certificate}' | base64 -d > u.crt
kubectl config set-credentials u --client-key=u.key --client-certificate=u.crt --embed-certs=true
kubectl config set-context u --cluster=kubernetes --user=u

kubectl create role|clusterrole <name> --verb=... --resource=...
kubectl create rolebinding|clusterrolebinding <name> --role|--clusterrole=... --user|--group|--serviceaccount=...
kubectl auth can-i <verb> <resource> [-n ns] --as <user> [--as-group <group>]
```

- for the CSR YAML, copying the normal user example from the "Certificate Signing Requests" doc and replacing just `request` is fast
- subresources in `--resource` are written like `pods/log`

### kubectl explain

```bash
kubectl explain csr.spec            # request, signerName, usages, expirationSeconds
kubectl explain clusterrole.aggregationRule
kubectl explain rolebinding.subjects
```

## References

- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Certificates and Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Organizing Cluster Access Using kubeconfig Files](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [Configure Access to Multiple Clusters](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
