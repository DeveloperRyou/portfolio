---
title: "CKA 概念ノート: kubeadm インストールと HA control plane"
description: "ノードの準備 (swap、sysctl、containerd の cgroup driver) から kubeadm init/join、CNI のインストール、kube-vip でまとめた stacked etcd の HA control plane まで、VM 3 台で直接実行しながらまとめました。"
pubDatetime: 2026-10-14T01:03:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "containerd", "high-availability"]
order: 3
---

> 基準: Kubernetes v1.34.12 / v1.35.9、kubeadm。libvirt VM 3 台 (Ubuntu 24.04、2 vCPU、2.5〜3GB)、containerd 2.4.1、Calico v3.33.0 でコマンドを確認

## 目次

## 全体の流れ

kubeadm は「ノード 1 台を control plane にして、残りのノードをつなぐ」ツール。OS の準備、container runtime のインストール、CNI のインストールは kubeadm がやってくれない。

| 段階               | どこで               | やること                                                    |
| ------------------ | -------------------- | ----------------------------------------------------------- |
| ノードの準備       | すべてのノード       | swap、sysctl、container runtime、cgroup driver              |
| パッケージの導入   | すべてのノード       | kubeadm、kubelet、kubectl (+ cri-tools)                     |
| `kubeadm init`     | 最初の control plane | 証明書、kubeconfig、static Pod、addon (CoreDNS、kube-proxy) |
| CNI のインストール | kubectl              | Pod ネットワーク。これがないとノードが `NotReady`           |
| `kubeadm join`     | 残りのノード         | worker または追加の control plane として参加                |

## ノードの準備

### 要件

- ノードあたり RAM 2GB 以上、control plane は CPU 2 個以上
- ノードごとに hostname、MAC アドレス、`product_uuid` が違う必要がある (VM を複製したときは注意)

```bash
ip link
sudo cat /sys/class/dmi/id/product_uuid
```

### 必要なポート

| ノード        | ポート      | 用途                    |
| ------------- | ----------- | ----------------------- |
| control plane | 6443        | kube-apiserver          |
| control plane | 2379-2380   | etcd client / peer      |
| control plane | 10250       | kubelet API             |
| control plane | 10257       | kube-controller-manager |
| control plane | 10259       | kube-scheduler          |
| worker        | 10250       | kubelet API             |
| worker        | 10256       | kube-proxy              |
| worker        | 30000-32767 | NodePort Service        |

### swap

kubelet はデフォルトでは swap が有効だと起動しない。無効にする (`swapoff -a` + `/etc/fstab` の整理) か、kubelet 設定に `failSwapOn: false` を入れて許可する。

worker 1 台で swap ファイルを有効にして kubelet を再起動すると、`activating` のまま再起動を繰り返した。

```text
"command failed" err="failed to run Kubelet: running with swap on is not supported,
please disable swap or set --fail-swap-on flag to false"
```

Ubuntu の cloud image は最初から swap がないので、`swapon --show` の出力は空だった。

### sysctl

現在の公式ドキュメントで必須とされているのは IPv4 forwarding だけ。

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # net.ipv4.ip_forward = 1
```

### container runtime と cgroup driver

kubelet と container runtime は同じ cgroup driver を使う必要がある。systemd が init のディストリビューション、cgroup v2 では `systemd` driver を推奨。kubeadm は kubelet 設定に `cgroupDriver: systemd` をデフォルトで入れるので、普通直す側は containerd。

Docker リポジトリの `containerd.io` パッケージで containerd 2.4.1 を入れてデフォルト設定を作ると、`SystemdCgroup = false` になっている。

```bash
sudo apt-get install -y containerd.io
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
grep -n SystemdCgroup /etc/containerd/config.toml
# 89:            SystemdCgroup = false
```

containerd 2.x の設定ファイル (`version = 4`) では、この値は下の位置にある。1.x のドキュメントの `[plugins."io.containerd.grpc.v1.cri"...]` というパスとは違う。

```toml
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
  SystemdCgroup = true
```

```bash
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

同じファイルに sandbox (pause) イメージも指定されている: `sandbox = 'registry.k8s.io/pause:3.10.2'`。

## パッケージの導入

`pkgs.k8s.io` は minor バージョンごとにリポジトリが分かれている。URL の `v1.34` の部分がインストールする minor バージョン。

```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

- `apt-mark hold`: `apt upgrade` で勝手にバージョンが上がらないよう固定。upgrade するときだけ `unhold`
- この時点の kubelet は設定ファイルがないので数秒ごとに再起動を繰り返す。`kubeadm init`/`join` が設定を書けば正常になる
- `crictl` は上の 3 パッケージだけではインストールされなかった。`sudo apt-get install -y cri-tools` で別途インストール
- `crictl` は `/etc/crictl.yaml` がないと、endpoint のデフォルト値が deprecated だという警告を毎回出す

```yaml
# /etc/crictl.yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
```

## kubeadm init

```bash
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=192.168.122.11
```

| フラグ                          | 意味                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `--pod-network-cidr`            | Pod IP の帯域。CNI の設定と合わせる。ノードネットワークと重なってはいけない |
| `--apiserver-advertise-address` | apiserver が広告する IP。省略すると default route のあるインターフェース    |
| `--control-plane-endpoint`      | HA 用の共有 endpoint (LB のアドレスや DNS)。下の HA の節を参照              |
| `--service-cidr`                | Service IP の帯域。デフォルト `10.96.0.0/12`                                |
| `--kubernetes-version`          | control plane のバージョン指定                                              |

イメージを先に取得しておくこともできる: `sudo kubeadm config images pull`。

### init がやること

出力の `[phase]` の順番が、そのまま kubeadm が作るもの。

| phase                   | 成果物                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `preflight`             | swap、ポート、runtime などの事前チェック。イメージの pull                                                                   |
| `certs`                 | `/etc/kubernetes/pki/` 以下の CA と証明書。apiserver 証明書の SAN に `10.96.0.1` (kubernetes Service IP) とノード IP を含む |
| `kubeconfig`            | `/etc/kubernetes/` に `admin.conf`、`super-admin.conf`、`kubelet.conf`、`controller-manager.conf`、`scheduler.conf`         |
| `etcd`, `control-plane` | `/etc/kubernetes/manifests/` に etcd、kube-apiserver、kube-controller-manager、kube-scheduler の static Pod manifest        |
| `kubelet-start`         | `/var/lib/kubelet/config.yaml`、`/var/lib/kubelet/kubeadm-flags.env` を書いて kubelet を起動                                |
| `upload-config`         | 使った設定を `kube-system/kubeadm-config` ConfigMap に保存                                                                  |
| `mark-control-plane`    | label `node-role.kubernetes.io/control-plane`、taint `node-role.kubernetes.io/control-plane:NoSchedule`                     |
| `bootstrap-token`       | join 用の token と関連する RBAC、`kube-public/cluster-info` ConfigMap                                                       |
| `addons`                | CoreDNS Deployment、kube-proxy DaemonSet                                                                                    |

### 終わった直後

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

root なら `export KUBECONFIG=/etc/kubernetes/admin.conf` でもいい。

CNI をインストールする前は、ノードが `NotReady` で CoreDNS は `Pending`。

```text
$ kubectl get nodes
NAME      STATUS     ROLES           AGE   VERSION
cka-cp1   NotReady   control-plane   7s    v1.34.12

$ kubectl describe node cka-cp1
Taints:  node.kubernetes.io/not-ready:NoExecute
         node.kubernetes.io/not-ready:NoSchedule
  Ready  False ... KubeletNotReady  container runtime network not ready: NetworkReady=false
         reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
```

`/opt/cni/bin` にはすでに基本プラグインのバイナリ (bridge、host-device など) があるが、`/etc/cni/net.d` が空なのでこの状態になる。

## CNI のインストール

Pod ネットワークはクラスタごとに 1 つだけ。Calico v3.33.0 を operator 方式でインストールした。

```bash
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/operator-crds.yaml
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/tigera-operator.yaml
curl -fsSLO https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/custom-resources.yaml
sed -i 's#cidr: 192.168.0.0/16#cidr: 10.244.0.0/16#' custom-resources.yaml
kubectl create -f custom-resources.yaml
```

- `custom-resources.yaml` のデフォルト帯域 `192.168.0.0/16` は libvirt のデフォルトネットワーク (`192.168.122.0/24`) と重なるので、`--pod-network-cidr` と同じ `10.244.0.0/16` に変更
- CRD が登録される前に custom resource を作ると `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`
- インストール後 `/etc/cni/net.d/10-calico.conflist` ができ、1 分ほどでノードが `Ready`

## kubeadm join

init の出力の最後にある join コマンドを worker で root として実行。出力をなくしたら control plane で作り直せる。

```bash
# control plane で
sudo kubeadm token create --print-join-command
# kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>

# worker で
sudo kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

| 値                               | 意味                                                                                 | 確認                  |
| -------------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| `--token`                        | worker が最初に apiserver につなぐときに使う bootstrap token。デフォルト TTL 24 時間 | `kubeadm token list`  |
| `--discovery-token-ca-cert-hash` | worker が接続した apiserver が本物か確かめるための CA 公開鍵の hash                  | 下の openssl コマンド |

```bash
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
  | openssl rsa -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -hex | sed 's/^.* //'
```

この値が join コマンドの hash と同じことを確認した。

join の出力で見える流れ: `kube-system/kubeadm-config` ConfigMap の読み込み → kubelet 設定の作成と起動 → TLS Bootstrap (token で CSR を送って kubelet のクライアント証明書を受け取る) → `This node has joined the cluster`。

```text
$ kubectl get nodes -o wide
NAME      STATUS   ROLES           VERSION    INTERNAL-IP      CONTAINER-RUNTIME
cka-cp1   Ready    control-plane   v1.34.12   192.168.122.11   containerd://2.4.1
cka-w1    Ready    <none>          v1.34.12   192.168.122.21   containerd://2.4.1
cka-w2    Ready    <none>          v1.34.12   192.168.122.22   containerd://2.4.1
```

worker の ROLES が `<none>` なのは正常。label を自分で付ければ表示される (`kubectl label node cka-w1 node-role.kubernetes.io/worker=`)。

control plane にも Pod を載せたいなら taint を外す。

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

## HA control plane

### トポロジー

|              | stacked etcd                                                      | external etcd                                        |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------- |
| etcd の場所  | control plane ノードごとに etcd member が一緒に動く               | 別の etcd ノード                                     |
| 最小ノード数 | control plane 3 台                                                | control plane 3 台 + etcd 3 台                       |
| 長所         | ノード数が少なく設定が単純。kubeadm のデフォルト                  | control plane が 1 台落ちても etcd member はそのまま |
| 短所         | ノードが 1 台落ちると etcd member と control plane が一緒に抜ける | ノードが倍、設定が複雑                               |

etcd は過半数 (quorum) が生きていないと書き込めない。3 台なら 1 台まで障害を許容。だから stacked でも最低 3 台。

### load balancer

control plane が複数台なら、kubelet や kubectl がつなぐ共有アドレスが必要。これが `--control-plane-endpoint` で、最初の init のときに決める必要がある。

- 外部 LB (HAProxy など) を置くか、ノード上に keepalived + HAProxy、または kube-vip のような static Pod を動かす
- LB のヘルスチェックは apiserver ポート (6443) の TCP チェック
- ここでは kube-vip v1.2.4 を static Pod として動かし、ARP で VIP `192.168.122.100` をリーダーノードに付けた

```bash
export KVVERSION=v1.2.4 VIP=192.168.122.100 INTERFACE=enp1s0
sudo ctr image pull ghcr.io/kube-vip/kube-vip:$KVVERSION
sudo ctr run --rm --net-host ghcr.io/kube-vip/kube-vip:$KVVERSION vip /kube-vip \
  manifest pod --interface $INTERFACE --address $VIP --controlplane --arp --leaderElection \
  | sudo tee /etc/kubernetes/manifests/kube-vip.yaml
```

- 最初の control plane では、manifest の kubeconfig hostPath を `admin.conf` ではなく `super-admin.conf` に変える必要がある。v1.29 から init の途中では `admin.conf` にまだ権限がないので、kube-vip がリーダー選出できず VIP が上がらない
- init が終わったら `admin.conf` に戻す。戻すと kube-vip Pod が再起動する間 VIP が一瞬消え、その間 kubectl は `dial tcp 192.168.122.100:6443: connect: no route to host` で失敗した
- init の前に `nc -zv -w 2 192.168.122.100 6443` を試すと timeout。kube-vip も kubelet が起動する static Pod なので、init 前は VIP がない

### init と control plane の join

```bash
# 最初の control plane
sudo kubeadm init --control-plane-endpoint "192.168.122.100:6443" --upload-certs \
  --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=192.168.122.11

# 残りの control plane (init の出力に出たコマンド)
sudo kubeadm join 192.168.122.100:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane --certificate-key <key>
```

| フラグ              | 意味                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `--upload-certs`    | CA など control plane 同士で共有する証明書を暗号化して `kube-system/kubeadm-certs` Secret にアップロード |
| `--control-plane`   | worker ではなく control plane として join                                                                |
| `--certificate-key` | 上の Secret を復号する鍵。この鍵で証明書をダウンロードする                                               |

- アップロードした証明書と鍵は 2 時間後に削除される。その後 control plane を追加するには `sudo kubeadm init phase upload-certs --upload-certs` でアップロードし直して新しい鍵をもらう
- worker の join は `--control-plane`、`--certificate-key` なしで同じ endpoint に

結果: control plane 3 台、etcd member 3 つ。HA の実習は VM 3 台をすべて control plane として組み直したので、名前はそのままだが cka-w1、cka-w2 も control plane。

```text
$ etcdctl member list -w table
|  NAME   |         PEER ADDRS          | IS LEARNER |
|  cka-w2 | https://192.168.122.22:2380 |      false |
| cka-cp1 | https://192.168.122.11:2380 |      false |
|  cka-w1 | https://192.168.122.21:2380 |      false |
```

### 障害テスト

VIP を持っていた cka-cp1 の VM を強制的に落とした。

- 約 19 秒後に VIP が cka-w1 に移り、VIP に送った kubectl がまた応答した
- cka-cp1 は 40〜50 秒ほどで `NotReady` に変わった
- `etcdctl endpoint health`: 2 つの member は healthy、cka-cp1 は `context deadline exceeded`、全体の結果は `unhealthy cluster`。それでも 3 台中 2 台が生きているので API は動き続けた

## 紛らわしいものの比較

| 比較                                                          | A                                                          | B                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `--apiserver-advertise-address` vs `--control-plane-endpoint` | このノードの apiserver が広告する自分の IP                 | すべてのノードがつなぐ共有アドレス (LB)。HA に必要 |
| bootstrap token vs certificate key                            | ノードが初めてクラスタにつなぐときの認証。24 時間          | control plane 証明書を受け取るための復号鍵。2 時間 |
| worker join vs control plane join                             | `kubeadm join <ep> --token --discovery-token-ca-cert-hash` | これに `--control-plane --certificate-key` を追加  |
| `/opt/cni/bin` vs `/etc/cni/net.d`                            | CNI プラグインのバイナリ                                   | CNI の設定。これがあってノードが `Ready`           |
| stacked vs external etcd                                      | control plane ノードに etcd も。最低 3 台                  | etcd は別。最低 3+3 台                             |
| `admin.conf` vs `super-admin.conf`                            | `kubeadm:cluster-admins` グループ。普段使う kubeconfig     | `system:masters` グループ。RBAC を迂回する非常用   |

## 試験のポイント

### 速く解くコマンド

```bash
sudo kubeadm token create --print-join-command     # join コマンドの再発行
sudo kubeadm token list
sudo kubeadm init phase upload-certs --upload-certs # control plane 追加用の鍵の再発行
kubectl -n kube-system get cm kubeadm-config -o yaml # podSubnet、serviceSubnet、etcd dataDir の確認
sudo kubeadm reset                                  # ノードを init/join 前に戻す (best-effort)
```

- ノード準備の段階で確認すること: `swapon --show`、`sysctl net.ipv4.ip_forward`、`grep SystemdCgroup /etc/containerd/config.toml`、`systemctl status containerd kubelet`
- init 直後に `NotReady` なら、まず CNI がインストールされているか確認

### kubectl explain

kubeadm の設定は Kubernetes リソースではないので `kubectl explain` がない。代わりに以下で確認。

```bash
kubeadm config print init-defaults   # InitConfiguration、ClusterConfiguration のデフォルト値
kubeadm config print join-defaults
kubeadm init --help
```

## 参考ドキュメント

- [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)
- [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/)
- [Options for Highly Available Topology](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/ha-topology/)
- [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [kubeadm HA considerations (kube-vip)](https://github.com/kubernetes/kubeadm/blob/main/docs/ha-considerations.md)
- [Calico: Install on on-premises deployments](https://docs.tigera.io/calico/latest/getting-started/kubernetes/self-managed-onprem/onpremises)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
