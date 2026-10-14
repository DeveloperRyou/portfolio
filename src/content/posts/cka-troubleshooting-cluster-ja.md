---
title: "CKA 概念ノート: ノードとクラスタコンポーネントのトラブルシューティング"
description: "kubelet と containerd を止め、kubelet の設定と static Pod manifest をわざと壊したうえで、kubectl、systemctl、journalctl、crictl、/var/log/pods で原因を探す過程を kubeadm クラスタで記録しました。"
pubDatetime: 2026-10-14T01:11:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "kubelet", "crictl", "static-pod"]
order: 11
---

> 基準: kubeadm クラスタ v1.35.9 (libvirt VM 3 台)、containerd 2.4.1、crictl v1.35.0 で実際に壊して確認

コンポーネントの構成と static Pod、`/etc/kubernetes` のファイルの場所は [クラスタ構成のノート](/ja/posts/cka-cluster-architecture)、証明書の期限確認は [lifecycle のノート](/ja/posts/cka-cluster-lifecycle) にまとめた。

## 目次

## どこから見るか

```text
kubectl は応答するか?
├─ いいえ → control plane ノードに ssh
│           crictl ps -a (apiserver、etcd の状態)
│           crictl logs / /var/log/pods
│           journalctl -u kubelet (manifest を読めているか)
└─ はい → kubectl get nodes
          ├─ NotReady のノード → そのノードに ssh
          │                     systemctl status kubelet containerd
          │                     journalctl -u kubelet
          └─ ノードは正常 → kubectl -n kube-system get pods
                            (scheduler、controller-manager、CoreDNS、CNI、kube-proxy)
```

| コンポーネント                                 | 実行方式               | 状態                                                                       | ログ                                            |
| ---------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| kubelet、containerd                            | systemd                | `systemctl status`                                                         | `journalctl -u kubelet`                         |
| apiserver、etcd、scheduler、controller-manager | static Pod             | `kubectl -n kube-system get pods`、apiserver が落ちていれば `crictl ps -a` | `kubectl logs`、`crictl logs`、`/var/log/pods/` |
| kube-proxy、CoreDNS、CNI                       | DaemonSet / Deployment | `kubectl get pods`                                                         | `kubectl logs`                                  |

## ノードが NotReady

### kubelet が止まった

worker で `sudo systemctl stop kubelet`。

- 48 秒後に `NotReady`。node lease が更新されないので、node lifecycle controller が状態を変える
- condition が `False` ではなく `Unknown`

```text
$ kubectl describe node cka-w1
  MemoryPressure  Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
  Ready           Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
Taints:  node.kubernetes.io/unreachable:NoExecute
         node.kubernetes.io/unreachable:NoSchedule
```

ノードで:

```bash
systemctl status kubelet
#  ○ kubelet.service - kubelet: The Kubernetes Node Agent
#     Loaded: loaded (/usr/lib/systemd/system/kubelet.service; enabled; ...)
#     Drop-In: /usr/lib/systemd/system/kubelet.service.d
#              └─10-kubeadm.conf
sudo systemctl start kubelet
sudo systemctl enable kubelet     # 再起動後も起動するように
```

`○` (inactive) は止まっている状態。`enabled` でなければ再起動後にまた止まる。

### containerd がない

containerd を止めた状態で kubelet を起動すると、kubelet 自体が失敗する。

```text
"command failed" err="failed to run Kubelet: validate service connection:
validate CRI v1 runtime API for endpoint \"unix:///var/run/containerd/containerd.sock\": rpc error ..."
```

`sudo systemctl start containerd` の後、30 秒以内に `Ready` に戻った。

### kubelet の設定エラー

`/var/lib/kubelet/config.yaml` の `clientCAFile` を存在しないファイルに変えて再起動。

```text
$ systemctl status kubelet
     Active: activating (auto-restart) (Result: exit-code) since ...; 9s ago

$ sudo journalctl -u kubelet --since "-1min"
"command failed" err="failed to construct kubelet dependencies: unable to load client CA file
/etc/kubernetes/pki/ca-wrong.crt: open /etc/kubernetes/pki/ca-wrong.crt: no such file or directory"
```

- `activating (auto-restart)` がずっと見えるなら、起動してすぐ落ちている。理由は journalctl の `command failed` の行にある
- kubelet の設定が入っている場所: `/var/lib/kubelet/config.yaml`、`/var/lib/kubelet/kubeadm-flags.env`、`/etc/default/kubelet`、`/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf`、`/etc/kubernetes/kubelet.conf`
- systemd の unit ファイルを直したら `systemctl daemon-reload` の後に再起動

```bash
sudo journalctl -u kubelet -f                  # 追いかけて見る
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -i -E "error|failed"
```

## control plane コンポーネント

### apiserver が etcd につながらない

`kube-apiserver.yaml` の `--etcd-servers` を `https://127.0.0.1:2399` に変えた。

```text
$ kubectl get nodes
Unable to connect to the server: net/http: TLS handshake timeout
```

kubectl が使えないので、ノードで container を直接見る。

```bash
sudo crictl ps -a --name kube-apiserver
# ea5139c8c6d5a   ...   19 seconds ago   Running   kube-apiserver   0
sudo crictl logs --tail 3 <container-id>
# grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ...
```

- container は `Running` なのに、etcd につながらずリクエストを処理できない状態。状態だけ見ると見逃す。ログを見る必要がある
- 同じログがノードの `/var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log` にもある。`/var/log/containers/*.log` はここへの symlink。どちらも root 権限が必要
- manifest を戻すと kubelet が起動し直し、1 分以内に kubectl が応答した

kubectl のエラーメッセージから推測できること:

| メッセージ                        | 疑う点                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `connect: connection refused`     | そのポートに apiserver がいない (起動していない、kubeconfig のアドレス・ポートが違う) |
| `net/http: TLS handshake timeout` | apiserver のプロセスはあるが応答できない (etcd への接続など)                          |
| `x509: certificate ...`           | kubeconfig の証明書や CA の問題                                                       |
| `Unauthorized`                    | 認証情報の問題                                                                        |

`~/.kube/config` のポートを `6444` に変えると `dial tcp 192.168.122.11:6444: connect: connection refused`。

### static Pod manifest の command のタイプミス

`kube-scheduler.yaml` の `- kube-scheduler` を `- kube-schedulerr` に変えた。

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
kube-scheduler-cka-cp1   0/1   CrashLoopBackOff   2 (14s ago)   26s

$ kubectl -n kube-system describe pod kube-scheduler-cka-cp1
      Reason:   StartError
      Message:  failed to create containerd task: failed to create shim task: OCI runtime create failed:
                runc create failed: unable to start container process: error during container init: exec: "kube-schedulerr": ...
```

この状態で Pod を作ると:

```text
$ kubectl get pod sched-test
sched-test   0/1   Pending   0   10s

$ kubectl describe pod sched-test
Events:  <none>
```

`Pending` なのに Events が空。scheduler がまったく見ていないということ。`FailedScheduling` があれば scheduler は生きていて、条件が合わないだけ。manifest を戻したら、Pod が `Scheduled` イベントとともに配置された。

### controller-manager の故障

同じやり方で `kube-controller-manager.yaml` の command を壊した。

```text
$ kubectl create deploy cm-test --image=nginx:1.27
$ kubectl get deploy cm-test
cm-test   0/1   0     0     10s
$ kubectl get rs -l app=cm-test
No resources found in default namespace.
```

Deployment オブジェクトは保存されたが、ReplicaSet ができない。Deployment controller がいないから。直して 50 秒後に `1/1`。

### manifest の YAML 文法エラー

インデントを壊した `kube-scheduler.yaml` を置くと、container も mirror Pod もできない。

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
Error from server (NotFound): pods "kube-scheduler-cka-cp1" not found
$ sudo crictl ps --name kube-scheduler -q | wc -l
0
$ sudo journalctl -u kubelet --since "-1min" | grep kube-scheduler.yaml
"Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml:
couldn't parse as pod(yaml: line 11: did not find expected key), please check config file"
```

Pod が一覧から完全に消えていたら manifest のパース失敗。kubelet のログに行番号が出る。

## 症状別のまとめ

| 症状                                   | 確認                                                  | 今回の実習の原因                          |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| ノード `NotReady`、condition `Unknown` | ノードで `systemctl status kubelet`                   | kubelet の停止                            |
| kubelet `activating (auto-restart)`    | `journalctl -u kubelet` の `command failed`           | config.yaml のパス誤り、containerd がない |
| kubectl `TLS handshake timeout`        | `crictl ps -a`、`crictl logs`                         | apiserver の etcd アドレスの誤り          |
| kubectl `connection refused`           | kubeconfig の server アドレス、apiserver の container | kubeconfig のポートの誤り                 |
| control plane Pod `CrashLoopBackOff`   | `describe pod` の Last State、`crictl logs`           | manifest の command のタイプミス          |
| control plane Pod が一覧にない         | `journalctl -u kubelet`                               | manifest の YAML 文法                     |
| Pod `Pending` + Events なし            | scheduler の Pod                                      | scheduler の故障                          |
| Deployment `0/1`、ReplicaSet なし      | controller-manager の Pod                             | controller-manager の故障                 |

## 紛らわしいものの比較

| 比較                                                         | A                                                     | B                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| node condition `False` vs `Unknown`                          | kubelet が報告した状態が悪い                          | kubelet が報告していない (落ちているかネットワーク) |
| `systemctl status` `inactive` vs `activating (auto-restart)` | 止まっている。start すればいい                        | 起動してすぐ落ちている。ログを確認                  |
| `kubectl logs` vs `crictl logs`                              | apiserver が必要                                      | ノードで直接。apiserver が落ちていても使える        |
| `/var/log/pods` vs `/var/log/containers`                     | 実際のファイル (`<ns>_<pod>_<uid>/<container>/N.log`) | symlink                                             |
| `Pending` + `FailedScheduling` vs `Pending` + Events なし    | 条件が合わない                                        | scheduler が動いていない                            |

## 試験のポイント

### すぐ確認するコマンド

```bash
kubectl get nodes; kubectl describe node <node> | grep -A8 Conditions
ssh <node>
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | tail -30
sudo crictl ps -a
sudo crictl logs <container-id>
ls /etc/kubernetes/manifests/
sudo cat /var/lib/kubelet/config.yaml
```

- 直した後、ノードの `Ready`、Pod の `Running` まで自分で確認
- manifest を直すときは、まず元のファイルをコピー (`cp kube-apiserver.yaml /tmp/`)。バックアップは `/etc/kubernetes/manifests/` の外に置く。kubelet は拡張子に関係なくこのディレクトリのファイルを読むので、`kube-scheduler.yaml.bak` を置いておいたら scheduler の Pod が作り直された
- kubelet の問題はたいていパスのタイプミス、証明書のパス、止まったサービス。`journalctl` にそのまま出る

### kubectl explain

```bash
kubectl explain node.status.conditions
kubectl explain pod.status.containerStatuses.lastState
```

## 参考ドキュメント

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Node status](https://kubernetes.io/docs/reference/node/node-status/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
