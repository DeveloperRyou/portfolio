---
title: "CKAD チートシート"
description: "CKAD v1.35 カリキュラムのドメイン別に、kubectl コマンド、最小限の YAML、試験中に開く kubernetes.io のドキュメントをまとめたもの。"
pubDatetime: 2026-09-26T12:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "cheatsheet"]
order: 1
---

> 基準: Kubernetes v1.35

## 要約

CKAD のコマンド・YAML 集。

解き方の原則は、imperative コマンドで骨組みを生成し、
コマンドでは設定できない、または覚えていないフィールドだけ YAML を編集。
`kubectl explain` か公式ドキュメントの例をコピー。

例:

```bash
k run web --image=nginx --port=80 --dry-run=client -o yaml > web.yaml  # 1. コマンドで Pod YAML の骨組みを生成
vi web.yaml                                                            # 2. コマンドで設定できないフィールド (probe, volume など) を追加
k apply -f web.yaml                                                    # 3. 適用
k get pod web                                                          # 4. 結果を確認
```

| ドメイン                                            | 配点 |
| --------------------------------------------------- | ---- |
| Application Design and Build                        | 20%  |
| Application Deployment                              | 20%  |
| Application Observability and Maintenance           | 15%  |
| Application Environment, Configuration and Security | 25%  |
| Services and Networking                             | 20%  |

試験中に閲覧できるサイト: `kubernetes.io/docs`、`kubernetes.io/blog`、`helm.sh/docs` (Linux Foundation の許可リソース基準)。

## 試験環境

- 問題ごとに `ssh <host>` で指定ホストに接続して解き、終わったら `exit`
- すべての ssh ホストに alias `k` と Bash 補完が標準で用意済み
- 自分で追加した alias・`export`・vim 設定はホストが変わると消える -- オプションは毎回直接入力
- namespace はコマンドごとに `-n <ns>` を明示

### YAML の生成・編集

```bash
k run web --image=nginx --dry-run=client -o yaml > pod.yaml  # 作成せず YAML だけファイルに出力
k apply -f pod.yaml                                          # 編集後に適用
```

- Pod spec は作成後ほとんど変更不可、`apply` すると `Forbidden: pod updates may not change fields ...` エラー
  - 変更可能: container の `image`、`activeDeadlineSeconds`、`tolerations` の追加
  - 変更不可の例: probe、`resources`、`env`、`command`・`args`、`volumeMounts`、`securityContext`、`serviceAccountName`
  - 対処: `k replace --force -f pod.yaml` -- 既存の Pod を削除して同じ名前で再作成
  - Deployment は Pod template を編集して `apply` するだけで十分 (Pod の入れ替えは Deployment が処理)

### kubectl explain

```bash
k explain pod.spec.containers.livenessProbe  # フィールドの説明
k explain pod.spec --recursive | less        # フィールドツリー全体
```

## Application Design and Build

カリキュラム: container image の定義・ビルド・変更、workload リソースの選択、multi-container Pod パターン (sidecar、init など)、persistent・ephemeral volume。

### container image

```bash
docker build -t myapp:v1 .                         # または podman build
docker tag myapp:v1 registry.example.com/myapp:v1  # リモート registry のパスでタグを追加
docker push registry.example.com/myapp:v1          # registry にアップロード
```

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

### workload の選択

| リソース    | 用途                              | 作成方法                                                        |
| ----------- | --------------------------------- | --------------------------------------------------------------- |
| Pod         | 単発、テスト                      | `k run`                                                         |
| Deployment  | stateless、ローリングアップデート | `k create deploy`                                               |
| StatefulSet | 固定の名前・ストレージ            | YAML                                                            |
| DaemonSet   | ノードごとに 1 つ                 | Deployment YAML の `kind` を変更、`replicas`・`strategy` を削除 |
| Job         | 完了まで実行                      | `k create job`                                                  |
| CronJob     | スケジュール実行                  | `k create cronjob`                                              |

```bash
k run web --image=nginx --port=80 --labels=app=web,tier=fe                # Pod 作成 + port・label 指定
k run tmp --image=busybox --restart=Never --rm -it -- sh                  # 一時 Pod で shell に入る、終了時に削除
k run box --image=busybox --dry-run=client -o yaml --command -- sh -c 'sleep 3600' > pod.yaml  # command を指定した Pod YAML を生成

k create deploy web --image=nginx --replicas=3 --port=80                  # replica 3 つの Deployment
k create job hello --image=busybox -- echo "Hello World"                  # 1 回だけ実行する Job
k create cronjob hello --image=busybox --schedule="*/1 * * * *" -- echo "Hello World"  # 毎分実行する CronJob
k create job manual-run --from=cronjob/hello                              # CronJob を今すぐ 1 回実行
```

`--` の後の引数が入る場所:

| イメージ (Dockerfile) | Pod spec  | 役割                               |
| --------------------- | --------- | ---------------------------------- |
| `ENTRYPOINT`          | `command` | 実行するプログラム                 |
| `CMD`                 | `args`    | そのプログラムに渡すデフォルト引数 |

```bash
k run box --image=busybox -- sleep 3600            # args: ["sleep", "3600"] -- ENTRYPOINT はそのまま、CMD だけ置き換え
k run box --image=busybox --command -- sleep 3600  # command: ["sleep", "3600"] -- ENTRYPOINT を置き換え
```

- busybox は `ENTRYPOINT` がないので、どちらも `sleep 3600` を実行
- `ENTRYPOINT ["python"]` のイメージで `--command` なしだと `python sleep 3600` が実行される -> エラー
- 「このコマンドを実行」という要求なら `--command` を使う

Job・CronJob の追加フィールド (コマンドのオプションなし):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      completions: 3
      parallelism: 2
      backoffLimit: 4
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: hello
              image: busybox
              command: ["sh", "-c", "date"]
```

- Job Pod の `restartPolicy` は `Never` か `OnFailure` のみ
- ドキュメント: [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

### multi-container Pod

| パターン               | 定義する場所                               | 動作                                                |
| ---------------------- | ------------------------------------------ | --------------------------------------------------- |
| init container         | `initContainers`                           | 順番に実行、すべて成功してから app container が起動 |
| sidecar (native)       | `initContainers` + `restartPolicy: Always` | Pod が生きている間ずっと実行、v1.33 から stable     |
| 通常の multi-container | `containers` に複数                        | 同時に起動、順序の保証なし                          |

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  initContainers:
    - name: wait-db
      image: busybox
      command:
        [
          "sh",
          "-c",
          "until nslookup db.default.svc.cluster.local; do sleep 2; done",
        ]
    - name: logshipper
      image: alpine
      restartPolicy: Always # sidecar
      command: ["sh", "-c", "tail -F /opt/logs.txt"]
      volumeMounts:
        - name: data
          mountPath: /opt
  containers:
    - name: app
      image: alpine
      command:
        [
          "sh",
          "-c",
          "while true; do echo logging >> /opt/logs.txt; sleep 1; done",
        ]
      volumeMounts:
        - name: data
          mountPath: /opt
  volumes:
    - name: data
      emptyDir: {}
```

- コンテナ間のファイル共有は同じ `emptyDir` をマウント
- 特定コンテナのログ・exec: `k logs app -c logshipper`、`k exec -it app -c app -- sh`
- ドキュメント: [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)、[Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)

### volume

| 種類                            | 寿命         | 備考                            |
| ------------------------------- | ------------ | ------------------------------- |
| `emptyDir`                      | Pod          | `medium: Memory` で tmpfs       |
| `hostPath`                      | ノード       | テスト用                        |
| `configMap` / `secret`          | 元のリソース | ファイルとしてマウント          |
| `persistentVolumeClaim`         | PVC          | PV とバインド                   |
| generic ephemeral (`ephemeral`) | Pod          | Pod ごとに PVC を自動作成・削除 |

PV、PVC、マウント (コマンドでは作成不可):

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  resources:
    requests:
      storage: 500Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: pvc-data
```

- PVC が `Pending`: `storageClassName`・`accessModes`・容量の不一致を確認 (`k describe pvc`)
- ドキュメント: [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/) (PV・PVC・Pod の例がまとめて載っている)、[Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)、[Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)

## Application Deployment

カリキュラム: デプロイ戦略 (blue/green、canary)、Deployment の rolling update、Helm で既存パッケージをデプロイ、Kustomize。

### rolling update、rollout

```bash
k set image deploy/web nginx=nginx:1.27    # コンテナ名=イメージ
k rollout status deploy/web                # rollout 完了まで待機・確認
k rollout history deploy/web               # revision 一覧
k rollout undo deploy/web                  # 直前の revision にロールバック
k rollout undo deploy/web --to-revision=1  # 特定の revision にロールバック
k rollout restart deploy/web               # 設定を変えずに Pod を再作成
k scale deploy/web --replicas=5            # replica 数を変更
```

```yaml
spec:
  strategy:
    type: RollingUpdate # または Recreate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
```

- `Recreate` に変えるときは `rollingUpdate` ブロックの削除が必須
- ドキュメント: [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)

### blue/green、canary

専用リソースなし。Deployment 2 つ + Service selector の組み合わせ。

| 戦略       | 方法                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| blue/green | `web-blue`、`web-green` の Deployment を併存させ、Service selector を `version=green` に切り替え                        |
| canary     | 2 つの Deployment が共通 label (`app=web`) を共有、Service は共通 label だけを選択、replicas の比率でトラフィックを分配 |

```bash
# blue/green の切り替え
k set selector svc web 'app=web,version=green'                            # Service selector を置き換え
# または
k patch svc web -p '{"spec":{"selector":{"app":"web","version":"green"}}}'  # 同じ変更を patch で

# canary: stable 9、canary 1 -> 約 10%
k scale deploy/web-stable --replicas=9                                    # stable 9 つ
k scale deploy/web-canary --replicas=1                                    # canary 1 つ
```

- 確認: `k get endpointslices -l kubernetes.io/service-name=web`、`k get pod -l app=web --show-labels`
- ドキュメント: [Managing Workloads](https://kubernetes.io/docs/concepts/workloads/management/) (canary deployments の節)

### Helm

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami                  # chart repo を登録
helm repo update                                                          # repo index を更新
helm show values bitnami/nginx > values.yaml                              # chart のデフォルト values を確認・保存

helm install web bitnami/nginx -n web --create-namespace --set replicaCount=2  # namespace を作成しつつインストール、値を override
helm install web bitnami/nginx -n web -f values.yaml                       # values ファイルでインストール
helm upgrade web bitnami/nginx -n web --set replicaCount=3                 # 値を変えてアップグレード
helm list -A                                                              # 全 namespace の release 一覧
helm history web -n web                                                   # release の revision 一覧
helm rollback web 1 -n web                                                # revision 1 にロールバック
helm uninstall web -n web                                                 # release を削除
```

- release は namespace 単位、`-n` を付け忘れると `helm list` に出てこない
- ドキュメント: [Using Helm](https://helm.sh/docs/intro/using_helm/)、[helm install](https://helm.sh/docs/helm/helm_install/)

### Kustomize

元の YAML はそのままにして、`kustomization.yaml` の変換ルールを適用した結果をデプロイ。テンプレート構文なし、`kubectl` に内蔵。

```
app/
├── base/                       # 共通の元ファイル
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml      # resources: [deployment.yaml, service.yaml]
└── overlay/
    └── prod/
        └── kustomization.yaml  # base を取り込んで prod 用に変換
```

```bash
k kustomize ./app/overlay/prod  # 変換結果の YAML を出力するだけ (適用前の確認)
k apply -k ./app/overlay/prod   # 変換結果を適用 (-k = kustomization.yaml があるディレクトリ)
k delete -k ./app/overlay/prod  # その結果で作ったリソースを削除
```

```yaml
# app/overlay/prod/kustomization.yaml
resources: # 変換する元 (ファイルまたはディレクトリ)
  - ../../base
namespace: prod # すべてのリソースの namespace を prod に
labels: # すべてのリソースに label を追加
  - pairs:
      env: prod
images: # nginx イメージのタグを置き換え
  - name: nginx
    newTag: "1.27"
patches: # 特定リソースの特定フィールドだけ変更
  - target: # 対象: Deployment web
      kind: Deployment
      name: web
    patch: |- # JSON patch: replicas を 3 に
      - op: replace
        path: /spec/replicas
        value: 3
```

- `commonLabels` は deprecated、`labels` を使う
- ドキュメント: [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)

## Application Observability and Maintenance

カリキュラム: API deprecation、probe・ヘルスチェック、組み込み CLI でのモニタリング、container log、デバッグ。

### API deprecation

```bash
k api-resources -o wide                         # リソースごとの group・version・verb 一覧
k explain cronjob | head -5                     # GROUP / VERSION を確認
k convert -f old.yaml --output-version apps/v1  # kubectl-convert plugin のインストールが必要
```

- apply 時の deprecated API 警告メッセージを確認
- ドキュメント: [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)、[Kubernetes Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)、kubectl-convert のインストールは [Install and Set Up kubectl on Linux](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)

### probe

| probe     | 失敗時                                                  |
| --------- | ------------------------------------------------------- |
| liveness  | コンテナを再起動                                        |
| readiness | Service の endpoint から除外 (再起動なし)               |
| startup   | 成功するまで liveness・readiness を停止、失敗時は再起動 |

| handler | フィールド               |
| ------- | ------------------------ |
| HTTP    | `httpGet: {path, port}`  |
| TCP     | `tcpSocket: {port}`      |
| command | `exec: {command: [...]}` |
| gRPC    | `grpc: {port}`           |

```yaml
spec:
  containers:
    - name: web
      image: nginx
      ports:
        - containerPort: 80
      startupProbe:
        httpGet:
          path: /
          port: 80
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /
          port: 80
        initialDelaySeconds: 5
        periodSeconds: 10
      readinessProbe:
        exec:
          command: ["cat", "/tmp/ready"]
        periodSeconds: 5
```

- probe は container 単位のフィールド (`spec.containers[].livenessProbe`)
- ドキュメント: [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)

### モニタリング CLI

```bash
k get pod -o wide                                   # Pod IP・ノードまで表示
k get pod --show-labels -l app=web                  # label でフィルタ + label を表示
k get events --sort-by=.metadata.creationTimestamp  # event を時系列順に
k top pod --sort-by=cpu                             # metrics-server が必要
k top node                                          # ノードの CPU・memory 使用量
k describe pod web                                  # 状態・Events の詳細
```

- ドキュメント: [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)、[Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)

### container log

```bash
k logs web                   # 基本のログ
k logs web -c sidecar        # multi-container
k logs web --all-containers  # すべてのコンテナのログ
k logs web --previous        # 再起動前のコンテナ
k logs web -f --tail=50      # 最後の 50 行からリアルタイム
```

### デバッグ

| 状態                         | 確認                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `Pending`                    | `describe` の Events: リソース不足、nodeSelector、PVC |
| `ImagePullBackOff`           | イメージ名・タグ、`imagePullSecrets`                  |
| `CrashLoopBackOff`           | `logs --previous`、command・args、liveness probe      |
| `Running` なのに接続できない | readiness、Service selector、`targetPort`             |
| `CreateContainerConfigError` | 参照している ConfigMap・Secret・key がない            |

```bash
k exec -it web -- sh                                                      # 実行中のコンテナの shell に入る
k debug web -it --image=busybox --target=web                              # ephemeral container
k debug web -it --image=busybox --copy-to=web-debug --share-processes                # コピーした Pod でプロセスを共有してデバッグ
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web:80  # 一時 Pod から Service の呼び出しをテスト
```

- ドキュメント: [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)、[Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)、[Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)

## Application Environment, Configuration and Security

カリキュラム: CRD・Operator、authentication・authorization・admission control、requests・limits・quota、ConfigMap、Secret、ServiceAccount、SecurityContext・capabilities。

### CRD、Operator

```bash
k get crd                            # CRD 一覧
k api-resources --api-group=<group>  # 特定 API group のリソース一覧
k explain <kind>.spec                # CRD schema に基づくフィールドを確認
k get <plural> -A                    # CR を全件取得
```

- CR は通常のリソースと同じように `apply`・`get`・`delete`
- ドキュメント: [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)、[Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)、[Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)

### authentication、authorization、admission control

```bash
k create role pod-reader --verb=get,list,watch --resource=pods            # namespace の権限を定義
k create rolebinding pod-reader-rb --role=pod-reader --serviceaccount=default:app-sa  # Role を ServiceAccount に紐付け
k create clusterrole node-reader --verb=get,list --resource=nodes         # クラスター全体の権限を定義
k create clusterrolebinding node-reader-rb --clusterrole=node-reader --user=jane  # ClusterRole を user に紐付け

k auth can-i list pods                                                    # 自分の権限を確認
k auth can-i list pods --as=system:serviceaccount:default:app-sa -n default  # ServiceAccount の権限で確認
```

| 段階              | 役割                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| authentication    | 誰なのか (証明書、token、ServiceAccount)                                        |
| authorization     | 実行できるか (RBAC Role・ClusterRole)                                           |
| admission control | リクエストの変更・検証 (LimitRange、ResourceQuota、Pod Security Admission など) |

- `--serviceaccount` の形式は `<namespace>:<name>`
- ドキュメント: [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)、[Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)、[Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)

### requests、limits、quota

```bash
k set resources deploy/web --requests=cpu=100m,memory=128Mi --limits=cpu=200m,memory=256Mi  # requests・limits を設定
k create quota ns-quota --hard=pods=10,requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi  # namespace の ResourceQuota を作成
k describe quota -n <ns>                                                  # quota の使用量を確認
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 200m
          memory: 256Mi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
```

- ResourceQuota で cpu・memory が制限された namespace では、requests・limits のない Pod の作成は拒否 (LimitRange のデフォルト値で補える)
- memory limit 超過で OOMKilled、cpu limit 超過で throttling
- ドキュメント: [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)、[Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)、[Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)

### ConfigMap

```bash
k create cm app-config --from-literal=LOG_LEVEL=info --from-literal=PORT=8080  # key=value で作成
k create cm app-file --from-file=app.properties                           # ファイルの内容で作成 (key = ファイル名)
k set env deploy/web --from=configmap/app-config                          # ConfigMap 全体を env として注入
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      env:
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config
          mountPath: /etc/app
  volumes:
    - name: config
      configMap:
        name: app-file
```

- env で注入した値は ConfigMap を変更しても Pod を再起動するまで反映されない、volume マウントは自動で更新 (`subPath` マウントを除く)
- ドキュメント: [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)

### Secret

```bash
k create secret generic db-secret --from-literal=user=admin --from-literal=password=pass123  # key=value で作成
k create secret docker-registry regcred --docker-server=<registry> --docker-username=<u> --docker-password=<p>  # private registry の認証用
k get secret db-secret -o jsonpath='{.data.password}' | base64 -d         # 値をデコードして確認
k set env deploy/web --from=secret/db-secret                              # Secret 全体を env として注入
```

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: app
      image: nginx
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
      volumeMounts:
        - name: secret
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: secret
      secret:
        secretName: db-secret
```

- YAML の `data` は base64、`stringData` は平文
- volume のフィールド名の違い: ConfigMap は `configMap.name`、Secret は `secret.secretName`
- ドキュメント: [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)、[Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)

### ServiceAccount

```bash
k create sa app-sa                      # ServiceAccount を作成
k set serviceaccount deploy/web app-sa  # Deployment に ServiceAccount を指定
```

```yaml
spec:
  serviceAccountName: app-sa
  automountServiceAccountToken: false
```

- Pod の `serviceAccountName` は作成後に変更不可、Deployment を編集して再作成
- ドキュメント: [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)

### SecurityContext、capabilities

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure
spec:
  securityContext: # Pod レベル
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
    - name: app
      image: busybox
      command: ["sh", "-c", "sleep 3600"]
      securityContext: # container レベル、Pod レベルより優先
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          add: ["NET_ADMIN"]
          drop: ["ALL"]
```

| フィールド                                                                         | 場所                  |
| ---------------------------------------------------------------------------------- | --------------------- |
| `runAsUser`, `runAsGroup`, `runAsNonRoot`                                          | Pod、container の両方 |
| `fsGroup`                                                                          | Pod のみ              |
| `capabilities`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem`, `privileged` | container のみ        |

- 確認: `k exec secure -- id`
- ドキュメント: [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)

## Services and Networking

カリキュラム: NetworkPolicy の基本理解、Service によるアクセス提供・トラブルシューティング、Ingress ルール。

### Service

```bash
k expose deploy/web --port=80 --target-port=8080 --name=web-svc  # ClusterIP Service、80 -> コンテナの 8080
k expose deploy/web --port=80 --type=NodePort                    # NodePort Service
k create svc nodeport web --tcp=80:8080 --node-port=30080        # nodePort を固定で指定
k run web --image=nginx --port=80 --expose                       # Pod + ClusterIP Service
```

| type         | アクセス範囲                                       |
| ------------ | -------------------------------------------------- |
| ClusterIP    | クラスター内部                                     |
| NodePort     | `<NodeIP>:<nodePort>` (デフォルト範囲 30000-32767) |
| LoadBalancer | 外部 LB (クラウドなど)                             |
| ExternalName | DNS CNAME                                          |

- `k create svc` は selector を `app=<名前>` に固定、別の label なら YAML を編集
- `expose` は元リソースの selector を再利用

トラブルシューティングの順序:

```bash
k get svc web-svc -o wide                                                 # selector、port
k get endpointslices -l kubernetes.io/service-name=web-svc                # endpoint が空かどうか
k get pod -l app=web --show-labels                                        # selector と label が一致しているか
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web-svc.<ns>.svc.cluster.local  # FQDN で Service の呼び出しをテスト
```

- endpoint がない: selector の不一致、または readiness の失敗
- 接続拒否: `targetPort` と `containerPort` の不一致
- ドキュメント: [Service](https://kubernetes.io/docs/concepts/services-networking/service/)、[Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)、DNS 名のルールは [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)

### Ingress

```bash
k create ingress web --class=nginx --rule="foo.com/=web-svc:80"  # host foo.com、パス / のみ完全一致 (pathType Exact)
k create ingress web --rule="foo.com/api*=api-svc:8080"          # * を付けると pathType Prefix (/api 以下すべて)
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  rules:
    - host: foo.com
      http:
        paths:
          - path: /api
            pathType: Prefix # Exact / Prefix / ImplementationSpecific
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
```

- 確認: `k describe ingress web` (backend の endpoint)、`curl -H 'Host: foo.com' http://<ingress-ip>/api`
- Ingress controller がないとルールだけあって動作しない
- ドキュメント: [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)、[kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)

### NetworkPolicy

コマンドでは作成不可。ドキュメントの例をコピーして編集。

```yaml
# namespace 全体の ingress を遮断
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# app=db は app=api からの 5432 だけ許可、egress は DNS のみ
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-policy
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - protocol: TCP
          port: 5432
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

`from` 内の selector の組み合わせ:

```yaml
# AND: namespace label と Pod label の両方を満たす
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
      podSelector:
        matchLabels:
          role: frontend
# OR: その namespace 全体、または (ポリシーと同じ namespace の) role=frontend の Pod
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
    - podSelector:
        matchLabels:
          role: frontend
```

- `-` ひとつの違いで AND/OR が分かれる
- ポリシーは許可リストとして累積 (OR)、選択された Pod は明示的に許可されたもの以外を遮断
- `policyTypes` に `Egress` を入れて DNS の許可を忘れると Service 名の解決に失敗
- CNI が NetworkPolicy に対応していなければ適用されない
- namespace の label 確認: `k get ns --show-labels` (`kubernetes.io/metadata.name` は自動付与)
- ドキュメント: [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

## 参考ドキュメント

- [CNCF curriculum: CKAD_Curriculum_v1.35.pdf](https://github.com/cncf/curriculum)
- [Linux Foundation: CKA/CKAD Exam Environment Tips](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- [Linux Foundation: Resources Allowed During the Exam](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- [Define a Command and Arguments for a Container](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/)
- [Pods: Pod update and replacement](https://kubernetes.io/docs/concepts/workloads/pods/#pod-update-and-replacement)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)、[Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)、[Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)、[Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)、[Managing Workloads](https://kubernetes.io/docs/concepts/workloads/management/)
- [Helm Docs](https://helm.sh/docs/)
- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)、[Install kubectl on Linux (kubectl convert)](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)、[Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)、[Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)、[Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)、[Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)、[Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)、[Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)、[Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)、[Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)、[DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)、[kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
