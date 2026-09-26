---
title: "CKAD 개념 노트: requests, limits, quota"
description: "requests는 스케줄링, limits는 실행 중 강제. CPU throttling과 OOMKill의 차이, QoS class, LimitRange 기본값, namespace 단위 ResourceQuota를 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:08:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "resources", "qos", "resourcequota", "limitrange"]
order: 9
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 개념

### 리소스 타입과 단위

| 리소스              | 기본 단위 | 표기 예                |
| ------------------- | --------- | ---------------------- |
| `cpu`               | core      | `1`, `0.5`, `500m`     |
| `memory`            | byte      | `128Mi`, `1Gi`, `129M` |
| `ephemeral-storage` | byte      | `2Gi`                  |
| `hugepages-<size>`  | byte      | Linux 전용             |

- CPU: `0.1` = `100m`(100 millicpu). 항상 절대량이고 노드 코어 수와 무관
- memory: `Mi`/`Gi`는 2의 거듭제곱, `M`/`G`는 10의 거듭제곱
- 대소문자 주의: memory `400m`은 0.4 byte. `400Mi`나 `400M`을 의도한 경우가 대부분

### requests와 limits

컨테이너마다 `spec.containers[].resources` 아래에 지정.

```yaml
resources:
  requests:
    cpu: 250m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

- limit만 쓰고 request를 쓰지 않으면(그리고 admission 단계에서 기본값을 넣는 장치가 없으면) limit 값이 request로 복사됨
- 노드에 여유가 있으면 컨테이너는 request보다 더 쓸 수 있음. limit보다 더 쓸 수는 없음(memory는 아래 참고)
- Pod 단위 `spec.resources`로 Pod 전체의 requests/limits를 정하는 기능도 있음(beta). 이 글은 컨테이너 단위 기준

## 동작 방식

### requests: 스케줄링

scheduler는 리소스 타입마다 "노드에 이미 배치된 컨테이너들의 request 합 + 새 Pod의 request"가 노드 용량 이하인 노드만 고름. 실제 사용량은 보지 않음. 노드의 실제 CPU·memory 사용량이 낮아도 request 합이 차 있으면 배치를 거부함.

맞는 노드가 없으면 Pod는 `Pending`으로 남고 `FailedScheduling` 이벤트가 생김.

```bash
kubectl describe pod <pod>          # Events에서 FailedScheduling 확인
kubectl describe node <node>        # Allocated resources에서 request/limit 합계 확인
```

### limits: 실행 중 강제

Linux 노드에서는 kubelet과 컨테이너 런타임이 cgroups로 limit을 걸고 kernel이 강제함. CPU와 memory의 동작이 다름.

|             | CPU limit                                       | memory limit                                                                        |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| 강제 방식   | throttling                                      | OOM kill                                                                            |
| 넘으려 하면 | kernel이 CPU 시간을 제한. limit 이상 쓸 수 없음 | limit을 넘은 컨테이너를 kernel이 종료할 수 있음                                     |
| 시점        | 즉시(hard limit)                                | memory pressure를 감지했을 때. 넘자마자 죽지 않을 수 있음(reactive)                 |
| 확인        | 응답이 느려짐, 재시작 없음                      | `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137`, Restart Count 증가 |

limit을 넘은 컨테이너는 kubelet이 종료 후 재시작하고, 같은 Pod의 다른 컨테이너에는 영향이 없음.

### request 초과와 eviction

limit과 별개로, 컨테이너가 request보다 많이 쓰고 있는 상태에서 노드가 resource pressure를 받으면 그 Pod는 eviction 후보가 됨. eviction되면 Pod의 모든 컨테이너가 종료되고, controller가 있으면 보통 다른 노드에 새 Pod를 만듦.

### QoS class

Kubernetes가 Pod마다 컨테이너의 requests/limits를 보고 QoS class를 붙임. `kubectl get pod <pod> -o yaml`의 `status.qosClass`로 확인.

| class        | 조건                                                                                | eviction 순서   |
| ------------ | ----------------------------------------------------------------------------------- | --------------- |
| `Guaranteed` | 모든 컨테이너에 CPU·memory의 request와 limit이 있고, 각각 request = limit           | 마지막          |
| `Burstable`  | Guaranteed는 아니지만 컨테이너 하나 이상에 CPU나 memory의 request 또는 limit이 있음 | BestEffort 다음 |
| `BestEffort` | 어느 컨테이너에도 CPU·memory의 request·limit이 없음                                 | 가장 먼저       |

- 노드 자원이 부족하면 BestEffort -> Burstable -> Guaranteed 순으로 evict. resource pressure로 인한 eviction은 request를 넘겨 쓰는 Pod만 후보
- Guaranteed Pod는 limit을 넘거나, 더 낮은 우선순위의 선점 가능한 Pod가 노드에 남아 있지 않을 때까지 죽지 않음
- limit만 쓰면 request가 limit으로 복사되므로, 모든 컨테이너가 CPU·memory limit만 써도 Guaranteed가 됨

### LimitRange

namespace에 두는 정책. 그 namespace에서 만들어지는 Pod·컨테이너·PersistentVolumeClaim 하나하나의 requests/limits를 제한.

할 수 있는 것:

- Pod/컨테이너별 compute 리소스 min·max
- PersistentVolumeClaim별 storage request min·max
- request 대비 limit 비율(`maxLimitRequestRatio`)
- 값을 쓰지 않은 컨테이너에 기본 request(`defaultRequest`)와 기본 limit(`default`) 주입

동작 순서:

1. LimitRange admission controller가 requests/limits가 없는 컨테이너에 기본값을 넣음
2. min/max/ratio 위반을 검사. 위반하면 API server가 `403 Forbidden`으로 거부

주의점:

- 검사는 Pod admission 시점에만. LimitRange를 추가하거나 바꿔도 기존 Pod는 그대로
- 한 namespace에 LimitRange가 둘 이상이면 어느 기본값이 적용될지 정해져 있지 않음
- 기본값끼리의 일관성은 검사하지 않음. 예를 들어 `default.cpu: 500m`인 LimitRange에서 컨테이너가 `requests.cpu: 700m`만 쓰면, limit 기본값 500m이 들어가 request > limit이 되고 Pod 생성이 실패함

### ResourceQuota

namespace 전체의 합계를 제한. 팀마다 namespace를 나눠 쓰는 환경에서 한 팀이 클러스터 자원을 독점하지 못하게 하는 용도.

| 대상          | 예                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| compute 합계  | `requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory` (`cpu`, `memory`는 `requests.*`와 같음) |
| storage 합계  | `requests.storage`, `persistentvolumeclaims`                                                             |
| 오브젝트 개수 | `pods`, `services`, `secrets`, `configmaps`, `count/deployments.apps`                                    |

- compute 합계는 non-terminal 상태의 Pod 전체 기준
- 요청이 quota를 넘으면 `403 Forbidden`으로 거부되고 메시지에 위반한 제약이 나옴
- `cpu`/`memory` quota가 있는 namespace에서는 Pod에 해당 requests/limits를 반드시 써야 함. 안 쓰면 생성이 거부될 수 있음. LimitRange로 기본값을 넣어 두면 해결
- quota 변경은 이미 만들어진 리소스에 영향 없음
- quota는 노드 단위 제한이 아님. 여러 namespace의 Pod가 같은 노드에 올라갈 수 있음
- `scopes`로 측정 대상을 좁힐 수 있음(`BestEffort`, `NotBestEffort`, `Terminating`, `NotTerminating`, `PriorityClass` 등)

## 예시

### 컨테이너 리소스

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        requests:
          cpu: 250m
          memory: 64Mi
        limits:
          cpu: 500m
          memory: 128Mi
```

→ request != limit이므로 `Burstable`. request와 limit을 CPU·memory 모두 같게 하면 `Guaranteed`.

### 기존 워크로드에 리소스 지정

```bash
kubectl set resources deployment web -c=app \
  --requests=cpu=100m,memory=256Mi --limits=cpu=200m,memory=512Mi

kubectl get pod <pod> -o jsonpath='{.status.qosClass}'
```

### LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-mem-defaults
  namespace: dev
spec:
  limits:
    - type: Container
      default: # limit 기본값
        cpu: 500m
        memory: 256Mi
      defaultRequest: # request 기본값
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 512Mi
      min:
        cpu: 50m
        memory: 64Mi
```

```bash
kubectl describe limitrange -n dev
```

### ResourceQuota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
  namespace: dev
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
    pods: "10"
```

```bash
kubectl create quota compute-resources -n dev \
  --hard=requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi,pods=10

kubectl create quota object-counts -n dev \
  --hard=count/deployments.apps=2,count/pods=3,count/secrets=4

kubectl describe quota -n dev        # Used / Hard 확인
```

## 헷갈리는 것 비교

| 비교                                     | 차이                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| request vs limit                         | 스케줄링 기준(배치 전) vs 실행 중 상한(배치 후)                 |
| CPU limit 초과 vs memory limit 초과      | throttling, 재시작 없음 vs OOMKilled, 재시작                    |
| OOMKilled vs eviction                    | limit 초과로 컨테이너 종료 vs 노드 pressure로 Pod 전체 종료     |
| LimitRange vs ResourceQuota              | 오브젝트 하나 단위(기본값·min·max) vs namespace 합계            |
| LimitRange `default` vs `defaultRequest` | limit 기본값 vs request 기본값                                  |
| quota `cpu` vs `limits.cpu`              | `requests.cpu`와 같음 vs limit 합계                             |
| `Guaranteed` vs `Burstable`              | 모든 컨테이너 CPU·memory request = limit vs 그 외 하나라도 지정 |

## 시험 포인트

### 명령어

- 리소스 지정: `kubectl set resources` 또는 `--dry-run=client -o yaml`로 뽑은 YAML에 `resources` 블록 추가
- quota: `kubectl create quota <name> --hard=...`
- LimitRange는 imperative 생성 명령이 없으므로 YAML로 작성
- 확인: `kubectl describe quota`, `kubectl describe limitrange`, `kubectl describe node`, `kubectl describe pod`(OOMKilled, FailedScheduling)
- QoS 확인: `-o jsonpath='{.status.qosClass}'`

### kubectl explain

```bash
kubectl explain pod.spec.containers.resources  # requests, limits
kubectl explain resourcequota.spec             # hard, scopes
kubectl explain limitrange.spec.limits         # default, defaultRequest, max, min
kubectl explain pod.status.qosClass
```

## 참고 문서

- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Configure Quality of Service for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [kubectl set resources](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_resources/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
