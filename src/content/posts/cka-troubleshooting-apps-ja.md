---
title: "CKA 概念ノート: ワークロード、リソース使用量、ネットワークのトラブルシューティング"
description: "kubectl top でリソース使用量を見て、kubectl logs の container の選択・以前の container・stdout/stderr とノードのログファイルの場所を確認し、Service の selector・targetPort・readiness・CoreDNS・NetworkPolicy を 1 つずつ壊して症状を比べました。"
pubDatetime: 2026-10-14T01:12:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "logging", "kubectl-top", "service"]
order: 12
---

> 基準: kubeadm クラスタ v1.35.9、metrics-server 0.9.0、Calico v3.33.0 で実際に壊して確認

`kubectl describe`、events、`exec`、`kubectl debug` で Pod を調べる基本の流れは [CKAD 概念ノート: モニタリング、ログ、デバッグ](/ja/posts/ckad-observability-debugging) にまとめた。ノードと control plane の故障は [ノードとクラスタコンポーネントのトラブルシューティング](/ja/posts/cka-troubleshooting-cluster) を参照。

## 目次

## リソース使用量

`kubectl top` は metrics-server がないと動かない (ないと `error: Metrics API not available`)。

```bash
kubectl top nodes --sort-by=cpu
kubectl top pods -A --sort-by=memory
kubectl top pod <pod> -n <ns> --containers
```

```text
$ kubectl top nodes --sort-by=cpu
NAME      CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
cka-cp1   214m         10%      1992Mi          70%
cka-w1    85m          4%       1156Mi          48%
cka-w2    69m          3%       743Mi           31%

$ kubectl top pods -A --sort-by=memory
NAMESPACE       NAME                     CPU(cores)   MEMORY(bytes)
kube-system     kube-apiserver-cka-cp1   55m          557Mi
calico-system   calico-node-lnw7f        32m          122Mi
```

- `--sort-by` は `cpu` か `memory`
- 値は収集周期ごとに更新される近似値。container が起動したばかりだと、まだ表示されないことがある
- 「一番多く使っている Pod の名前をファイルに書け」のような問題は `--sort-by` と `--no-headers | head -1` で

`kubectl describe node` の `Allocated resources` は実際の使用量ではなく request/limit の合計。2 つを混同しない。

## container の出力

container が stdout、stderr に書いたものを container runtime がノードのファイルに保存し、`kubectl logs` はそのファイルを kubelet 経由で読む。

### kubectl logs

container 2 つ (`out`: 2 秒ごとに stdout と stderr に 1 行ずつ、`crash`: 5 秒後に exit 3) の Pod で確認。

| コマンド                                                 | 結果                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `kubectl logs logger`                                    | `Defaulted container "out" out of: out, crash` の後、最初の container のログ |
| `kubectl logs logger -c out --tail=2`                    | `out-19`、`err-19` (stdout と stderr が混ざって出る)                         |
| `kubectl logs logger --all-containers --prefix --tail=1` | `[pod/logger/out] err-19`、`[pod/logger/crash] boom`                         |
| `kubectl logs logger -c out --since=5s --timestamps`     | 先頭に RFC3339 の時刻                                                        |
| `kubectl logs <pod> --previous`                          | 再起動前の container のログ                                                  |
| `kubectl logs -f`                                        | 追いかける                                                                   |
| `kubectl logs deploy/web`                                | Deployment の Pod 1 つ                                                       |
| `kubectl logs -l app=web`                                | label で複数の Pod                                                           |

`--previous` の確認: 25 秒後に exit 1 で終わる container が 1 回再起動した後

```text
current:  run-at-02:35:59
previous: run-at-02:35:34
```

container が落ち続けて原因を見たいときは `--previous`。今の container は起動したばかりで何も出力していないことがある。終了コードは status に残る。

```bash
kubectl get pod logger -o jsonpath='{.status.containerStatuses[?(@.name=="crash")].lastState.terminated}'
# {"exitCode":3,"reason":"Error","startedAt":"...","finishedAt":"..."}
```

`CrashLoopBackOff` で待っている間は、`--previous` が `unable to retrieve container logs for containerd://...` で失敗することがあった。そのときは `kubectl logs -c <container>` (最後に終わった container) が同じ内容を見せてくれた。

### ノードのログファイル

```text
/var/log/pods/<namespace>_<pod>_<uid>/<container>/<restart 番号>.log   ← 実際のファイル
/var/log/containers/<pod>_<namespace>_<container>-<container id>.log   ← symlink
```

```text
$ sudo sh -c 'ls /var/log/pods/app_logger_*/crash/'
2.log  3.log
$ sudo sh -c 'tail -n2 /var/log/pods/app_logger_*/out/0.log'
2026-10-14T02:35:21.78145528Z stdout F out-29
2026-10-14T02:35:21.781537313Z stderr F err-29
```

- 1 行の形式: `時刻 stream タグ 内容`。stream で stdout と stderr を区別できる。`kubectl logs` は 2 つを混ぜて見せる
- ファイル名の番号が再起動の回数。最近のものだけが残っている
- root 権限が必要で、glob は `sudo sh -c '...'` の中で使わないと展開されない
- ログの rotation は kubelet 設定の `containerLogMaxSize` (デフォルト 10Mi)、`containerLogMaxFiles` (デフォルト 5)。このクラスタの `config.yaml` には指定がないのでデフォルト値
- kubelet と containerd 自身のログはファイルではなく `journalctl -u kubelet`、`journalctl -u containerd`

## Service の接続の問題

nginx の Deployment (`app=web`、replicas 2) と busybox のクライアントで、1 つずつ壊して `wget` の結果を比べた。

| 故障                                  | EndpointSlice               | クライアントの結果                       |
| ------------------------------------- | --------------------------- | ---------------------------------------- |
| 正常                                  | Pod IP 2 つ、port 80        | `Welcome to nginx!`                      |
| selector の不一致                     | `<unset>` (endpoint なし)   | `Connection refused`                     |
| targetPort の誤り (8080)              | Pod IP 2 つ、port 8080      | `Connection refused`                     |
| readiness に失敗する Pod              | その Pod だけ `ready=false` | 残りの Pod から正常に応答                |
| CoreDNS の replicas 0                 | `kube-dns` の endpoint なし | 名前は `bad address`、ClusterIP なら正常 |
| NetworkPolicy の default deny ingress | 正常                        | `download timed out`                     |

### selector の不一致

`kubectl create svc clusterip web-bad-sel --tcp=80:80` は selector を `app: web-bad-sel` で作る。Pod の label は `app=web`。

```bash
kubectl get svc web-bad-sel -o jsonpath='{.spec.selector}'    # {"app":"web-bad-sel"}
kubectl get pods -l app=web --show-labels                       # app=web,pod-template-hash=...
kubectl get endpointslice -l kubernetes.io/service-name=web-bad-sel
# web-bad-sel-rcjwq   IPv4   <unset>   <unset>
```

endpoint が空なら、selector と Pod の label から比べる。

### targetPort の誤り

endpoint はあるが、port が container の listen していない 8080。EndpointSlice の PORTS 列ですぐ分かる。`refused` はその Pod IP:port で誰も listen していないということ。

### readiness の失敗

`readinessProbe` が存在しないパス (`/nope`) を見るように変えた新しい Pod は `0/1 Running` で、EndpointSlice に `ready=false` で残る。rolling update なので既存の Pod 2 つはそのまま Ready で、リクエストもそちらに行く。新しい Pod はトラフィックを受けない。

### DNS

CoreDNS を 0 に減らすと名前解決だけが失敗し、ClusterIP への直接接続は通る。「Service が動かない」という問題で名前と IP を別々に試すと、DNS の問題かどうかがすぐ分かれる。replicas を 2 に戻した直後は少しの間失敗が続き、すぐに正常に戻った。

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=kube-dns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### NetworkPolicy

`podSelector: {}` + `policyTypes: [Ingress]` の default deny があると、接続は拒否されず、応答なしで timeout になる。`refused` (すぐ失敗) と timeout (待ってから失敗) の違いが手がかり。

## 確認の順番

```text
1. kubectl get svc <svc> -o wide            selector、port、targetPort
2. kubectl get endpointslice -l kubernetes.io/service-name=<svc>
   ├─ 空 → selector と Pod の label、Pod が Ready か
   └─ ある → port が container の port と合っているか
3. Pod IP:port に直接 → 通れば Service/kube-proxy 側、通らなければ Pod/NetworkPolicy 側
4. ClusterIP に → 通れば DNS の問題
5. FQDN で nslookup
6. kubectl get networkpolicy -A
7. kube-proxy、CNI の Pod の状態 (kubectl -n kube-system get pods、calico-system など)
```

## 紛らわしいものの比較

| 比較                                               | A                                                                     | B                                             |
| -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `kubectl top node` vs `describe node` の Allocated | 実際の使用量                                                          | request/limit の合計                          |
| `logs` vs `logs --previous`                        | 現在の (または最後の) container                                       | その前の container                            |
| `-c <name>` vs `--all-containers`                  | 1 つの container                                                      | 全部。`--prefix` で区別                       |
| `/var/log/pods` vs `/var/log/containers`           | 実際のファイル                                                        | symlink                                       |
| `Connection refused` vs `timed out`                | そのアドレスで listen しているものがない (endpoint なし、port の誤り) | パケットが止められている (NetworkPolicy など) |
| `bad address`                                      | 名前解決の失敗                                                        | DNS (CoreDNS、dnsPolicy) を確認               |
| endpoint なし vs `ready=false`                     | selector の不一致か Pod がない                                        | Pod はあるが readiness に失敗                 |

## 試験のポイント

### すぐ確認するコマンド

```bash
kubectl top pods -A --sort-by=cpu --no-headers | head -1
kubectl logs <pod> -c <container> --previous
kubectl logs <pod> --all-containers --prefix
kubectl logs <pod> > /path/to/file          # ログをファイルに保存する問題
kubectl get endpointslice -l kubernetes.io/service-name=<svc>
kubectl get pods -l <selector> --show-labels
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
```

- 結果をファイルに書けという問題は、パスと形式 (名前だけか、1 行か) を問題のとおりに
- busybox の `wget`、`nslookup` には `-T3` のような timeout を付けて、長く待たないように

### kubectl explain

```bash
kubectl explain endpointslice.endpoints.conditions
kubectl explain pod.status.containerStatuses.lastState.terminated
```

## 参考ドキュメント

- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
