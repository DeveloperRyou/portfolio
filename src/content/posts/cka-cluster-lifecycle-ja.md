---
title: "CKA 概念ノート: クラスタの upgrade、etcd バックアップ、証明書"
description: "version skew のルール、kubeadm で 1.34 から 1.35 に上げる手順と drain/uncordon、etcdctl・etcdutl による etcd のバックアップと復元、kubeadm 証明書の確認と更新を VM クラスタで直接実行しながらまとめました。"
pubDatetime: 2026-10-14T01:04:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "upgrade", "etcd", "certificates"]
order: 4
---

> 基準: kubeadm クラスタ v1.34.12 → v1.35.9 (libvirt VM 3 台: control plane 1、worker 2)、etcd 3.6.5 / 3.6.6、etcdctl・etcdutl 3.6.5 でコマンドを確認

## 目次

## version skew

upgrade の順番は「どのコンポーネントが apiserver よりどれだけ先行・遅れてもいいか」から決まる。

| コンポーネント                          | kube-apiserver に対する許容範囲       |
| --------------------------------------- | ------------------------------------- |
| kube-apiserver (HA)                     | apiserver 同士で minor 1 つ差まで     |
| kube-controller-manager、kube-scheduler | 同じか 1 minor 低い。高いのは不可     |
| kubelet                                 | 同じか最大 3 minor 低い。高いのは不可 |
| kube-proxy                              | 同じか最大 3 minor 低い。高いのは不可 |
| kubectl                                 | ±1 minor                              |

ここから出てくるルール:

- control plane を先に、kubelet を後に上げる
- minor バージョンは飛ばせない。1.33 → 1.35 は 1.34 を経由する必要がある。patch は飛ばしてもいい

## upgrade の順番

| 順番 | ノード               | コマンド                                                                                                          |
| ---- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | 最初の control plane | リポジトリ変更 → kubeadm インストール → `kubeadm upgrade plan` → `kubeadm upgrade apply v1.35.9`                  |
| 2    | 残りの control plane | kubeadm インストール → `kubeadm upgrade node`                                                                     |
| 3    | 各 control plane     | drain → kubelet、kubectl インストール → kubelet 再起動 → uncordon                                                 |
| 4    | worker を 1 台ずつ   | kubeadm インストール → `kubeadm upgrade node` → drain → kubelet、kubectl インストール → kubelet 再起動 → uncordon |

`kubeadm upgrade apply` はクラスタ全体で 1 回だけ。残りのノードはすべて `kubeadm upgrade node`。

## control plane の upgrade

### リポジトリと kubeadm

`pkgs.k8s.io` は minor バージョンごとにリポジトリが違うので、リポジトリ行のバージョンから変えないと新しいバージョンが見えない。

```bash
sudo sed -i 's#v1.34#v1.35#g' /etc/apt/sources.list.d/kubernetes.list
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo apt-get update
sudo apt-cache madison kubeadm
#    kubeadm | 1.35.9-1.1 | https://pkgs.k8s.io/core:/stable:/v1.35/deb  Packages
#    kubeadm | 1.35.8-1.1 | ...

sudo apt-mark unhold kubeadm && \
sudo apt-get install -y kubeadm='1.35.9-*' && \
sudo apt-mark hold kubeadm
kubeadm version -o short   # v1.35.9
```

### upgrade plan

```bash
sudo kubeadm upgrade plan
```

```text
[upgrade/versions] Cluster version: 1.34.12
[upgrade/versions] kubeadm version: v1.35.9
remote version is much newer: v1.37.1; falling back to: stable-1.35
Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':
COMPONENT   NODE      CURRENT    TARGET
kubelet     cka-cp1   v1.34.12   v1.35.9
kubelet     cka-w1    v1.34.12   v1.35.9
kubelet     cka-w2    v1.34.12   v1.35.9

COMPONENT                 NODE      CURRENT    TARGET
kube-apiserver            cka-cp1   v1.34.12   v1.35.9
kube-controller-manager   cka-cp1   v1.34.12   v1.35.9
kube-scheduler            cka-cp1   v1.34.12   v1.35.9
kube-proxy                          1.34.12    v1.35.9
CoreDNS                             v1.12.1    v1.13.1
etcd                      cka-cp1   3.6.5-0    3.6.6-0
```

- kubelet は kubeadm が上げてくれない。上の表が「自分でやること」
- control plane の static Pod を再起動した直後に plan を実行したら `[ERROR CreateJob]: Job "upgrade-health-check-..." ... did not complete in 15s` で失敗した。30 秒後にもう一度実行したら通った。plan と apply は最初に health check Job を起動してクラスタの状態を見る

### upgrade apply

```bash
sudo kubeadm upgrade apply v1.35.9
```

apply がやること:

- etcd、kube-apiserver、kube-controller-manager、kube-scheduler の順に manifest を書き直し、kubelet が static Pod を起動し直すまで待つ
- 以前の manifest は `/etc/kubernetes/tmp/kubeadm-backup-manifests-<日付>/` に、etcd のデータは `kubeadm-backup-etcd-<日付>/` にバックアップ
- コンポーネントごとに証明書を更新 (`Renewing apiserver certificate` など)
- `kube-system/kubelet-config` ConfigMap の更新、CoreDNS と kube-proxy の addon upgrade
- 最後の行: `[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.35.9".`

apply が終わっても `kubectl get nodes` の VERSION は `v1.34.12` のまま。この列は kubelet のバージョンなので、kubelet を上げるまで変わらない。

### kubelet、kubectl

```bash
kubectl drain cka-cp1 --ignore-daemonsets

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && \
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon cka-cp1
```

drain 中は `Ready,SchedulingDisabled`、uncordon 後は `Ready` と `v1.35.9`。

## worker の upgrade

```bash
# worker で: リポジトリを変えた後
sudo apt-mark unhold kubeadm && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade node
# [upgrade/addon] Skipping the addon/kube-proxy phase. Not a control plane node.

# control plane (kubectl がある場所) で
kubectl drain cka-w1 --ignore-daemonsets

# worker で
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet

# control plane で
kubectl uncordon cka-w1
```

worker の `kubeadm upgrade node` は kubelet の設定 (`/var/lib/kubelet/config.yaml`) を新しく受け取るだけ。drain は worker ではなく kubeconfig がある場所で実行。

## drain、cordon、uncordon

| コマンド                  | スケジュールを止める | 既存の Pod          |
| ------------------------- | -------------------- | ------------------- |
| `kubectl cordon <node>`   | O                    | そのまま            |
| `kubectl drain <node>`    | O (先に cordon)      | eviction で追い出す |
| `kubectl uncordon <node>` | 解除                 | 変化なし            |

オプションなしで drain すると拒否されるケース:

```text
cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore):
  calico-system/calico-node-..., calico-system/csi-node-driver-..., kube-system/kube-proxy-...
cannot delete Pods that declare no controller (use --force to override): default/plain
```

| 状況                     | オプション               | 結果                            |
| ------------------------ | ------------------------ | ------------------------------- |
| DaemonSet の Pod         | `--ignore-daemonsets`    | スキップ。ノードにそのまま残る  |
| controller のない Pod    | `--force`                | 削除。作り直されない            |
| emptyDir を使う Pod      | `--delete-emptydir-data` | 削除。emptyDir のデータは消える |
| PodDisruptionBudget 違反 | (なし)                   | 再試行を続ける                  |

- drain が失敗しても cordon はすでにかかっている。もう一度 drain すると `node/cka-w2 already cordoned`
- `minAvailable: 2` の PDB がかかった replicas 2 の Deployment のノードを drain すると、`Cannot evict pod as it would violate the pod's disruption budget.` が 5 秒ごとに繰り返される。`--timeout=10s` を付けると `global timeout reached: 10s` で終わる
- uncordon しても Pod は元のノードに戻らない。実習では worker 2 台を順に drain したら、replicas 4 つが全部 cka-w1 に集まっていた

## etcd のバックアップと復元

### ツール

| ツール    | 用途                                 | 備考                                  |
| --------- | ------------------------------------ | ------------------------------------- |
| `etcdctl` | 動いている etcd にネットワークで接続 | `snapshot save`                       |
| `etcdutl` | etcd のデータファイルを直接扱う      | `snapshot status`、`snapshot restore` |

etcd 3.6.5 の `etcdctl snapshot` には `save` だけが残っている。status と restore は `etcdutl` で。

```text
$ etcdctl snapshot --help
COMMANDS:
  save	Stores an etcd node backend snapshot to a given file
```

kubeadm のノードにはどちらもデフォルトでは入っていないので、etcd イメージのバージョン (`registry.k8s.io/etcd:3.6.5-0`) に合わせて GitHub release から取得した。

### 接続情報を探す

必要な値はすべて etcd の static Pod manifest にある。

```bash
sudo grep -E "listen-client-urls|cert-file|key-file|trusted-ca-file|data-dir" /etc/kubernetes/manifests/etcd.yaml
#    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
#    - --data-dir=/var/lib/etcd
#    - --key-file=/etc/kubernetes/pki/etcd/server.key
#    - --listen-client-urls=https://127.0.0.1:2379,https://192.168.122.11:2379
#    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
```

### バックアップ

```bash
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db
# Snapshot saved at /opt/etcd-backup.db

sudo etcdutl --write-out=table snapshot status /opt/etcd-backup.db
```

```text
+----------+----------+------------+------------+---------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |
+----------+----------+------------+------------+---------+
| 2e711e8a |     2202 |        767 |      11 MB |   3.6.0 |
+----------+----------+------------+------------+---------+
```

### 復元

確認方法: バックアップ前に ConfigMap `before-backup`、バックアップ後に `after-backup` を作ってから復元。復元後は `before-backup` だけがあるはず。

```bash
# 1. 新しい data dir に復元
sudo etcdutl --data-dir /var/lib/etcd-from-backup snapshot restore /opt/etcd-backup.db

# 2. etcd manifest の hostPath を新しいパスに
sudo vi /etc/kubernetes/manifests/etcd.yaml
```

```yaml
volumes:
  - hostPath:
      path: /var/lib/etcd-from-backup # 元は /var/lib/etcd
      type: DirectoryOrCreate
    name: etcd-data
```

- container の中の `--data-dir=/var/lib/etcd` と `mountPath` はそのまま。ホスト側のパスだけ変えればいい
- manifest を直してから kubelet が etcd Pod を起動し直すまで 1 分以上かかった

ここで一度混乱した。etcd が新しいデータで起動した後も、`kubectl get cm` には `after-backup` が表示され続けた。`etcdctl get /registry/configmaps/backup-test --prefix --keys-only` で etcd を直接見ると、`after-backup` はもうなかった。apiserver の watch cache が復元前の状態を持っていたということ。

```bash
# 3. control plane コンポーネントを再起動 (static Pod は manifest を出し入れすると再起動する)
cd /etc/kubernetes/manifests
sudo mv kube-apiserver.yaml kube-controller-manager.yaml kube-scheduler.yaml /tmp/
# container が落ちるまで待ってから
sudo mv /tmp/kube-apiserver.yaml /tmp/kube-controller-manager.yaml /tmp/kube-scheduler.yaml .
sudo systemctl restart kubelet
```

再起動後は `before-backup` だけが残る。公式ドキュメントも、復元後にすべての apiserver の再起動と、scheduler・controller-manager・kubelet の再起動を推奨している。

### 復元後の upgrade に注意

hostPath だけ変えた状態で `kubeadm upgrade apply` をしたら、kubeadm が etcd manifest を `kubeadm-config` の `etcd.local.dataDir` (`/var/lib/etcd`) を基準に書き直し、hostPath が `/var/lib/etcd` に戻った。etcd が復元前のデータで起動し直し、続いて apiserver の段階で `context deadline exceeded` になって upgrade が失敗した。

実際のクラスタなら、復元データを元のパスに置くか、`kubeadm-config` の dataDir も一緒に変える必要がある。この実習では VM の snapshot で戻して、きれいな状態から upgrade をやり直した。

## 証明書

### 期限の確認

```bash
sudo kubeadm certs check-expiration
```

```text
CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY
admin.conf                 Oct 13, 2027 16:21 UTC   364d            ca
apiserver                  Oct 13, 2027 16:21 UTC   364d            ca
apiserver-etcd-client      Oct 13, 2027 16:21 UTC   364d            etcd-ca
apiserver-kubelet-client   Oct 13, 2027 16:21 UTC   364d            ca
controller-manager.conf    Oct 13, 2027 16:21 UTC   364d            ca
etcd-healthcheck-client    Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-peer                  Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-server                Oct 13, 2027 16:21 UTC   364d            etcd-ca
front-proxy-client         Oct 13, 2027 16:21 UTC   364d            front-proxy-ca
scheduler.conf             Oct 13, 2027 16:21 UTC   364d            ca
super-admin.conf           Oct 13, 2027 16:21 UTC   364d            ca

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME
ca                      Oct 10, 2036 16:21 UTC   9y
etcd-ca                 Oct 10, 2036 16:21 UTC   9y
front-proxy-ca          Oct 10, 2036 16:21 UTC   9y
```

- leaf 証明書は 1 年、CA は 10 年
- `kubelet.conf` は一覧にない。kubelet のクライアント証明書は kubelet が自分で更新し、`/var/lib/kubelet/pki/kubelet-client-current.pem` の symlink が最新のファイルを指す
- 個別の確認: `sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate`

### 更新

| 方法                                     | いつ                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `kubeadm upgrade apply` / `upgrade node` | upgrade のときに自動更新。1 年以内に 1 回 upgrade していれば別途やることはない |
| `kubeadm certs renew all`                | 手動更新。名前を指定すれば 1 つだけ (`kubeadm certs renew apiserver`)          |

```bash
sudo kubeadm certs renew all
# Done renewing certificates. You must restart the kube-apiserver, kube-controller-manager,
# kube-scheduler and etcd, so that they can use the new certificates.
```

- 更新後に control plane の static Pod の再起動が必要
- `~/.kube/config` は `admin.conf` をコピーしたものなので自動では変わらない。コピーし直す

## 紛らわしいものの比較

| 比較                                      | A                                                          | B                                                                         |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `kubeadm upgrade apply` vs `upgrade node` | 最初の control plane で 1 回。クラスタのバージョンを上げる | 残りの control plane と worker。そのノードの manifest と kubelet 設定だけ |
| `kubectl get nodes` の VERSION            | kubelet のバージョン                                       | control plane のバージョンは `kubectl version` か static Pod のイメージ   |
| cordon vs drain                           | スケジュールを止めるだけ                                   | スケジュールを止めて Pod を追い出す                                       |
| `--ignore-daemonsets` vs `--force`        | DaemonSet の Pod をスキップ                                | controller のない Pod を削除                                              |
| `etcdctl` vs `etcdutl`                    | 動いている etcd に接続。save                               | ファイルを直接。status、restore                                           |
| `--data-dir` vs hostPath                  | container 内のパス。そのまま                               | ホストのパス。復元したディレクトリに変える                                |
| leaf vs CA 証明書                         | 1 年。renew で更新                                         | 10 年。renew の対象外                                                     |

## 試験のポイント

### 速く解くコマンド

```bash
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9
sudo kubeadm upgrade node
kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
kubectl uncordon <node>

sudo cat /etc/kubernetes/manifests/etcd.yaml | grep -E "file|urls|data-dir"
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=... --cert=... --key=... snapshot save <file>
sudo etcdutl --data-dir <new-dir> snapshot restore <file>

sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
```

- upgrade の問題は、ノードごとにどこで実行するか (ssh 先のノード vs kubectl があるノード) を混同しやすい
- etcd の証明書パスは覚えずに `etcd.yaml` からコピー
- 復元後に `kubectl` の結果が変わらなければ、まず apiserver の再起動を疑う

### kubectl explain

```bash
kubectl explain poddisruptionbudget.spec   # minAvailable, maxUnavailable, selector
kubectl explain node.spec.unschedulable    # cordon が変えるフィールド
kubectl drain --help
```

## 参考ドキュメント

- [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [etcd: etcdutl](https://github.com/etcd-io/etcd/blob/main/etcdutl/README.md)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
