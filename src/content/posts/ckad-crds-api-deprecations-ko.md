---
title: "CKAD 개념 노트: CRD, Operator, API deprecation"
description: "Kubernetes API를 확장하는 CRD·custom resource·Operator와, API 버전이 deprecated되고 제거되는 규칙 및 manifest 이전 방법을 공식 문서 기준으로 정리한 노트."
pubDatetime: 2026-09-26T12:10:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "crd", "operator", "api-deprecation"]
order: 11
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 개념

### resource와 custom resource

- resource: 특정 kind의 API 객체 모음을 저장하는 API endpoint. 예: `pods` resource에 Pod 객체들
- custom resource: 기본 설치에는 없는 API 확장. 실행 중인 클러스터에 등록·제거 가능
- 설치 후에는 built-in 리소스처럼 `kubectl`로 생성·조회
- custom resource 자체는 구조화된 데이터를 저장·조회할 뿐. 실제 동작은 controller가 붙어야 생김

### custom resource를 추가하는 두 가지 방법

|                    | CRD                     | API aggregation                      |
| ------------------ | ----------------------- | ------------------------------------ |
| 프로그래밍         | 필요 없음 (YAML 하나)   | 별도 API server 바이너리·이미지 필요 |
| 추가로 띄울 서비스 | 없음. API server가 처리 | 있음. 장애 지점이 늘어남             |
| 유연성             | 낮음                    | 높음                                 |

CKAD 범위에서는 CRD만 다뤄도 충분.

### ConfigMap으로 충분한 경우

공식 문서 기준, 다음이면 ConfigMap:

- `mysql.cnf`, `pom.xml`처럼 이미 정해진 설정 파일 형식이 있음
- 설정 전체를 ConfigMap 키 하나에 넣으려 함
- Pod 안 프로그램이 파일·환경 변수로 읽음 (Kubernetes API로 읽지 않음)
- 파일이 바뀌면 Deployment rolling update로 반영하려 함

`kubectl get my-object`처럼 kubectl에서 1급 리소스로 다루고 싶거나, 새 자동화(controller)를 붙이려면 custom resource.

### Operator

- custom resource를 써서 애플리케이션과 그 구성요소를 관리하는 Kubernetes 확장 소프트웨어
- Kubernetes 코드를 고치지 않고, controller를 하나 이상의 custom resource에 연결해 동작을 확장
- Operator = custom resource의 controller 역할을 하는 Kubernetes API client
- 자동화 대상 예: 필요할 때 애플리케이션 배포, 상태 백업·복원, DB schema 변경을 동반한 업그레이드, leader 선출
- 가장 흔한 배포 방식: CRD + controller를 클러스터에 추가. controller는 보통 control plane 밖에서, 일반 컨테이너처럼(예: Deployment) 실행
- 사용 방식: Operator가 보는 custom resource를 추가·수정·삭제

```
사용자 ── kubectl apply ──▶ SampleDB (custom resource)
                              │ watch
                              ▼
                       operator controller (Deployment의 Pod)
                              │ reconcile
                              ▼
                  StatefulSet, Service, 백업 Job ... (built-in 리소스)
```

## 동작 방식

### CRD 등록

1. `CustomResourceDefinition` 객체를 apply
2. API server가 새 RESTful endpoint 생성: `/apis/<group>/<version>/namespaces/*/<plural>/...`
3. endpoint 생성까지 몇 초 걸릴 수 있음. CRD의 `Established` condition이 true가 되면 사용 가능
4. 이후 해당 kind의 객체를 `kubectl`로 생성·조회

CRD를 삭제하면 endpoint가 사라지고, 그 안에 저장된 custom object도 전부 삭제됨.

### API 버전 트랙

API group마다 버전이 독립적. 버전 이름으로 트랙을 구분.

| 예         | 트랙                 | 제거 규칙 (Rule #4a)                                                                                                   |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `v1`       | GA (stable)          | deprecated 표시는 가능, major 버전 안에서는 제거 불가                                                                  |
| `v1beta1`  | Beta (pre-release)   | 도입 후 9개월 또는 3 minor release 안에 deprecated, deprecated 후 9개월 또는 3 minor release 뒤 서빙 중단 (각각 긴 쪽) |
| `v1alpha1` | Alpha (experimental) | 사전 deprecation 없이 아무 release에서나 제거 가능                                                                     |

그 밖의 규칙(발췌):

- Rule #1: API 요소는 API group의 버전을 올려야만 제거 가능. 한 버전에 들어간 요소는 그 버전에서 빠지거나 동작이 크게 바뀌지 않음
- Rule #2: 한 release 안에서 API 객체는 버전 간 정보 손실 없이 변환(round-trip) 가능해야 함
- Rule #3: 덜 안정적인 버전을 위해 더 안정적인 버전을 deprecated할 수 없음 (GA는 beta·alpha를 대체 가능, 그 반대는 불가)

"deprecated"와 "removed"는 다름. deprecated 버전은 아직 서빙되고, removed 버전은 API server가 더 이상 받지 않음.

## 예시

### CRD와 custom object

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com # <plural>.<group>
spec:
  group: stable.example.com
  versions:
    - name: v1
      served: true # 이 버전을 API로 제공
      storage: true # 저장 버전은 정확히 하나
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                cronSpec:
                  type: string
                image:
                  type: string
                replicas:
                  type: integer
  scope: Namespaced # 또는 Cluster
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
      - ct
---
apiVersion: stable.example.com/v1
kind: CronTab
metadata:
  name: my-new-cron-object
spec:
  cronSpec: "* * * * */5"
  image: my-awesome-cron-image
```

```bash
kubectl apply -f resourcedefinition.yaml
kubectl apply -f my-crontab.yaml
kubectl get crontab          # plural, singular, shortName(ct) 모두 사용 가능
kubectl get ct -o yaml
```

### 클러스터에 어떤 확장이 있는지 찾기

```bash
kubectl get crd                                  # 등록된 CRD 목록
kubectl api-resources                            # 모든 리소스: 이름, shortName, APIVERSION, NAMESPACED, KIND
kubectl api-resources --api-group=stable.example.com
kubectl api-resources --namespaced=true
kubectl api-versions                             # 서빙 중인 group/version 목록
kubectl explain crontab.spec                     # CRD schema 기반 필드 설명
kubectl explain deployments --api-version=apps/v1
kubectl explain pod.spec --recursive
```

- `kubectl explain`이 custom resource 필드를 보여주는 건 CRD에 OpenAPI v3 schema가 있어서

### 제거된 API에서 manifest 옮기기

v1.35 문서의 Deprecated API Migration Guide에 있는 제거 이력 중 CKAD에서 자주 쓰는 리소스:

| 리소스                  | 제거된 버전                                          | 서빙 중단 | 옮길 버전              | 주요 변경                                                                                      |
| ----------------------- | ---------------------------------------------------- | --------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Deployment, DaemonSet   | `extensions/v1beta1`, `apps/v1beta1`, `apps/v1beta2` | v1.16     | `apps/v1`              | `spec.selector` 필수, 생성 후 변경 불가                                                        |
| NetworkPolicy           | `extensions/v1beta1`                                 | v1.16     | `networking.k8s.io/v1` |                                                                                                |
| Ingress                 | `extensions/v1beta1`, `networking.k8s.io/v1beta1`    | v1.22     | `networking.k8s.io/v1` | `serviceName` → `service.name`, `servicePort` → `service.port.number`/`.name`, `pathType` 필수 |
| CronJob                 | `batch/v1beta1`                                      | v1.25     | `batch/v1`             | 없음                                                                                           |
| HorizontalPodAutoscaler | `autoscaling/v2beta1`                                | v1.25     | `autoscaling/v2`       |                                                                                                |
| PodSecurityPolicy       | `policy/v1beta1`                                     | v1.25     | 대체 API 없음          | Pod Security Admission 또는 서드파티 admission webhook으로 이전                                |

v1.35 문서 기준 가장 최근 제거는 v1.32(`flowcontrol.apiserver.k8s.io/v1beta3`).

Ingress `v1beta1` → `v1`:

```yaml
# 이전 (networking.k8s.io/v1beta1, v1.22부터 서빙 중단)
#   backend:
#     serviceName: web
#     servicePort: 80
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

이전 절차 (문서의 What to do):

- 테스트: API server를 `--runtime-config=<group>/<version>=false`로 띄워 앞으로의 제거를 미리 재현
- 찾기: 1.19+의 client warning, metric, audit 정보로 deprecated API 사용처 확인
- 옮기기: YAML의 `apiVersion`과 바뀐 필드를 수정. 자동 변환은 `kubectl convert -f <file> --output-version <group>/<version>`
  - `kubectl convert`는 기본 설치에 없는 별도 plugin. 변환 결과의 기본값이 이상적이지 않을 수 있음

## 헷갈리는 것 비교

| 항목                                      | A                                                                       | B                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CRD vs custom resource                    | 종류 정의 (`kind: CustomResourceDefinition`, `apiextensions.k8s.io/v1`) | 그 종류의 객체 (`kind: CronTab`, `stable.example.com/v1`)                          |
| CRD vs Operator                           | API에 새 종류만 추가. 혼자서는 데이터 저장뿐                            | CRD + controller. 선언한 상태로 실제 리소스를 맞춤                                 |
| CRD vs ConfigMap                          | kubectl·API로 다루는 1급 리소스, schema 검증                            | 파일·환경 변수로 Pod에 주입하는 설정                                               |
| deprecated vs removed                     | 아직 서빙. warning만                                                    | 서빙 중단. 그 버전으로 요청하면 실패                                               |
| `served` vs `storage`                     | 이 버전을 API로 제공할지                                                | etcd에 저장할 때 쓰는 버전. 정확히 하나                                            |
| `kubectl api-resources` vs `api-versions` | 리소스 단위 (이름, kind, group/version, namespaced 여부)                | group/version 목록만                                                               |
| alpha vs beta                             | 사전 deprecation 없이 언제든 제거 가능                                  | deprecated 후 9개월 또는 3 release 뒤 서빙 중단 (GA는 major 버전 안에서 제거 없음) |

## 시험 포인트

### 빨리 쓰는 명령어

```bash
kubectl get crd
kubectl describe crd <plural>.<group>
kubectl api-resources | grep -i <keyword>
kubectl explain <kind>.spec --recursive
kubectl explain <resource> --api-version=<group>/<version>
```

- 모르는 custom resource가 나오면: `api-resources`로 이름·group·namespaced 여부 확인 → `explain`으로 필드 확인 → YAML 작성
- 제거된 `apiVersion`을 고쳐야 하면: `kubectl api-resources`의 APIVERSION 열로 현재 서빙 버전 확인. 바뀐 필드는 Deprecated API Migration Guide

### 문서에서 찾는 위치

- CRD YAML 전체 예시(`crontabs.stable.example.com`): "Extend the Kubernetes API with CustomResourceDefinitions"
- 제거된 API별 이전 버전·필드 변경: "Deprecated API Migration Guide"
- alpha/beta/GA 수명 규칙: "Kubernetes Deprecation Policy"의 Rule #4a
- `api-resources` 옵션: kubectl Quick Reference

### 자주 하는 실수

- CRD의 `metadata.name`을 `<plural>.<group>` 형식으로 안 맞춤
- `versions` 중 `storage: true`를 두 개 이상 두거나 하나도 안 둠
- custom object의 `apiVersion`에 CRD의 `apiextensions.k8s.io/v1`을 씀. custom object는 `<group>/<version>`
- CRD를 지우면 그 종류의 객체도 전부 지워진다는 걸 잊음
- Ingress를 `v1`으로 올리면서 `pathType` 누락, `serviceName`/`servicePort`를 그대로 둠
- Deployment를 `apps/v1`으로 올리면서 `spec.selector` 누락

## 참고 문서

- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl explain](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_explain/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
