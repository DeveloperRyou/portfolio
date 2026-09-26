---
title: "CKAD 概念ノート: モニタリング、ログ、デバッグ"
description: "kubectl get/describe/events/top で状態を見て、kubectl logs でログを読み、exec と debug でコンテナの中を覗く流れを公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:13:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "logging", "debugging"]
order: 14
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### 何を見ればいいか

| 見たいもの                                        | コマンド                               | 出どころ                                 |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Pod の一覧と STATUS、RESTARTS                     | `kubectl get pods`                     | API server                               |
| コンテナの State、Reason、Restart Count、イベント | `kubectl describe pod <pod>`           | API server (Pod + Event)                 |
| システムが持っている全情報                        | `kubectl get pod <pod> -o yaml`        | API server                               |
| namespace のイベント                              | `kubectl events`、`kubectl get events` | Event リソース                           |
| CPU/メモリの使用量                                | `kubectl top pod`、`kubectl top node`  | Metrics API (metrics-server)             |
| アプリケーションの出力                            | `kubectl logs`                         | kubelet がノードに保存した stdout/stderr |
| コンテナの内部                                    | `kubectl exec`、`kubectl debug`        | 実行中のコンテナ / 新しく付けたコンテナ  |

### Pod phase と kubectl の STATUS は別の値

- `phase` は API のフィールド。値は `Pending`、`Running`、`Succeeded`、`Failed`、`Unknown` の五つだけ
- `kubectl get pods` の STATUS 列は人が見やすいように作った表示用の値。`CrashLoopBackOff`、`Terminating`、`OOMKilled` はここに出るが、phase の値ではない
- 実際の原因はコンテナ単位で見る必要がある。コンテナの state は `Waiting`、`Running`、`Terminated` の三つで、`Waiting` と `Terminated` には Reason が付く

### コンテナのログはどこにあるか

- コンテナが stdout/stderr に書いた出力を container runtime が受け取り、kubelet がノードの `/var/log/pods` の下にファイルとして保存する
- コンテナが再起動すると、kubelet はデフォルトで終了したコンテナ一つとそのログを残す → `--previous` で読む対象
- Pod がノードから evict されると、コンテナとログも一緒に削除される
- ログの rotation は kubelet の担当。`containerLogMaxSize` のデフォルトは 10Mi、`containerLogMaxFiles` のデフォルトは 5
- `kubectl logs` は最新のログファイルだけを読む。40MiB 書いて 10MiB ごとに rotation されると、見えるのは最大 10MiB だけ
- ファイルにしかログを書かないアプリだと `kubectl logs` には何も出ない。この場合、streaming sidecar がファイルを `tail` して自分の stdout に流すパターンが公式ドキュメントにある

### ephemeral container

- すでに作られた Pod に一時的に追加するコンテナ。トラブルシューティング専用
- Pod spec に直接入れるのではなく、API の `ephemeralcontainers` ハンドラで追加する → `kubectl edit` では付けられない
- 制約
  - `ports`、`livenessProbe`、`readinessProbe` は不可
  - `resources` は不可 (Pod のリソース割り当ては immutable)
  - 自動再起動なし、リソース・実行の保証なし
  - 一度追加すると変更・削除できない
  - static Pod では対応していない

## 動作の仕組み

### よくある失敗状態の読み方

| 表示               | どこで見えるか                 | 意味                                                                                             | まず見るもの                                                                                        |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `Pending`          | phase                          | スケジュール待ち、またはイメージのダウンロード中                                                 | `describe` の Events。`FailedScheduling` ならリソース不足、nodeSelector の不一致、`hostPort` の衝突 |
| `ImagePullBackOff` | コンテナの `Waiting` Reason    | イメージを取得できない。イメージ名の誤り、private registry なのに `imagePullSecret` がない、など | イメージ名・タグ、registry へのアクセス                                                             |
| `CrashLoopBackOff` | コンテナの `Waiting` Reason    | 起動 → 終了を繰り返していて、再起動の back-off がかかった状態                                    | `logs --previous`、`describe` の Last State と Exit Code                                            |
| `OOMKilled`        | コンテナの `Terminated` Reason | memory limit を超えて kernel が終了させた。`exitCode: 137`                                       | `resources.limits.memory`、`top pod`                                                                |

### back-off のタイミング

- コンテナの再起動: 10s、20s、40s ... のように伸びていき、300 秒 (5 分) で止まる
- 10 分間問題なく動けば back-off のタイマーはリセット
- イメージの pull の再試行も同じように伸びていき、上限は 300 秒
- だから直した直後でも、しばらく `CrashLoopBackOff` と表示されることがある。すぐ確認したいなら Pod を作り直すほうが早い

### CrashLoopBackOff の原因 (公式ドキュメントのリスト)

- アプリケーションのエラーで終了
- 設定の誤り: 間違った環境変数、存在しない設定ファイル
- メモリ・CPU の不足
- liveness probe または startup probe の失敗

### kubectl debug の三つのモード

```text
kubectl debug <pod> --image=...               # 既存の Pod に ephemeral container を追加
kubectl debug <pod> --copy-to=<new> ...       # Pod をコピーして新しい Pod を作成 (元はそのまま)
kubectl debug node/<node> --image=...         # ノードにデバッグ用の Pod を作成
```

- ephemeral container モード: `--target=<container>` で対象コンテナの process namespace を共有。runtime が対応していなければ、`ps` に対象のプロセスが見えないことがある
- copy モード: 新しいコンテナの追加、`--container` で既存のコンテナの command の差し替え、`--set-image` でイメージの差し替えができる。`--share-processes` で Pod 内のコンテナ同士がプロセスを見られる
- node モード: ノードの root filesystem が `/host` にマウントされ、host の IPC/Network/PID namespace を使う。privileged ではないので、必要なら `--profile=sysadmin`
- `--profile` の値: `legacy`、`general`、`baseline`、`restricted`、`netadmin`、`sysadmin`。指定しなければ `legacy` が使われ、kubectl 1.35 はそのとき `--profile=legacy is deprecated and will be removed in the future` という警告とともに `--profile=general` を明示するよう案内する
- `-i` を付けると新しいコンテナに自動で attach。接続が切れたら `kubectl attach` でつなぎ直す
- `--container` を付けなければ、コンテナ名は自動生成 (`debugger-xxxxx`)

## 例

### 状態とイベント

```bash
kubectl get pods -o wide
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'
kubectl describe pod <pod>

# イベントは namespace 単位
kubectl get events --sort-by='.lastTimestamp'
kubectl get events -n my-namespace
kubectl events --for pod/<pod> --watch
kubectl events --types=Warning

# メトリクス (metrics-server が必要)
kubectl top node
kubectl top pod --sort-by=memory
kubectl top pod <pod> --containers
```

### 終了の理由だけを取り出す

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
kubectl get pod <pod> -o go-template='{{range .status.containerStatuses}}{{.lastState.terminated.message}}{{end}}'
```

- termination message は、コンテナが `terminationMessagePath` (デフォルト `/dev/termination-log`) に書いた内容
- `terminationMessagePolicy: FallbackToLogsOnError` なら、ファイルが空でエラー終了したとき、ログの末尾 (2048 バイトか 80 行の小さいほう) を代わりに使う

### ログ

```bash
kubectl logs <pod>
kubectl logs <pod> -c <container>          # multi-container の Pod
kubectl logs <pod> --previous              # 直前に終了したコンテナ (-p)
kubectl logs -f <pod>                      # ストリーミング
kubectl logs <pod> --all-containers=true
kubectl logs -l app=nginx --all-containers=true
kubectl logs deployment/nginx -c nginx-1
kubectl logs --tail=20 <pod>
kubectl logs --since=1h <pod>
kubectl logs <pod> --timestamps=true --prefix
```

### streaming sidecar

公式ドキュメントの例を縮めた形。アプリはファイルにだけログを書き、sidecar がそのファイルを自分の stdout に流す。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: counter
spec:
  containers:
    - name: count
      image: busybox:1.28
      args:
        - /bin/sh
        - -c
        - >
          i=0;
          while true;
          do
            echo "$i: $(date)" >> /var/log/1.log;
            i=$((i+1));
            sleep 1;
          done
      volumeMounts:
        - name: varlog
          mountPath: /var/log
    - name: count-log-1
      image: busybox:1.28
      args: [/bin/sh, -c, "tail -n+1 -F /var/log/1.log"]
      volumeMounts:
        - name: varlog
          mountPath: /var/log
  volumes:
    - name: varlog
      emptyDir: {}
```

```bash
kubectl logs counter count-log-1
```

### exec

```bash
kubectl exec <pod> -- ls /
kubectl exec <pod> -c <container> -- cat /etc/config/app.conf
kubectl exec -it <pod> -- sh
```

- `--` の後ろがコンテナで実行するコマンド
- イメージに `sh` がなければ `executable file not found in $PATH` で失敗 → `kubectl debug` に移る

### debug

```bash
# shell のないイメージに ephemeral container を追加
kubectl run ephemeral-demo --image=registry.k8s.io/pause:3.1 --restart=Never
kubectl debug -it ephemeral-demo --image=busybox:1.28 --target=ephemeral-demo
kubectl describe pod ephemeral-demo        # "Ephemeral Containers:" の項目に追加される

# 起動してすぐ死ぬコンテナ: コピーで command を shell に差し替える
kubectl run --image=busybox:1.28 myapp -- false
kubectl debug myapp -it --copy-to=myapp-debug --container=myapp -- sh

# コピーにデバッグツールのコンテナを追加 + プロセス共有
kubectl debug myapp -it --image=ubuntu --share-processes --copy-to=myapp-debug

# コピーのすべてのコンテナのイメージを差し替え
kubectl debug myapp --copy-to=myapp-debug --set-image=*=ubuntu

# ノード
kubectl debug node/mynode -it --image=ubuntu

# 後片付け
kubectl delete pod myapp myapp-debug
```

## 紛らわしいものの比較

### exec、ephemeral container、copy

|                         | `kubectl exec`         | `kubectl debug <pod> --image`         | `kubectl debug <pod> --copy-to` |
| ----------------------- | ---------------------- | ------------------------------------- | ------------------------------- |
| 対象                    | 実行中の既存のコンテナ | 既存の Pod に新しいコンテナを追加     | 新しい Pod                      |
| イメージに shell が必要 | 必要                   | 不要 (デバッグ用イメージを使う)       | 不要                            |
| コンテナが死んでいても  | 不可                   | 可能                                  | 可能 (command の差し替え)       |
| 元の Pod の変更         | なし                   | ephemeral container が残る (削除不可) | なし                            |
| 後片付け                | なし                   | Pod を消すまで残る                    | コピーした Pod を削除           |

### --target と --share-processes

|            | `--target=<container>`                   | `--share-processes`               |
| ---------- | ---------------------------------------- | --------------------------------- |
| 使うモード | ephemeral container                      | `--copy-to`                       |
| 範囲       | 指定したコンテナ一つの process namespace | コピーした Pod のすべてのコンテナ |
| 条件       | container runtime の対応が必要           | Pod の設定で適用                  |

### logs のオプション

| オプション         | 意味                       | 注意                                                        |
| ------------------ | -------------------------- | ----------------------------------------------------------- |
| `-c`               | コンテナを指定             | コンテナが一つなら省略できる                                |
| `-p`、`--previous` | 直前に終了したインスタンス | kubelet が残しておいた終了済みのコンテナ一つが対象          |
| `-f`               | ストリーミング             | 終えるには Ctrl+C                                           |
| `--all-containers` | すべてのコンテナ           | `-l` と一緒に使うと複数の Pod のすべてのコンテナ            |
| `-l`               | label selector             | 同時リクエストは `--max-log-requests` でデフォルト 5 個まで |

### get events と events

|                    | `kubectl get events`                | `kubectl events`                       |
| ------------------ | ----------------------------------- | -------------------------------------- |
| 時系列の並び       | `--sort-by='.lastTimestamp'`        | デフォルトの出力が最近のイベントの一覧 |
| 特定のリソースだけ | `describe` の Events で代わりに見る | `--for pod/<name>`                     |
| タイプで絞る       | -                                   | `--types=Warning`                      |
| 見続ける           | `--watch`                           | `--watch`                              |

## 試験のポイント

### まず打つコマンド

```bash
kubectl get pods -A | grep -v Running
kubectl describe pod <pod> | grep -A10 -E 'State|Events'
kubectl logs <pod> -c <container> --previous
kubectl get events -n <ns> --sort-by='.lastTimestamp'
```

- Pending は `logs` を見ても意味がない。コンテナが起動前なのでログがない。`describe` の Events から
- `CrashLoopBackOff` は今のコンテナが立ち上がってすぐ死んでいる途中なので、`logs` が空のことがある。`--previous`
- `OOMKilled` は `describe` の Last State の Reason と Exit Code 137、そして `resources.limits.memory` を一緒に見る
- イベントは namespace 単位。`-n` を付けないと default namespace しか見ない
- `kubectl top` がエラーを出したら、コマンドより先に Metrics API (metrics-server) がデプロイされているかを疑う

### kubectl explain

```bash
kubectl explain pod.status.containerStatuses.state            # waiting / running / terminated
kubectl explain pod.status.containerStatuses.lastState        # 再起動前の終了 reason、exitCode
kubectl explain pod.spec.containers.terminationMessagePolicy  # File / FallbackToLogsOnError
kubectl explain pod.spec.ephemeralContainers                  # kubectl debug が追加する container
kubectl explain event                                         # reason、involvedObject、type
```

## 参考ドキュメント

- [CKAD Curriculum v1.35 (cncf/curriculum)](https://github.com/cncf/curriculum/blob/master/CKAD_Curriculum_v1.35.pdf)
- [Troubleshooting Applications](https://kubernetes.io/docs/tasks/debug/debug-application/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Determine the Reason for Pod Failure](https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [kubectl events](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_events/)
- [Ephemeral Containers](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Images: ImagePullBackOff](https://kubernetes.io/docs/concepts/containers/images/#imagepullbackoff)
- [Assign Memory Resources to Containers and Pods](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
