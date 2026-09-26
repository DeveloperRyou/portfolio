---
title: "CKAD 概念ノート: ワークロードリソースの選び方"
description: "Deployment、StatefulSet、DaemonSet、Job、CronJob がそれぞれ何を保証するのか、いつどれを選ぶのかを公式ドキュメントに沿って比較します。"
pubDatetime: 2026-09-26T12:04:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  [
    "kubernetes",
    "ckad",
    "deployment",
    "statefulset",
    "daemonset",
    "job",
    "cronjob",
  ]
order: 5
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 選ぶ基準

| 問い                                                                                                | 選択        |
| --------------------------------------------------------------------------------------------------- | ----------- |
| 状態を持たない replica を必要な数だけ、ローリングアップデート・ロールバックが必要                   | Deployment  |
| Pod ごとに固定の名前・DNS、Pod ごとの専用 PersistentVolume、順序のあるデプロイ・スケール            | StatefulSet |
| すべてのノード (または条件に合うノード) に Pod を一つずつ。ログ収集、ノード監視、ストレージデーモン | DaemonSet   |
| 最後まで実行し、成功回数を数える必要がある処理                                                      | Job         |
| バックアップやレポート生成のように、決まったスケジュールで繰り返す処理                              | CronJob     |

StatefulSet のドキュメントは、固定の identifier や順序の保証が要らないなら Deployment か ReplicaSet を使え、と書いている。DaemonSet のドキュメントも、replica 数の調整とロールアウトが大事なら Deployment、どのノードに立つかが大事なら DaemonSet と区別している。

## Deployment と ReplicaSet

Deployment は Pod と ReplicaSet の宣言的な更新を提供する。望む状態を書けば、Deployment controller が実際の状態をそちらに合わせていく。

- 構造: Deployment → ReplicaSet → Pod。ReplicaSet の名前と Pod ラベルの `pod-template-hash` は Deployment controller が付ける
- Deployment が所有する ReplicaSet は直接いじらない
- ロールアウトは `.spec.template` が変わったときだけ起きる。イメージや template のラベルの変更はロールアウト、`replicas` の変更 (スケール) はロールアウトではない
- ロールアウトのたびに新しい ReplicaSet ができて revision が上がる。古い ReplicaSet は `.spec.revisionHistoryLimit` (デフォルト 10) だけ残る。0 だとロールバック不可
- `apps/v1` では `.spec.selector` は必須で、作成後は変更できない。`.spec.template.metadata.labels` と一致していないと API が受け付けない
- template の `restartPolicy` は `Always` のみ

### 更新戦略

| `.spec.strategy.type`        | 動作                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `RollingUpdate` (デフォルト) | 新しい ReplicaSet を増やし、古いものを減らしながら少しずつ入れ替える |
| `Recreate`                   | 既存の Pod をすべて終了してから新しい Pod を作る                     |

`RollingUpdate` の細かい設定:

- `maxUnavailable`: 更新中に使えない Pod の最大数。デフォルト 25%、パーセントは切り捨て
- `maxSurge`: 望む数を超えて作れる Pod の最大数。デフォルト 25%、パーセントは切り上げ
- 両方 0 にはできない

## StatefulSet

StatefulSet は Pod ごとに固定の identity を保つ。次のどれか一つ以上が必要なときに使う。

- 固定で一意なネットワーク identifier
- 固定の永続ストレージ
- 順序のあるデプロイとスケール
- 順序のある自動ローリングアップデート

ここでの「固定」は、Pod が再スケジュールされても維持されるという意味。

### identity

- Pod 名: `$(statefulset name)-$(ordinal)`。replica 3 なら `web-0`、`web-1`、`web-2`
- DNS: headless Service (`clusterIP: None`) がドメインを管理する。Pod ごとの名前は `$(podname).$(service name).$(namespace).svc.cluster.local`
- headless Service は StatefulSet が作ってくれない。自分で作って `.spec.serviceName` に名前を書く
- ストレージ: `volumeClaimTemplates` の項目ごとに、Pod ごとの PersistentVolumeClaim が一つずつできる。Pod が別のノードに再スケジュールされても同じ PVC をマウント

### 順序の保証

- 作成は 0 から N-1 まで順番に、削除は N-1 から 0 まで逆順
- 次の Pod を作る前に、それより前の番号の Pod がすべて Running かつ Ready でなければならない
- この動作が `.spec.podManagementPolicy: OrderedReady` (デフォルト)。`Parallel` なら待たずに同時に作成・削除する。一意な identity の保証はそのまま

### 更新と削除

- `.spec.updateStrategy.type`: `RollingUpdate` (デフォルト) は最も大きい ordinal から小さい方へ一つずつ削除して作り直す。`OnDelete` は自動更新をせず、ユーザーが Pod を削除して初めて新しい template で作り直す
- `rollingUpdate.partition` を指定すると、その値以上の ordinal の Pod だけ更新
- StatefulSet を削除・スケールダウンしてもボリュームは消さない。`.spec.persistentVolumeClaimRetentionPolicy` の `whenDeleted`、`whenScaled` のデフォルトが `Retain`
- StatefulSet を削除するとき、Pod の終了順序は保証されない。順番に落としたいなら先に replicas を 0 にスケール

## DaemonSet

DaemonSet は、すべての (または一部の) ノードで Pod のコピーが一つずつ動くことを保証する。

- ノードが追加されれば Pod も追加、ノードが外れればその Pod は garbage collection。DaemonSet を削除すると作った Pod も片付く
- 一部のノードだけ: `.spec.template.spec.nodeSelector` か `affinity` を指定。どちらもなければ全ノード
- `node.kubernetes.io/unschedulable:NoSchedule` のような toleration が自動で付くので、unschedulable 扱いのノードにも立てる
- template の `restartPolicy` は `Always` か空 (デフォルト `Always`) でなければならない
- `.spec.selector` は作成後に変更不可、template のラベルと一致が必要
- `.spec.updateStrategy.type`: `RollingUpdate` (デフォルト) または `OnDelete`
- replica 数のフィールドがない。数は条件に合うノードの数で決まる

## Job

Job は Pod を一つ以上作り、指定した数だけ正常終了するまで再試行する。成功回数が満たされたら Job は完了。

- template の `restartPolicy` は `Never` か `OnFailure` のみ
- `.spec.template` が `.spec` の唯一の必須フィールド。`.spec.selector` はほぼ指定しない

### completions と parallelism

| 種類           | 設定                                               | 完了条件                         |
| -------------- | -------------------------------------------------- | -------------------------------- |
| 非並列         | 両方空 (どちらもデフォルト 1)                      | Pod が一つ正常終了               |
| 固定の完了回数 | `completions` を正の数に。`parallelism` は空なら 1 | 成功した Pod が `completions` 個 |
| work queue     | `completions` を空にして `parallelism` だけ指定    | Pod が一つでも成功し、すべて終了 |

- `parallelism: 0` なら事実上の一時停止
- 固定の完了回数の Job では、実際の同時実行数は残りの completions を超えない
- `.spec.completionMode`: `NonIndexed` (デフォルト) か `Indexed`。`Indexed` なら Pod ごとに 0 から `completions-1` までのインデックスが付き、コンテナ内では `JOB_COMPLETION_INDEX` 環境変数で読める。インデックスごとに成功した Pod が一つずつあれば完了

### 失敗の扱い

- `.spec.backoffLimit`: Job を失敗とみなす前の再試行回数。デフォルト 6 (`backoffLimitPerIndex` を使うとデフォルトが変わる)
- 失敗した Pod は 10s、20s、40s ... 最大 6 分の間隔で作り直される
- `restartPolicy: OnFailure` なら Pod はノードに残り、コンテナだけ再実行。`Never` なら Pod が失敗し、Job controller が新しい Pod を作る
- `OnFailure` は backoffLimit に達すると Pod が終了してログを見にくくなる。ドキュメントはデバッグ時は `Never` を勧めている
- `.spec.activeDeadlineSeconds`: Job 全体の実行時間の上限。`backoffLimit` より優先。超えると実行中の Pod をすべて終了し、`reason: DeadlineExceeded` で失敗
- `activeDeadlineSeconds` は Job spec と Pod spec の両方にあるフィールドなので、場所を間違えやすい
- 失敗で終わった Job は自動では再開しない

### 後片付け

- 完了した Job と Pod はデフォルトで残る。ログや状態を見られるようにするため
- `kubectl delete job <name>` で消すと Pod も一緒に消える
- `.spec.ttlSecondsAfterFinished` を指定すると、終わってからその時間が経つと自動削除

## CronJob

CronJob は繰り返しのスケジュールに従って Job を作る。crontab の一行に相当。

- `.spec.schedule` (必須): Cron 形式 `分 時 日 月 曜日`。`0 3 * * 1` は毎週月曜 03 時。`*/2` のような step、`@monthly` のようなマクロも使える
- `.spec.jobTemplate` (必須): Job spec と同じスキーマで、`apiVersion`・`kind` だけがない
- `.spec.timeZone`: 指定しなければ kube-controller-manager のローカルタイムゾーン基準。`schedule` の中に `CRON_TZ` や `TZ` を書くと validation エラー
- 名前は 52 文字以下。controller が Job 名に 11 文字を付け足し、Job 名の上限が 63 文字だから

### 同時実行と遅延

| `.spec.concurrencyPolicy` | 前の Job がまだ実行中のとき          |
| ------------------------- | ------------------------------------ |
| `Allow` (デフォルト)      | 同時に実行                           |
| `Forbid`                  | 今回の実行をスキップ                 |
| `Replace`                 | 実行中の Job を新しい Job に置き換え |

- 同じ CronJob が作った Job 同士にだけ適用。別の CronJob の Job は常に同時実行できる
- `.spec.startingDeadlineSeconds`: 予定時刻を逃したとき、遅れてでも開始できる上限 (秒)。超えるとその回はスキップされ失敗扱い。10 秒未満だと controller が 10 秒ごとに確認するため、まったくスケジュールされないことがある
- 逃したスケジュールが 100 回を超えると Job を開始せずにエラーを残す
- `.spec.suspend: true`: 以降の実行を止める。すでに始まった Job には影響なし
- `.spec.successfulJobsHistoryLimit` のデフォルトは 3、`.spec.failedJobsHistoryLimit` は 1
- CronJob を修正しても、すでに始まった Job はそのまま。変更は次の新しい Job から
- 一回のスケジュールで Job が二つできたり一つもできなかったりすることがあるので、Job は idempotent に作る

## 例

### imperative で骨組みを作る

```bash
kubectl create deployment web --image=nginx --replicas=3
kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle 'print bpi(2000)'
kubectl create cronjob hello --image=busybox:1.28 --schedule="*/1 * * * *" -- date
kubectl create job hello-manual --from=cronjob/hello

# YAML に書き出して修正
kubectl create job pi --image=perl:5.34.0 --dry-run=client -o yaml > job.yaml
```

`kubectl create` には `statefulset`、`daemonset` のサブコマンドがない。YAML を直接書くか、Deployment の YAML を書き出して直す。DaemonSet にするときは `kind` を変え、`replicas` と `strategy` を消す (DaemonSet のフィールド名は `updateStrategy`)。

### Deployment のロールアウト

```bash
kubectl set image deployment/web nginx=nginx:1.16.1
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=2
kubectl rollout pause deployment/web
kubectl rollout resume deployment/web
kubectl scale deployment/web --replicas=5
kubectl annotate deployment/web kubernetes.io/change-cause="image updated to 1.16.1"
```

`CHANGE-CAUSE` は `kubernetes.io/change-cause` annotation から来る。`--record` フラグは deprecated。

### Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: batch-demo
spec:
  completions: 5
  parallelism: 2
  backoffLimit: 4
  activeDeadlineSeconds: 120
  ttlSecondsAfterFinished: 100
  template:
    spec:
      containers:
        - name: worker
          image: busybox:1.28
          command: ["sh", "-c", "echo done"]
      restartPolicy: Never
```

### CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "*/5 * * * *"
  timeZone: "Etc/UTC"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 200
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: hello
              image: busybox:1.28
              command: ["/bin/sh", "-c", "date; echo Hello"]
          restartPolicy: OnFailure
```

### StatefulSet と headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  clusterIP: None
  selector:
    app: nginx
  ports:
    - port: 80
      name: web
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: nginx
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: registry.k8s.io/nginx-slim:0.24
          ports:
            - containerPort: 80
              name: web
          volumeMounts:
            - name: www
              mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
    - metadata:
        name: www
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

`storageClassName` を空にすると default StorageClass が使われる。

### DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
spec:
  selector:
    matchLabels:
      app: node-agent
  template:
    metadata:
      labels:
        app: node-agent
    spec:
      nodeSelector:
        kubernetes.io/os: linux
      containers:
        - name: agent
          image: busybox:1.28
          command: ["sh", "-c", "sleep 3600"]
```

## 紛らわしいものの比較

|                            | Deployment                             | StatefulSet                                  | DaemonSet                                    | Job                                                       | CronJob                     |
| -------------------------- | -------------------------------------- | -------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | --------------------------- |
| apiVersion                 | `apps/v1`                              | `apps/v1`                                    | `apps/v1`                                    | `batch/v1`                                                | `batch/v1`                  |
| 数の決まり方               | `replicas`                             | `replicas`                                   | 条件に合うノードの数                         | `completions`、`parallelism`                              | スケジュールごとに Job 1 つ |
| Pod 名                     | `名前-hash-ランダム`                   | `名前-ordinal` で固定                        | ランダム                                     | ランダム (`Indexed` なら hostname が `名前-インデックス`) | CronJob 名ベース            |
| ストレージ                 | 共有またはなし                         | Pod ごとの PVC                               | 普通はノードローカル                         | -                                                         | -                           |
| 更新戦略のフィールド       | `strategy`: `RollingUpdate`/`Recreate` | `updateStrategy`: `RollingUpdate`/`OnDelete` | `updateStrategy`: `RollingUpdate`/`OnDelete` | -                                                         | 修正は次の Job から適用     |
| 許可される `restartPolicy` | `Always`                               | `Always`                                     | `Always`                                     | `OnFailure`、`Never`                                      | `OnFailure`、`Never`        |
| imperative な作成          | 可能                                   | 不可                                         | 不可                                         | 可能                                                      | 可能                        |

- Deployment は `strategy`、StatefulSet・DaemonSet は `updateStrategy`。フィールド名からして違う
- `Recreate` が保証するのは、アップグレード時に既存の Pod の終了を先にすることだけ。Pod を手で消すと ReplicaSet がすぐに代わりの Pod を作る。「最大一つ」の保証が必要なら StatefulSet を見よ、というのがドキュメントの説明
- Job の `restartPolicy` は Pod に適用されるもの。Job 自体が失敗したら再実行はされない

## 試験のポイント

- まず imperative で作れるもの (Deployment、Job、CronJob) は `kubectl create ... --dry-run=client -o yaml` で骨組みを作り、必要なフィールドだけ足す
- StatefulSet、DaemonSet には imperative なコマンドがない → ドキュメントの例をコピーして、フィールドは下の explain で確認
- CronJob は `jobTemplate.spec.template.spec` までインデントが三段なので、`restartPolicy` の位置をよく間違える
- Job の template で `restartPolicy` を書き忘れたり `Always` を入れたりすると拒否される
- `completions` と `parallelism` を取り違えない。成功の総数が `completions`、同時実行数が `parallelism`
- `activeDeadlineSeconds` は Job の `spec` の直下に置く。Pod template の spec にも同じフィールドがある
- `kubectl rollout undo` は一つ前の revision へ。特定の revision は `--to-revision`
- CronJob を手動で動かして確認するなら `kubectl create job <name> --from=cronjob/<cronjob>`
- selector は Deployment・DaemonSet とも作成後に変えられない。間違えたら削除して作り直す

### kubectl explain

```bash
kubectl explain job.spec                                                   # completions、parallelism、backoffLimit、activeDeadlineSeconds
kubectl explain cronjob.spec                                               # schedule、concurrencyPolicy、history limit
kubectl explain cronjob.spec.jobTemplate.spec.template.spec.restartPolicy  # 深い位置を一度に確認
kubectl explain statefulset.spec                                           # serviceName、volumeClaimTemplates
kubectl explain daemonset.spec.updateStrategy
```

## 参考ドキュメント

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- [Perform a Rolling Update on a DaemonSet](https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/)
- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Pod Lifecycle: Container restarts](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
- [kubectl create deployment](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_deployment/)
- [kubectl create job](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_job/)
- [kubectl create cronjob](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_cronjob/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
