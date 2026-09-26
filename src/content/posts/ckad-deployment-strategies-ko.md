---
title: "CKAD 개념 노트: Rolling update와 배포 전략"
description: "Deployment의 RollingUpdate·Recreate 동작, maxSurge·maxUnavailable 계산, rollout 명령, 그리고 Service selector와 replica 비율로 만드는 blue/green·canary 배포를 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:05:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  ["kubernetes", "ckad", "deployment", "rolling-update", "canary", "blue-green"]
order: 6
---

> 기준: Kubernetes v1.35 (kind `kindest/node:v1.35.8`에서 명령어·YAML 확인)

## 목차

## 개념

### Deployment, ReplicaSet, revision

Deployment는 Pod를 직접 관리하지 않는다. `.spec.template`이 바뀌면 새 ReplicaSet을 만들고, 새 쪽은 scale up, 옛 쪽은 scale down 하면서 Pod를 교체한다.

- ReplicaSet 이름의 해시와 Pod label의 `pod-template-hash` 값은 같음. Pod template을 해시한 값이고, Deployment controller가 ReplicaSet selector·Pod template label·기존 Pod에 붙여서 ReplicaSet끼리 Pod가 겹치지 않게 함
- revision history는 옛 ReplicaSet에 저장됨. ReplicaSet이 지워지면 그 revision으로는 rollback 불가
- `.spec.revisionHistoryLimit` 기본값 10. 0이면 replica 0인 옛 ReplicaSet을 전부 정리하므로 undo 불가

### rollout이 시작되는 조건

공식 문서 표현 그대로 "if and only if the Deployment's Pod template (`.spec.template`) is changed".

| 변경                                       | rollout / 새 revision |
| ------------------------------------------ | --------------------- |
| container image 변경 (`kubectl set image`) | O                     |
| template의 label, env, resources 등 변경   | O                     |
| `kubectl scale`로 replicas 변경            | X                     |
| Deployment 자체의 annotation 변경          | X                     |

그래서 rollback도 Pod template 부분만 되돌린다. replicas는 undo 대상이 아니다.

### 두 가지 strategy

|                   | `RollingUpdate` (기본)                                 | `Recreate`                          |
| ----------------- | ------------------------------------------------------ | ----------------------------------- |
| 동작              | 옛 ReplicaSet을 점진적으로 줄이고 새 ReplicaSet을 늘림 | 옛 Pod를 전부 종료한 뒤 새 Pod 생성 |
| 다운타임          | `maxUnavailable` 범위 안에서 가용성 유지               | 옛 Pod가 모두 사라지는 구간이 있음  |
| 두 버전 동시 실행 | 있음                                                   | 업그레이드 중에는 없음              |
| 세부 설정         | `maxSurge`, `maxUnavailable`                           | 없음                                |

`Recreate`의 "먼저 종료, 나중 생성" 보장은 업그레이드에만 해당한다. Pod를 수동으로 지우면 ReplicaSet이 바로 대체 Pod를 만든다(옛 Pod가 Terminating이어도). "동시에 최대 N개"가 꼭 필요하면 문서는 StatefulSet을 권한다.

## 동작 방식

### maxSurge / maxUnavailable

둘 다 `.spec.strategy.rollingUpdate` 아래의 선택 필드. 정수(`5`) 또는 원하는 Pod 수에 대한 퍼센트(`10%`).

| 필드             | 의미                                         | 퍼센트 환산 | 기본값 |
| ---------------- | -------------------------------------------- | ----------- | ------ |
| `maxSurge`       | `replicas`를 초과해서 더 만들 수 있는 Pod 수 | 올림        | 25%    |
| `maxUnavailable` | 업데이트 중 unavailable 상태여도 되는 Pod 수 | 내림        | 25%    |

- 둘 다 0은 불가 (한쪽이 0이면 다른 쪽은 0이 아니어야 함)
- 기본값이면 "최소 75% available, 최대 125% 존재"

`replicas: 10`, 기본값 기준 계산:

```text
maxSurge       = ceil(10 * 0.25)  = 3  -> 전체 Pod 최대 13개
maxUnavailable = floor(10 * 0.25) = 2  -> available Pod 최소 8개
```

자주 쓰는 조합:

| 설정                               | 효과                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `maxSurge: 1`, `maxUnavailable: 0` | 새 Pod가 ready 된 뒤에야 옛 Pod를 줄임. 용량 감소 없음, 추가 자원 필요 |
| `maxSurge: 0`, `maxUnavailable: 1` | 옛 Pod를 먼저 하나 줄이고 새로 만듦. 추가 자원 없음, 용량 일시 감소    |

### available 판정과 진행 기한

- `.spec.minReadySeconds` (기본 0): 새 Pod가 이 시간 동안 container crash 없이 ready여야 available로 침. rollout 속도에 직접 영향
- `.spec.progressDeadlineSeconds` (기본 600): 이 시간 동안 진행이 없으면 condition이 `Progressing=False`, `reason: ProgressDeadlineExceeded`. controller가 rollback을 해 주지는 않고 상태만 보고함. `minReadySeconds`보다 커야 함
- `kubectl rollout status`는 완료 시 exit code 0, deadline 초과 시 0이 아닌 값 → 스크립트에서 판정 가능

### 업데이트 중에 또 업데이트하면

rollover. 진행 중에 template을 다시 바꾸면 새 ReplicaSet을 또 만들고, 직전에 늘리던 ReplicaSet도 옛 것으로 취급해 줄이기 시작한다. 이전 rollout이 끝나기를 기다리지 않는다.

rollout 도중(진행 중이거나 pause 상태) scale하면 proportional scaling. 늘어난 replica를 활성 ReplicaSet들에 비율대로 나눠 준다.

### pause / resume

- `.spec.paused: true`인 동안 template 변경은 rollout을 만들지 않음. 여러 변경을 모아서 한 번에 rollout할 때 사용
- scale은 pause 중에도 됨
- **pause 상태에서는 rollback 불가**. resume 먼저

## 예시 (YAML·kubectl)

### RollingUpdate 설정

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  minReadySeconds: 5
  revisionHistoryLimit: 5
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
```

`Recreate`로 바꿀 때는 `rollingUpdate` 블록을 지우고 `type: Recreate`만 남긴다.

### rollout 명령 흐름

```shell
# image 교체 → rollout 시작
kubectl set image deployment/web web=nginx:1.28

# 진행 상황 (완료까지 대기)
kubectl rollout status deployment/web

# history. CHANGE-CAUSE는 kubernetes.io/change-cause annotation에서 복사됨
kubectl annotate deployment/web kubernetes.io/change-cause="image updated to 1.28"
kubectl rollout history deployment/web
kubectl rollout history deployment/web --revision=2

# rollback
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=1

# 여러 변경을 모아서 한 번에
kubectl rollout pause deployment/web
kubectl set image deployment/web web=nginx:1.29
kubectl set resources deployment/web -c=web --limits=memory=256Mi
kubectl rollout resume deployment/web

# ReplicaSet 교체 확인
kubectl get rs -l app=web
```

`--record` 플래그는 deprecated. change-cause가 필요하면 annotation으로 직접 넣는다.

undo로 되돌린 revision은 history에서 새 번호를 받는다. 위 순서대로 치면 첫 `undo`에서 revision 1이 3으로 옮겨 가서, 다음 줄 `--to-revision=1`은 `unable to find specified revision 1 in history`로 실패한다. undo 전에 `rollout history`로 번호부터 확인.

### blue/green: Service selector 전환

Service는 selector에 맞는 Pod를 계속 찾아서 EndpointSlice를 갱신한다. 그래서 selector 값 하나만 바꾸면 트래픽 대상이 통째로 넘어간다.

Deployment 두 개를 동시에 띄우고 `version` label로 구분:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
      version: blue
  template:
    metadata:
      labels:
        app: web
        version: blue
    spec:
      containers:
        - name: web
          image: nginx:1.27
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
      version: green
  template:
    metadata:
      labels:
        app: web
        version: green
    spec:
      containers:
        - name: web
          image: nginx:1.28
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
    version: blue
  ports:
    - port: 80
      targetPort: 80
```

전환과 되돌리기는 selector 값만 바꾼다.

```shell
kubectl patch service web -p '{"spec":{"selector":{"version":"green"}}}'
kubectl get endpointslices -l kubernetes.io/service-name=web

# 문제가 있으면 다시 blue
kubectl patch service web -p '{"spec":{"selector":{"version":"blue"}}}'
```

- 전환 전 green Pod가 전부 ready인지 먼저 확인
- 전환이 안정되면 blue Deployment는 scale 0 또는 삭제

### canary: replica 비율

`docs/concepts/workloads/management`의 canary 예시 구조 그대로. 공통 label은 같게, `track` label만 다르게 두고, Service는 `track`을 빼고 선택한다.

```yaml
# stable: track=stable, replicas 3, image v1
# canary: track=canary, replicas 1, image v2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-canary
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
      track: canary
  template:
    metadata:
      labels:
        app: web
        track: canary
    spec:
      containers:
        - name: web
          image: nginx:1.28
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web # track 없음 → stable, canary 둘 다 선택
  ports:
    - port: 80
```

- stable 3 : canary 1 → 트래픽 대략 3:1 (문서 예시 그대로의 비율)
- 비율 조정은 `kubectl scale deployment/web-canary --replicas=2` 식으로
- 확신이 서면 stable의 image를 새 버전으로 올리고 canary Deployment 삭제
- stable과 canary의 `selector.matchLabels`는 서로 겹치면 안 됨. `track` 값이 달라서 두 ReplicaSet 집합이 분리됨

## 헷갈리는 것 비교

|                  | RollingUpdate                 | Recreate                      | blue/green                             | canary                                     |
| ---------------- | ----------------------------- | ----------------------------- | -------------------------------------- | ------------------------------------------ |
| 구현             | Deployment 1개, strategy 설정 | Deployment 1개, strategy 설정 | Deployment 2개 + Service selector 전환 | Deployment 2개 + 공통 label을 고른 Service |
| 버전 공존        | 교체 중에만                   | 없음                          | 둘 다 떠 있지만 트래픽은 한쪽          | 둘 다 트래픽 받음                          |
| 트래픽 비율 제어 | 불가 (진행 속도만 조절)       | 불가                          | 0 또는 100                             | replica 수 비율                            |
| 되돌리기         | `kubectl rollout undo`        | `kubectl rollout undo`        | selector 원복                          | canary scale 0 / 삭제                      |
| 추가 자원        | `maxSurge`만큼                | 없음                          | 두 벌 전체                             | canary replica만큼                         |

| 헷갈리는 쌍                    | 차이                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `maxSurge` vs `maxUnavailable` | 초과 생성 상한(올림) vs 부족 허용 상한(내림)                                 |
| revision vs replicas           | revision은 template 변경만 기록. scale은 revision을 만들지 않고 undo도 안 됨 |
| `rollout pause` vs scale 0     | pause는 template 변경 반영을 멈출 뿐 Pod는 그대로 돌아감                     |
| `progressDeadlineSeconds` 초과 | 상태 보고일 뿐, 자동 rollback 아님                                           |
| Deployment `selector` 변경     | `apps/v1`에서 immutable. 바꾸려면 삭제 후 재생성                             |

## 시험 포인트

**빨리 만드는 명령**

```shell
kubectl create deployment web --image=nginx:1.27 --replicas=3 --dry-run=client -o yaml > web.yaml
kubectl set image deployment/web web=nginx:1.28     # container 이름=image
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web --to-revision=N
kubectl scale deployment/web --replicas=5
```

- `kubectl create deployment`는 `strategy`를 따로 받지 않으므로 `--dry-run=client -o yaml`로 뽑고 `strategy` 블록을 손으로 추가
- `kubectl set image`의 왼쪽은 container 이름. Deployment 이름이 아님 (`kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[*].name}'`)

**kubectl explain**

```bash
kubectl explain deployment.spec.strategy                # type: RollingUpdate / Recreate
kubectl explain deployment.spec.strategy.rollingUpdate  # maxSurge, maxUnavailable 기본값
kubectl explain deployment.spec.revisionHistoryLimit    # rollout history에 남는 revision 수
kubectl explain deployment.spec.minReadySeconds
kubectl explain service.spec.selector                   # blue/green 전환 대상
```

## 참고 문서

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Managing Workloads -- Canary deployments](https://kubernetes.io/docs/concepts/workloads/management/#canary-deployments)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
