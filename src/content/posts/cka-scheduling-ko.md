---
title: "CKA 개념 노트: Pod scheduling"
description: "nodeName, nodeSelector, node affinity, taint와 toleration, Pod anti-affinity, topology spread constraint, PriorityClass와 preemption을 worker 2대짜리 kubeadm 클러스터에서 직접 배치해 보며 정리했습니다."
pubDatetime: 2026-10-14T01:07:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "scheduling", "affinity", "taint", "priorityclass"]
order: 7
draft: true
---

> 기준: kubeadm 클러스터 v1.35.9 (control plane 1 + worker 2, worker당 CPU 2)에서 명령어 확인

requests·limits, LimitRange, ResourceQuota처럼 admission과 리소스 쪽은 [CKAD 개념 노트: requests, limits, quota](/ko/posts/ckad-resources-quotas)에 정리했음.

## 목차

## scheduler가 하는 일

`spec.nodeName`이 비어 있는 Pod마다 노드를 하나 골라 binding.

1. filter: 조건을 못 맞추는 노드 제외 (리소스 request, nodeSelector, affinity, taint, spread 등)
2. score: 남은 노드에 점수 (preferred affinity, 리소스 균형 등)
3. 가장 높은 노드에 binding

filter에서 전부 걸러지면 Pod는 `Pending`이고, 이유가 `FailedScheduling` 이벤트에 노드 수와 함께 나옴.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s),
2 node(s) didn't match Pod's node affinity/selector.
```

이 클러스터에서는 "1 node(s) had untolerated taint(s)"가 거의 항상 붙음. control plane의 `node-role.kubernetes.io/control-plane:NoSchedule` taint 때문.

## 방법 한눈에

| 방법 | 위치 | 성격 |
| --- | --- | --- |
| `nodeName` | `spec.nodeName` | scheduler를 건너뜀. 그 노드 kubelet이 바로 실행 |
| `nodeSelector` | `spec.nodeSelector` | node label이 전부 일치하는 노드만 |
| node affinity | `spec.affinity.nodeAffinity` | 연산자(In, NotIn, Exists 등), required/preferred |
| Pod affinity / anti-affinity | `spec.affinity.podAffinity` / `podAntiAffinity` | 다른 Pod가 있는(없는) 곳으로 |
| taint / toleration | node `spec.taints` / Pod `spec.tolerations` | 노드가 Pod를 밀어냄. toleration이 있어야 들어감 |
| topology spread | `spec.topologySpreadConstraints` | 도메인(노드, zone)마다 고르게 |
| PriorityClass | `spec.priorityClassName` | 자리가 없으면 낮은 priority Pod를 밀어냄 |

## nodeName

```bash
kubectl run nn --image=nginx:1.27 --overrides='{"spec":{"nodeName":"cka-cp1"}}'
```

- control plane의 NoSchedule taint가 있어도 cka-cp1에 배치됨. scheduler가 taint를 보는 건데 scheduler를 거치지 않기 때문
- `default-scheduler`의 `Scheduled` 이벤트가 없음
- 노드 이름이 틀리거나 노드에 자원이 없으면 그대로 실패. 실무보다는 "scheduler가 죽었을 때 수동 배치" 문제에서 씀

## nodeSelector

```bash
kubectl label node cka-w1 disk=ssd
```

```yaml
spec:
  nodeSelector:
    disk: ssd
```

`disk=hdd`처럼 맞는 노드가 없으면 `Pending`.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector.
```

## node affinity

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: disk
            operator: In
            values: [ssd, nvme]
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 50
        preference:
          matchExpressions:
          - key: kubernetes.io/hostname
            operator: In
            values: [cka-w2]
```

- required: filter. 못 맞추면 `Pending`
- preferred: score. 위 예는 cka-w2를 선호하지만 required(disk=ssd)를 cka-w1만 만족해서 cka-w1에 배치됨
- 연산자: `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`. `NotIn`, `DoesNotExist`로 "이 노드는 피하기"
- `nodeSelectorTerms` 여러 개는 OR, 한 term 안의 `matchExpressions` 여러 개는 AND
- `IgnoredDuringExecution`: 배치 후 node label을 지워도 Pod는 그대로. cka-w1의 `disk` label을 지워도 실행 중인 Pod는 `Running`

## taint와 toleration

```bash
kubectl taint node cka-w2 dedicated=gpu:NoSchedule
kubectl taint node cka-w2 dedicated-          # 제거 (key 뒤에 -)
kubectl describe node cka-w2 | grep Taints
```

| effect | 새 Pod | 이미 있는 Pod |
| --- | --- | --- |
| `NoSchedule` | toleration 없으면 배치 안 함 | 그대로 |
| `PreferNoSchedule` | 가능하면 피함 | 그대로 |
| `NoExecute` | toleration 없으면 배치 안 함 | toleration 없으면 즉시 축출. `tolerationSeconds`가 있으면 그만큼 뒤 축출 |

```yaml
spec:
  tolerations:
  - key: dedicated
    operator: Equal
    value: gpu
    effect: NoSchedule
  - key: maint
    operator: Exists        # value 없이 key만 맞으면
    effect: NoExecute
    tolerationSeconds: 30
```

실습 결과:

- cka-w2에 `NoSchedule`을 건 뒤에도 원래 있던 Pod는 `Running` 그대로. Deployment를 `rollout restart`하니 새 Pod는 전부 cka-w1로 감
- cka-w2에 `maint=true:NoExecute`를 걸었더니, NoExecute toleration이 없는 Pod는 10초 안에 사라지고, `tolerationSeconds: 30`인 Pod는 10초 시점에는 `Running`, 40초 시점에는 축출됨

toleration은 "들어가도 된다"일 뿐 "거기로 가라"가 아님. 특정 노드 전용으로 만들려면 taint(다른 Pod 막기) + nodeSelector나 affinity(이 Pod를 그리로) 둘 다 필요.

## Pod anti-affinity

replica를 노드마다 하나씩:

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: aa
        topologyKey: kubernetes.io/hostname
```

- `topologyKey`: 같은 값을 가진 노드를 한 도메인으로 봄. `kubernetes.io/hostname`이면 노드 하나가 도메인, `topology.kubernetes.io/zone`이면 zone
- replicas 3으로 만들었더니 worker 2대에 하나씩, 세 번째는 `Pending`

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod anti-affinity rules.
```

- `podAffinity`는 반대로 같은 도메인에 모음 (예: 캐시를 앱 옆에)

## topology spread constraint

```yaml
spec:
  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: ts
```

| 필드 | 의미 |
| --- | --- |
| `maxSkew` | 도메인 간 Pod 수 차이 최대값 |
| `whenUnsatisfiable` | `DoNotSchedule`(Pending) 또는 `ScheduleAnyway`(score만 반영) |
| `labelSelector` | 셀 Pod |
| `nodeTaintsPolicy` | taint가 있는 노드를 도메인으로 셀지. 기본 `Ignore`(셈) |

replicas 5로 만들었더니 cka-w1 1개, cka-w2 1개만 뜨고 3개가 `Pending`.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod topology spread constraints.
```

control plane도 `kubernetes.io/hostname` label이 있어서 도메인으로 세어짐. 거기에는 taint 때문에 Pod가 0개라서, worker에 하나씩 더 놓으면 skew가 2가 되어 막힘. `nodeTaintsPolicy: Honor`를 넣으니 toleration 없는 taint 노드가 계산에서 빠지고 2/3으로 배치됨.

## PriorityClass와 preemption

```bash
kubectl get priorityclass
# system-cluster-critical   2000000000
# system-node-critical      2000001000

kubectl create priorityclass high --value=1000 --description="high"
kubectl create priorityclass low --value=10
```

실습: worker마다 `cpu: 1200m`을 request하는 `low` Pod를 하나씩 띄움 (노드 allocatable CPU 2). 그다음 `cpu: 1200m`의 `high` Pod를 만듦.

```text
low-w1   Running   cka-w1
high     Running   cka-w2
Preempted   pod/low-w2   Preempted by pod 92ff4701-... on node cka-w2
```

- 들어갈 노드가 없으면 scheduler가 낮은 priority Pod를 축출할 노드를 골라 `status.nominatedNodeName`에 적고, 축출이 끝나면 배치
- `preemptionPolicy: Never`인 PriorityClass는 대기열에서 앞설 뿐 남을 밀어내지 않음
- `globalDefault: true`인 PriorityClass는 하나만. `priorityClassName`이 없는 Pod에 적용

## 헷갈리는 것 비교

| 비교 | A | B |
| --- | --- | --- |
| nodeName vs nodeSelector | scheduler 건너뜀. taint 무시 | scheduler가 label로 filter |
| nodeSelector vs node affinity | label 일치(AND)만 | 연산자, OR, preferred |
| required vs preferred | filter. 못 맞추면 Pending | score. 못 맞춰도 배치 |
| taint vs affinity | 노드가 Pod를 밀어냄 | Pod가 노드를 고름 |
| NoSchedule vs NoExecute | 새 Pod만 막음 | 기존 Pod도 축출 |
| anti-affinity vs topology spread | 같은 도메인에 같이 두지 않음 (도메인당 최대 1) | 도메인 간 개수 차이를 maxSkew 이하로 |
| `Equal` vs `Exists` | key와 value 일치 | key만 있으면 |

## 시험 포인트

### 빨리 푸는 명령어

```bash
kubectl label node <node> key=value
kubectl label node <node> key-
kubectl taint node <node> key=value:NoSchedule
kubectl taint node <node> key=value:NoSchedule-
kubectl get nodes --show-labels
kubectl describe node <node> | grep -A3 Taints
kubectl create priorityclass <name> --value=1000
kubectl describe pod <pod> | grep -A5 Events      # FailedScheduling 이유
```

- affinity YAML은 외우지 말고 문서 "Assigning Pods to Nodes"에서 복사
- toleration의 `effect`를 빼면 그 key의 모든 effect를 허용
- Pending 원인은 FailedScheduling 메시지의 "N node(s) ..." 항목을 하나씩 읽으면 됨

### kubectl explain

```bash
kubectl explain pod.spec.affinity.nodeAffinity
kubectl explain pod.spec.tolerations
kubectl explain pod.spec.topologySpreadConstraints
kubectl explain priorityclass
```

## 참고 문서

- [Kubernetes Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
