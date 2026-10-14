---
title: "CKA 概念ノート: Pod ネットワークと CoreDNS"
description: "Kubernetes のネットワークモデル、ノードをまたぐ Pod 通信、kube-proxy が Service を iptables ルールに変える様子、NodePort と LoadBalancer、CoreDNS の Corefile の変更と Pod の dnsPolicy を kubeadm + Calico クラスタで直接確認しました。"
pubDatetime: 2026-10-14T01:09:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "networking", "kube-proxy", "coredns", "dns"]
order: 9
---

> 基準: kubeadm クラスタ v1.35.9 (libvirt VM 3 台、ノードネットワーク 192.168.122.0/24)、Calico v3.33.0、CoreDNS v1.13.1 でコマンドを確認

Service type、selector と EndpointSlice、Ingress、NetworkPolicy の基本は [CKAD 概念ノート: Service、Ingress、NetworkPolicy](/ja/posts/ckad-services-ingress-networkpolicy) にまとめた。ここではノードとクラスタの側で見るものだけ。

## 目次

## ネットワークモデル

Kubernetes が CNI に求めること:

- Pod ごとにクラスタ内で一意の IP
- すべての Pod は NAT なしで他のすべての Pod と通信できる (同じノードでも別のノードでも)
- ノードの agent (kubelet など) はそのノードの Pod と通信できる

3 つの IP 帯域が重なってはいけない。

| 帯域                 | このクラスタ       | 決める場所                                    |
| -------------------- | ------------------ | --------------------------------------------- |
| ノードネットワーク   | `192.168.122.0/24` | インフラ (libvirt)                            |
| Pod ネットワーク     | `10.244.0.0/16`    | `kubeadm init --pod-network-cidr`、CNI の設定 |
| Service ネットワーク | `10.96.0.0/12`     | `kubeadm init --service-cidr` (デフォルト)    |

## Pod IP はどこから来るのか

```text
$ kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR
NAME      PODCIDR
cka-cp1   10.244.0.0/24
cka-w1    10.244.1.0/24
cka-w2    10.244.2.0/24
```

controller-manager が `--allocate-node-cidrs=true` なので、ノードごとに `/24` を割り当てる。ところが実際の Pod IP は `10.244.95.x`、`10.244.62.x` だった。Calico は `node.spec.podCIDR` を使わず、独自の IPAM ブロックを使う。

```text
$ kubectl get blockaffinities -o custom-columns=NODE:.spec.node,CIDR:.spec.cidr
NODE      CIDR
cka-cp1   10.244.212.128/26
cka-w1    10.244.95.128/26
cka-w2    10.244.62.128/26
```

`podCIDR` を使う CNI (flannel など) もあるので、Pod IP がどの帯域から出るかは CNI によって違う。

## ノードをまたぐ Pod 通信

cka-w1 の busybox Pod から cka-w2 の nginx Pod の IP に直接リクエスト:

```bash
kubectl exec c -- wget -qO- -T3 http://10.244.62.167
# <title>Welcome to nginx!</title>
```

Service なしで Pod IP に直接届く。Calico はノード間を VXLAN (`vxlan.calico` インターフェース) で包む。

## kube-proxy

Service は実体のない仮想 IP。各ノードの kube-proxy が Service と EndpointSlice を watch してパケットのルールに変える。

| mode       | 方式                   | 備考               |
| ---------- | ---------------------- | ------------------ |
| `iptables` | iptables の NAT ルール | Linux のデフォルト |
| `ipvs`     | カーネルの IPVS        |                    |
| `nftables` | nftables のルール      |                    |

```bash
kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep '^mode'
# mode: ""        ← 空 = Linux では iptables
```

Service `net/web` (ClusterIP `10.111.80.136`、endpoint 2 つ) が作ったルール:

```text
-A KUBE-SERVICES -d 10.111.80.136/32 -p tcp -m comment --comment "net/web cluster IP" -m tcp --dport 80 -j KUBE-SVC-RTHZXQ2YZKSHM2PI
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.62.167:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-S3UT2MK4P7AJ67WG
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.95.170:80" -j KUBE-SEP-JIQR6UIXHEWKPI63
-A KUBE-NODEPORTS -p tcp -m comment --comment "net/web" -m tcp --dport 31777 -j KUBE-EXT-RTHZXQ2YZKSHM2PI
```

- `KUBE-SERVICES`: ClusterIP:port を見て Service のチェーンへ
- `KUBE-SVC-*`: endpoint の中から 1 つを確率で選ぶ (2 つなら 0.5)
- `KUBE-SEP-*`: 実際の Pod IP:port に DNAT
- `KUBE-NODEPORTS`: NodePort から入ってきたもの

Service に endpoint がなければ `KUBE-SVC-*` に行き先がない。「Service はあるのにつながらない」なら EndpointSlice から確認。

```bash
kubectl get endpointslice -l kubernetes.io/service-name=web
# NAME        ADDRESSTYPE   PORTS   ENDPOINTS
# web-4bnv6   IPv4          80      10.244.62.167,10.244.95.170
```

## NodePort と LoadBalancer

```bash
kubectl expose deploy web --port=80 --type=NodePort
# web   NodePort   10.111.80.136   <none>   80:31777/TCP
```

NodePort はすべてのノードで開く。Pod がない control plane の IP にリクエストしても応答する。

```text
192.168.122.11:31777  <title>Welcome to nginx!</title>   (cka-cp1、Pod なし)
192.168.122.21:31777  <title>Welcome to nginx!</title>
192.168.122.22:31777  <title>Welcome to nginx!</title>
```

LoadBalancer は外部 LB を作ってくれる実装 (クラウドの controller、MetalLB など) がないと IP が付かない。このクラスタにはないので `<pending>`。

```text
$ kubectl create svc loadbalancer lb --tcp=80:80
lb   LoadBalancer   10.111.57.195   <pending>   80:30363/TCP
```

LoadBalancer Service も NodePort (`30363`) を一緒に受け取るので、`<pending>` の状態でも NodePort からはアクセスできる。

## CoreDNS

### 構成

```text
$ kubectl -n kube-system get deploy coredns
coredns   2/2

$ kubectl -n kube-system get svc kube-dns
kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP,9153/TCP
```

- Deployment の名前は `coredns`、Service の名前は互換性のため `kube-dns`
- `10.96.0.10` は kubelet 設定の `clusterDNS` と同じ値。kubelet が Pod の `/etc/resolv.conf` にこのアドレスを入れる

### Corefile

設定は `kube-system/coredns` ConfigMap の `Corefile`。

```text
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
```

| plugin                         | やること                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| `kubernetes cluster.local ...` | Service、Pod のレコードに応答。`pods insecure` なら Pod IP のレコードも |
| `forward . /etc/resolv.conf`   | クラスタ外の名前はノード (CoreDNS Pod) の resolv.conf のサーバーへ      |
| `cache 30`                     | 30 秒のキャッシュ                                                       |
| `reload`                       | Corefile が変わったら再起動なしで読み直す                               |
| `health`、`ready`              | liveness (8080)、readiness (8181)                                       |

### Corefile の変更

`hosts` plugin でクラスタ外の名前を 1 つ固定してみた。

```bash
kubectl -n kube-system edit cm coredns
```

```text
    ready
    hosts {
       192.168.122.200 legacy.example.internal
       fallthrough
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
```

- `reload` plugin があるので CoreDNS を再起動しなくても反映される。ログに `[INFO] Reloading`
- 反映まで 82 秒かかった。ConfigMap volume が Pod 内のファイルに反映される時間 + reload の周期。急ぐなら `kubectl -n kube-system rollout restart deploy coredns`
- 特定のドメインだけ別の DNS サーバーに送るなら server block を追加 (`example.internal:53 { forward . 10.0.0.53 }`)

## DNS 名

| 対象                    | 名前                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Service                 | `<service>.<namespace>.svc.cluster.local`                                                     |
| Pod                     | `<IP の . を - に>.<namespace>.pod.cluster.local` (例: `10-244-62-167.net.pod.cluster.local`) |
| headless Service の Pod | `<hostname>.<service>.<namespace>.svc.cluster.local`                                          |

Pod の `/etc/resolv.conf` (`dnsPolicy: ClusterFirst`、デフォルト):

```text
search net.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

- 同じ namespace なら `web`、別の namespace なら `web.other` でも引けるのが正常
- busybox:1.36 の `nslookup web` は `** server can't find web.svc.cluster.local: NXDOMAIN` で失敗した。FQDN (`web.net.svc.cluster.local`) なら成功。busybox で確認するときは FQDN を使うのが安全

## dnsPolicy

| dnsPolicy                   | resolv.conf                               | 実習の結果                                             |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `ClusterFirst` (デフォルト) | CoreDNS + search のリスト                 | 上と同じ                                               |
| `Default`                   | Pod が動くノードの resolv.conf をそのまま | `nameserver 192.168.122.1`。クラスタ内の名前は引けない |
| `ClusterFirstWithHostNet`   | hostNetwork Pod でも CoreDNS を使う       | `nameserver 10.96.0.10` + search のリスト              |
| `None`                      | `dnsConfig` だけを使う                    | 下                                                     |

- 名前に反して `Default` はデフォルト値ではない
- `hostNetwork: true` で `dnsPolicy` を書かない (`ClusterFirst`) と、ノードの resolv.conf (`192.168.122.1`) が入る。CoreDNS を使うなら `ClusterFirstWithHostNet`

```yaml
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers: [1.1.1.1]
    searches: [example.internal]
    options:
      - name: ndots
        value: "2"
```

```text
search example.internal
nameserver 1.1.1.1
options ndots:2
```

## 紛らわしいものの比較

| 比較                                       | A                                   | B                                                                    |
| ------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------- |
| `--pod-network-cidr` vs `--service-cidr`   | Pod IP                              | Service ClusterIP                                                    |
| `node.spec.podCIDR` vs 実際の Pod IP       | controller-manager が割り当てた帯域 | CNI の IPAM が決める。Calico は独自のブロック                        |
| kube-proxy vs CNI                          | Service → Pod (DNAT)                | Pod ↔ Pod の接続                                                     |
| ClusterIP vs NodePort                      | クラスタ内だけ                      | すべてのノード IP の 30000-32767                                     |
| NodePort vs LoadBalancer                   | ノード IP:port                      | 外部 LB の IP。実装がなければ `<pending>`。NodePort も一緒に受け取る |
| `kube-dns` Service vs `coredns` Deployment | 名前だけ kube-dns                   | 実際のサーバー                                                       |
| `dnsPolicy: Default` vs `ClusterFirst`     | ノードの DNS                        | CoreDNS (実際のデフォルト値)                                         |

## 試験のポイント

### すぐ確認するコマンド

```bash
kubectl get nodes -o wide; kubectl get pods -o wide            # ノード IP、Pod IP
kubectl -n kube-system get cm kubeadm-config -o yaml | grep -E "podSubnet|serviceSubnet"
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode
kubectl get svc,endpointslice
kubectl -n kube-system get cm coredns -o yaml
kubectl -n kube-system edit cm coredns
kubectl -n kube-system rollout restart deploy coredns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup <svc>.<ns>.svc.cluster.local
sudo iptables -t nat -S | grep <namespace>/<service>
```

- Pod CIDR、Service CIDR を問う問題は、`kubeadm-config` ConfigMap や apiserver (`--service-cluster-ip-range`)、controller-manager (`--cluster-cidr`) の manifest から探す
- Pod レコードの名前は IP のドットをダッシュに

### kubectl explain

```bash
kubectl explain pod.spec.dnsPolicy
kubectl explain pod.spec.dnsConfig
kubectl explain service.spec.type
```

## 参考ドキュメント

- [Services, Load Balancing, and Networking](https://kubernetes.io/docs/concepts/services-networking/)
- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [CoreDNS plugins](https://coredns.io/plugins/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
