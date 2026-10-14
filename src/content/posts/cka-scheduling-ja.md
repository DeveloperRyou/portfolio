---
title: "CKA 概念ノート: Pod scheduling"
description: "nodeName、nodeSelector、node affinity、taint と toleration、Pod anti-affinity、topology spread constraint、PriorityClass と preemption を、worker 2 台の kubeadm クラスタで実際に配置しながらまとめました。"
pubDatetime: 2026-10-14T01:07:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "scheduling", "affinity", "taint", "priorityclass"]
order: 7
---

> 基準: kubeadm クラスタ v1.35.9 (control plane 1 + worker 2、worker あたり CPU 2) でコマンドを確認

requests・limits、LimitRange、ResourceQuota のような admission とリソースの側は [CKAD 概念ノート: requests、limits、quota](/ja/posts/ckad-resources-quotas) にまとめた。

## 目次

## scheduler がやること

`spec.nodeName` が空の Pod ごとにノードを 1 つ選んで binding する。

1. filter: 条件を満たせないノードを除外 (リソース request、nodeSelector、affinity、taint、spread など)
2. score: 残ったノードに点数を付ける (preferred affinity、リソースのバランスなど)
3. 一番高いノードに binding

filter ですべて除外されると Pod は `Pending` で、理由が `FailedScheduling` イベントにノード数と一緒に出る。

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s),
2 node(s) didn't match Pod's node affinity/selector.
```

このクラスタでは「1 node(s) had untolerated taint(s)」がほぼ必ず付く。control plane の `node-role.kubernetes.io/control-plane:NoSchedule` taint のせい。

## 方法の一覧

| 方法                         | 場所                                            | 性質                                                |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `nodeName`                   | `spec.nodeName`                                 | scheduler を飛ばす。そのノードの kubelet がすぐ実行 |
| `nodeSelector`               | `spec.nodeSelector`                             | node label がすべて一致するノードだけ               |
| node affinity                | `spec.affinity.nodeAffinity`                    | 演算子 (In、NotIn、Exists など)、required/preferred |
| Pod affinity / anti-affinity | `spec.affinity.podAffinity` / `podAntiAffinity` | 他の Pod がいる (いない) 場所へ                     |
| taint / toleration           | node `spec.taints` / Pod `spec.tolerations`     | ノードが Pod を押し返す。toleration があれば入れる  |
| topology spread              | `spec.topologySpreadConstraints`                | ドメイン (ノード、zone) ごとに均等に                |
| PriorityClass                | `spec.priorityClassName`                        | 空きがなければ priority の低い Pod を押し出す       |

## nodeName

```bash
kubectl run nn --image=nginx:1.27 --overrides='{"spec":{"nodeName":"cka-cp1"}}'
```

- control plane の NoSchedule taint があっても cka-cp1 に配置される。taint を見るのは scheduler だが、scheduler を通らないから
- `default-scheduler` の `Scheduled` イベントがない
- ノード名が間違っていたりノードにリソースがなかったりすると、そのまま失敗する。実務よりは「scheduler が落ちたときに手動で配置」する問題で使う

## nodeSelector

```bash
kubectl label node cka-w1 disk=ssd
```

```yaml
spec:
  nodeSelector:
    disk: ssd
```

`disk=hdd` のように合うノードがなければ `Pending`。

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

- required: filter。満たせなければ `Pending`
- preferred: score。上の例は cka-w2 を優先するが、required (disk=ssd) を満たすのが cka-w1 だけなので cka-w1 に配置された
- 演算子: `In`、`NotIn`、`Exists`、`DoesNotExist`、`Gt`、`Lt`。`NotIn`、`DoesNotExist` で「このノードは避ける」
- `nodeSelectorTerms` が複数なら OR、1 つの term の中の `matchExpressions` が複数なら AND
- `IgnoredDuringExecution`: 配置後に node label を消しても Pod はそのまま。cka-w1 の `disk` label を消しても実行中の Pod は `Running`

## taint と toleration

```bash
kubectl taint node cka-w2 dedicated=gpu:NoSchedule
kubectl taint node cka-w2 dedicated-          # 削除 (key の後に -)
kubectl describe node cka-w2 | grep Taints
```

| effect             | 新しい Pod                      | すでにある Pod                                                                          |
| ------------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `NoSchedule`       | toleration がなければ配置しない | そのまま                                                                                |
| `PreferNoSchedule` | できれば避ける                  | そのまま                                                                                |
| `NoExecute`        | toleration がなければ配置しない | toleration がなければ即座に追い出す。`tolerationSeconds` があればその時間の後に追い出す |

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: gpu
      effect: NoSchedule
    - key: maint
      operator: Exists # value なしで key だけ合えば
      effect: NoExecute
      tolerationSeconds: 30
```

実習の結果:

- cka-w2 に `NoSchedule` をかけた後も、元からあった Pod は `Running` のまま。Deployment を `rollout restart` したら、新しい Pod は全部 cka-w1 に行った
- cka-w2 に `maint=true:NoExecute` をかけたら、NoExecute の toleration がない Pod は 10 秒以内に消え、`tolerationSeconds: 30` の Pod は 10 秒の時点では `Running`、40 秒の時点では追い出されていた

toleration は「入ってもいい」というだけで、「そこへ行け」ではない。特定のノード専用にするには、taint (他の Pod を止める) + nodeSelector か affinity (この Pod をそこへ) の両方が必要。

## Pod anti-affinity

replica をノードごとに 1 つずつ:

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

- `topologyKey`: 同じ値を持つノードを 1 つのドメインとみなす。`kubernetes.io/hostname` ならノード 1 台がドメイン、`topology.kubernetes.io/zone` なら zone
- replicas 3 で作ったら、worker 2 台に 1 つずつ、3 つ目は `Pending`

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod anti-affinity rules.
```

- `podAffinity` は逆に同じドメインに集める (例: キャッシュをアプリの隣に)

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

| フィールド          | 意味                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `maxSkew`           | ドメイン間の Pod 数の差の最大値                                          |
| `whenUnsatisfiable` | `DoNotSchedule` (Pending) か `ScheduleAnyway` (score にだけ反映)         |
| `labelSelector`     | 数える Pod                                                               |
| `nodeTaintsPolicy`  | taint のあるノードをドメインとして数えるか。デフォルト `Ignore` (数える) |

replicas 5 で作ったら、cka-w1 に 1 つ、cka-w2 に 1 つだけ起動して、3 つが `Pending`。

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod topology spread constraints.
```

control plane にも `kubernetes.io/hostname` label があるのでドメインとして数えられる。そこには taint のせいで Pod が 0 個なので、worker にもう 1 つ置くと skew が 2 になって止められる。`nodeTaintsPolicy: Honor` を入れたら、toleration のない taint ノードが計算から外れて 2/3 で配置された。

## PriorityClass と preemption

```bash
kubectl get priorityclass
# system-cluster-critical   2000000000
# system-node-critical      2000001000

kubectl create priorityclass high --value=1000 --description="high"
kubectl create priorityclass low --value=10
```

実習: worker ごとに `cpu: 1200m` を request する `low` の Pod を 1 つずつ起動 (ノードの allocatable CPU は 2)。次に `cpu: 1200m` の `high` の Pod を作った。

```text
low-w1   Running   cka-w1
high     Running   cka-w2
Preempted   pod/low-w2   Preempted by pod 92ff4701-... on node cka-w2
```

- 入れるノードがなければ、scheduler が priority の低い Pod を追い出すノードを選んで `status.nominatedNodeName` に書き、追い出しが終わったら配置する
- `preemptionPolicy: Never` の PriorityClass は待ち行列で前に出るだけで、他を押し出さない
- `globalDefault: true` の PriorityClass は 1 つだけ。`priorityClassName` がない Pod に適用される

## 紛らわしいものの比較

| 比較                             | A                                                   | B                                   |
| -------------------------------- | --------------------------------------------------- | ----------------------------------- |
| nodeName vs nodeSelector         | scheduler を飛ばす。taint を無視                    | scheduler が label で filter        |
| nodeSelector vs node affinity    | label の一致 (AND) だけ                             | 演算子、OR、preferred               |
| required vs preferred            | filter。満たせなければ Pending                      | score。満たせなくても配置           |
| taint vs affinity                | ノードが Pod を押し返す                             | Pod がノードを選ぶ                  |
| NoSchedule vs NoExecute          | 新しい Pod だけ止める                               | 既存の Pod も追い出す               |
| anti-affinity vs topology spread | 同じドメインに一緒に置かない (ドメインあたり最大 1) | ドメイン間の数の差を maxSkew 以下に |
| `Equal` vs `Exists`              | key と value が一致                                 | key があれば                        |

## 試験のポイント

### 速く解くコマンド

```bash
kubectl label node <node> key=value
kubectl label node <node> key-
kubectl taint node <node> key=value:NoSchedule
kubectl taint node <node> key=value:NoSchedule-
kubectl get nodes --show-labels
kubectl describe node <node> | grep -A3 Taints
kubectl create priorityclass <name> --value=1000
kubectl describe pod <pod> | grep -A5 Events      # FailedScheduling の理由
```

- affinity の YAML は覚えずに、ドキュメント「Assigning Pods to Nodes」からコピー
- toleration の `effect` を省くと、その key のすべての effect を許可
- Pending の原因は FailedScheduling メッセージの「N node(s) ...」の項目を 1 つずつ読めばいい

### kubectl explain

```bash
kubectl explain pod.spec.affinity.nodeAffinity
kubectl explain pod.spec.tolerations
kubectl explain pod.spec.topologySpreadConstraints
kubectl explain priorityclass
```

## 参考ドキュメント

- [Kubernetes Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
