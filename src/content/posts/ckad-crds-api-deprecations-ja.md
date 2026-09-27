---
title: "CKAD 概念ノート: CRD、Operator、API deprecation"
description: "Kubernetes API を拡張する CRD・custom resource・Operator と、API バージョンが deprecated になり削除されるルール、manifest の移行方法を公式ドキュメントに沿ってまとめたノート。"
pubDatetime: 2026-09-26T12:10:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "crd", "operator", "api-deprecation"]
order: 11
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### resource と custom resource

- resource: 特定の kind の API オブジェクトの集まりを保存する API endpoint。例: `pods` resource に Pod のオブジェクトたち
- custom resource: デフォルトのインストールにはない API の拡張。実行中のクラスタに登録・削除できる
- インストール後は組み込みのリソースと同じように `kubectl` で作成・参照する
- custom resource そのものは構造化されたデータを保存・参照するだけ。実際の動作は controller が付いて初めて生まれる

### custom resource を追加する二つの方法

|                      | CRD                     | API aggregation                            |
| -------------------- | ----------------------- | ------------------------------------------ |
| プログラミング       | 不要 (YAML 一つ)        | 別の API server のバイナリ・イメージが必要 |
| 追加で動かすサービス | なし。API server が処理 | あり。障害点が増える                       |
| 柔軟性               | 低い                    | 高い                                       |

CKAD の範囲では CRD だけ押さえれば十分。

### ConfigMap で足りる場合

公式ドキュメントによれば、次のようなら ConfigMap:

- `mysql.cnf`、`pom.xml` のように、すでに決まった設定ファイルの形式がある
- 設定全体を ConfigMap のキー一つに入れたい
- Pod の中のプログラムがファイル・環境変数として読む (Kubernetes API では読まない)
- ファイルが変わったら Deployment の rolling update で反映したい

`kubectl get my-object` のように kubectl で第一級のリソースとして扱いたい、あるいは新しい自動化 (controller) を付けたいなら custom resource。

### Operator

- custom resource を使ってアプリケーションとその構成要素を管理する、Kubernetes の拡張ソフトウェア
- Kubernetes のコードを変えずに、controller を一つ以上の custom resource につないで動作を拡張する
- Operator = custom resource の controller の役割を担う Kubernetes API client
- 自動化の対象の例: 必要なときにアプリケーションをデプロイ、状態のバックアップ・リストア、DB schema の変更を伴うアップグレード、leader の選出
- 最も一般的なデプロイ方法: CRD + controller をクラスタに追加。controller は普通 control plane の外で、通常のコンテナのように (例: Deployment として) 動く
- 使い方: Operator が見ている custom resource を追加・変更・削除する

```
ユーザー ── kubectl apply ──▶ SampleDB (custom resource)
                              │ watch
                              ▼
                       operator controller (Deployment の Pod)
                              │ reconcile
                              ▼
                  StatefulSet、Service、バックアップの Job ... (組み込みのリソース)
```

## 動作の仕組み

### CRD の登録

1. `CustomResourceDefinition` オブジェクトを apply
2. API server が新しい RESTful endpoint を作る: `/apis/<group>/<version>/namespaces/*/<plural>/...`
3. endpoint の作成には数秒かかることがある。CRD の `Established` condition が true になれば使える
4. 以降、その kind のオブジェクトを `kubectl` で作成・参照する

CRD を削除すると endpoint が消え、その中に保存された custom object もすべて削除される。

### API バージョンのトラック

API group ごとにバージョンは独立している。バージョン名でトラックを区別する。

| 例         | トラック             | 削除のルール (Rule #4a)                                                                                                         |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `v1`       | GA (stable)          | deprecated の表示はできるが、major バージョンの中では削除できない                                                               |
| `v1beta1`  | Beta (pre-release)   | 導入後 9 か月または 3 minor release 以内に deprecated、deprecated の後 9 か月または 3 minor release で提供終了 (それぞれ長い方) |
| `v1alpha1` | Alpha (experimental) | 事前の deprecation なしにどの release でも削除できる                                                                            |

その他のルール (抜粋):

- Rule #1: API の要素は API group のバージョンを上げることでしか削除できない。あるバージョンに入った要素は、そのバージョンから消えたり動作が大きく変わったりしない
- Rule #2: 一つの release の中で、API オブジェクトは情報を失わずにバージョン間で変換 (round-trip) できなければならない
- Rule #3: より安定したバージョンを、より不安定なバージョンのために deprecated にすることはできない (GA は beta・alpha を置き換えられるが、その逆は不可)

"deprecated" と "removed" は違う。deprecated のバージョンはまだ提供されていて、removed のバージョンは API server がもう受け付けない。

## 例

### CRD と custom object

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com # <plural>.<group>
spec:
  group: stable.example.com
  versions:
    - name: v1
      served: true # このバージョンを API で提供
      storage: true # 保存用のバージョンはちょうど一つ
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                cronSpec:
                  type: string
                image:
                  type: string
                replicas:
                  type: integer
  scope: Namespaced # または Cluster
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
      - ct
---
apiVersion: stable.example.com/v1
kind: CronTab
metadata:
  name: my-new-cron-object
spec:
  cronSpec: "* * * * */5"
  image: my-awesome-cron-image
```

```bash
kubectl apply -f resourcedefinition.yaml
kubectl apply -f my-crontab.yaml
kubectl get crontab          # plural、singular、shortName (ct) のどれでも使える
kubectl get ct -o yaml
```

### クラスタにどんな拡張があるか調べる

```bash
kubectl get crd                                  # 登録された CRD の一覧
kubectl api-resources                            # すべてのリソース: 名前、shortName、APIVERSION、NAMESPACED、KIND
kubectl api-resources --api-group=stable.example.com
kubectl api-resources --namespaced=true
kubectl api-versions                             # 提供中の group/version の一覧
kubectl explain crontab.spec                     # CRD の schema に基づくフィールドの説明
kubectl explain deployments --api-version=apps/v1
kubectl explain pod.spec --recursive
```

- `kubectl explain` が custom resource のフィールドを表示できるのは、CRD に OpenAPI v3 schema があるから

### 削除された API から manifest を移行する

v1.35 のドキュメントの Deprecated API Migration Guide にある削除の履歴のうち、CKAD でよく使うリソース:

| リソース                | 削除されたバージョン                                 | 提供終了 | 移行先のバージョン     | 主な変更                                                                                         |
| ----------------------- | ---------------------------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Deployment、DaemonSet   | `extensions/v1beta1`、`apps/v1beta1`、`apps/v1beta2` | v1.16    | `apps/v1`              | `spec.selector` が必須、作成後は変更不可                                                         |
| NetworkPolicy           | `extensions/v1beta1`                                 | v1.16    | `networking.k8s.io/v1` |                                                                                                  |
| Ingress                 | `extensions/v1beta1`、`networking.k8s.io/v1beta1`    | v1.22    | `networking.k8s.io/v1` | `serviceName` → `service.name`、`servicePort` → `service.port.number`/`.name`、`pathType` が必須 |
| CronJob                 | `batch/v1beta1`                                      | v1.25    | `batch/v1`             | なし                                                                                             |
| HorizontalPodAutoscaler | `autoscaling/v2beta1`                                | v1.25    | `autoscaling/v2`       |                                                                                                  |
| PodSecurityPolicy       | `policy/v1beta1`                                     | v1.25    | 代わりの API なし      | Pod Security Admission かサードパーティの admission webhook へ移行                               |

v1.35 のドキュメント時点で最も新しい削除は v1.32 (`flowcontrol.apiserver.k8s.io/v1beta3`)。

Ingress `v1beta1` → `v1`:

```yaml
# 以前 (networking.k8s.io/v1beta1、v1.22 から提供終了)
#   backend:
#     serviceName: web
#     servicePort: 80
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

移行の手順 (ドキュメントの What to do):

- テスト: API server を `--runtime-config=<group>/<version>=false` で起動し、将来の削除を前もって再現
- 探す: 1.19 以降の client warning、metric、audit の情報で deprecated API の使用箇所を確認
- 移す: YAML の `apiVersion` と変わったフィールドを修正。自動変換は `kubectl convert -f <file> --output-version <group>/<version>`
  - `kubectl convert` はデフォルトのインストールにない別のプラグイン。変換結果のデフォルト値が理想的でないことがある。上の v1beta1 の Ingress を kubectl-convert v1.35 で変換すると `pathType` が `ImplementationSpecific` で埋まる。`Prefix` にしたかったなら自分で直す必要がある

削除された `apiVersion` をそのまま apply すると、`no matches for kind "Ingress" in version "networking.k8s.io/v1beta1"` と一緒に `ensure CRDs are installed first` が出る。CRD の問題ではなく、そのバージョンがもう提供されていないという意味。

## 紛らわしいものの比較

| 項目                                      | A                                                                        | B                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| CRD vs custom resource                    | 種類の定義 (`kind: CustomResourceDefinition`、`apiextensions.k8s.io/v1`) | その種類のオブジェクト (`kind: CronTab`、`stable.example.com/v1`)                        |
| CRD vs Operator                           | API に新しい種類を足すだけ。単体ではデータを保存するだけ                 | CRD + controller。宣言した状態に実際のリソースを合わせる                                 |
| CRD vs ConfigMap                          | kubectl・API で扱う第一級のリソース、schema の検証                       | ファイル・環境変数として Pod に渡す設定                                                  |
| deprecated vs removed                     | まだ提供中。warning だけ                                                 | 提供終了。そのバージョンでリクエストすると失敗                                           |
| `served` vs `storage`                     | このバージョンを API で提供するか                                        | etcd に保存するときに使うバージョン。ちょうど一つ                                        |
| `kubectl api-resources` vs `api-versions` | リソース単位 (名前、kind、group/version、namespaced かどうか)            | group/version の一覧だけ                                                                 |
| alpha vs beta                             | 事前の deprecation なしにいつでも削除されうる                            | deprecated の後 9 か月または 3 release で提供終了 (GA は major バージョンの中で削除なし) |

## 試験のポイント

### 素早く使うコマンド

```bash
kubectl get crd
kubectl describe crd <plural>.<group>
kubectl api-resources | grep -i <keyword>
```

- 知らない custom resource が出てきたら: `api-resources` で名前・group・namespaced かどうかを確認 → `explain` でフィールドを確認 → YAML を書く
- 削除された `apiVersion` を直す必要があれば: `kubectl api-resources` の APIVERSION 列で現在提供中のバージョンを確認。変わったフィールドは Deprecated API Migration Guide

### kubectl explain

```bash
kubectl explain crd.spec.names                              # plural、singular、kind、shortNames
kubectl explain crd.spec.versions                           # served、storage、schema
kubectl explain crd.spec.scope                              # Namespaced / Cluster
kubectl explain <kind>.spec --recursive                     # custom resource のフィールド (CRD の schema 基準)
kubectl explain ingress --api-version=networking.k8s.io/v1  # 特定の group/version でフィールドを確認
```

## 参考ドキュメント

- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl explain](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_explain/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
