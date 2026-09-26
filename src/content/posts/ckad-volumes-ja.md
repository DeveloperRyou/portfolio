---
title: "CKAD 概念ノート: persistent volume と ephemeral volume"
description: "container filesystem と volume の違いから、emptyDir、hostPath、configMap volume、PV/PVC の binding、access mode、reclaim policy、StorageClass、generic ephemeral volume までを公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:11:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "volume", "persistentvolume", "storageclass"]
order: 12
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### container filesystem だけでは足りない理由

- container がクラッシュすると、kubelet は container を**きれいな状態で**再起動する。container の中で書いたファイルは消える
- 同じ Pod の中の複数の container がファイルを共有する方法がない
- volume はこの二つの問題を解くための手段。公式ドキュメントの定義: "a directory, possibly with some data in it, which is accessible to the containers in a pod"

### ephemeral vs persistent

| 区分              | 寿命                                             | 例                                                                         |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| ephemeral volume  | Pod と同じ。Pod が消えると一緒に削除             | `emptyDir`、`configMap`、`secret`、`downwardAPI`、generic ephemeral volume |
| persistent volume | Pod とは無関係。Pod が入れ替わってもデータを維持 | `persistentVolumeClaim` で付けた PV                                        |

どちらも **container の再起動**ではデータが残る。違いは Pod が削除されたときに現れる。

### volume の宣言の構造

- `spec.volumes[]`: Pod が使う volume の定義 (種類とソース)
- `spec.containers[].volumeMounts[]`: container ごとにどこにマウントするか。container ごとに指定する必要がある
- `volumeMounts[].name` は `spec.volumes[].name` と一致しなければならない
- volume の中に別の volume をマウントすることはできない (似た用途には `subPath`)

### 主な volume の種類

**emptyDir**

- Pod がノードに割り当てられたときに空のディレクトリとして作られ、Pod がノードから取り除かれると永久に削除
- container のクラッシュでは Pod は取り除かれないので、データは残る
- 用途: scratch 領域、同じ Pod の container 間のファイル共有 (sidecar パターン)
- `medium: Memory` → tmpfs。速いが、書いたファイルはその container の memory limit に加算される
- `sizeLimit` でサイズの上限

**hostPath**

- ノードのファイル/ディレクトリを Pod にマウント
- 公式ドキュメントの警告: セキュリティ上のリスクが多いので、避けられるなら避けること (代わりに `local` PV を提示)
- 同じ設定の Pod でも、ノードごとにファイルの中身が違って動作が変わることがある
- `type`: `""` (検査しない)、`DirectoryOrCreate`、`Directory`、`FileOrCreate`、`File`、`Socket`、`CharDevice`、`BlockDevice`

**configMap**

- ConfigMap のデータをファイルとしてマウント。キー一つがファイル一つ
- `items[].key`/`items[].path` で特定のキーだけを、好きなファイル名で
- 常に read-only でマウント
- ConfigMap を先に作っておく必要がある
- `subPath` でマウントすると、ConfigMap が変わっても container に反映されない

**persistentVolumeClaim**

- PVC を通じて PV を Pod にマウント。下の「動作の仕組み」を参照

## 動作の仕組み

### PV と PVC

- **PersistentVolume (PV)**: クラスタのストレージの一片。管理者が作るか、StorageClass で動的に作られる。cluster-scoped で、Pod とは独立した寿命
- **PersistentVolumeClaim (PVC)**: ユーザーのストレージのリクエスト。サイズと access mode を要求する。namespace のリソースなので、**使う Pod と同じ namespace** になければならない
- Pod は PV を直接参照せず、PVC を参照する

### provisioning

| 方式    | 流れ                                                                               |
| ------- | ---------------------------------------------------------------------------------- |
| static  | 管理者が PV を先に作成 → PVC が条件に合う PV に binding                            |
| dynamic | 合う static PV がなければ、PVC が要求した StorageClass の provisioner が PV を作る |

- `storageClassName: ""` の PVC は、自分で dynamic provisioning をオフにする
- dynamic provisioning のデフォルトの動作には、API server の `DefaultStorageClass` admission controller が必要

### binding のルール

- control plane の control loop が新しい PVC を見て、合う PV を探して binding する
- 1:1 の対応。PV と PVC の両方が `claimRef` でお互いを指す。一度結ばれると排他的
- 要求以上のものを受け取ることはある (8Gi の要求に 10Gi の PV が結ばれることがある)
- 合う PV がなければ PVC は**無期限に Pending**。条件に合う PV ができたらその時点で binding
- マッチングの条件: サイズ、access mode、`storageClassName` の一致、`selector` (あれば)、`volumeMode`
- `volumeName` で特定の PV を指定して事前に binding できる。その PV がすでに別の PVC に結ばれていれば Pending で止まる

### storageClassName の三つのケース

| PVC の設定               | 動作                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `storageClassName: fast` | 同じ class の PV だけ binding。なければ `fast` class で dynamic provisioning                            |
| `storageClassName: ""`   | class のない PV だけ binding。dynamic provisioning はしない                                             |
| フィールドを省略         | default StorageClass があればその値が入る。なければ unset のまま残り、後で default ができたら更新される |

`""` と省略は違う。static PV に結び付けたいのにクラスタに default StorageClass があるなら、`""` を明示する必要がある。

### access mode

| モード           | 略称 | 意味                                                                              |
| ---------------- | ---- | --------------------------------------------------------------------------------- |
| ReadWriteOnce    | RWO  | **ノード一つ**で read-write マウント。同じノードの Pod なら複数からアクセスできる |
| ReadOnlyMany     | ROX  | 複数のノードから read-only                                                        |
| ReadWriteMany    | RWX  | 複数のノードから read-write                                                       |
| ReadWriteOncePod | RWOP | **Pod 一つ**だけが read-write (v1.29 で stable、CSI volume のみ)                  |

- volume が複数のモードに対応していても、**一度に一つのモードでだけ**マウントされる
- RWO/ROX/RWX は volume に実際の制約をかけない。ROX で作っても read-only が保証されるわけではない。単一 Pod に制約するのは RWOP だけ
- 対応するモードは volume plugin ごとに違う (例: HostPath は RWO のみ)

### volumeMode

- `Filesystem` (デフォルト): ディレクトリとしてマウント
- `Block`: ファイルシステムのない raw block device として公開

### reclaim policy

PVC が削除された後に PV をどうするか。PV の `persistentVolumeReclaimPolicy` フィールド。

| ポリシー  | 動作                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Retain`  | PV が残り `Released` 状態に。以前のデータが残っているので、別の PVC にすぐには binding されない。管理者が手動で片付ける |
| `Delete`  | PV オブジェクトと外部のストレージ資産を一緒に削除                                                                       |
| `Recycle` | deprecated。`rm -rf /thevolume/*` の後に再利用。公式ドキュメントは dynamic provisioning を勧めている                    |

- 手動で作った PV のデフォルトは `Retain`
- dynamic provisioning で作られた PV は StorageClass の `reclaimPolicy` を引き継ぎ、そのデフォルトは `Delete`

### PV の phase

| phase       | 意味                            |
| ----------- | ------------------------------- |
| `Available` | まだどの PVC にも結ばれていない |
| `Bound`     | PVC に結ばれている              |
| `Released`  | PVC は削除されたが、まだ回収前  |
| `Failed`    | 自動回収に失敗                  |

### Storage Object in Use Protection

- Pod が使用中の PVC、PVC に結ばれた PV は、削除をリクエストしてもすぐには消えない (finalizer で保留)
- PVC を使う Pod がいなくなった後に実際に削除される

### StorageClass

- `apiVersion: storage.k8s.io/v1`、cluster-scoped
- フィールド: `provisioner` (必須)、`parameters`、`reclaimPolicy` (デフォルト `Delete`)、`allowVolumeExpansion`、`volumeBindingMode` (デフォルト `Immediate`)、`mountOptions`
- 名前がそのまま PVC が要求する class 名。管理者が最初に作るときに名前とパラメータを決める
- default の指定: annotation `storageclass.kubernetes.io/is-default-class: "true"`。複数あれば最も新しいものが使われる

| volumeBindingMode      | 動作                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `Immediate`            | PVC の作成と同時に binding・provisioning                                                      |
| `WaitForFirstConsumer` | その PVC を使う Pod ができるまで遅延。scheduler が Pod の配置を考慮して volume の場所を決める |

`WaitForFirstConsumer` で Pod に `nodeName` を書くと、scheduler を迂回するので PVC が Pending のままになる。公式ドキュメントは代わりに `kubernetes.io/hostname` の nodeSelector を提示している。

### PVC の拡張

- StorageClass が `allowVolumeExpansion: true` のとき、PVC の `spec.resources.requests.storage` を増やせば拡張
- 縮小はサポートしていない

### generic ephemeral volume

- Pod spec の `volumes[].ephemeral.volumeClaimTemplate` に PVC の spec をインラインで書く (v1.23 で stable)
- Pod の作成時に ephemeral volume controller が同じ namespace に PVC を作り、Pod がその PVC の owner になる
- PVC 名: `<Pod 名>-<volume 名>`。例: Pod `my-app` + volume `scratch-volume` → `my-app-scratch-volume`
- Pod が削除されると garbage collector が PVC を削除。StorageClass の reclaim policy がデフォルトで `Delete` なので、普通は volume も一緒に消える
- `emptyDir` と似た用途だが、ネットワークストレージ、固定サイズ、snapshot/clone/resize のようなストレージドライバの機能を使える
- 名前の衝突に注意: Pod `pod-a` + volume `scratch` と、Pod `pod` + volume `a-scratch` はどちらも `pod-a-scratch`。同じ namespace の手動の PVC とも衝突しうる。衝突すると既存の PVC には触れないが、Pod が起動できない
- 公式ドキュメントのおすすめの binding mode: `WaitForFirstConsumer`

## 例

### emptyDir: container 間の共有

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-scratch
spec:
  containers:
    - name: writer
      image: busybox:1.36
      command:
        ["sh", "-c", "while true; do date >> /data/log.txt; sleep 5; done"]
      volumeMounts:
        - name: scratch
          mountPath: /data
    - name: reader
      image: busybox:1.36
      command: ["sh", "-c", "tail -F /data/log.txt"]
      volumeMounts:
        - name: scratch
          mountPath: /data
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 500Mi
```

### configMap volume: キー一つだけをファイルに

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: configmap-pod
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "cat /etc/config/log_level.conf && sleep 3600"]
      volumeMounts:
        - name: config-vol
          mountPath: /etc/config
  volumes:
    - name: config-vol
      configMap:
        name: log-config
        items:
          - key: log_level
            path: log_level.conf
```

`log-config` の `log_level` キーが `/etc/config/log_level.conf` に入る。

### static PV + PVC + Pod

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi
  storageClassName: ""
---
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
  namespace: default
spec:
  containers:
    - name: web
      image: nginx:1.27
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: pvc-data
```

- PV・PVC とも `storageClassName: ""` なので、default StorageClass があっても dynamic provisioning なしでこの PV に結ばれる
- 500Mi の要求に 1Gi の PV が結ばれる (要求以上は許容)
- `hostPath` の PV は、公式ドキュメント上は単一ノードのテスト用

### StorageClass + dynamic provisioning

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: csi-driver.example-vendor.example
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-fast
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
  storageClassName: fast
```

`provisioner` はクラスタにインストールされた CSI ドライバの名前に変える必要がある。`WaitForFirstConsumer` なので、この PVC を使う Pod ができるまで PVC が `Pending` なのは正常。

### generic ephemeral volume

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "1000000"]
      volumeMounts:
        - name: scratch-volume
          mountPath: /scratch
  volumes:
    - name: scratch-volume
      ephemeral:
        volumeClaimTemplate:
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: fast
            resources:
              requests:
                storage: 1Gi
```

上の `fast` class の provisioner は例示用の名前なので、このまま立てると PVC と Pod は `Pending` のままになる。kind で実際に動かすときは、`storageClassName` をデフォルトの class の `standard` に変えれば、`my-app-scratch-volume` PVC が Bound になり、Pod を消すと PVC も一緒に消えるのを確認できる。

### 確認用の kubectl

```bash
kubectl get pv
kubectl get pvc -A
kubectl describe pvc pvc-data          # Events で Pending の原因を確認
kubectl get storageclass               # (default) の表示で default class を確認
kubectl get pvc my-app-scratch-volume  # generic ephemeral volume が作った PVC
kubectl patch pv pv-data -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## 紛らわしいものの比較

| 項目                         | emptyDir                       | hostPath                | generic ephemeral      | PVC (persistent)                  |
| ---------------------------- | ------------------------------ | ----------------------- | ---------------------- | --------------------------------- |
| 寿命                         | Pod                            | ノード (Pod とは無関係) | Pod                    | PV 基準、Pod とは無関係           |
| データの場所                 | ノードのローカルディスクか RAM | ノードの特定のパス      | ストレージドライバ     | ストレージドライバ                |
| 別のノードに再配置されたとき | データなし                     | そのノードのパスの中身  | 新しい PVC             | 同じデータ (access mode が許せば) |
| PVC オブジェクト             | なし                           | なし                    | 自動で作成・自動で削除 | ユーザーが作成・削除              |

| 紛らわしいペア                         | 違い                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| RWO vs RWOP                            | RWO はノード単位で、同じノードの Pod なら複数でもよい。RWOP はクラスタ全体で Pod 一つ |
| `Retain` vs `Delete`                   | PVC の削除後に PV が `Released` で残る vs PV と実際のストレージまで削除               |
| `storageClassName: ""` vs 省略         | class のない PV だけ vs default StorageClass が適用                                   |
| `Immediate` vs `WaitForFirstConsumer`  | PVC の作成と同時に binding vs Pod ができるまで Pending                                |
| PV vs PVC の範囲                       | PV は cluster-scoped、PVC は namespaced                                               |
| configMap volume vs `subPath` マウント | 全体のマウントは ConfigMap の変更が反映、`subPath` は反映されない                     |

## 試験のポイント

### 素早く解く方法

- PV・PVC・StorageClass には `kubectl create` のサブコマンドがない → 公式ドキュメントの YAML をコピーして直す
- Pod は `kubectl run <name> --image=<img> --dry-run=client -o yaml > pod.yaml` で骨組みを作ってから `volumes`/`volumeMounts` を追加

### kubectl explain

```bash
kubectl explain pod.spec.volumes                                # volume type の一覧
kubectl explain pod.spec.volumes.persistentVolumeClaim          # claimName、readOnly
kubectl explain pod.spec.volumes.emptyDir                       # medium、sizeLimit
kubectl explain pod.spec.volumes.ephemeral.volumeClaimTemplate  # generic ephemeral volume
kubectl explain pv.spec --recursive | less                      # PV のフィールドツリー
kubectl explain pvc.spec                                        # accessModes、resources、storageClassName
kubectl explain storageclass                                    # provisioner、volumeBindingMode
```

## 参考ドキュメント

- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)
- [PersistentVolume API reference](https://kubernetes.io/docs/reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1/) (`persistentVolumeReclaimPolicy` のデフォルト値)
