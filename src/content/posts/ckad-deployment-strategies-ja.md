---
title: "CKAD 概念ノート: Rolling update とデプロイ戦略"
description: "Deployment の RollingUpdate・Recreate の動作、maxSurge・maxUnavailable の計算、rollout コマンド、そして Service selector と replica の比率で作る blue/green・canary デプロイを公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:05:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  ["kubernetes", "ckad", "deployment", "rolling-update", "canary", "blue-green"]
order: 6
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### Deployment、ReplicaSet、revision

Deployment は Pod を直接管理しない。`.spec.template` が変わると新しい ReplicaSet を作り、新しい方を scale up、古い方を scale down しながら Pod を入れ替える。

- ReplicaSet 名のハッシュと Pod ラベルの `pod-template-hash` の値は同じ。Pod template をハッシュした値で、Deployment controller が ReplicaSet の selector・Pod template のラベル・既存の Pod に付けて、ReplicaSet 同士で Pod が重ならないようにしている
- revision history は古い ReplicaSet に保存される。ReplicaSet が消えると、その revision には rollback できない
- `.spec.revisionHistoryLimit` のデフォルトは 10。0 にすると replica 0 の古い ReplicaSet をすべて片付けるので undo できない

### rollout が始まる条件

公式ドキュメントの表現そのままで "if and only if the Deployment's Pod template (`.spec.template`) is changed"。

| 変更                                         | rollout / 新しい revision |
| -------------------------------------------- | ------------------------- |
| container image の変更 (`kubectl set image`) | O                         |
| template の label、env、resources などの変更 | O                         |
| `kubectl scale` での replicas の変更         | X                         |
| Deployment 自体の annotation の変更          | X                         |

だから rollback も Pod template の部分だけを戻す。replicas は undo の対象ではない。

### 二つの strategy

|                            | `RollingUpdate` (デフォルト)                                 | `Recreate`                                     |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| 動作                       | 古い ReplicaSet を少しずつ減らし、新しい ReplicaSet を増やす | 古い Pod をすべて終了してから新しい Pod を作る |
| ダウンタイム               | `maxUnavailable` の範囲内で可用性を維持                      | 古い Pod がすべて消える区間がある              |
| 二つのバージョンの同時実行 | あり                                                         | アップグレード中はなし                         |
| 細かい設定                 | `maxSurge`、`maxUnavailable`                                 | なし                                           |

`Recreate` の「先に終了、後から作成」という保証はアップグレードにしか当てはまらない。Pod を手で消すと、ReplicaSet はすぐに代わりの Pod を作る (古い Pod が Terminating でも)。「同時に最大 N 個」がどうしても必要なら、ドキュメントは StatefulSet を勧めている。

## 動作の仕組み

### maxSurge / maxUnavailable

どちらも `.spec.strategy.rollingUpdate` の下の任意フィールド。整数 (`5`) か、望む Pod 数に対するパーセント (`10%`)。

| フィールド       | 意味                                     | パーセントの換算 | デフォルト |
| ---------------- | ---------------------------------------- | ---------------- | ---------- |
| `maxSurge`       | `replicas` を超えて追加で作れる Pod の数 | 切り上げ         | 25%        |
| `maxUnavailable` | 更新中に unavailable でもよい Pod の数   | 切り捨て         | 25%        |

- 両方 0 は不可 (片方が 0 ならもう片方は 0 以外)
- デフォルト値なら「最低 75% が available、最大 125% が存在」

`replicas: 10`、デフォルト値での計算:

```text
maxSurge       = ceil(10 * 0.25)  = 3  -> Pod は全体で最大 13 個
maxUnavailable = floor(10 * 0.25) = 2  -> available な Pod は最低 8 個
```

よく使う組み合わせ:

| 設定                               | 効果                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `maxSurge: 1`、`maxUnavailable: 0` | 新しい Pod が ready になってから古い Pod を減らす。容量は減らないが、追加のリソースが必要 |
| `maxSurge: 0`、`maxUnavailable: 1` | 古い Pod を先に一つ減らしてから新しく作る。追加のリソースは不要だが、容量が一時的に減る   |

### available の判定と進行期限

- `.spec.minReadySeconds` (デフォルト 0): 新しい Pod がこの時間、container がクラッシュせずに ready であって初めて available とみなされる。rollout の速度に直接影響
- `.spec.progressDeadlineSeconds` (デフォルト 600): この時間進展がなければ condition が `Progressing=False`、`reason: ProgressDeadlineExceeded`。controller が rollback してくれるわけではなく、状態を報告するだけ。`minReadySeconds` より大きくなければならない
- `kubectl rollout status` は完了時に exit code 0、deadline 超過時に 0 以外 → スクリプトで判定できる

### 更新中にさらに更新すると

rollover。進行中に template をもう一度変えると、また新しい ReplicaSet を作り、直前まで増やしていた ReplicaSet も古いものとして減らし始める。前の rollout が終わるのを待たない。

rollout の途中 (進行中または pause 中) に scale すると proportional scaling。増えた replica をアクティブな ReplicaSet に比率で配分する。

### pause / resume

- `.spec.paused: true` の間は、template を変えても rollout は起きない。複数の変更をまとめて一度に rollout したいときに使う
- pause 中でも scale はできる
- **pause 中は rollback できない**。先に resume

## 例 (YAML・kubectl)

### RollingUpdate の設定

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

`Recreate` に変えるときは `rollingUpdate` のブロックを消して `type: Recreate` だけ残す。

### rollout コマンドの流れ

```shell
# image を変更 → rollout 開始
kubectl set image deployment/web web=nginx:1.28

# 進行状況 (完了まで待つ)
kubectl rollout status deployment/web

# history。CHANGE-CAUSE は kubernetes.io/change-cause annotation からコピーされる
kubectl annotate deployment/web kubernetes.io/change-cause="image updated to 1.28"
kubectl rollout history deployment/web
kubectl rollout history deployment/web --revision=2

# rollback
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=1

# 複数の変更をまとめて一度に
kubectl rollout pause deployment/web
kubectl set image deployment/web web=nginx:1.29
kubectl set resources deployment/web -c=web --limits=memory=256Mi
kubectl rollout resume deployment/web

# ReplicaSet の入れ替わりを確認
kubectl get rs -l app=web
```

`--record` フラグは deprecated。change-cause が必要なら annotation で自分で入れる。

undo で戻した revision は history 上で新しい番号になる。上の順番どおりに打つと、最初の `undo` で revision 1 が 3 に移るので、次の行の `--to-revision=1` は `unable to find specified revision 1 in history` で失敗する。undo の前に `rollout history` で番号を確認すること。

### blue/green: Service selector の切り替え

Service は selector に合う Pod を探し続けて EndpointSlice を更新する。だから selector の値を一つ変えるだけで、トラフィックの行き先が丸ごと移る。

Deployment を二つ同時に立て、`version` ラベルで区別:

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

切り替えも戻しも、selector の値を変えるだけ。

```shell
kubectl patch service web -p '{"spec":{"selector":{"version":"green"}}}'
kubectl get endpointslices -l kubernetes.io/service-name=web

# 問題があれば blue に戻す
kubectl patch service web -p '{"spec":{"selector":{"version":"blue"}}}'
```

- 切り替える前に green の Pod がすべて ready か確認
- 切り替えが落ち着いたら、blue の Deployment は scale 0 にするか削除

### canary: replica の比率

`docs/concepts/workloads/management` の canary の例と同じ構造。共通ラベルは同じにして `track` ラベルだけ変え、Service は `track` を外して選択する。

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
    app: web # track なし → stable、canary の両方を選択
  ports:
    - port: 80
```

- stable 3 : canary 1 → トラフィックはおおよそ 3:1 (ドキュメントの例どおりの比率)
- 比率は `kubectl scale deployment/web-canary --replicas=2` のように調整
- 確信が持てたら stable の image を新しいバージョンに上げ、canary の Deployment を削除
- stable と canary の `selector.matchLabels` は互いに重なってはいけない。`track` の値が違うので、二つの ReplicaSet の集合が分かれる

## 紛らわしいものの比較

|                        | RollingUpdate                    | Recreate                         | blue/green                                    | canary                                     |
| ---------------------- | -------------------------------- | -------------------------------- | --------------------------------------------- | ------------------------------------------ |
| 実装                   | Deployment 1 つ、strategy の設定 | Deployment 1 つ、strategy の設定 | Deployment 2 つ + Service selector の切り替え | Deployment 2 つ + 共通ラベルを選ぶ Service |
| バージョンの共存       | 入れ替え中だけ                   | なし                             | 両方立っているが、トラフィックは片方          | 両方トラフィックを受ける                   |
| トラフィック比率の制御 | 不可 (進行速度だけ調整)          | 不可                             | 0 か 100                                      | replica 数の比率                           |
| 戻し方                 | `kubectl rollout undo`           | `kubectl rollout undo`           | selector を元に戻す                           | canary を scale 0 / 削除                   |
| 追加のリソース         | `maxSurge` の分                  | なし                             | 丸ごと二セット                                | canary の replica の分                     |

| 紛らわしいペア                  | 違い                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `maxSurge` vs `maxUnavailable`  | 超過して作る上限 (切り上げ) vs 不足を許す上限 (切り捨て)                           |
| revision vs replicas            | revision は template の変更だけを記録。scale は revision を作らず、undo もされない |
| `rollout pause` vs scale 0      | pause は template の変更の反映を止めるだけで、Pod はそのまま動く                   |
| `progressDeadlineSeconds` 超過  | 状態の報告にすぎず、自動 rollback ではない                                         |
| Deployment の `selector` の変更 | `apps/v1` では immutable。変えるなら削除して作り直す                               |

## 試験のポイント

**素早く作るコマンド**

```shell
kubectl create deployment web --image=nginx:1.27 --replicas=3 --dry-run=client -o yaml > web.yaml
kubectl set image deployment/web web=nginx:1.28     # container名=image
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web --to-revision=N
kubectl scale deployment/web --replicas=5
```

- `kubectl create deployment` は `strategy` を受け取らないので、`--dry-run=client -o yaml` で書き出して `strategy` のブロックを手で足す
- `kubectl set image` の左側は container 名。Deployment 名ではない (`kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[*].name}'`)

**kubectl explain**

```bash
kubectl explain deployment.spec.strategy                # type: RollingUpdate / Recreate
kubectl explain deployment.spec.strategy.rollingUpdate  # maxSurge、maxUnavailable のデフォルト値
kubectl explain deployment.spec.revisionHistoryLimit    # rollout history に残る revision 数
kubectl explain deployment.spec.minReadySeconds
kubectl explain service.spec.selector                   # blue/green で切り替える対象
```

## 参考ドキュメント

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Managing Workloads -- Canary deployments](https://kubernetes.io/docs/concepts/workloads/management/#canary-deployments)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
