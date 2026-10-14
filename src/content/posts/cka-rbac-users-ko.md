---
title: "CKA 개념 노트: RBAC, 사용자 인증서, kubeconfig"
description: "Kubernetes에 User 객체가 없다는 것에서 시작해, CertificateSigningRequest로 사용자 인증서를 발급하고 kubeconfig에 넣는 과정, ClusterRole을 RoleBinding과 ClusterRoleBinding에 붙였을 때의 차이, aggregated ClusterRole과 기본 ClusterRole을 kubeadm 클러스터에서 확인했습니다."
pubDatetime: 2026-10-14T01:05:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "rbac", "csr", "kubeconfig"]
order: 5
draft: true
---

> 기준: kubeadm 클러스터 v1.35.9 (libvirt VM 3대)에서 명령어 확인

Role, RoleBinding, ServiceAccount, `kubectl auth can-i` 기본은 [CKAD 개념 노트: ServiceAccount, 접근 제어, SecurityContext](/ko/posts/ckad-security-basics)에 정리했고, 여기서는 관리자 쪽에서 더 보는 것만 다룸.

## 목차

## 사용자는 어디에 있나

Kubernetes에는 User 객체가 없음. apiserver는 요청에 붙은 인증 정보에서 username과 group을 꺼내 쓸 뿐.

| 인증 방법               | username                            | group                                                   |
| ----------------------- | ----------------------------------- | ------------------------------------------------------- |
| X.509 클라이언트 인증서 | `CN`                                | `O` (여러 개 가능)                                      |
| ServiceAccount token    | `system:serviceaccount:<ns>:<name>` | `system:serviceaccounts`, `system:serviceaccounts:<ns>` |
| OIDC 등                 | 설정한 claim                        | 설정한 claim                                            |

그래서 "사용자 jane을 만든다"는 건 `CN=jane`인 인증서를 클러스터 CA로 서명받는 것. RBAC binding의 subject `kind: User`, `name: jane`은 이 문자열과 맞춰질 뿐.

## CSR로 사용자 인증서 발급

### 1. 키와 CSR 만들기

```bash
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -out jane.csr -subj "/CN=jane/O=dev-team"
```

### 2. CertificateSigningRequest 객체

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: <base64 < jane.csr | tr -d "\n" 결과>
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages:
    - client auth
```

| 필드                | 값                                                               |
| ------------------- | ---------------------------------------------------------------- |
| `request`           | PEM CSR 파일을 base64로 한 줄로                                  |
| `signerName`        | 사용자 클라이언트 인증서는 `kubernetes.io/kube-apiserver-client` |
| `usages`            | `client auth`                                                    |
| `expirationSeconds` | 선택. 위 예는 24시간                                             |

### 3. 승인과 인증서 꺼내기

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

- 거절은 `kubectl certificate deny jane`
- `Approved`만 되고 `Issued`가 안 붙으면 signer가 서명하지 않은 것. kubeadm 클러스터에서는 controller-manager가 서명함

## kubeconfig

kubeconfig는 세 부분: `clusters`(어디로), `users`(누구로), `contexts`(둘의 조합 + 기본 namespace).

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

- `--embed-certs=true`: 파일 경로 대신 내용을 kubeconfig에 넣음. 없으면 경로만 저장됨
- 다른 kubeconfig 파일을 만들려면 `--kubeconfig=jane.kubeconfig`를 붙이고, `set-cluster`로 server 주소와 CA도 넣어야 함
- `kubectl config use-context jane`으로 전환, 한 번만 쓰려면 `kubectl --context jane ...`

```text
$ kubectl --context jane auth whoami
Username   jane
Groups     [dev-team system:authenticated]
```

권한을 주기 전에는 인증은 되지만 인가에서 막힘.

```text
$ kubectl --context jane get pods
Error from server (Forbidden): pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "dev"
```

`Forbidden`(403)이면 인증은 통과한 것. `Unauthorized`(401)이면 인증서나 token부터 문제.

## Role과 ClusterRole 조합

```bash
kubectl create role pod-reader -n dev --verb=get,list,watch --resource=pods
kubectl create rolebinding jane-pod-reader -n dev --role=pod-reader --user=jane
```

| Role 종류   | Binding 종류       | 효과                                                       |
| ----------- | ------------------ | ---------------------------------------------------------- |
| Role        | RoleBinding        | 그 namespace 안에서만                                      |
| ClusterRole | RoleBinding        | ClusterRole의 규칙을 RoleBinding이 있는 namespace 안에서만 |
| ClusterRole | ClusterRoleBinding | 모든 namespace + 클러스터 범위 리소스                      |
| Role        | ClusterRoleBinding | 불가                                                       |

ClusterRole + RoleBinding으로는 클러스터 범위 리소스(nodes, PV, namespace 등)를 줄 수 없음. 직접 해 봄.

```bash
kubectl create clusterrole node-reader --verb=get,list --resource=nodes
kubectl create rolebinding jane-nodes -n dev --clusterrole=node-reader --user=jane
kubectl --context jane get nodes
# Error from server (Forbidden): nodes is forbidden: User "jane" cannot list resource "nodes" in API group "" at the cluster scope

kubectl create clusterrolebinding jane-nodes --clusterrole=node-reader --user=jane
kubectl --context jane get nodes     # 성공
```

subject 종류:

```bash
kubectl create rolebinding ... --user=jane
kubectl create rolebinding ... --group=dev-team                  # 인증서 O 필드
kubectl create rolebinding ... --serviceaccount=dev:ci           # <namespace>:<name>
```

## 기본 ClusterRole

| ClusterRole     | 용도             | 비고                                                                    |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| `cluster-admin` | 전부             | ClusterRoleBinding이면 클러스터 전체, RoleBinding이면 그 namespace 전체 |
| `admin`         | namespace 관리자 | Role/RoleBinding 생성 가능. ResourceQuota와 namespace 자체는 수정 불가  |
| `edit`          | 대부분 읽기/쓰기 | Role, RoleBinding 수정 불가                                             |
| `view`          | 읽기             | Secret 제외                                                             |

`dev-team` group에 `view`를 ClusterRoleBinding으로 줘 봄:

| 요청                         | 결과                                    |
| ---------------------------- | --------------------------------------- |
| `get deploy -n kube-system`  | 허용                                    |
| `get secrets -n kube-system` | `Forbidden` (view는 Secret 제외)        |
| `get nodes`                  | `Forbidden` (view는 namespace 리소스만) |

```bash
kubectl create sa ci -n dev
kubectl create rolebinding ci-edit -n dev --clusterrole=edit --serviceaccount=dev:ci
kubectl auth can-i create deploy -n dev --as=system:serviceaccount:dev:ci        # yes
kubectl auth can-i create rolebinding -n dev --as=system:serviceaccount:dev:ci   # no
```

## aggregated ClusterRole

`aggregationRule`이 있는 ClusterRole은 label selector에 맞는 다른 ClusterRole의 rules를 controller가 자동으로 합쳐 넣음. 직접 쓴 `rules`는 덮어써짐.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-monitoring: "true"
rules: [] # controller가 채움
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

기본 `admin`, `edit`, `view`도 이 방식. CRD 권한을 기본 role에 끼워 넣을 때 쓰는 label:

```text
$ kubectl get clusterrole admin -o jsonpath='{.aggregationRule}'
{"clusterRoleSelectors":[{"matchLabels":{"rbac.authorization.k8s.io/aggregate-to-admin":"true"}}]}
```

`rbac.authorization.k8s.io/aggregate-to-view: "true"`, `aggregate-to-edit`, `aggregate-to-admin`.

## 권한 확인

```bash
kubectl auth can-i list pods -n dev --as jane                     # yes
kubectl auth can-i create pods -n dev --as jane                   # no
kubectl auth can-i list pods -n dev --as bob --as-group dev-team  # group 권한만 확인
kubectl auth can-i --list -n dev --as jane
```

```text
pods    []   []   [get list watch]
nodes   []   []   [get list]
```

`--list` 결과에는 기본 binding으로 모든 인증 사용자가 받는 권한(`selfsubjectaccessreviews` 등)과 CNI가 추가한 권한도 섞여 나옴.

## binding 수정

RoleBinding의 `roleRef`는 바꿀 수 없음.

```text
$ kubectl patch rolebinding jane-pod-reader -n dev --type=merge \
    -p '{"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"view"}}'
The RoleBinding "jane-pod-reader" is invalid: roleRef: Invalid value: ...: cannot change roleRef
```

role을 바꾸려면 binding을 지우고 다시 만듦. `subjects`는 수정 가능.

## 헷갈리는 것 비교

| 비교                                                   | A                                     | B                                             |
| ------------------------------------------------------ | ------------------------------------- | --------------------------------------------- |
| 인증서 CN vs O                                         | username                              | group                                         |
| `kube-apiserver-client` signer vs `kubelet-serving` 등 | 사용자/클라이언트 인증서. 수동 승인   | kubelet용. kubelet이 요청                     |
| CSR `Approved` vs `Issued`                             | 사람이 승인                           | signer가 서명해서 `status.certificate`에 넣음 |
| `set-credentials` vs `set-context`                     | user 항목 (키, 인증서)                | cluster + user + namespace 조합               |
| ClusterRole + RoleBinding vs + ClusterRoleBinding      | 그 namespace 안. 클러스터 리소스 불가 | 전체 + 클러스터 리소스                        |
| `edit` vs `admin`                                      | RBAC 객체 수정 불가                   | namespace 안의 Role/RoleBinding 수정 가능     |
| 401 vs 403                                             | 인증 실패                             | 인증 성공, 권한 없음                          |

## 시험 포인트

### 빨리 푸는 명령어

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

- CSR YAML은 공식 문서 "Certificate Signing Requests"의 normal user 예제를 복사해서 `request`만 바꾸면 빠름
- `--resource`에 subresource는 `pods/log`처럼 씀

### kubectl explain

```bash
kubectl explain csr.spec            # request, signerName, usages, expirationSeconds
kubectl explain clusterrole.aggregationRule
kubectl explain rolebinding.subjects
```

## 참고 문서

- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Certificates and Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Organizing Cluster Access Using kubeconfig Files](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [Configure Access to Multiple Clusters](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
