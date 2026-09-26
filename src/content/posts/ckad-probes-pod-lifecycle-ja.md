---
title: "CKAD 概念ノート: Probe と Pod lifecycle"
description: "Pod phase、condition、container state、restartPolicy を先に整理し、liveness・readiness・startup probe が失敗したときにそれぞれ何が起きるのかを公式ドキュメントに沿って比較します。"
pubDatetime: 2026-09-26T12:03:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "probe", "pod-lifecycle"]
order: 4
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## Pod phase

`status.phase` は、Pod が lifecycle のどのあたりにいるかを示す要約値。コンテナ・Pod の状態をすべて表す state machine ではない、と公式ドキュメントもはっきり書いている。

| phase       | 意味                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Pending`   | クラスタは Pod を受け付けたが、コンテナの一つ以上がまだ実行準備前。スケジューリング待ち、イメージのダウンロード時間を含む |
| `Running`   | ノードに bind され、コンテナがすべて作成された。少なくとも一つが実行中、または起動・再起動中                              |
| `Succeeded` | すべてのコンテナが正常終了し、再起動しない                                                                                |
| `Failed`    | すべてのコンテナが終了し、一つ以上が失敗 (non-zero exit またはシステムによる終了)、自動再起動の対象でもない               |
| `Unknown`   | Pod の状態を取得できない。普通はノードとの通信の問題                                                                      |

`kubectl get pod` の `STATUS` 列に出る `CrashLoopBackOff` や `Terminating` は phase ではない。kubectl が見せる表示用の値で、phase は Pod API のフィールド。

## Pod conditions

`status.conditions` は、Pod が通過した、またはまだ通過していない条件のリスト。kubelet が管理するもののうち probe と直接関係するもの:

| condition                   | `True` になるタイミング                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `PodScheduled`              | ノードにスケジュールされた                                               |
| `PodReadyToStartContainers` | sandbox の作成とネットワーク設定が完了 (beta、デフォルト有効)            |
| `Initialized`               | init container がすべて正常終了                                          |
| `ContainersReady`           | Pod のすべてのコンテナが ready                                           |
| `Ready`                     | リクエストを受けられる。マッチする Service の load balancing pool に入る |

各 condition には `status` (`True`/`False`/`Unknown`)、`lastTransitionTime`、`reason`、`message` などが付く。`readinessGates` でカスタム condition を足すと、コンテナがすべて ready で、かつ gate の condition もすべて `True` のときだけ Pod が ready になる。

## Container state

コンテナごとの state は `Waiting`、`Running`、`Terminated` の三つ。`kubectl describe pod <name>` で確認する。

- `Waiting`: `Running` でも `Terminated` でもない状態。イメージの pull や Secret の適用など、起動に必要な作業の途中。`Reason` フィールドが一緒に表示される
- `Running`: 問題なく実行中。`postStart` hook があったなら、それはもう終わっている
- `Terminated`: 実行を始めて、完了したか失敗した状態。reason、exit code、開始・終了時刻が見える。`preStop` hook はこの状態に入る前に実行される

## restartPolicy

Pod の `spec.restartPolicy`。値は `Always` (デフォルト)、`OnFailure`、`Never`。app コンテナと通常の init container に適用される。

| exit code       | `Always` | `OnFailure`  | `Never`      |
| --------------- | -------- | ------------ | ------------ |
| 0 (成功)        | 再起動   | 再起動しない | 再起動しない |
| non-zero (失敗) | 再起動   | 再起動       | 再起動しない |

- 再起動の間隔は exponential backoff: 10s、20s、40s ... 最大 300s (5 分)。10 分間問題なく動くと backoff はリセット
- backoff がかかっている間、kubectl に表示されるのが `CrashLoopBackOff`
- liveness/startup probe の失敗も `CrashLoopBackOff` の原因になりうる
- sidecar container (`initContainers` の中でコンテナ単位の `restartPolicy: Always` を指定したもの) は Pod の `restartPolicy` を無視して常に再起動
- ワークロードごとの制約: Deployment は `Always` のみ、Job は `OnFailure` か `Never` のみ

## Probe の種類

|                | startup probe                                     | liveness probe                                    | readiness probe                                                                                              |
| -------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 確認するもの   | アプリケーションの起動が終わったか                | コンテナを生かし続けるべきか                      | トラフィックを受けてよいか                                                                                   |
| 実行タイミング | 起動時のみ。成功したら終わり                      | 定期的にずっと (startup probe があればその成功後) | コンテナの lifecycle の間ずっと定期的に (startup probe があればその成功後)                                   |
| 失敗時         | kubelet がコンテナを kill、`restartPolicy` を適用 | kubelet がコンテナを kill、`restartPolicy` を適用 | コンテナを not ready にし、Pod の `Ready` condition が `False`、EndpointSlice から Pod IP を外す。再起動なし |
| 主な用途       | 起動が遅いコンテナ                                | deadlock のように動いてはいるが先に進めない状態   | ウォームアップ、一時的な過負荷、バックエンド依存の確認                                                       |

### startup probe があると何が変わるか

startup probe が成功するまで liveness と readiness の probe は実行されない。liveness・readiness の `initialDelaySeconds` も startup probe の成功後から数える。

起動にかかる時間が `initialDelaySeconds + failureThreshold × periodSeconds` より長いなら startup probe を使う、というのが公式ドキュメントの推奨。liveness probe と同じ endpoint を見るようにして、`failureThreshold` を多めに取る。liveness 側のデフォルト値はいじらない。

### liveness probe は readiness を待つのか

待たない。二つの probe は互いの成功に依存しない。liveness を遅らせて始めたいなら `initialDelaySeconds` か startup probe を使う。

### probe を定義しなかったら

その probe の結果は常に `Success` とみなされる。ただし readiness probe は、定義されていれば initial delay が過ぎるまで `Failure`。だから readiness probe がある Pod はトラフィックなしで起動し、probe が成功してからトラフィックを受け始める。

### liveness probe を間違って設定すると

公式ドキュメントが caution で警告している部分。liveness probe は本当に復旧不能な状態 (deadlock など) のときだけ失敗するべき。負荷が高いときに liveness が失敗すると、コンテナが次々に再起動し、残った Pod に負荷が集中する cascading failure につながる。

問題があるとプロセスが自分で落ちる作りなら、liveness probe がなくても kubelet が `restartPolicy` どおりに処理する。よくあるパターンは、readiness と同じ軽い HTTP endpoint を使いつつ liveness 側の `failureThreshold` を高めにすること。そうすると kill の前に not ready の状態がしばらく続く。

## Probe のハンドラ

一つの probe に次の四つのうちちょうど一つを指定する。

| ハンドラ    | 成功の条件                                                   | メモ                                                                                  |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `exec`      | コンテナ内でコマンドを実行し、exit code 0                    | 実行のたびにプロセスを fork する。Pod の密度が高く周期が短いとノードの CPU の負担に   |
| `httpGet`   | Pod IP に GET し、ステータスコードが 200 以上 400 未満       | `path` のデフォルトは `/`、`scheme` のデフォルトは `HTTP`。HTTPS は証明書を検証しない |
| `tcpSocket` | 指定ポートへの TCP 接続が成立                                | 接続はノードから行う。`host` に Service 名を入れても kubelet は名前解決できない       |
| `grpc`      | gRPC Health Checking Protocol の応答の `status` が `SERVING` | v1.27 で stable。`port` 必須、named port は不可                                       |

結果は `Success`、`Failure`、`Unknown`。`Unknown` は診断自体が失敗した場合なので、何もせず次のチェックに進む。

`httpGet` と `tcpSocket` の `port` には、数字の代わりに `ports[].name` (named port) を使える。

## タイミングのフィールド

| フィールド                      | デフォルト                     | 最小値 | 意味                                                                                                         |
| ------------------------------- | ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ |
| `initialDelaySeconds`           | 0                              | 0      | コンテナ起動から最初の probe までの待ち時間                                                                  |
| `periodSeconds`                 | 10                             | 1      | probe の周期                                                                                                 |
| `timeoutSeconds`                | 1                              | 1      | probe のタイムアウト                                                                                         |
| `successThreshold`              | 1                              | 1      | 失敗の後に成功とみなすための連続成功回数。liveness・startup は必ず 1                                         |
| `failureThreshold`              | 3                              | 1      | 連続失敗がこの回数に達するとチェック全体が失敗                                                               |
| `terminationGracePeriodSeconds` | Pod の値を継承 (未指定なら 30) | 1      | probe の失敗でコンテナを落とすとき、SIGKILL までの待ち時間。readiness probe には設定不可 (API server が拒否) |

startup probe が許す最大の起動時間は `failureThreshold × periodSeconds`。`failureThreshold: 30`、`periodSeconds: 10` なら 300 秒。

## 例

### 三つの probe を一緒に使う Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: probe-demo
spec:
  containers:
    - name: app
      image: registry.k8s.io/e2e-test-images/agnhost:2.40
      args: ["liveness"]
      ports:
        - name: http
          containerPort: 8080
      startupProbe:
        httpGet:
          path: /healthz
          port: http
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
        failureThreshold: 3
      readinessProbe:
        tcpSocket:
          port: 8080
        periodSeconds: 5
```

- 起動後最大 300 秒まで startup probe が `/healthz` を見る。一度成功すると liveness・readiness に引き継がれる
- イメージと `args` は公式ドキュメントの HTTP liveness の例から持ってきたもの。このイメージの `/healthz` は最初の 10 秒だけ 200 を返し、その後は 500 を返す。だからこの Pod が probe の失敗で再起動を繰り返すのは正常。v1.35 の kind クラスタで動かすと、約 40 秒後に最初の liveness 失敗による再起動が出て、再起動後は startup probe が最初の 10 秒を逃すので `Startup probe failed ... statuscode: 500` のイベントがたまっていく

### exec、grpc

```yaml
livenessProbe:
  exec:
    command: ["cat", "/tmp/healthy"]
  initialDelaySeconds: 5
  periodSeconds: 5
```

```yaml
livenessProbe:
  grpc:
    port: 2379
  initialDelaySeconds: 10
```

### 確認コマンド

```bash
kubectl describe pod probe-demo      # Events に Unhealthy / Killing、Liveness probe failed のメッセージ
kubectl get pod probe-demo           # READY 0/1、RESTARTS が増えるか
kubectl get pod probe-demo -o jsonpath='{.status.phase}'
kubectl get pod probe-demo -o jsonpath='{.status.conditions}'
kubectl get pod probe-demo -o jsonpath='{.status.containerStatuses[0].state}'
kubectl explain pod.spec.containers.livenessProbe
```

`RESTARTS` は、失敗したコンテナが再び running 状態に戻った瞬間に増える。

## probe と init container

入門記事で例に挙げた「アプリが立ち上がる前に DB への接続を確認したい」という要件は、どちらでも解決できそうに見えて紛らわしい。動くタイミングと失敗したときの結果が違う。

|                    | init container                                                                                            | startup probe                           | readiness probe                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| 定義する場所       | `spec.initContainers`                                                                                     | app コンテナの `startupProbe`           | app コンテナの `readinessProbe`            |
| 実行タイミング     | app コンテナの起動前、順番に一つずつ                                                                      | app コンテナの起動後、成功するまで      | app コンテナの lifecycle の間ずっと        |
| 成功の基準         | 最後まで実行して exit 0                                                                                   | ハンドラが 1 回成功                     | 連続 `successThreshold` 回成功             |
| 失敗時             | Pod の `restartPolicy` どおりに再試行 (`Always` なら `OnFailure` として動作)。`Never` なら Pod 全体が失敗 | コンテナを kill、`restartPolicy` を適用 | トラフィックから外す、コンテナは動き続ける |
| 関連する condition | `Initialized`                                                                                             | -                                       | `ContainersReady`、`Ready`                 |
| probe 対応         | なし (`livenessProbe`、`readinessProbe`、`startupProbe` フィールド不可)                                   | -                                       | -                                          |

- 依存先の準備ができるまでアプリのプロセス自体を立ち上げないなら: init container
- アプリは動かしたまま、依存先が切れたらトラフィックだけ外したいなら: readiness probe。公式ドキュメントも、バックエンドへの依存が強いアプリは liveness でアプリ自身の健全性を、readiness でバックエンドの可用性まで見るように勧めている
- sidecar container は `initContainers` に入るが、動き続けて probe にも対応する

## 試験のポイント

- probe には imperative なフラグがない。`kubectl run app --image=nginx --dry-run=client -o yaml > pod.yaml` で骨組みを作って、probe は YAML で足す
- フィールドの場所は `spec.containers[].livenessProbe`。`spec` の直下ではない
- フィールド名は `livenessProbe`、`readinessProbe`、`startupProbe` と camelCase。ハンドラは `httpGet`、`tcpSocket`、`exec`、`grpc`
- liveness・startup の `successThreshold` に 1 以外を入れてはいけない
- readiness の失敗では再起動は起きない。`RESTARTS` が増えているなら liveness か startup の方を見る
- `restartPolicy: Never` の Pod で liveness が失敗すると、コンテナは kill されて二度と起動しない
- `STATUS` 列の `CrashLoopBackOff` は phase ではない。phase を聞かれたら `-o jsonpath='{.status.phase}'` で確認

### kubectl explain

```bash
kubectl explain pod.spec.containers.livenessProbe          # 共通フィールド: periodSeconds、failureThreshold など
kubectl explain pod.spec.containers.livenessProbe.httpGet  # path、port、httpHeaders
kubectl explain pod.spec.containers.startupProbe
kubectl explain pod.spec.containers.lifecycle              # postStart、preStop
kubectl explain pod.spec.terminationGracePeriodSeconds
kubectl explain pod.spec.restartPolicy                     # Always / OnFailure / Never
```

## 参考ドキュメント

- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
