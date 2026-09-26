---
title: "CKAD 概念ノート: Helm と Kustomize"
description: "Helm の chart・repository・release の概念と install/upgrade/rollback/uninstall、values の上書き、そして Kustomize の base/overlay・patches・generator と kubectl apply -k を公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:06:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "helm", "kustomize"]
order: 7
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)
> Helm のコマンド・フラグは helm.sh ドキュメント 4.3.0 基準。Helm 4.3.0 と 3.19.0 の両方で実行してみた

## 目次

## Helm の概念

公式ドキュメントが Helm を説明する三つの要素:

| 要素       | 定義 (helm.sh Introduction より)                                                           |
| ---------- | ------------------------------------------------------------------------------------------ |
| chart      | Helm のパッケージ。アプリケーションの実行に必要な resource 定義の束                        |
| repository | chart を集めて共有する場所                                                                 |
| release    | cluster で動いている chart の instance。同じ chart を二回インストールすると release が二つ |

release を作るとき、Helm は chart と configuration (values、普通は `values.yaml`) を合わせる。

### release の revision

- install、upgrade、rollback のたびに revision が 1 ずつ増える。最初の revision は常に 1
- rollback も revision を巻き戻すのではなく、**新しい revision を一つ追加**する
- `helm history <release>` で revision の一覧を確認
- `helm uninstall` は release の記録まで削除する。だから uninstall の後は rollback できない。記録を残すなら `--keep-history`

## Helm の動作

### repo → search → install

```shell
helm repo add bitnami <repo-url>
helm repo update
helm search repo wordpress        # 追加した repo から検索 (ローカルのデータ)
helm search hub wordpress         # Artifact Hub を検索
helm show values bitnami/wordpress
helm install my-wp bitnami/wordpress
```

- `helm search repo` はローカルに取得しておいた repo のデータを検索する。`helm repo update` で更新
- Helm 3 からデフォルトの repository はない。必要な repo を自分で `helm repo add`
- install の引数は release 名と chart。名前を Helm に決めさせるなら `--generate-name`
- chart のソース: repo の参照 (`bitnami/wordpress`)、ローカルの `.tgz`、展開済みのディレクトリ、URL、OCI registry (`oci://...`)
- Helm はデフォルトでは resource がすべて立ち上がるのを待たずに終了する。Helm 4 の `--wait` は戦略を受け取る: フラグなしなら `hookOnly`、`--wait` だけなら `watcher`。Helm 3 の `--wait` はオン・オフのフラグにすぎない。待ち時間の上限はどちらも `--timeout` (デフォルト `5m0s`)

### values の上書き

```shell
helm install my-wp bitnami/wordpress -f values.yaml
helm install my-wp bitnami/wordpress -f base.yaml -f override.yaml   # 右側のファイルが優先
helm install my-wp bitnami/wordpress --set service.type=NodePort
helm get values my-wp              # この release に渡した値を確認
```

| 方式                   | 優先順位                                |
| ---------------------- | --------------------------------------- |
| chart の `values.yaml` | 最も低い (デフォルト値)                 |
| `-f` / `--values`      | 複数指定すると右側のファイルが優先      |
| `--set`                | `-f` より高い。複数指定すると右側が優先 |

`--set` の文法:

| `--set`               | YAML                                   |
| --------------------- | -------------------------------------- |
| `a=b,c=d`             | `a: b` / `c: d`                        |
| `outer.inner=value`   | `outer:` の下に `inner: value`         |
| `name={a,b,c}`        | リスト                                 |
| `servers[0].port=80`  | リスト要素のフィールド                 |
| `name=value1\,value2` | カンマのエスケープ → `"value1,value2"` |

### upgrade / rollback / uninstall

```shell
helm upgrade my-wp bitnami/wordpress -f new-values.yaml
helm upgrade --install my-wp bitnami/wordpress     # なければ install
helm upgrade my-wp bitnami/wordpress --reuse-values --set image.tag=6.6
helm history my-wp
helm rollback my-wp 1       # revision 1 へ
helm rollback my-wp         # revision 省略 (または 0) → 直前の release へ
helm uninstall my-wp
helm list                   # 現在の context の namespace の release
helm list -A                # 全 namespace
```

- upgrade は変わったものだけを更新する ("least invasive upgrade")
- chart の参照で upgrade すると、`--version` がなければ最新の chart バージョンを使う
- upgrade 時の values の扱い:

| フラグ                      | 動作                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `--reuse-values`            | 直前の release の値 + 今回の `--set`/`-f` をマージ                              |
| `--reset-values`            | chart のデフォルト値に初期化                                                    |
| `--reset-then-reuse-values` | chart のデフォルト値に初期化 → 直前の release の値を適用 → 今回の上書きをマージ |

- `-n <ns>`: 対象の namespace。`--create-namespace` でなければ作成 (upgrade では `--install` と一緒のとき)

### インストール前に結果を見る

```shell
helm template my-wp bitnami/wordpress -f values.yaml     # ローカルでレンダリング、cluster は参照しない
helm install my-wp bitnami/wordpress --dry-run=server     # cluster でシミュレーション
```

`--dry-run` の出力には Secret もそのまま出る。隠すなら `--hide-secret`。

## Kustomize の概念

Kubernetes ドキュメントにある Kustomize の役割:

- 他のソースから resource を生成 (`configMapGenerator`、`secretGenerator`)
- すべての resource に共通のフィールドを設定 (namespace、name の prefix/suffix、labels、annotations)
- resource の束を組み合わせて customize (`resources`、`patches`)

kubectl は 1.14 から kustomization ファイルに対応。入り口はディレクトリの中の `kustomization.yaml`。

```shell
kubectl kustomize <dir>      # レンダリング結果だけ出力
kubectl apply -k <dir>       # 適用
kubectl get -k <dir>
kubectl describe -k <dir>
kubectl diff -k <dir>        # 適用したときとの差分
kubectl delete -k <dir>
```

`-k` はファイルではなく kustomization の**ディレクトリ**を指す必要がある。

### base と overlay

- base: `kustomization.yaml` があるディレクトリ。resource と customization の束。ローカルまたはリモートの repo
- overlay: 別の kustomization ディレクトリを参照する `kustomization.yaml` のあるディレクトリ
- base は overlay を知らない。一つの base を複数の overlay が使い回す

```text
.
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
├── dev/
│   └── kustomization.yaml    # resources: [../base], namePrefix: dev-
└── prod/
    └── kustomization.yaml    # resources: [../base], namePrefix: prod-
```

## Kustomize の例

### base

```yaml
# base/kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
```

```yaml
# base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      run: my-nginx
  template:
    metadata:
      labels:
        run: my-nginx
    spec:
      containers:
        - name: my-nginx
          image: nginx
```

### overlay: 共通フィールド + image + patch

```yaml
# prod/kustomization.yaml
resources:
  - ../base
namespace: prod
namePrefix: prod-
labels:
  - pairs:
      env: prod
images:
  - name: nginx
    newTag: "1.27"
patches:
  - path: increase_replicas.yaml
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: my-nginx
    path: set_memory.json.yaml
```

```yaml
# prod/increase_replicas.yaml  (strategic merge patch)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 3
```

```yaml
# prod/set_memory.json.yaml  (JSON 6902 patch)
- op: add
  path: /spec/template/spec/containers/0/resources
  value:
    limits:
      memory: 512Mi
```

- patch はどちらの種類も `patches` フィールド一つに書く
  - strategic merge: patch ファイルの中の `group`/`version`/`kind`/`name` で対象を探す
  - JSON 6902: 対象の情報がファイルにないので `target` が**必須**
- `patches` は書かれた順に適用される。ドキュメントのおすすめは「一つのことだけをする小さな patch」
- `images`: patch なしで image の名前・tag・digest を変更
- `labels` は selector にラベルを入れない。selector にも入れるなら `includeSelectors: true`。以前の `commonLabels` も selector まで変えるが、kubectl 1.35 に同梱の Kustomize は `'commonLabels' is deprecated. Please use 'labels' instead` という警告を出す

### generator

```yaml
# kustomization.yaml
configMapGenerator:
  - name: app-config
    files:
      - application.properties
    literals:
      - FOO=Bar
secretGenerator:
  - name: app-secret
    files:
      - password.txt
```

- 生成された ConfigMap/Secret の名前には content hash の接尾辞が付く (`app-config-8mbdf7882g` のような形)。内容が変わると名前が変わる
- 同じ kustomization の中でこの ConfigMap を参照する Deployment の `name: app-config` も、ハッシュ付きの名前に書き換わる。結果として Pod template が変わり、rollout が起きる
- 接尾辞をなくすなら `generatorOptions.disableNameSuffixHash: true`

## Helm vs Kustomize

|                        | Helm                             | Kustomize                                     |
| ---------------------- | -------------------------------- | --------------------------------------------- |
| 入力                   | chart (template + `values.yaml`) | 普通の YAML + `kustomization.yaml`            |
| 環境ごとの違いの表し方 | values を変える                  | overlay ディレクトリ + patch                  |
| ツール                 | 別の `helm` CLI                  | `kubectl` に内蔵 (`-k`)                       |
| インストールの記録     | release・revision を Helm が保存 | なし。適用された object だけが残る            |
| rollback               | `helm rollback`                  | 以前の manifest をもう一度 `apply -k`         |
| 共有の単位             | repository、OCI registry         | base ディレクトリ (ローカル・リモートの repo) |
| レンダリングだけ見る   | `helm template`                  | `kubectl kustomize`                           |

どちらをいつ使うか:

- 他人が作ったソフトウェア (DB、ingress controller など) を設定だけ変えてインストール → Helm chart
- 自分の manifest を dev/prod のように少しずつ変える → Kustomize の overlay
- CKAD の問題文が "chart"、"release"、"repository" と言っていれば Helm、"kustomization"、"overlay"、`-k` と言っていれば Kustomize

## 試験のポイント

**素早く使うコマンド**

```shell
helm repo list
helm search repo <keyword>
helm show values <repo>/<chart> | less
helm install <release> <repo>/<chart> -n <ns> --create-namespace --set key=value
helm upgrade <release> <repo>/<chart> --reuse-values --set key=value
helm list -A
helm history <release> -n <ns>
helm rollback <release> <revision> -n <ns>
helm uninstall <release> -n <ns>

kubectl kustomize <dir>
kubectl apply -k <dir>
```

**kubectl explain**

```bash
# Helm・Kustomize の設定は API リソースではないので explain の対象外。結果のリソースのフィールドだけ explain
kubectl explain deployment.spec.replicas                                      # Kustomize の patch・Helm の values が変えるフィールドを確認
kubectl explain deployment.spec.template.spec.containers.image
# オプションは CLI の help で
helm install --help | grep -E -- '--(set|values|namespace|create-namespace)'
helm upgrade --help | grep -E -- '--(install|reuse-values|reset-values)'
kubectl kustomize --help
```

## 参考ドキュメント

- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Helm Docs](https://helm.sh/docs/)
- [Introduction to Helm](https://helm.sh/docs/intro/introduction/)
- [Using Helm](https://helm.sh/docs/intro/using_helm/)
- [helm install](https://helm.sh/docs/helm/helm_install/)、[helm upgrade](https://helm.sh/docs/helm/helm_upgrade/)、[helm rollback](https://helm.sh/docs/helm/helm_rollback/)、[helm uninstall](https://helm.sh/docs/helm/helm_uninstall/)、[helm template](https://helm.sh/docs/helm/helm_template/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
