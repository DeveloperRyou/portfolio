---
title: "CKAD 概念ノート: ConfigMap と Secret"
description: "ConfigMap と Secret の作り方、Pod に渡す三つの方式 (env、envFrom、volume)、値が変わったときに反映される経路、projected volume と Downward API までを公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:07:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "configmap", "secret", "downward-api"]
order: 8
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### ConfigMap

キーと値の形の、機密ではない設定データ。コンテナイメージと環境ごとの設定を分けるために使う。

- 他のオブジェクトと違って `spec` がなく、`data`、`binaryData` フィールドを持つ
  - `data`: UTF-8 の文字列
  - `binaryData`: base64 でエンコードしたバイナリ
  - 二つのフィールドでキーが重なってはいけない
- キー名: 英字、数字、`-`、`_`、`.` だけ
- サイズ上限: 1 MiB。それより大きい設定は volume や別のストレージへ
- 秘匿・暗号化の機能はない。機密の値は Secret に
- Pod と同じ namespace になければ参照できない。static Pod は ConfigMap を参照できない

公式ドキュメントが挙げる使い方は四つ。

1. コンテナの `command`/`args` の中で参照
2. コンテナの環境変数
3. 読み取り専用 volume のファイル
4. Pod の中から Kubernetes API で直接読む

試験で主に手書きすることになるのは 2 と 3。

### Secret

パスワード、トークン、鍵のような少量の機密データ。構造は ConfigMap に似ているが `type` フィールドがあり、`data` の値は base64 エンコードが必須。

- `data`: base64 エンコードした値
- `stringData`: 平文で書くと API server がエンコードして `data` にマージしてくれる。同じキーが両方にあれば `stringData` が優先
- サイズ上限: Secret 一つあたり 1MiB
- Secret はそれを必要とする Pod があるノードにだけ渡される。volume としてマウントすると kubelet が tmpfs にコピーしてディスクには書かず、Pod が削除されるとローカルのコピーも消す

### base64 != 暗号化

公式ドキュメントの警告をそのまま訳すと、Secret はデフォルトで API server のストレージ (etcd) に**暗号化されないまま**保存される。API へのアクセス権がある人、etcd にアクセスできる人は Secret を読んで変更できる。namespace に Pod を作る権限があれば、その Pod を通じて同じ namespace の Secret を間接的に読むこともできる。

ドキュメントが示す最低限の対策:

- Secret に Encryption at Rest を適用
- RBAC で Secret へのアクセスを最小権限に制限
- Secret へのアクセスを必要なコンテナだけに制限
- 外部の Secret store provider を検討

`data` にある値は `base64 -d` 一回で平文に戻る。

### Secret の type

| type                                  | 用途                                     |
| ------------------------------------- | ---------------------------------------- |
| `Opaque`                              | デフォルト。任意のユーザーデータ         |
| `kubernetes.io/service-account-token` | ServiceAccount のトークン                |
| `kubernetes.io/dockercfg`             | シリアライズした `~/.dockercfg`          |
| `kubernetes.io/dockerconfigjson`      | シリアライズした `~/.docker/config.json` |
| `kubernetes.io/basic-auth`            | basic authentication の認証情報          |
| `kubernetes.io/ssh-auth`              | SSH の認証データ                         |
| `kubernetes.io/tls`                   | TLS 証明書と鍵                           |
| `bootstrap.kubernetes.io/token`       | bootstrap token                          |

`kubectl create secret` のサブコマンドとの対応: `generic` -> `Opaque`、`docker-registry` -> `kubernetes.io/dockerconfigjson`、`tls` -> `kubernetes.io/tls`。

### immutable

ConfigMap も Secret も `immutable: true` を設定できる (v1.21 から stable)。一度 immutable にすると元に戻すことも `data` を変更することもできず、削除して作り直すしかない。immutable なオブジェクトは watch を閉じるので、kube-apiserver の負荷も減る。

## 動作の仕組み

### 値を渡す方式ごとの動作

| 方式                     | フィールド                                         | 結果                                                                 |
| ------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| キー一つ -> 環境変数一つ | `env[].valueFrom.configMapKeyRef` / `secretKeyRef` | 名前を自分で決める                                                   |
| 全キー -> 環境変数       | `envFrom[].configMapRef` / `secretRef`             | キー名がそのまま変数名                                               |
| ファイル                 | `volumes[].configMap` / `secret` + `volumeMounts`  | キー一つにつきファイル一つ。`items` で一部のキーだけ選んでパスを指定 |

- `env` で参照した ConfigMap やキーがなければ Pod は起動しない。`optional: true` にすればなくても起動
- `envFrom` はキーをそのまま変数名に使う。v1.34 から変数名のルールが緩和され (`=` を除く表示可能な ASCII)、v1.35 のクラスタでは `Y-Z`、`1abc`、`.dot` のようなキーもスキップされずに変数になる。「使えないキーはスキップされ、`InvalidVariableNames` イベントに記録される」という説明は、ルールが厳しかった頃のバージョンの話
- Secret volume のファイルのパーミッションは `defaultMode` (volume 全体) か `items[].mode` (ファイルごと) で指定
- `.` で始まるキーは隠しファイルになる (`ls -la` で確認)

### 更新の反映

| 使い方                      | 元の値が変わったとき                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| volume マウント             | 自動で反映。遅延は最大で kubelet の sync period + キャッシュの伝播遅延 |
| volume + `subPath` マウント | 反映されない                                                           |
| `env` / `envFrom`           | 反映されない。Pod の再起動が必要                                       |
| API で直接参照              | アプリケーションが watch して自分で処理                                |

kubelet が変更を検知する方式は `configMapAndSecretChangeDetectionStrategy` で決まり、デフォルトは `Watch`。ほかに TTL ベースのキャッシュ、sync のたびに API server に問い合わせる方式がある。

volume で受け取った値が変わっても、アプリケーションがファイルを読み直さなければ効果はない。反映されるかどうかはアプリの実装次第。

### projected volume

複数の volume ソースを一つのディレクトリにまとめてマウントする。対応するソース:

- `secret`
- `configMap`
- `downwardAPI`
- `serviceAccountToken`
- `clusterTrustBundle`
- `podCertificate`

注意点:

- すべてのソースは Pod と同じ namespace
- `subPath` でマウントすると更新を受け取れない
- 普通の `secret` volume は `secretName` だが、projected の中の `secret` は `name`
- `defaultMode` は projected volume 全体に適用され、ソースごとには `items[].mode` で上書き
- `serviceAccountToken`: `audience`、`expirationSeconds` (デフォルト 1 時間、最小 10 分)、`path` を指定

### Downward API

Pod とコンテナ自身のフィールドをコンテナに公開する方法。環境変数と `downwardAPI` volume の二つを合わせて Downward API と呼ぶ。

`fieldRef` で公開できるフィールド:

| フィールド                                                         | env | volume |
| ------------------------------------------------------------------ | --- | ------ |
| `metadata.name`、`metadata.namespace`、`metadata.uid`              | O   | O      |
| `metadata.labels['<KEY>']`、`metadata.annotations['<KEY>']`        | O   | O      |
| `metadata.labels`、`metadata.annotations` (全体)                   | X   | O      |
| `spec.nodeName`、`spec.serviceAccountName`                         | O   | X      |
| `status.podIP`、`status.podIPs`、`status.hostIP`、`status.hostIPs` | O   | X      |

`resourceFieldRef` ではコンテナの `requests`/`limits` の値 (`cpu`、`memory`、`ephemeral-storage`、`hugepages-*`) を公開する。limit を設定していなければノードの allocatable の最大値が出る。`divisor` のデフォルトが `1` なので、下の例の `limits.cpu: 500m` は `1` に切り上げられて出てくる。millicore で見たいなら `divisor: 1m`。

ラベル全体、annotation 全体は volume でしか公開できない。実行中にリソースが resize されると、volume 側は更新されるが env はコンテナが再起動するまでそのまま。

## 例

### 作成

```bash
# ConfigMap
kubectl create configmap app-config --from-literal=MODE=prod --from-literal=LOG_LEVEL=info
kubectl create configmap app-files --from-file=app.properties            # キー = ファイル名
kubectl create configmap app-files2 --from-file=config=app.properties    # キー名を指定
kubectl create configmap app-env --from-env-file=app.env                 # VAR=VAL を行単位で

# Secret
kubectl create secret generic db-cred --from-literal=username=admin --from-literal=password='s3cr3t'
kubectl create secret tls web-tls --cert=tls.crt --key=tls.key
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com --docker-username=user --docker-password=pass

# YAML を書き出す
kubectl create configmap app-config --from-literal=MODE=prod --dry-run=client -o yaml > cm.yaml

# 値を確認
kubectl get secret db-cred -o jsonpath='{.data.password}' | base64 -d
```

`--from-file` と `--from-env-file` の違い:

- `--from-file=app.env`: ファイル全体で値一つ。キーは `app.env`
- `--from-env-file=app.env`: ファイルの `VAR=VAL` の行ごとにキー一つ。`#` のコメントと空行は無視

### Secret の manifest

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-cred
type: Opaque
data:
  username: YWRtaW4= # "admin"
stringData:
  password: s3cr3t # 平文、作成時に base64 に変換
```

### env / envFrom / volume

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "env; ls /etc/config /etc/secret; sleep 3600"]
      env:
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: db-cred
              key: username
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
              optional: true
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config-vol
          mountPath: /etc/config
          readOnly: true
        - name: secret-vol
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: config-vol
      configMap:
        name: app-files
    - name: secret-vol
      secret:
        secretName: db-cred
        defaultMode: 0400
        items:
          - key: password
            path: db-password
```

### projected volume + Downward API

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: projected-demo
  labels:
    app: demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      resources:
        limits:
          cpu: 500m
          memory: 128Mi
      env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
      volumeMounts:
        - name: all-in-one
          mountPath: /projected
          readOnly: true
  volumes:
    - name: all-in-one
      projected:
        sources:
          - configMap:
              name: app-config
          - secret:
              name: db-cred # projected の中では secretName ではなく name
              items:
                - key: password
                  path: secret/password
          - downwardAPI:
              items:
                - path: labels
                  fieldRef:
                    fieldPath: metadata.labels
                - path: cpu_limit
                  resourceFieldRef:
                    containerName: app
                    resource: limits.cpu
```

## 紛らわしいものの比較

| 項目                | ConfigMap                             | Secret                                             |
| ------------------- | ------------------------------------- | -------------------------------------------------- |
| 用途                | 機密ではない設定                      | 機密の値                                           |
| 値のフィールド      | `data` (UTF-8)、`binaryData` (base64) | `data` (base64)、`stringData` (平文、書き込み専用) |
| `type`              | なし                                  | `Opaque` など                                      |
| サイズ上限          | 1 MiB                                 | 1MiB                                               |
| env での参照        | `configMapKeyRef` / `configMapRef`    | `secretKeyRef` / `secretRef`                       |
| volume のフィールド | `configMap.name`                      | `secret.secretName` (projected の中では `name`)    |
| ノードでの保存      | -                                     | volume マウント時は tmpfs                          |

| 比較                               | 違い                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `env` vs `envFrom`                 | キー一つを好きな名前で vs 全キーをそのまま              |
| volume vs `subPath` volume         | 更新が反映される vs 反映されない                        |
| `--from-file` vs `--from-env-file` | ファイル一つ = キー一つ vs 行一つ = キー一つ            |
| `fieldRef` vs `resourceFieldRef`   | Pod のメタデータ・状態 vs コンテナの requests/limits    |
| Downward API の env vs volume      | 実行中は値が固定 vs ラベル・annotation 全体、更新も反映 |

## 試験のポイント

### コマンド

- ConfigMap・Secret は `kubectl create configmap` / `kubectl create secret generic` ですぐ作り、YAML は `--dry-run=client -o yaml` で書き出す
- Pod 側の `env`/`envFrom`/`volumes` には imperative なコマンドがないので YAML で書く。既存の Deployment なら `kubectl set env deployment/<name> --from=configmap/<cm>` も使える
- Secret の値の確認: `kubectl get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`
- 環境変数の確認: `kubectl exec <pod> -- env`

### kubectl explain

```bash
kubectl explain pod.spec.containers.env.valueFrom   # configMapKeyRef、secretKeyRef、fieldRef
kubectl explain pod.spec.containers.envFrom         # configMapRef、secretRef、prefix
kubectl explain pod.spec.volumes.configMap          # name、items、defaultMode
kubectl explain pod.spec.volumes.secret             # secretName (configMap とフィールド名が違う)
kubectl explain pod.spec.volumes.projected.sources  # projected volume に入れられる source
kubectl explain pod.spec.volumes.downwardAPI.items  # Downward API の volume
kubectl explain secret.stringData                   # 平文で入れるフィールド
```

## 参考ドキュメント

- [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Projected Volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/)
- [Downward API](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
