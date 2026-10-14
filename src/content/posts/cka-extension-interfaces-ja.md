---
title: "CKA 概念ノート: CNI、CSI、CRI と Operator"
description: "kubelet と container runtime の間の CRI、Pod ネットワークをつなぐ CNI、ストレージをつなぐ CSI がノードのどこに設定されているかを確認し、Helm と Kustomize でクラスタコンポーネントをインストールし、Operator が CRD でコンポーネントを管理する仕組みを kubeadm クラスタでまとめました。"
pubDatetime: 2026-10-14T01:06:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "cni", "csi", "cri", "operator", "helm"]
order: 6
---

> 基準: kubeadm クラスタ v1.35.9 (libvirt VM 3 台)、containerd 2.4.1、Calico v3.33.0、Helm v4.3.0 でコマンドを確認

Helm の chart・release・values と Kustomize の base/overlay の基本は [CKAD 概念ノート: Helm と Kustomize](/ja/posts/ckad-helm-kustomize)、CRD の定義と custom resource の基本は [CKAD 概念ノート: CRD、Operator、API deprecation](/ja/posts/ckad-crds-api-deprecations) にまとめた。ここではクラスタコンポーネントをインストールして管理する側だけを扱う。

## 目次

## 3 つのインターフェース

Kubernetes は container の実行、ネットワーク、ストレージを自分では実装せず、標準インターフェースの裏のプラグインに任せる。

| インターフェース                  | 呼び出す側                      | 呼ばれる側               | やること                                         | このクラスタ                    |
| --------------------------------- | ------------------------------- | ------------------------ | ------------------------------------------------ | ------------------------------- |
| CRI (Container Runtime Interface) | kubelet                         | container runtime        | sandbox・container の作成、イメージの pull       | containerd 2.4.1                |
| CNI (Container Network Interface) | container runtime               | CNI プラグインのバイナリ | Pod にネットワークインターフェースと IP を付ける | Calico                          |
| CSI (Container Storage Interface) | kubelet、CSI sidecar controller | CSI driver               | volume の作成、attach、mount                     | `csi.tigera.io` (Calico に内蔵) |

```text
kubelet ──CRI(gRPC)──▶ containerd ──▶ runc (container)
                          └──CNI──▶ /opt/cni/bin/calico (Pod ネットワーク)
kubelet ──CSI(gRPC)──▶ CSI node plugin (DaemonSet)
```

## CRI

kubelet は Unix socket で runtime に CRI の gRPC リクエストを送る。socket のパスは kubelet の設定にある。

```bash
sudo grep containerRuntimeEndpoint /var/lib/kubelet/config.yaml
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock

sudo crictl version
# RuntimeName:  containerd
# RuntimeVersion:  v2.4.1
# RuntimeApiVersion:  v1
```

- `crictl` は CRI クライアント。ノード上の Pod と container を runtime の視点で見る (`crictl pods`、`crictl ps`、`crictl logs`、`crictl images`)
- Kubernetes v1.24 で dockershim が削除された。Docker Engine を使うには cri-dockerd のようなアダプタが必要
- container を実際に作る低レベル runtime は runc。別の低レベル runtime (gVisor、Kata など) を使うなら RuntimeClass で選ぶ。このクラスタには RuntimeClass がない (`kubectl get runtimeclass` → `No resources found`)

## CNI

CNI の設定はノードのファイル 2 か所。

| パス              | 内容                                             |
| ----------------- | ------------------------------------------------ |
| `/etc/cni/net.d/` | CNI の設定ファイル。名前順で最初のファイルを使う |
| `/opt/cni/bin/`   | CNI プラグインのバイナリ                         |

containerd がこのパスを使っているか確認:

```bash
sudo crictl info | grep -A3 '"cni"'
# confDir: /etc/cni/net.d, binDirs: ["/opt/cni/bin"]
```

Calico のインストール後:

```text
$ sudo ls /etc/cni/net.d
10-calico.conflist
calico-kubeconfig
```

`10-calico.conflist` の中にはプラグインのチェーンがある: `calico` (ipam `calico-ipam`) の次に `portmap` (hostPort の処理)。

CNI プラグインがやること:

- Pod sandbox が作られるときに network namespace にインターフェースを作って IP を割り当てる
- 他のノードの Pod までルーティング (Calico はここで VXLAN を使う)
- NetworkPolicy の適用は CNI によって違う。Calico は対応、flannel 単体では非対応

CNI がない、または設定が空だとノードは `NotReady` で、理由は `cni plugin not initialized`。([kubeadm インストールのノート](/ja/posts/cka-kubeadm-install-ha) を参照)

## CSI

CSI driver は普通 2 つの部分に分けてインストールされる。

| 部分              | 形態                                                                            | やること                         |
| ----------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| controller plugin | Deployment/StatefulSet + sidecar (external-provisioner、external-attacher など) | PVC を見て volume を作成、attach |
| node plugin       | DaemonSet + node-driver-registrar                                               | 各ノードで mount                 |

クラスタに登録された driver は CSIDriver オブジェクトとして見える。

```text
$ kubectl get csidriver
NAME            ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   MODES       AGE
csi.tigera.io   true             true             false             Ephemeral   61m
```

```text
$ kubectl -n calico-system get ds
NAME              DESIRED   CURRENT   READY
calico-node       3         3         3
csi-node-driver   3         3         3
```

- StorageClass の `provisioner` が CSI driver の名前。dynamic provisioning がうまくいかなければ、StorageClass の provisioner と `kubectl get csidriver` から突き合わせる
- `csi.tigera.io` は Calico が使う ephemeral 専用の driver なので PV を作らない
- PV、PVC、StorageClass、reclaim policy、access mode は [CKAD 概念ノート: persistent volume と ephemeral volume](/ja/posts/ckad-volumes) を参照

## Helm でコンポーネントをインストール

metrics-server を Helm でインストール。

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo metrics-server
# metrics-server/metrics-server   3.14.0   0.9.0

helm show values metrics-server/metrics-server | grep -A1 '^args'
# args: []

helm install metrics-server metrics-server/metrics-server -n kube-system \
  --set 'args={--kubelet-insecure-tls}'
kubectl top nodes
```

`--kubelet-insecure-tls` を外して upgrade すると、新しい Pod が `0/1 Running` のまま Ready にならない。

```text
"Failed to scrape node" err="Get \"https://192.168.122.21:10250/metrics/resource\":
tls: failed to verify certificate: x509: cannot validate certificate for 192.168.122.21
because it doesn't contain any IP SANs" node="cka-w1"
```

kubeadm のデフォルトの kubelet serving 証明書が自己署名で、ノード IP の SAN がないために起きる。実習では TLS 検証を切り、運用では kubelet の `serverTLSBootstrap: true` でクラスタ CA が署名した serving 証明書を受け取るようにする。

```bash
helm list -n kube-system
helm history metrics-server -n kube-system
helm rollback metrics-server 1 -n kube-system
helm get values metrics-server -n kube-system
# USER-SUPPLIED VALUES:
# args:
# - --kubelet-insecure-tls
```

## Kustomize でコンポーネントをインストール

kustomization があるディレクトリやリモート URL を `kubectl apply -k` でそのまま適用できる。Gateway API の CRD をインストールしてみた。

```bash
kubectl kustomize 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3' \
  | grep -c '^kind: CustomResourceDefinition'
# 10

kubectl apply -k 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3'
kubectl get crd | grep gateway.networking
```

- `kubectl kustomize` (= `kustomize build`) で結果の YAML を先に見てから apply
- この kustomization は CRD 10 個と ValidatingAdmissionPolicy (`safe-upgrades.gateway.networking.k8s.io`) を作る

## Operator

Operator = CRD + その CRD を watch する controller。人がやっていた運用手順 (インストール、設定変更、復旧) を controller が代わりにやる。

Calico は operator 方式でインストールした。

| 構成                | このクラスタ                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| operator Deployment | `tigera-operator/tigera-operator`                                           |
| CRD                 | `operator.tigera.io` グループなど (`kubectl get crd \| grep tigera` → 9 個) |
| custom resource     | `Installation default`、`APIServer default` など                            |
| 状態                | `kubectl get tigerastatus`                                                  |

```bash
kubectl get installation default -o jsonpath='{.spec.calicoNetwork.ipPools}'
# [{"cidr":"10.244.0.0/16","encapsulation":"VXLANCrossSubnet",...}]
```

```text
$ kubectl get tigerastatus
NAME        AVAILABLE   PROGRESSING   DEGRADED
apiserver   True        False         False
calico      True        False         False
...
```

operator が管理するリソースを直接消すと、また作られる。

```bash
kubectl -n calico-system delete ds calico-node
# 15 秒後
kubectl -n calico-system get ds calico-node    # DESIRED 3, READY 3
```

だから operator が管理する DaemonSet や Deployment を直したいなら、そのリソースではなく custom resource (`Installation`) を直す必要がある。直接変更した内容は operator が元に戻す。

### operator のインストール順

1. CRD のインストール (`operator-crds.yaml`)
2. operator のインストール (Deployment、RBAC)
3. custom resource の作成 (`custom-resources.yaml`)

順番が逆になると `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`。

## 紛らわしいものの比較

| 比較                                                    | A                                   | B                                        |
| ------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| CRI vs CNI                                              | kubelet ↔ runtime。container の実行 | runtime ↔ ネットワークプラグイン。Pod IP |
| `/etc/cni/net.d` vs `/opt/cni/bin`                      | 設定                                | バイナリ                                 |
| containerd vs runc                                      | CRI を実装する高レベル runtime      | 実際に container を作る低レベル runtime  |
| CSI controller plugin vs node plugin                    | volume の作成、attach (Deployment)  | ノードで mount (DaemonSet)               |
| `helm install --set` vs `-f values.yaml`                | 値がいくつか                        | 値が多いとき                             |
| `kubectl apply -k` vs `kubectl kustomize`               | ビルドして適用                      | ビルド結果を出力するだけ                 |
| operator のリソースを直接変更 vs custom resource を変更 | operator が元に戻す                 | operator が反映する                      |

## 試験のポイント

### すぐ確認するコマンド

```bash
sudo crictl version; sudo crictl info | grep -A3 '"cni"'
ls /etc/cni/net.d /opt/cni/bin
kubectl get csidriver; kubectl get storageclass
kubectl get runtimeclass

helm repo add <name> <url>; helm repo update; helm search repo <keyword>
helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback / uninstall / list -A / get values

kubectl kustomize <dir|url>
kubectl apply -k <dir|url>

kubectl get crd; kubectl api-resources --api-group=<group>
```

- 「インストールされている CNI は何か」: `/etc/cni/net.d` のファイル名と、`kube-system` や専用 namespace の DaemonSet
- Helm の問題は namespace と release 名を正確に。`-n` を忘れると default namespace にインストールされる

### kubectl explain

```bash
kubectl explain csidriver.spec
kubectl explain runtimeclass.handler
kubectl explain storageclass.provisioner
```

## 参考ドキュメント

- [Extending Kubernetes](https://kubernetes.io/docs/concepts/extend-kubernetes/)
- [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [Volumes: CSI](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [Runtime Class](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [metrics-server Helm chart](https://github.com/kubernetes-sigs/metrics-server/tree/master/charts/metrics-server)
- [Gateway API: Getting started](https://gateway-api.sigs.k8s.io/guides/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
