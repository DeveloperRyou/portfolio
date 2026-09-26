---
title: "CKAD 概念ノート: マルチコンテナ Pod のパターン"
description: "init container、native sidecar と従来型の sidecar、ambassador・adapter パターン、ephemeral container を公式ドキュメントに沿って比較しました。"
pubDatetime: 2026-09-26T12:02:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "pod", "init-container", "sidecar"]
order: 3
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## Pod の中の container の種類

| 種類                | 定義する場所                                    | いつ実行されるか               | 再起動                | probe |
| ------------------- | ----------------------------------------------- | ------------------------------ | --------------------- | ----- |
| app container       | `spec.containers`                               | init 段階が終わった後、並列    | Pod `restartPolicy`   | 対応  |
| init container      | `spec.initContainers`                           | app より先に、順番に、完了まで | 失敗時に再試行 (後述) | 不可  |
| sidecar (native)    | `spec.initContainers` + `restartPolicy: Always` | 定義順に起動し、その後ずっと   | 常に                  | 対応  |
| ephemeral container | `ephemeralcontainers` subresource               | ユーザーが追加したとき         | しない                | 不可  |

### 共有するもの

- network: Pod IP を一つ共有する。container 同士は `localhost:<port>` で通信でき、その代わりポートが重複してはいけない
- storage: `spec.volumes` に定義した volume を各 container が `volumeMounts` で mount する。受け渡しするファイルには普通 `emptyDir` を使う
- IPC: SystemV semaphore、POSIX shared memory も使える
- process namespace はデフォルトで分離。必要なら process namespace sharing を有効にする

## init container

Pod の起動前に準備作業をする container。ドキュメントが挙げる用途は、Service ができるまで待つ、Git repository を volume に clone する、設定ファイルをテンプレートからレンダリングする、など。

- app とは別のイメージなので、`sed` や `dig` のようなツールを app のイメージに入れなくて済む
- app container からは見えない Secret にアクセスさせられる
- 条件が揃うまで app の起動を止めておく用途に使う

### 動作の流れ

1. kubelet は network と storage の準備ができてから、spec に書かれた順に init container を実行する
2. 各 init container が成功 (exit 0) しないと次のものは始まらない
3. すべて終わると app container を起動する

失敗したとき:

- Pod `restartPolicy` が `Never`: Pod 全体が失敗扱い
- `OnFailure`: その init container を再試行
- `Always`: init container には `OnFailure` として適用される

その他のルール:

- init が終わるまで Pod phase は `Pending`、condition `Initialized` は false。`kubectl get` の STATUS には `Init:0/2` のように表示される
- 通常の init container には `lifecycle`、`livenessProbe`、`readinessProbe`、`startupProbe` を書けない。書くと API server が `Forbidden: may not be set for init containers without restartPolicy=Always` で拒否する
- 再実行されることがあるので idempotent に書く。`emptyDir` に書き込むファイルがすでにあるかもしれない
- 実行中の Pod では init container の `image` だけ変更でき、変えても Pod は再起動しない
- container 名は init・app 全体で一意でなければならない
- init container のポートは Service に紐付かない

### リソースの計算

- init container の中で最も大きい request/limit = effective init request/limit
- Pod の effective request/limit = max(app・sidecar container の合計, effective init の値) + pod overhead
- スケジューリングはこの effective な値で行われるので、init が大きいと初期化のときにしか使わないリソースも予約される

## sidecar

メインのアプリの隣で、ログ収集、モニタリング、データ同期のような補助機能を担う container。アプリのコードを変えずに機能を足すのが目的です。

### native sidecar

`SidecarContainers` feature gate (v1.29 からデフォルト有効) で入った方式。`initContainers` の項目に `restartPolicy: Always` を付けると sidecar になります。

- init container と同じく順序が保証される。sidecar が `started` になると次の init container が始まる。`startupProbe` があれば、それが成功して初めて `started`
- 起動後は Pod が終わるまで動き続ける。終了すると Pod `restartPolicy` に関係なく再起動
- probe に対応。`readinessProbe` の結果は Pod の ready 判定に含まれる
- Pod 終了時: メイン container が完全に止まってから sidecar に TERM が送られ、定義順の逆順に止まる
- Job ではメイン container が終われば、sidecar が残っていても Job は完了する
- image を変えると Pod ではなくその container だけが再起動
- 終了処理でメイン container が grace period を使い切ると、sidecar はすぐに SIGKILL を受けることがある。その場合の 0 以外の exit code は正常とみなしてよい

### 従来型の sidecar

`containers` に app container をもう一つ入れる方式。container 単位の `restartPolicy` がない古いバージョンでも動き、今でも有効です。ただし普通の app container なので:

- アプリより先に起動する保証がない
- Job では問題になる。Pod が `Succeeded` になるにはすべての container が終了する必要があり、動き続ける sidecar がいると終わらない

起動・終了の順序が問題にならず、すべての container が Pod の動作に必要なら、この方式で十分だと公式ドキュメントも説明しています。

## ambassador と adapter

Kubernetes ブログの 2015 年の記事 "Patterns for Composite Containers" で sidecar と一緒に紹介されたパターン。現在の concepts ドキュメントには独立した項目がなく、実装も専用フィールドなしで container を追加するだけです。

| パターン   | 役割                                     | 例 (ブログより)                                                                               |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| sidecar    | メイン container の機能拡張              | nginx + Git リポジトリを同期する container、ファイルシステムを共有                            |
| ambassador | 外部接続を代わりに受け持つローカル proxy | アプリは `localhost` の Redis につなぎ、ambassador が読み書きを振り分けて実際のサーバーに転送 |
| adapter    | 出力を標準形式に変換                     | アプリごとに違うモニタリングデータの形式を共通の形式にして出す                                |

ambassador は network namespace の共有、adapter は volume か `localhost` の共有に頼る構造。三つとも実装は `containers` か native sidecar で行います。

## ephemeral container

実行中の Pod に一時的に付けるデバッグ用 container。v1.25 から stable。

- Pod には作成後に container を追加できないが、ephemeral container は `ephemeralcontainers` subresource で追加する。だから `kubectl edit` では入れられない
- 追加した後は変更・削除できない
- 自動再起動なし、リソース保証なし
- `ports`、`livenessProbe`、`readinessProbe`、`resources` は使えない
- static Pod では使えない
- 使う場面: container がクラッシュした、または distroless のように shell がなくて `kubectl exec` ができないとき

```bash
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

`--target` は指定した container の process namespace に入り、そのプロセスを見られるようにする。container runtime が対応している必要があり、対応していなければ process namespace が分かれたまま起動することがある。

## 例

init container で設定ファイルを作り、native sidecar がアプリのログを読む Pod。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  initContainers:
    - name: init-config
      image: busybox:1.36
      command: ["sh", "-c", 'echo "server_name=web" > /config/app.conf']
      volumeMounts:
        - name: config
          mountPath: /config
    - name: log-shipper
      image: busybox:1.36
      restartPolicy: Always
      command: ["sh", "-c", "touch /logs/app.log; tail -F /logs/app.log"]
      volumeMounts:
        - name: logs
          mountPath: /logs
  containers:
    - name: app
      image: busybox:1.36
      command:
        [
          "sh",
          "-c",
          "while true; do cat /config/app.conf >> /logs/app.log; sleep 5; done",
        ]
      volumeMounts:
        - name: config
          mountPath: /config
        - name: logs
          mountPath: /logs
  volumes:
    - name: config
      emptyDir: {}
    - name: logs
      emptyDir: {}
```

実行順: `init-config` 完了 → `log-shipper` 起動 (started) → `app` 起動。`log-shipper` は `app` と一緒に動き続ける。

同じ sidecar を従来型で書くなら、`containers` の下に移して `restartPolicy` を消せばよい。この場合 `log-shipper` と `app` は順序なしで一緒に起動します。

```bash
kubectl apply -f web.yaml
kubectl get pod web                      # STATUS: Init:0/2 → Running
kubectl logs web -c init-config          # init container のログ
kubectl logs web -c log-shipper -f       # sidecar のログ
kubectl logs web --all-containers
kubectl exec -it web -c app -- sh
kubectl describe pod web                 # Init Containers セクションの State/Reason
```

## 紛らわしいものの比較

### init container、native sidecar、従来型の sidecar

|                           | init container               | native sidecar      | 従来型の sidecar   |
| ------------------------- | ---------------------------- | ------------------- | ------------------ |
| 場所                      | `initContainers`             | `initContainers`    | `containers`       |
| container `restartPolicy` | なし                         | `Always`            | なし               |
| 実行期間                  | 終わるまで                   | Pod の生存期間全体  | Pod の生存期間全体 |
| app より先に起動          | はい (完了まで)              | はい (started まで) | 保証なし           |
| probe                     | 不可                         | 対応                | 対応               |
| app とのデータ受け渡し    | 一方向 (volume に書いておく) | 双方向              | 双方向             |
| Job の完了を妨げる        | いいえ                       | いいえ              | はい               |
| 終了順                    | 該当なし                     | メインの後、逆順    | 順序なし           |

### `kubectl exec` と `kubectl debug`

|                          | `kubectl exec`              | `kubectl debug` (ephemeral) |
| ------------------------ | --------------------------- | --------------------------- |
| 使うイメージ             | 既存の container のイメージ | 新しく指定したイメージ      |
| shell のないイメージ     | 不可                        | 可能                        |
| クラッシュした container | 不可                        | 可能                        |
| Pod spec の変化          | なし                        | ephemeral container が残る  |

## 試験のポイント

### コマンド

マルチ container の Pod を一発で作る imperative コマンドはありません。骨組みを作ってから YAML を直す流れです。

```bash
kubectl run web --image=busybox:1.36 --dry-run=client -o yaml \
  --command -- sh -c 'sleep 3600' > web.yaml
# initContainers、追加の container、volumes を手で書く

kubectl logs <pod> -c <container>
kubectl exec -it <pod> -c <container> -- sh
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

### kubectl explain

```bash
kubectl explain pod.spec.initContainers
kubectl explain pod.spec.initContainers.restartPolicy  # Always = native sidecar
kubectl explain pod.spec.shareProcessNamespace         # container 間のプロセス共有
kubectl explain pod.spec.volumes.emptyDir              # container 間のファイル共有
kubectl explain pod.spec.containers.volumeMounts
```

## 参考ドキュメント

- [Init Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Ephemeral Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pods: Pods with multiple containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/#how-pods-manage-multiple-containers)
- [Pod Lifecycle: Pod phase, Restart policy, Pod shutdown and sidecar containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Debug Running Pods: ephemeral container | Kubernetes](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#ephemeral-container)
- [Share Process Namespace between Containers in a Pod | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/)
- [The Distributed System ToolKit: Patterns for Composite Containers | Kubernetes Blog (2015)](https://kubernetes.io/blog/2015/06/the-distributed-system-toolkit-patterns/)
- [kubectl debug](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
