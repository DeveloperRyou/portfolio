---
title: "CKAD 概念ノート: コンテナイメージと Pod"
description: "イメージ名・tag・digest、imagePullPolicy のデフォルト値のルール、private registry と imagePullSecrets、イメージの build・push、そして Pod spec の基本を公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:01:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "container-image", "pod"]
order: 2
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## イメージ名

形式は `[REGISTRY_HOST[:PORT]/]NAME[:TAG][@DIGEST]`。

| 表記                                       | 実際の意味                                        |
| ------------------------------------------ | ------------------------------------------------- |
| `busybox`                                  | `docker.io/library/busybox:latest`                |
| `busybox:1.32.0`                           | `docker.io/library/busybox:1.32.0`                |
| `registry.k8s.io/pause:3.5`                | 指定した registry、tag `3.5`                      |
| `registry.k8s.io/pause@sha256:1ff6...`     | digest で固定                                     |
| `registry.k8s.io/pause:3.5@sha256:1ff6...` | tag と digest の両方。pull には digest だけを使う |

- デフォルトの registry (Docker Hub) は container runtime の設定で変更できる
- tag のルール: 英大文字・小文字・数字・`_`・`.`・`-`、最大 128 文字、正規表現 `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`
- tag は別のイメージを指すように付け替えられるが、digest (`sha256:<hash>`) はイメージ内容のハッシュなので変わらない

### tag ではなく digest を使う理由

同じ tag が registry で別のイメージに差し替えられると、先に起動した Pod と後から起動した Pod が別のコードを動かすことになりかねません。digest で指定すれば常に同じイメージです。公式ドキュメントも本番環境では `:latest` を避け、`v1.42.0` のような意味のある tag か digest を使うよう勧めています。`:latest` だと今どのバージョンが動いているのか追いにくく、ロールバックも面倒です。

## imagePullPolicy

kubelet がいつイメージを pull するかを決める container 単位のフィールド。

| 値             | 動作                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IfNotPresent` | ノードにイメージがないときだけ pull                                                                                   |
| `Always`       | container を起動するたびに runtime に pull を要求。registry で digest を確認し、キャッシュ済みの layer は再取得しない |
| `Never`        | pull しない。ノードにイメージがあれば実行、なければ起動失敗                                                           |

`Always` でも layer のキャッシュがあるので、registry に安定してアクセスできるなら思ったほど高くつきません。

### 省略したときのデフォルト値

Pod が API server に送信されるときに、次のように埋められます。

| image の表記             | デフォルトの `imagePullPolicy` |
| ------------------------ | ------------------------------ |
| digest を指定            | `IfNotPresent`                 |
| tag が `:latest`         | `Always`                       |
| tag 省略 (結局 `latest`) | `Always`                       |
| `:latest` 以外の tag     | `IfNotPresent`                 |

この値はオブジェクトが最初に**作成されるとき**に一度だけ決まります。たとえば `nginx:1.27` で作った Deployment の image を後から `nginx:latest` に変えても、`imagePullPolicy` は `IfNotPresent` のまま。必要なら自分で変える。

毎回 pull させる方法:

- `imagePullPolicy: Always` を明示
- policy を省略 + `:latest` または tag を省略
- クラスターで `AlwaysPullImages` admission controller を有効化 (管理者の領域)

### ImagePullBackOff

pull の失敗で container が Waiting 状態にとどまること。原因はたいてい間違った image 名か、private registry なのに `imagePullSecrets` がない場合。kubelet は再試行の間隔を延ばしながら pull を続け、間隔の上限は 300 秒 (5 分)。

## private registry

認証方法はいくつかありますが (ノードの設定、kubelet credential provider、pre-pulled image)、公式ドキュメントが推奨しているのは Pod に `imagePullSecrets` を指定する方法。開発者が namespace の中で完結できるので、CKAD の範囲にも合っています。

- Secret のタイプ: `kubernetes.io/dockerconfigjson` (または古い形式の `kubernetes.io/dockercfg`)
- Secret は Pod と**同じ namespace** にある必要がある。namespace ごとに作る
- `imagePullSecrets` の 1 項目は Secret 1 つを指す
- `kubectl create secret docker-registry` で作った Secret は 1 つの registry にしか有効でない。複数の registry を使うなら、既存の `~/.docker/config.json` を `--from-file` で取り込むほうがよい
- ServiceAccount に `imagePullSecrets` を入れておくと、その ServiceAccount を使う Pod に自動で付く

## イメージの build と変更

Kubernetes のドキュメントはイメージを使う側だけを扱い、build 自体は Docker/Podman のドキュメントの領域です。

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

```bash
# build: -t で名前を指定、最後の引数は build context
docker build -t registry.example.com/team/web:v2 .
podman build -t registry.example.com/team/web:v2 .

# 別の Dockerfile を使う
docker build -t web:v2 -f Dockerfile.prod .

# 既存のイメージに新しい名前を付けて registry に push
docker tag web:v2 registry.example.com/team/web:v2
docker push registry.example.com/team/web:v2

# tar ファイルに書き出す
docker save -o web-v2.tar web:v2
podman save -o web-v2.tar web:v2
```

- `docker build` は `docker buildx build` の alias。`-f` を付けなければ context ルートの `Dockerfile` を使う
- `podman build` は `Containerfile` と `Dockerfile` を同じように扱う
- podman で registry なしに `-t web:v2` で build すると、名前の前に `localhost/` が付く。Pod spec でこのイメージを使うときに混乱しやすいポイント

「イメージの変更」とは、結局 Dockerfile を直して新しい tag で build し直すこと。実行中の container を直すわけではありません。

## Pod

Pod は Kubernetes で作成・管理できる最小のデプロイ単位。1 つ以上の container と、共有の storage・network、そして実行方法についての spec をまとめたものです。

- 同じ Pod の container は常に同じノードに一緒にスケジューリングされる
- network namespace を共有: Pod IP は 1 つ (address family ごと)、ポート空間を共有、お互い `localhost` で通信
- `volumes` で定義した volume を複数の container が mount してファイルを共有
- container 内の hostname は Pod 名
- 最も多いのは container 1 つの Pod。複数の container は強く結合している場合だけ (次回のテーマ)
- Pod は使い捨てとして設計されている。普通は Deployment、Job、StatefulSet のような workload resource が pod template から Pod を作って管理する
- replica が必要なら Pod 内の container を増やすのではなく Pod の数を増やす
- container の再起動と Pod の再起動は別物。Pod はプロセスではなく container を実行する環境で、削除されるまで残る

### 最小限の Pod spec

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: web
      image: nginx:1.27
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 80
  imagePullSecrets:
    - name: regcred
  restartPolicy: Always
```

- 必須: `apiVersion: v1`、`kind: Pod`、`metadata.name`、`spec.containers[].name`・`image`
- Pod 名は DNS subdomain のルールに従う必要があり、hostname との互換性を考えるとより厳しい DNS label のルールが安全
- `restartPolicy`: `Always` (デフォルト) / `OnFailure` / `Never`。Pod 単位のフィールド
- `.spec.os.name` に `linux`/`windows` を指定でき、ノードの OS と違えば kubelet が実行を拒否

### 実行中の Pod で変更できるもの

`patch`/`replace` で変更できる spec フィールドはこれだけ:

- `spec.containers[*].image`
- `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds` (未設定 → 正の値、またはより小さい値にのみ)
- `spec.terminationGracePeriodSeconds` (以前の値が負のときに 1 にするのみ)
- `spec.tolerations` (項目の追加のみ)
- `spec.schedulingGates` (項目の削除のみ)

`namespace`、`name`、`uid` のような metadata も変更不可。env、ports、command などを変えるには Pod を削除して作り直す。workload resource の pod template を変えると、controller は既存の Pod を変更せず新しい Pod に置き換えます。

## 紛らわしいものの比較

### tag と digest

|                            | tag                                                | digest                       |
| -------------------------- | -------------------------------------------------- | ---------------------------- |
| 形                         | `:v1.2.3`                                          | `@sha256:<hash>`             |
| 指す対象                   | 付け替えられる                                     | イメージ内容のハッシュ、固定 |
| 両方書いたとき             | 無視される                                         | pull に使われる              |
| 省略時の `imagePullPolicy` | `:latest` なら `Always`、それ以外は `IfNotPresent` | `IfNotPresent`               |

### imagePullSecrets をどこに置くか

| 場所                                              | 適用範囲                              |
| ------------------------------------------------- | ------------------------------------- |
| Pod の `spec.imagePullSecrets`                    | その Pod だけ                         |
| ServiceAccount の `imagePullSecrets`              | その ServiceAccount を使う Pod すべて |
| ノードの設定 (`config.json`、credential provider) | ノードのすべての Pod。管理者の作業    |

### Pod を直接直すときと pod template を直すとき

|                              | 実行中の Pod       | workload resource の pod template                         |
| ---------------------------- | ------------------ | --------------------------------------------------------- |
| 変更できるフィールド         | image など一部だけ | ほぼすべて                                                |
| 既存の Pod への影響          | その場で反映       | 既存の Pod はそのまま、controller が新しい Pod に置き換え |
| 残りのフィールドを変えるには | 削除して作り直す   | template の修正だけで済む                                 |

## 試験のポイント

### コマンド

```bash
# Pod YAML の骨組みを作る
kubectl run web --image=nginx:1.27 --port=80 \
  --image-pull-policy=IfNotPresent --dry-run=client -o yaml > pod.yaml

# 一度実行して終わる Pod
kubectl run tmp --image=busybox:1.36 --restart=Never -- sh -c 'echo hi'

# private registry の Secret
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=<user> --docker-password=<password> \
  --docker-email=<email>

# ServiceAccount に imagePullSecrets を追加
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "regcred"}]}'

# image の差し替え (Pod・Deployment どちらも可、形式は container名=イメージ)
kubectl set image pod/web web=nginx:1.28
kubectl set image deployment/web web=nginx:1.28

# 実際に適用された imagePullPolicy を確認
kubectl get pod web -o jsonpath='{.spec.containers[0].imagePullPolicy}'
```

### kubectl explain

```bash
kubectl explain pod.spec.containers.image
kubectl explain pod.spec.containers.imagePullPolicy  # 値の一覧とデフォルト値のルール
kubectl explain pod.spec.imagePullSecrets
kubectl explain serviceaccount.imagePullSecrets      # ServiceAccount に付ける場合
kubectl explain pod.spec --recursive | less          # Pod spec のフィールドツリー全体
```

## 参考ドキュメント

- [Images | Kubernetes](https://kubernetes.io/docs/concepts/containers/images/)
- [Pods | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/)
- [Pod Lifecycle: Restart policy | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
- [Pull an Image from a Private Registry | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
- [Add ImagePullSecrets to a service account | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)
- [kubectl run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_run/)、[kubectl set image](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_image/)、[kubectl create secret docker-registry](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_secret_docker-registry/)
- [docker buildx build | Docker Docs](https://docs.docker.com/reference/cli/docker/buildx/build/)、[docker image push](https://docs.docker.com/reference/cli/docker/image/push/)、[docker image save](https://docs.docker.com/reference/cli/docker/image/save/)
- [podman-build | Podman](https://docs.podman.io/en/latest/markdown/podman-build.1.html)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
