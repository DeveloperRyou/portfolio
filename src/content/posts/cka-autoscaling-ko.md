---
title: "CKA 개념 노트: workload autoscaling"
description: "metrics-server가 HPA에 CPU 사용량을 주는 흐름, kubectl autoscale과 autoscaling/v2 HPA, 부하를 걸었을 때 늘어나고 부하를 뺐을 때 5분 뒤 줄어드는 과정, VPA와의 차이를 kubeadm 클러스터에서 정리했습니다."
pubDatetime: 2026-10-14T01:08:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "hpa", "autoscaling", "metrics-server"]
order: 8
draft: true
---

> 기준: kubeadm 클러스터 v1.35.9, kubectl v1.35.9, metrics-server 0.9.0 (Helm chart 3.14.0)에서 명령어 확인

## 목차

## autoscaling 종류

| 대상 | 방법 | 누가 |
| --- | --- | --- |
| Pod 개수 | HorizontalPodAutoscaler (HPA) | kube-controller-manager의 HPA controller. 기본 포함 |
| Pod 리소스 크기 | VerticalPodAutoscaler (VPA) | 별도 설치하는 add-on (CRD + controller) |
| 노드 개수 | Cluster Autoscaler, Karpenter 등 | 클라우드 연동 add-on |
| 수동 | `kubectl scale deploy <name> --replicas=N` | 사람 |

시험 범위에서 직접 다룰 건 HPA. VPA와 노드 autoscaler는 개념만.

## metrics-server

HPA는 CPU·memory 사용량을 Metrics API(`metrics.k8s.io`)에서 가져옴. 이 API를 제공하는 게 metrics-server이고, kubeadm은 설치해 주지 않음.

```text
kubelet (/metrics/resource) ──▶ metrics-server ──▶ metrics.k8s.io API ──▶ HPA controller, kubectl top
```

- 설치는 [확장 인터페이스 노트](/ko/posts/cka-extension-interfaces)에서 Helm으로 함. kubeadm 클러스터에서는 `--kubelet-insecure-tls` 없이 설치하면 kubelet 인증서 검증 실패로 Ready가 되지 않음
- 없으면 `kubectl top nodes` → `error: Metrics API not available`
- VM을 재부팅한 직후에도 metrics-server가 다시 뜨기 전까지 같은 에러가 났음

## HPA 만들기

### 준비

HPA의 CPU 사용률(%)은 "request 대비" 사용량. 대상 컨테이너에 CPU request가 있어야 함.

```bash
kubectl create deploy php --image=registry.k8s.io/hpa-example --port=80
kubectl set resources deploy php --requests=cpu=200m --limits=cpu=500m
kubectl expose deploy php --port=80
```

### kubectl autoscale

```bash
kubectl autoscale deploy php --cpu=50% --min=1 --max=5
```

- kubectl v1.35에서는 `--cpu`가 `50%`(사용률) 또는 `500m`(평균 사용량)를 받음. `--memory`도 있음
- 예전 `--cpu-percent=50`도 동작하지만 `Flag --cpu-percent has been deprecated`라는 경고가 나옴

만들어진 객체는 `autoscaling/v2`.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php
  minReplicas: 1
  maxReplicas: 5
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

| `target.type` | 의미 |
| --- | --- |
| `Utilization` + `averageUtilization` | request 대비 % 평균 |
| `AverageValue` + `averageValue` | 절대량 평균 (예: `500m`, `200Mi`) |

## 동작 확인

부하 Pod:

```bash
kubectl run load --image=busybox:1.36 --restart=Never -- \
  /bin/sh -c "while sleep 0.01; do wget -q -O- http://php; done"
```

```text
NAME   REFERENCE        TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
php    Deployment/php   cpu: 0%/50%     1         5         1          31s
php    Deployment/php   cpu: 250%/50%   1         5         1          61s
php    Deployment/php   cpu: 186%/50%   1         5         5          91s
php    Deployment/php   cpu: 79%/50%    1         5         5          2m1s
php    Deployment/php   cpu: 65%/50%    1         5         5          2m31s
```

```text
Normal  SuccessfulRescale  New size: 4; reason: cpu resource utilization (percentage of request) above target
Normal  SuccessfulRescale  New size: 5; reason: cpu resource utilization (percentage of request) above target
```

- 계산식: `원하는 replicas = ceil(현재 replicas × 현재 값 / 목표 값)`. 1 × 250 / 50 = 5인데 처음엔 4로 갔다가 바로 5가 됨
- 처음 몇십 초는 `FailedGetResourceMetric` 경고가 나옴. 새 Pod의 metric이 아직 수집되지 않은 상태
- maxReplicas(5)에 닿으면 사용률이 목표보다 높아도 더 늘리지 않음

부하 Pod를 지운 뒤:

| 시간 | TARGETS | REPLICAS |
| --- | --- | --- |
| 0분 | `0%/50%` | 5 |
| 3분 | `0%/50%` | 5 |
| 약 4~5분 | `0%/50%` | 1 |

줄어드는 쪽은 기본 stabilization window가 300초라서 바로 줄지 않음. 늘어나는 쪽은 기본 0초.

## behavior

scale 속도와 안정화 시간을 `spec.behavior`로 조정.

```yaml
spec:
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Pods
        value: 2
        periodSeconds: 15
```

- `stabilizationWindowSeconds`: 이 기간의 추천값 중 가장 보수적인 값을 씀 (scale down이면 가장 큰 값)
- `policies`: 한 period 동안 바꿀 수 있는 양. 여러 개면 기본은 가장 많이 바꾸는 쪽(`selectPolicy: Max`)
- `selectPolicy: Disabled`면 그 방향 scaling을 끔

## 안 될 때

| 증상 | 원인 |
| --- | --- |
| `TARGETS`가 `cpu: <unknown>/50%` | metrics-server 없음, 아직 수집 전, 또는 request 없음 |
| `missing request for cpu in container nginx of Pod ...` | 대상 컨테이너에 CPU request가 없음 |
| replicas가 min에서 안 움직임 | 부하가 실제로 안 들어감, 목표값이 너무 높음 |
| replicas가 바로 안 줄어듦 | scaleDown stabilization (기본 300초) |

request 없는 Deployment에 HPA를 걸어 봄:

```text
$ kubectl get hpa noreq
NAME    REFERENCE          TARGETS              MINPODS   MAXPODS   REPLICAS
noreq   Deployment/noreq   cpu: <unknown>/50%   1         3         1

$ kubectl describe hpa noreq
... missing request for cpu in container nginx of Pod noreq-75667f6bd8-h2q66
```

## VPA

- Pod의 requests/limits를 실제 사용량에 맞춰 추천하거나 바꿈. Kubernetes 본체가 아니라 `kubernetes/autoscaler` 저장소의 add-on
- `updateMode`: `Off`(추천만), `Initial`(생성 시에만), `Recreate`(Pod를 다시 만들어 적용), `InPlaceOrRecreate`(가능하면 재시작 없이)
- 같은 CPU·memory metric으로 HPA와 VPA를 같이 쓰면 서로 반대로 움직일 수 있어서 권장하지 않음

이 클러스터에는 VPA를 설치하지 않아서 명령어는 확인하지 않음.

## 헷갈리는 것 비교

| 비교 | A | B |
| --- | --- | --- |
| HPA vs VPA | Pod 개수 | Pod 크기 (requests/limits) |
| `Utilization` vs `AverageValue` | request 대비 % | 절대량 |
| `kubectl scale` vs HPA | 한 번 바꿈. HPA가 있으면 다시 덮어씀 | 계속 조정 |
| scale up vs scale down 기본 | stabilization 0초 | stabilization 300초 |
| `--cpu=50%` vs `--cpu-percent=50` | v1.35 kubectl 방식 | deprecated 경고 |

## 시험 포인트

### 빨리 푸는 명령어

```bash
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5 --dry-run=client -o yaml   # behavior 추가할 때
kubectl get hpa -w
kubectl describe hpa <name>        # Events: SuccessfulRescale, FailedGetResourceMetric
kubectl top pods
```

- HPA를 만들기 전에 대상에 CPU request가 있는지부터 확인 (`kubectl set resources`)
- behavior는 imperative 플래그가 없으니 YAML로 뽑아서 추가

### kubectl explain

```bash
kubectl explain hpa.spec.metrics.resource.target
kubectl explain hpa.spec.behavior.scaleDown
```

## 참고 문서

- [Autoscaling Workloads](https://kubernetes.io/docs/concepts/workloads/autoscaling/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
