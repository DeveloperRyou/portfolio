---
title: "CKA 概念ノート: workload autoscaling"
description: "metrics-server が HPA に CPU 使用量を渡す流れ、kubectl autoscale と autoscaling/v2 の HPA、負荷をかけると増えて負荷を止めると 5 分後に減る過程、VPA との違いを kubeadm クラスタでまとめました。"
pubDatetime: 2026-10-14T01:08:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "hpa", "autoscaling", "metrics-server"]
order: 8
---

> 基準: kubeadm クラスタ v1.35.9、kubectl v1.35.9、metrics-server 0.9.0 (Helm chart 3.14.0) でコマンドを確認

## 目次

## autoscaling の種類

| 対象                 | 方法                                       | 誰が                                                      |
| -------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Pod の数             | HorizontalPodAutoscaler (HPA)              | kube-controller-manager の HPA controller。標準で含まれる |
| Pod のリソースサイズ | VerticalPodAutoscaler (VPA)                | 別途インストールする add-on (CRD + controller)            |
| ノードの数           | Cluster Autoscaler、Karpenter など         | クラウド連携の add-on                                     |
| 手動                 | `kubectl scale deploy <name> --replicas=N` | 人                                                        |

試験範囲で直接扱うのは HPA。VPA とノードの autoscaler は概念だけ。

## metrics-server

HPA は CPU・memory の使用量を Metrics API (`metrics.k8s.io`) から取得する。この API を提供するのが metrics-server で、kubeadm はインストールしてくれない。

```text
kubelet (/metrics/resource) ──▶ metrics-server ──▶ metrics.k8s.io API ──▶ HPA controller, kubectl top
```

- インストールは [拡張インターフェースのノート](/ja/posts/cka-extension-interfaces) で Helm を使ってやった。kubeadm クラスタでは `--kubelet-insecure-tls` なしでインストールすると、kubelet 証明書の検証に失敗して Ready にならない
- ないと `kubectl top nodes` → `error: Metrics API not available`
- VM を再起動した直後も、metrics-server が起動し直すまで同じエラーが出た

## HPA を作る

### 準備

HPA の CPU 使用率 (%) は「request に対する」使用量。対象の container に CPU request が必要。

```bash
kubectl create deploy php --image=registry.k8s.io/hpa-example --port=80
kubectl set resources deploy php --requests=cpu=200m --limits=cpu=500m
kubectl expose deploy php --port=80
```

### kubectl autoscale

```bash
kubectl autoscale deploy php --cpu=50% --min=1 --max=5
```

- kubectl v1.35 では `--cpu` が `50%` (使用率) か `500m` (平均使用量) を受け取る。`--memory` もある
- 以前の `--cpu-percent=50` も動くが、`Flag --cpu-percent has been deprecated` という警告が出る

作られるオブジェクトは `autoscaling/v2`。

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

| `target.type`                        | 意味                               |
| ------------------------------------ | ---------------------------------- |
| `Utilization` + `averageUtilization` | request に対する % の平均          |
| `AverageValue` + `averageValue`      | 絶対量の平均 (例: `500m`、`200Mi`) |

## 動作の確認

負荷用の Pod:

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

- 計算式: `望ましい replicas = ceil(現在の replicas × 現在の値 / 目標値)`。1 × 250 / 50 = 5 だが、最初は 4 になってからすぐ 5 になった
- 最初の数十秒は `FailedGetResourceMetric` の警告が出る。新しい Pod の metric がまだ収集されていない状態
- maxReplicas (5) に達すると、使用率が目標より高くてもそれ以上増やさない

負荷用の Pod を消した後:

| 時間       | TARGETS  | REPLICAS |
| ---------- | -------- | -------- |
| 0 分       | `0%/50%` | 5        |
| 3 分       | `0%/50%` | 5        |
| 約 4〜5 分 | `0%/50%` | 1        |

減る側はデフォルトの stabilization window が 300 秒なので、すぐには減らない。増える側はデフォルト 0 秒。

## behavior

scale の速度と安定化の時間を `spec.behavior` で調整。

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

- `stabilizationWindowSeconds`: この期間の推奨値のうち、一番保守的な値を使う (scale down なら一番大きい値)
- `policies`: 1 つの period の間に変えられる量。複数あればデフォルトは一番多く変える方 (`selectPolicy: Max`)
- `selectPolicy: Disabled` ならその方向の scaling を止める

## うまくいかないとき

| 症状                                                    | 原因                                                     |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `TARGETS` が `cpu: <unknown>/50%`                       | metrics-server がない、まだ収集前、または request がない |
| `missing request for cpu in container nginx of Pod ...` | 対象の container に CPU request がない                   |
| replicas が min から動かない                            | 負荷が実際には届いていない、目標値が高すぎる             |
| replicas がすぐ減らない                                 | scaleDown の stabilization (デフォルト 300 秒)           |

request のない Deployment に HPA をかけてみた:

```text
$ kubectl get hpa noreq
NAME    REFERENCE          TARGETS              MINPODS   MAXPODS   REPLICAS
noreq   Deployment/noreq   cpu: <unknown>/50%   1         3         1

$ kubectl describe hpa noreq
... missing request for cpu in container nginx of Pod noreq-75667f6bd8-h2q66
```

## VPA

- Pod の requests/limits を実際の使用量に合わせて推奨したり変えたりする。Kubernetes 本体ではなく `kubernetes/autoscaler` リポジトリの add-on
- `updateMode`: `Off` (推奨だけ)、`Initial` (作成時だけ)、`Recreate` (Pod を作り直して適用)、`InPlaceOrRecreate` (できれば再起動なしで)
- 同じ CPU・memory の metric で HPA と VPA を一緒に使うと、互いに逆方向に動くことがあるので推奨されない

このクラスタには VPA をインストールしていないので、コマンドは確認していない。

## 紛らわしいものの比較

| 比較                                | A                                        | B                              |
| ----------------------------------- | ---------------------------------------- | ------------------------------ |
| HPA vs VPA                          | Pod の数                                 | Pod のサイズ (requests/limits) |
| `Utilization` vs `AverageValue`     | request に対する %                       | 絶対量                         |
| `kubectl scale` vs HPA              | 1 回変える。HPA があればまた上書きされる | 継続的に調整                   |
| scale up vs scale down のデフォルト | stabilization 0 秒                       | stabilization 300 秒           |
| `--cpu=50%` vs `--cpu-percent=50`   | v1.35 の kubectl の方式                  | deprecated の警告              |

## 試験のポイント

### 速く解くコマンド

```bash
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5 --dry-run=client -o yaml   # behavior を追加するとき
kubectl get hpa -w
kubectl describe hpa <name>        # Events: SuccessfulRescale, FailedGetResourceMetric
kubectl top pods
```

- HPA を作る前に、対象に CPU request があるかをまず確認 (`kubectl set resources`)
- behavior は imperative なフラグがないので、YAML に出して追加

### kubectl explain

```bash
kubectl explain hpa.spec.metrics.resource.target
kubectl explain hpa.spec.behavior.scaleDown
```

## 参考ドキュメント

- [Autoscaling Workloads](https://kubernetes.io/docs/concepts/workloads/autoscaling/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
