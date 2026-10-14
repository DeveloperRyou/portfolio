---
title: "CKA 概念ノート: クラスタ構成とコンポーネント"
description: "control plane コンポーネント (kube-apiserver、etcd、scheduler、controller-manager) と node コンポーネント (kubelet、kube-proxy、container runtime) がどうつながっているか、static Pod と /etc/kubernetes 以下のファイルを kubeadm クラスタで直接確認しながらまとめました。"
pubDatetime: 2026-10-14T01:02:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "control-plane", "kubelet", "static-pod"]
order: 2
---

> 基準: kubeadm クラスタ v1.35.9 (libvirt VM 3 台: control plane 1、worker 2)、containerd 2.4.1 でコマンドを確認

## 目次

## コンポーネントの地図

```text
              kubectl / ユーザー
                    │ :6443
┌───────────────────▼──── control plane (cka-cp1) ───────────────┐
│  kube-apiserver ──── etcd (:2379)                              │
│     ▲      ▲                                                   │
│     │      └── kube-scheduler, kube-controller-manager         │
│     │          (apiserver を watch、結果を apiserver に書く)    │
└─────┼──────────────────────────────────────────────────────────┘
      │ :6443                       ▲ :10250 (logs, exec)
┌─────┴──────────── worker (cka-w1, cka-w2) ──┴──────────────────┐
│  kubelet ── CRI ── containerd ── runc                          │
│  kube-proxy (Service → iptables ルール)                         │
│  CNI プラグイン (Pod ネットワーク)                               │
└────────────────────────────────────────────────────────────────┘
```

- etcd に直接つなぐのは kube-apiserver だけ。それ以外はすべて apiserver を経由
- コンポーネント同士は直接命令しない。それぞれが apiserver を watch し、望ましい状態と実際の状態がずれていれば合わせる方式

## control plane コンポーネント

| コンポーネント           | 役割                                                                             | kubeadm での実行方式            |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------- |
| kube-apiserver           | すべてのリクエストの入口。認証、認可、admission、検証の後 etcd に保存            | static Pod                      |
| etcd                     | クラスタの状態を保存する key-value store                                         | static Pod                      |
| kube-scheduler           | `nodeName` が空の Pod にノードを選ぶ                                             | static Pod                      |
| kube-controller-manager  | Deployment、ReplicaSet、Node、Job などの controller の束。望ましい状態に合わせる | static Pod                      |
| cloud-controller-manager | クラウド API 連携 (LB、ノードなど)                                               | オンプレミスの kubeadm にはない |

manifest の主なフラグ:

```bash
sudo grep -E "etcd-servers|service-cluster-ip-range|authorization-mode|enable-admission" \
  /etc/kubernetes/manifests/kube-apiserver.yaml
#    - --authorization-mode=Node,RBAC
#    - --enable-admission-plugins=NodeRestriction
#    - --etcd-servers=https://127.0.0.1:2379
#    - --service-cluster-ip-range=10.96.0.0/12

sudo grep -E "cluster-cidr|allocate-node-cidrs|leader-elect" \
  /etc/kubernetes/manifests/kube-controller-manager.yaml
#    - --allocate-node-cidrs=true
#    - --cluster-cidr=10.244.0.0/16
#    - --leader-elect=true
```

- `--service-cluster-ip-range`: Service ClusterIP の帯域。`kubeadm init --service-cidr`
- `--cluster-cidr`: Pod の帯域。`kubeadm init --pod-network-cidr`
- scheduler と controller-manager は `--leader-elect=true`。HA で複数台動いていても、働くのは Lease を取った 1 台

```text
$ kubectl -n kube-system get lease
NAME                      HOLDER
kube-controller-manager   cka-cp1_570f3ff0-...
kube-scheduler            cka-cp1_af5d04d1-...
```

## node コンポーネント

| コンポーネント    | 役割                                                                        | 実行方式                                       |
| ----------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| kubelet           | ノードに割り当てられた Pod を container runtime で実行し、状態を報告        | systemd サービス                               |
| container runtime | イメージの pull、container の実行。kubelet と CRI で通信                    | systemd サービス (containerd)                  |
| kube-proxy        | Service と EndpointSlice を見てノードの iptables/IPVS/nftables ルールを書く | DaemonSet                                      |
| CNI プラグイン    | Pod に IP とネットワークインターフェースを付ける                            | たいてい DaemonSet + `/opt/cni/bin` のバイナリ |

kubelet だけは Pod ではない。kubelet がないと Pod が起動しないから。control plane ノードにも kubelet、container runtime、kube-proxy が全部ある。

```text
$ kubectl -n kube-system get pods -o wide
coredns-7d764666f9-9w4dz          cka-cp1
coredns-7d764666f9-bwvwh          cka-w1
etcd-cka-cp1                      cka-cp1
kube-apiserver-cka-cp1            cka-cp1
kube-controller-manager-cka-cp1   cka-cp1
kube-proxy-44chc                  cka-w1
kube-proxy-ckfkj                  cka-w2
kube-proxy-mjtnj                  cka-cp1
kube-scheduler-cka-cp1            cka-cp1
```

- 名前の最後にノード名が付いているもの (`etcd-cka-cp1`) が static Pod
- ランダムな接尾辞が付いているものは Deployment (CoreDNS) か DaemonSet (kube-proxy)

## kubelet

### 設定の場所

```bash
systemctl cat kubelet
```

```text
# /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
EnvironmentFile=-/etc/default/kubelet
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

| ファイル                             | 内容                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `/etc/kubernetes/kubelet.conf`       | apiserver 接続用の kubeconfig                                            |
| `/var/lib/kubelet/config.yaml`       | KubeletConfiguration。`staticPodPath`、`cgroupDriver`、`clusterDNS` など |
| `/var/lib/kubelet/kubeadm-flags.env` | kubeadm が入れる追加フラグ (`KUBELET_KUBEADM_ARGS`)                      |
| `/etc/default/kubelet`               | ユーザーが入れる追加フラグ (`KUBELET_EXTRA_ARGS`)                        |

```bash
sudo grep -E "staticPodPath|cgroupDriver|containerRuntimeEndpoint|clusterDomain" /var/lib/kubelet/config.yaml
# cgroupDriver: systemd
# clusterDomain: cluster.local
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock
# staticPodPath: /etc/kubernetes/manifests
```

`clusterDNS: [10.96.0.10]` もこのファイルにある。Pod の `/etc/resolv.conf` の nameserver はここから来る。

## static Pod

kubelet が apiserver なしでローカルディレクトリ (`staticPodPath`) の manifest を見て自分で起動する Pod。control plane が apiserver なしで起動できる理由。

### mirror Pod

kubelet は static Pod ごとに apiserver に mirror Pod を作り、`kubectl get pods` に表示されるようにする。名前は `<metadata.name>-<ノード名>`。

worker (cka-w1) の `/etc/kubernetes/manifests/` にファイルを 1 つ置いてみた。

```yaml
# /etc/kubernetes/manifests/static-web.yaml (cka-w1)
apiVersion: v1
kind: Pod
metadata:
  name: static-web
  labels:
    role: static
spec:
  containers:
    - name: web
      image: nginx:1.27
```

```text
$ kubectl get pod -o wide
static-web-cka-w1   Running   cka-w1

$ kubectl get pod static-web-cka-w1 -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
Node/cka-w1
```

| 操作                                   | 結果                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `kubectl delete pod static-web-cka-w1` | `deleted` と出るが数秒後にまた `Running`。kubelet が mirror Pod を作り直す |
| manifest ファイルを削除                | Pod が実際に消える (`NotFound`)                                            |
| manifest ファイルを修正                | kubelet が Pod を作り直す                                                  |

static Pod を消したり直したりするには、そのノードに ssh してファイルを扱う必要がある。どのノードかは名前の末尾か `-o wide` で。

- worker の `/etc/kubernetes/manifests/` は最初は空。ディレクトリと `staticPodPath` の設定は worker にも同じようにある
- static Pod は ConfigMap、Secret、ServiceAccount のような他の API オブジェクトを参照できない

## /etc/kubernetes 以下のファイル

control plane:

```text
/etc/kubernetes/
├── admin.conf               # kubeadm:cluster-admins グループ。kubectl 用
├── super-admin.conf         # system:masters グループ。非常用
├── controller-manager.conf  # controller-manager が apiserver につなぐとき
├── scheduler.conf           # scheduler が apiserver につなぐとき
├── kubelet.conf             # kubelet が apiserver につなぐとき
├── manifests/               # static Pod: etcd, kube-apiserver, kube-controller-manager, kube-scheduler
└── pki/
    ├── ca.crt, ca.key                     # クラスタ CA
    ├── apiserver.crt/key                  # apiserver のサーバー証明書
    ├── apiserver-kubelet-client.crt/key   # apiserver → kubelet (logs, exec)
    ├── apiserver-etcd-client.crt/key      # apiserver → etcd
    ├── front-proxy-ca.*, front-proxy-client.*  # aggregation layer
    ├── sa.key, sa.pub                     # ServiceAccount token の署名
    └── etcd/                              # etcd 専用 CA と server/peer 証明書
```

worker には `kubelet.conf`、`manifests/` (空)、`pki/ca.crt` だけ。worker の `kubelet.conf` は `server: https://192.168.122.11:6443` を指す。

## ポート

control plane で `ss -tlnp` で見たもの:

| アドレス                                | プロセス                | 用途                                 |
| --------------------------------------- | ----------------------- | ------------------------------------ |
| `*:6443`                                | kube-apiserver          | API                                  |
| `192.168.122.11:2379`、`127.0.0.1:2379` | etcd                    | client                               |
| `192.168.122.11:2380`                   | etcd                    | peer (HA で member 同士)             |
| `127.0.0.1:2381`                        | etcd                    | metrics、health                      |
| `127.0.0.1:10257`                       | kube-controller-manager | health                               |
| `127.0.0.1:10259`                       | kube-scheduler          | health                               |
| `*:10250`                               | kubelet                 | API (apiserver が logs、exec で接続) |
| `127.0.0.1:10248`                       | kubelet                 | healthz                              |
| `*:10256`、`127.0.0.1:10249`            | kube-proxy              | healthz、metrics                     |

## 1 つのリクエストが Pod になるまで

`kubectl create deploy web --image=nginx --replicas=2`:

1. kubectl → apiserver: 認証、認可 (RBAC)、admission の後、Deployment を etcd に保存
2. controller-manager の Deployment controller が ReplicaSet を作成
3. ReplicaSet controller が Pod を 2 つ作成 (`nodeName` は空)
4. scheduler が Pod ごとにノードを選んで `nodeName` を書く (binding)
5. そのノードの kubelet が自分のノードの Pod を見て、CRI で containerd に sandbox と container の作成を依頼、CNI が Pod IP を割り当て
6. kubelet が Pod の status を apiserver に報告

どの段階で止まったかによって見る場所が違う:

| 症状                                                          | 疑う場所                        |
| ------------------------------------------------------------- | ------------------------------- |
| Deployment はあるのに ReplicaSet/Pod ができない               | kube-controller-manager         |
| Pod が `Pending`、Events に何もない                           | kube-scheduler                  |
| Pod がノードに割り当てられたのに `ContainerCreating` で止まる | kubelet、container runtime、CNI |
| `kubectl` がまったく応答しない                                | kube-apiserver、etcd            |

## 紛らわしいものの比較

| 比較                                             | A                                                             | B                                                      |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| static Pod vs DaemonSet                          | kubelet がローカルファイルで起動。apiserver 不要。ノード 1 つ | controller が API で管理。すべて (または選んだ) ノード |
| mirror Pod の削除 vs manifest の削除             | また作られる                                                  | 実際に消える                                           |
| kubelet vs 他のコンポーネント                    | systemd サービス。`systemctl`、`journalctl`                   | Pod。`kubectl logs`、`crictl logs`                     |
| `--service-cluster-ip-range` vs `--cluster-cidr` | Service IP の帯域 (apiserver)                                 | Pod IP の帯域 (controller-manager)                     |
| `admin.conf` vs `kubelet.conf`                   | 人が使う管理者 kubeconfig                                     | kubelet のノードとしての身元 (`system:node:<ノード>`)  |

## 試験のポイント

### すぐ確認するコマンド

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide        # static Pod は名前の末尾にノード名
ls /etc/kubernetes/manifests/                  # どの static Pod があるか
sudo grep staticPodPath /var/lib/kubelet/config.yaml
systemctl status kubelet
sudo crictl ps                                  # apiserver が落ちていても container を確認できる
kubectl get --raw='/readyz?verbose'             # apiserver の状態
```

- 「static Pod を作れ」という問題は、そのノードの `staticPodPath` に YAML を置けば終わり。`kubectl run --dry-run=client -o yaml` で骨組みを作ると速い
- `staticPodPath` がデフォルト値でないこともある。まず `config.yaml` で確認
- `kubectl get componentstatuses` は v1.19 から deprecated という警告が出る。状態確認は `/readyz`、`/livez` や Pod の状態で

### kubectl explain

```bash
kubectl explain pod.spec.nodeName
kubectl explain lease.spec            # holderIdentity, renewTime
```

## 参考ドキュメント

- [Cluster Architecture](https://kubernetes.io/docs/concepts/architecture/)
- [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/)
- [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [Communication between Nodes and the Control Plane](https://kubernetes.io/docs/concepts/architecture/control-plane-node-communication/)
- [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
