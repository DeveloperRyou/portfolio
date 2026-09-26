---
title: "CKAD 概念ノート: requests、limits、quota"
description: "requests はスケジューリング、limits は実行中の強制。CPU throttling と OOMKill の違い、QoS class、LimitRange のデフォルト値、namespace 単位の ResourceQuota を公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:08:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "resources", "qos", "resourcequota", "limitrange"]
order: 9
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### リソースの種類と単位

| リソース            | 基本単位 | 表記の例               |
| ------------------- | -------- | ---------------------- |
| `cpu`               | core     | `1`、`0.5`、`500m`     |
| `memory`            | byte     | `128Mi`、`1Gi`、`129M` |
| `ephemeral-storage` | byte     | `2Gi`                  |
| `hugepages-<size>`  | byte     | Linux 専用             |

- CPU: `0.1` = `100m` (100 millicpu)。常に絶対量で、ノードのコア数とは無関係
- memory: `Mi`/`Gi` は 2 のべき乗、`M`/`G` は 10 のべき乗
- 大文字・小文字に注意: memory の `400m` は 0.4 byte。`400Mi` や `400M` のつもりだったことがほとんど

### requests と limits

コンテナごとに `spec.containers[].resources` の下に指定する。

```yaml
resources:
  requests:
    cpu: 250m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

- limit だけ書いて request を書かないと (そして admission の段階でデフォルト値を入れる仕組みがなければ)、limit の値が request にコピーされる
- ノードに余裕があれば、コンテナは request より多く使える。limit より多くは使えない (memory は後述)
- Pod 単位の `spec.resources` で Pod 全体の requests/limits を決める機能もある (beta)。この記事はコンテナ単位で話を進める

## 動作の仕組み

### requests: スケジューリング

scheduler はリソースの種類ごとに、「ノードにすでに配置されたコンテナの request の合計 + 新しい Pod の request」がノードの容量以下のノードだけを選ぶ。実際の使用量は見ない。ノードの実際の CPU・memory の使用量が低くても、request の合計が埋まっていれば配置を拒否する。

合うノードがなければ Pod は `Pending` のまま残り、`FailedScheduling` イベントが作られる。

```bash
kubectl describe pod <pod>          # Events で FailedScheduling を確認
kubectl describe node <node>        # Allocated resources で request/limit の合計を確認
```

### limits: 実行中の強制

Linux ノードでは kubelet とコンテナランタイムが cgroups で limit をかけ、kernel が強制する。CPU と memory で動作が違う。

|                  | CPU limit                                      | memory limit                                                                            |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| 強制の方式       | throttling                                     | OOM kill                                                                                |
| 超えようとすると | kernel が CPU 時間を制限。limit 以上は使えない | limit を超えたコンテナを kernel が終了させることがある                                  |
| タイミング       | 即時 (hard limit)                              | memory pressure を検知したとき。超えた瞬間に死ぬとは限らない (reactive)                 |
| 確認             | 応答が遅くなる、再起動なし                     | `Last State: Terminated`、`Reason: OOMKilled`、`Exit Code: 137`、Restart Count が増える |

limit を超えたコンテナは kubelet が終了させて再起動し、同じ Pod の他のコンテナには影響しない。

### request の超過と eviction

limit とは別に、コンテナが request より多く使っている状態でノードが resource pressure を受けると、その Pod は eviction の候補になる。evict されると Pod のすべてのコンテナが終了し、controller があれば普通は別のノードに新しい Pod を作る。

### QoS class

Kubernetes は Pod ごとにコンテナの requests/limits を見て QoS class を付ける。`kubectl get pod <pod> -o yaml` の `status.qosClass` で確認。

| class        | 条件                                                                                     | eviction の順序 |
| ------------ | ---------------------------------------------------------------------------------------- | --------------- |
| `Guaranteed` | すべてのコンテナに CPU・memory の request と limit があり、それぞれ request = limit      | 最後            |
| `Burstable`  | Guaranteed ではないが、一つ以上のコンテナに CPU か memory の request または limit がある | BestEffort の次 |
| `BestEffort` | どのコンテナにも CPU・memory の request・limit がない                                    | 最初            |

- ノードのリソースが足りなくなると BestEffort -> Burstable -> Guaranteed の順に evict。resource pressure による eviction では、request を超えて使っている Pod だけが候補
- Guaranteed の Pod は、limit を超えるか、より優先度の低い preempt 可能な Pod がノードに残っていない状況にならない限り殺されない
- limit だけ書くと request が limit にコピーされるので、すべてのコンテナが CPU・memory の limit だけを書いても Guaranteed になる

### LimitRange

namespace に置くポリシー。その namespace で作られる Pod・コンテナ・PersistentVolumeClaim 一つ一つの requests/limits を制限する。

できること:

- Pod/コンテナごとの compute リソースの min・max
- PersistentVolumeClaim ごとの storage request の min・max
- request に対する limit の比率 (`maxLimitRequestRatio`)
- 値を書いていないコンテナにデフォルトの request (`defaultRequest`) とデフォルトの limit (`default`) を注入

動作の順序:

1. LimitRange admission controller が、requests/limits のないコンテナにデフォルト値を入れる
2. min/max/ratio の違反を検査。違反すると API server が `403 Forbidden` で拒否

注意点:

- 検査は Pod の admission のときだけ。LimitRange を追加・変更しても既存の Pod はそのまま
- 一つの namespace に LimitRange が二つ以上あると、どのデフォルト値が適用されるかは決まっていない
- デフォルト値同士の整合性は検査しない。たとえば `default.cpu: 500m` の LimitRange で、コンテナが `requests.cpu: 700m` だけを書くと、limit のデフォルト 500m が入って request > limit になり、Pod の作成が失敗する

### ResourceQuota

namespace 全体の合計を制限する。チームごとに namespace を分けて使う環境で、一つのチームがクラスタのリソースを独占しないようにするためのもの。

| 対象             | 例                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| compute の合計   | `requests.cpu`、`requests.memory`、`limits.cpu`、`limits.memory` (`cpu`、`memory` は `requests.*` と同じ) |
| storage の合計   | `requests.storage`、`persistentvolumeclaims`                                                              |
| オブジェクトの数 | `pods`、`services`、`secrets`、`configmaps`、`count/deployments.apps`                                     |

- compute の合計は non-terminal 状態の Pod 全体が基準
- リクエストが quota を超えると `403 Forbidden` で拒否され、メッセージに違反した制約が出る
- `cpu`/`memory` の quota がある namespace では、Pod に該当する requests/limits を必ず書かなければならない。書かないと作成を拒否されることがある。LimitRange でデフォルト値を入れておけば解決
- quota の変更はすでに作られたリソースには影響しない
- quota はノード単位の制限ではない。複数の namespace の Pod が同じノードに載ることがある
- `scopes` で測定対象を絞れる (`BestEffort`、`NotBestEffort`、`Terminating`、`NotTerminating`、`PriorityClass` など)

## 例

### コンテナのリソース

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

→ request != limit なので `Burstable`。CPU・memory とも request と limit を同じにすれば `Guaranteed`。

### 既存のワークロードにリソースを指定

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
      default: # limit のデフォルト値
        cpu: 500m
        memory: 256Mi
      defaultRequest: # request のデフォルト値
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

kubectl describe quota -n dev        # Used / Hard を確認
```

## 紛らわしいものの比較

| 比較                                        | 違い                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| request vs limit                            | スケジューリングの基準 (配置前) vs 実行中の上限 (配置後)                        |
| CPU limit 超過 vs memory limit 超過         | throttling、再起動なし vs OOMKilled、再起動                                     |
| OOMKilled vs eviction                       | limit 超過でコンテナが終了 vs ノードの pressure で Pod 全体が終了               |
| LimitRange vs ResourceQuota                 | オブジェクト一つ単位 (デフォルト値・min・max) vs namespace の合計               |
| LimitRange の `default` vs `defaultRequest` | limit のデフォルト値 vs request のデフォルト値                                  |
| quota の `cpu` vs `limits.cpu`              | `requests.cpu` と同じ vs limit の合計                                           |
| `Guaranteed` vs `Burstable`                 | すべてのコンテナで CPU・memory の request = limit vs それ以外で一つでも指定あり |

## 試験のポイント

### コマンド

- リソースの指定: `kubectl set resources`、または `--dry-run=client -o yaml` で書き出した YAML に `resources` ブロックを追加
- quota: `kubectl create quota <name> --hard=...`
- LimitRange には imperative な作成コマンドがないので YAML で書く
- 確認: `kubectl describe quota`、`kubectl describe limitrange`、`kubectl describe node`、`kubectl describe pod` (OOMKilled、FailedScheduling)
- QoS の確認: `-o jsonpath='{.status.qosClass}'`

### kubectl explain

```bash
kubectl explain pod.spec.containers.resources  # requests、limits
kubectl explain resourcequota.spec             # hard、scopes
kubectl explain limitrange.spec.limits         # default、defaultRequest、max、min
kubectl explain pod.status.qosClass
```

## 参考ドキュメント

- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Configure Quality of Service for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [kubectl set resources](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_resources/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
