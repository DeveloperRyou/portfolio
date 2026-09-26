---
title: "CKAD 개념 노트: ServiceAccount, 접근 제어, SecurityContext"
description: "API 요청이 authentication, authorization, admission을 거치는 흐름과 ServiceAccount·RBAC·SecurityContext·Pod Security Standards를 공식 문서 기준으로 정리한 노트."
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

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 요약

- 커리큘럼 위치: Application Environment, Configuration and Security
  - Understand authentication, authorization and admission control
  - Understand ServiceAccounts
  - Understand Application Security (SecurityContexts, Capabilities, etc.)
- API 요청 흐름: authentication → authorization → admission → etcd 저장
- "누가 무엇을 할 수 있나"는 RBAC(Role/RoleBinding), "Pod가 노드 위에서 어떤 권한으로 도나"는 SecurityContext
- Pod가 API server를 부를 때의 신원이 ServiceAccount

## 요청 흐름

```
kubectl / Pod
   │  (client certificate, bearer token ...)
   ▼
[1] Authentication   실패 → 401 Unauthorized
   ▼
[2] Authorization    실패 → 403 Forbidden
   ▼
[3] Admission        mutating → validating, 하나라도 거부하면 요청 전체 거부
   ▼
etcd에 저장
```

### Authentication: 누구인가

- 사용자 종류 두 가지
  - normal user: Kubernetes 밖에서 관리. API로 User 객체를 만들 수 없음
  - ServiceAccount: Kubernetes API가 관리, namespace에 속함
- 방식: client certificate, bearer token, authenticating proxy 등 authentication plugin
- 결과로 요청에 붙는 속성: username, UID, groups, extra
- ServiceAccount의 username: `system:serviceaccount:<namespace>:<name>`
  - groups: `system:serviceaccounts`, `system:serviceaccounts:<namespace>`
- 어떤 방식으로도 거부되지 않은 요청은 (anonymous 허용 시) `system:anonymous` / `system:unauthenticated`로 처리
- 잘못된 bearer token → `401 Unauthorized`

### Authorization: 해도 되는가

- 확인 속성: user, group, verb, resource, subresource, namespace, API group 등
- HTTP method → verb 대응

| HTTP      | verb                                     |
| --------- | ---------------------------------------- |
| POST      | create                                   |
| GET, HEAD | get (단일), list (컬렉션), watch         |
| PUT       | update                                   |
| PATCH     | patch                                    |
| DELETE    | delete (단일), deletecollection (컬렉션) |

- mode: `Node`, `RBAC`, `ABAC`, `Webhook`, `AlwaysAllow`, `AlwaysDeny`
- 여러 authorizer가 있으면 순서대로 물어보고, 처음 allow/deny를 낸 쪽이 결정. 전부 "의견 없음"이면 거부
- 기본은 deny. 허용 규칙만 있고 거부 규칙은 RBAC에 없음
- 거부 → `403 Forbidden`

### Admission: 받아들여도 되는가

- authentication·authorization을 통과한 뒤, 저장 직전에 요청을 가로채는 kube-apiserver 내장 코드
- 두 단계: mutating(객체 수정 가능) → validating(검사만)
- 읽기 요청(get, list, watch)은 admission을 거치지 않음
- 켜고 끄기: `kube-apiserver --enable-admission-plugins=...` / `--disable-admission-plugins=...`
- v1.35 기본 활성 목록 중 CKAD와 닿는 것

| plugin               | 역할                                                   |
| -------------------- | ------------------------------------------------------ |
| `NamespaceLifecycle` | 삭제 중이거나 없는 namespace에 객체 생성 막음          |
| `LimitRanger`        | LimitRange 적용 (기본 requests/limits 주입, 범위 검사) |
| `ResourceQuota`      | namespace 단위 총량 제한                               |
| `ServiceAccount`     | Pod에 ServiceAccount·token 자동 설정                   |
| `PodSecurity`        | Pod Security Standards 적용                            |

- "생성은 되는데 Pod가 안 뜬다"가 아니라 "생성 자체가 거부된다"면 admission 단계에서 막혔을 가능성

## RBAC

API group `rbac.authorization.k8s.io/v1`, 객체 4종.

| 객체               | 범위      | 내용                                                                    |
| ------------------ | --------- | ----------------------------------------------------------------------- |
| Role               | namespace | 한 namespace 안의 권한 규칙                                             |
| ClusterRole        | 클러스터  | 클러스터 범위 리소스 권한, 또는 여러 namespace에 재사용할 규칙          |
| RoleBinding        | namespace | Role 또는 ClusterRole을 subject에 연결. 효과는 그 namespace 안으로 한정 |
| ClusterRoleBinding | 클러스터  | ClusterRole을 클러스터 전체에 연결                                      |

- subject 종류: `User`, `Group`, `ServiceAccount`
- 바인딩을 만든 뒤에는 `roleRef`를 바꿀 수 없음. 바꾸려면 삭제 후 재생성
- 기본 제공 사용자용 ClusterRole: `cluster-admin`, `admin`, `edit`, `view`

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

- 사람이 아닌 계정. Pod 안의 프로세스가 API server에 접근할 때의 신원
- namespace마다 `default` ServiceAccount가 자동 생성. 지워도 control plane이 다시 만듦
- `default` ServiceAccount는 RBAC 기준으로 API discovery 외 권한 없음
- Pod에 지정: `spec.serviceAccountName`
  - 이미 존재하는 Pod의 `serviceAccountName`은 수정 불가. Deployment 등은 template을 바꿔 새 Pod로 교체
  - `spec.serviceAccount`는 deprecated alias
- token
  - v1.22부터 `TokenRequest` API로 받은 짧은 수명·자동 갱신 token을 projected volume으로 마운트
  - 경로: `/var/run/secrets/kubernetes.io/serviceaccount/` (`token`, `ca.crt`, `namespace`)
  - 수동 발급: `kubectl create token <sa>` (`--duration`으로 수명 요청)
- 자동 마운트 끄기: `automountServiceAccountToken: false`
  - ServiceAccount와 Pod 양쪽에 둘 수 있고, 둘 다 있으면 Pod 쪽이 우선

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
  automountServiceAccountToken: true # Pod 설정이 우선
  containers:
    - name: app
      image: busybox:1.28
      command: ["sh", "-c", "sleep 1h"]
```

## SecurityContext

Pod·container가 노드에서 어떤 사용자·권한으로 실행되는지 정하는 설정. RBAC와 달리 API 권한과는 무관.

- 위치
  - Pod 레벨: `spec.securityContext`, 모든 container에 적용
  - container 레벨: `spec.containers[].securityContext`
  - 둘 다 있으면 container 레벨이 덮어씀

| 필드                       | Pod | container | 의미                                               |
| -------------------------- | --- | --------- | -------------------------------------------------- |
| `runAsUser` / `runAsGroup` | O   | O         | 프로세스 UID / 기본 GID                            |
| `runAsNonRoot`             | O   | O         | `true`면 UID 0으로 실행 시 kubelet이 시작 거부     |
| `seccompProfile`           | O   | O         | `RuntimeDefault`, `Localhost`, `Unconfined`        |
| `fsGroup`                  | O   | X         | volume 소유 그룹                                   |
| `supplementalGroups`       | O   | X         | 추가 그룹                                          |
| `sysctls`                  | O   | X         | Pod sysctl                                         |
| `capabilities`             | X   | O         | Linux capability add/drop                          |
| `readOnlyRootFilesystem`   | X   | O         | root filesystem 읽기 전용                          |
| `allowPrivilegeEscalation` | X   | O         | setuid 등으로 권한 상승 허용 여부 (`no_new_privs`) |
| `privileged`               | X   | O         | privileged 모드                                    |

- `allowPrivilegeEscalation`: container가 `privileged`이거나 `CAP_SYS_ADMIN`을 가지면 항상 true
- capability 이름은 `CAP_` 접두사 없이: `CAP_SYS_TIME` → `SYS_TIME`

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
          mountPath: /tmp # readOnlyRootFilesystem일 때 쓰기 경로
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
          add: ["NET_BIND_SERVICE"]
```

## Pod Security Standards

Pod 보안 수준을 세 단계 정책으로 정의한 것. 강제는 `PodSecurity` admission controller(Pod Security Admission)가 담당.

| 수준       | 내용                                                   |
| ---------- | ------------------------------------------------------ |
| Privileged | 제한 없음. 알려진 권한 상승도 허용                     |
| Baseline   | 알려진 권한 상승 차단. 기본(최소 지정) Pod 설정은 허용 |
| Restricted | 현재 Pod hardening best practice 수준의 강한 제한      |

Restricted에서 요구하는 container 설정(발췌):

- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`, `runAsUser`는 0 금지
- `capabilities.drop`에 `ALL`, add는 `NET_BIND_SERVICE`만
- `seccompProfile.type`: `RuntimeDefault` 또는 `Localhost` (미지정·`Unconfined` 불가)
- volume 종류 제한: configMap, csi, downwardAPI, emptyDir, ephemeral, persistentVolumeClaim, projected, secret

namespace label로 적용:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: secure-ns
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
```

| mode      | 위반 시                           |
| --------- | --------------------------------- |
| `enforce` | Pod 거부                          |
| `audit`   | audit log에 annotation 추가, 허용 |
| `warn`    | 사용자에게 경고, 허용             |

## 헷갈리는 것 비교

| 항목                             | A                                           | B                                                              |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| 401 vs 403                       | 401: authentication 실패 (누구인지 모름)    | 403: authorization 거부 (누구인지는 알지만 권한 없음)          |
| authorization vs admission       | 요청 속성(user, verb, resource)만 보고 판단 | 객체 내용(필드 값)까지 보고 수정·거부. 읽기 요청은 대상 아님   |
| Role vs ClusterRole              | namespace 범위                              | 클러스터 범위. RoleBinding으로 한 namespace에만 붙일 수도 있음 |
| RoleBinding + ClusterRole        | 효과는 RoleBinding의 namespace 안으로 한정  | ClusterRoleBinding이면 전 namespace                            |
| RBAC vs SecurityContext          | API server에 대한 권한                      | 노드에서 프로세스가 가진 권한                                  |
| `runAsNonRoot` vs `runAsUser`    | 조건 검사 (root면 실행 거부)                | 실제 UID 지정                                                  |
| `privileged` vs capabilities     | 사실상 호스트 수준 권한 전부                | 필요한 capability만 골라서 add/drop                            |
| Pod vs container securityContext | 공통 기본값, `fsGroup` 등 Pod 전용 필드     | 덮어쓰기, `capabilities` 등 container 전용 필드                |

## 시험 포인트

### imperative 명령어

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

# 권한 확인
kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:my-sa
kubectl auth can-i --list -n dev --as=system:serviceaccount:dev:my-sa

# Pod Security Admission
kubectl label namespace secure-ns pod-security.kubernetes.io/enforce=restricted
```

- SecurityContext는 imperative 플래그가 없음. `kubectl run ... --dry-run=client -o yaml`로 뼈대를 만든 뒤 YAML에 추가
- 필드 위치 확인: `kubectl explain pod.spec.securityContext`, `kubectl explain pod.spec.containers.securityContext`

### 문서에서 찾는 위치

- RBAC YAML, `kubectl create role/rolebinding` 예시: "Using RBAC Authorization"
- `kubectl auth can-i`, `--as`: "Authorization" 페이지의 Checking API access
- SecurityContext 필드, capabilities 예시: "Configure a Security Context for a Pod or Container"
- `automountServiceAccountToken`, `kubectl create token`: "Configure Service Accounts for Pods"
- namespace label 형식: "Pod Security Admission"

### 자주 하는 실수

- `--serviceaccount=<namespace>:<name>` 형식에서 namespace 누락
- Role에서 core group을 `apiGroups: [""]`로 쓰지 않음. Deployment는 `apps`
- 이미 떠 있는 Pod의 `serviceAccountName`을 `kubectl edit`으로 바꾸려 함. Pod 재생성 필요
- `capabilities`, `readOnlyRootFilesystem`을 Pod 레벨 `securityContext`에 넣음
- capability를 `CAP_NET_ADMIN`처럼 접두사 포함해서 씀
- `readOnlyRootFilesystem: true`만 켜고 쓰기 필요한 경로에 `emptyDir`를 안 붙임
- `kubectl auth can-i`에서 ServiceAccount를 `--as=my-sa`로 적음. `system:serviceaccount:<ns>:<name>` 전체가 필요

## 참고 문서

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
