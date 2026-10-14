---
title: "CKA 概念ノート: RBAC、ユーザー証明書、kubeconfig"
description: "Kubernetes に User オブジェクトがないところから始めて、CertificateSigningRequest でユーザー証明書を発行して kubeconfig に入れる流れ、ClusterRole を RoleBinding と ClusterRoleBinding に付けたときの違い、aggregated ClusterRole とデフォルトの ClusterRole を kubeadm クラスタで確認しました。"
pubDatetime: 2026-10-14T01:05:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "rbac", "csr", "kubeconfig"]
order: 5
---

> 基準: kubeadm クラスタ v1.35.9 (libvirt VM 3 台) でコマンドを確認

Role、RoleBinding、ServiceAccount、`kubectl auth can-i` の基本は [CKAD 概念ノート: ServiceAccount、アクセス制御、SecurityContext](/ja/posts/ckad-security-basics) にまとめたので、ここでは管理者側でさらに見るものだけを扱う。

## 目次

## ユーザーはどこにいるのか

Kubernetes には User オブジェクトがない。apiserver はリクエストに付いた認証情報から username と group を取り出して使うだけ。

| 認証方法                 | username                            | group                                                   |
| ------------------------ | ----------------------------------- | ------------------------------------------------------- |
| X.509 クライアント証明書 | `CN`                                | `O` (複数可)                                            |
| ServiceAccount token     | `system:serviceaccount:<ns>:<name>` | `system:serviceaccounts`、`system:serviceaccounts:<ns>` |
| OIDC など                | 設定した claim                      | 設定した claim                                          |

だから「ユーザー jane を作る」というのは、`CN=jane` の証明書をクラスタ CA に署名してもらうこと。RBAC binding の subject `kind: User`、`name: jane` はこの文字列と照合されるだけ。

## CSR でユーザー証明書を発行

### 1. 鍵と CSR を作る

```bash
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -out jane.csr -subj "/CN=jane/O=dev-team"
```

### 2. CertificateSigningRequest オブジェクト

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: <base64 < jane.csr | tr -d "\n" の結果>
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages:
    - client auth
```

| フィールド          | 値                                                                   |
| ------------------- | -------------------------------------------------------------------- |
| `request`           | PEM の CSR ファイルを base64 で 1 行に                               |
| `signerName`        | ユーザーのクライアント証明書は `kubernetes.io/kube-apiserver-client` |
| `usages`            | `client auth`                                                        |
| `expirationSeconds` | 任意。上の例は 24 時間                                               |

### 3. 承認と証明書の取り出し

```bash
kubectl get csr jane
# NAME   SIGNERNAME                            REQUESTOR          REQUESTEDDURATION   CONDITION
# jane   kubernetes.io/kube-apiserver-client   kubernetes-admin   24h                 Pending

kubectl certificate approve jane
kubectl get csr jane            # CONDITION: Approved,Issued

kubectl get csr jane -o jsonpath='{.status.certificate}' | base64 -d > jane.crt
openssl x509 -in jane.crt -noout -subject -issuer
# subject=O = dev-team, CN = jane
# issuer=CN = kubernetes
```

- 拒否は `kubectl certificate deny jane`
- `Approved` だけで `Issued` が付かないなら signer が署名していない。kubeadm クラスタでは controller-manager が署名する

## kubeconfig

kubeconfig は 3 つの部分: `clusters` (どこへ)、`users` (誰として)、`contexts` (2 つの組み合わせ + デフォルト namespace)。

```bash
kubectl config set-credentials jane \
  --client-key=jane.key --client-certificate=jane.crt --embed-certs=true
kubectl config set-context jane --cluster=kubernetes --user=jane --namespace=dev
kubectl config get-contexts
```

```text
CURRENT   NAME                          CLUSTER      AUTHINFO           NAMESPACE
          jane                          kubernetes   jane               dev
*         kubernetes-admin@kubernetes   kubernetes   kubernetes-admin
```

- `--embed-certs=true`: ファイルパスの代わりに中身を kubeconfig に入れる。付けないとパスだけ保存される
- 別の kubeconfig ファイルを作るなら `--kubeconfig=jane.kubeconfig` を付け、`set-cluster` で server のアドレスと CA も入れる必要がある
- `kubectl config use-context jane` で切り替え、1 回だけなら `kubectl --context jane ...`

```text
$ kubectl --context jane auth whoami
Username   jane
Groups     [dev-team system:authenticated]
```

権限を与える前は、認証は通るが認可で止められる。

```text
$ kubectl --context jane get pods
Error from server (Forbidden): pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "dev"
```

`Forbidden` (403) なら認証は通っている。`Unauthorized` (401) なら証明書や token から問題。

## Role と ClusterRole の組み合わせ

```bash
kubectl create role pod-reader -n dev --verb=get,list,watch --resource=pods
kubectl create rolebinding jane-pod-reader -n dev --role=pod-reader --user=jane
```

| Role の種類 | Binding の種類     | 効果                                                           |
| ----------- | ------------------ | -------------------------------------------------------------- |
| Role        | RoleBinding        | その namespace の中だけ                                        |
| ClusterRole | RoleBinding        | ClusterRole のルールを RoleBinding がある namespace の中だけで |
| ClusterRole | ClusterRoleBinding | すべての namespace + クラスタスコープのリソース                |
| Role        | ClusterRoleBinding | 不可                                                           |

ClusterRole + RoleBinding ではクラスタスコープのリソース (nodes、PV、namespace など) を与えられない。実際に試した。

```bash
kubectl create clusterrole node-reader --verb=get,list --resource=nodes
kubectl create rolebinding jane-nodes -n dev --clusterrole=node-reader --user=jane
kubectl --context jane get nodes
# Error from server (Forbidden): nodes is forbidden: User "jane" cannot list resource "nodes" in API group "" at the cluster scope

kubectl create clusterrolebinding jane-nodes --clusterrole=node-reader --user=jane
kubectl --context jane get nodes     # 成功
```

subject の種類:

```bash
kubectl create rolebinding ... --user=jane
kubectl create rolebinding ... --group=dev-team                  # 証明書の O フィールド
kubectl create rolebinding ... --serviceaccount=dev:ci           # <namespace>:<name>
```

## デフォルトの ClusterRole

| ClusterRole     | 用途               | 備考                                                                     |
| --------------- | ------------------ | ------------------------------------------------------------------------ |
| `cluster-admin` | すべて             | ClusterRoleBinding ならクラスタ全体、RoleBinding ならその namespace 全体 |
| `admin`         | namespace 管理者   | Role/RoleBinding を作成可能。ResourceQuota と namespace 自体は変更不可   |
| `edit`          | ほとんどの読み書き | Role、RoleBinding は変更不可                                             |
| `view`          | 読み取り           | Secret を除く                                                            |

`dev-team` group に `view` を ClusterRoleBinding で与えてみた:

| リクエスト                   | 結果                                           |
| ---------------------------- | ---------------------------------------------- |
| `get deploy -n kube-system`  | 許可                                           |
| `get secrets -n kube-system` | `Forbidden` (view は Secret を除く)            |
| `get nodes`                  | `Forbidden` (view は namespace のリソースだけ) |

```bash
kubectl create sa ci -n dev
kubectl create rolebinding ci-edit -n dev --clusterrole=edit --serviceaccount=dev:ci
kubectl auth can-i create deploy -n dev --as=system:serviceaccount:dev:ci        # yes
kubectl auth can-i create rolebinding -n dev --as=system:serviceaccount:dev:ci   # no
```

## aggregated ClusterRole

`aggregationRule` がある ClusterRole には、label selector に合う他の ClusterRole の rules を controller が自動でまとめて入れる。自分で書いた `rules` は上書きされる。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-monitoring: "true"
rules: [] # controller が埋める
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-endpoints
  labels:
    rbac.example.com/aggregate-to-monitoring: "true"
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "list", "watch"]
```

```text
$ kubectl get clusterrole monitoring -o jsonpath='{.rules}'
[{"apiGroups":[""],"resources":["services","endpoints","pods"],"verbs":["get","list","watch"]}]
```

デフォルトの `admin`、`edit`、`view` もこの方式。CRD の権限をデフォルトの role に差し込むときに使う label:

```text
$ kubectl get clusterrole admin -o jsonpath='{.aggregationRule}'
{"clusterRoleSelectors":[{"matchLabels":{"rbac.authorization.k8s.io/aggregate-to-admin":"true"}}]}
```

`rbac.authorization.k8s.io/aggregate-to-view: "true"`、`aggregate-to-edit`、`aggregate-to-admin`。

## 権限の確認

```bash
kubectl auth can-i list pods -n dev --as jane                     # yes
kubectl auth can-i create pods -n dev --as jane                   # no
kubectl auth can-i list pods -n dev --as bob --as-group dev-team  # group の権限だけ確認
kubectl auth can-i --list -n dev --as jane
```

```text
pods    []   []   [get list watch]
nodes   []   []   [get list]
```

`--list` の結果には、デフォルトの binding ですべての認証済みユーザーが受け取る権限 (`selfsubjectaccessreviews` など) や CNI が追加した権限も混ざって出る。

## binding の変更

RoleBinding の `roleRef` は変更できない。

```text
$ kubectl patch rolebinding jane-pod-reader -n dev --type=merge \
    -p '{"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"view"}}'
The RoleBinding "jane-pod-reader" is invalid: roleRef: Invalid value: ...: cannot change roleRef
```

role を変えるには binding を消して作り直す。`subjects` は変更できる。

## 紛らわしいものの比較

| 比較                                                     | A                                             | B                                               |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| 証明書の CN vs O                                         | username                                      | group                                           |
| `kube-apiserver-client` signer vs `kubelet-serving` など | ユーザー/クライアント証明書。手動で承認       | kubelet 用。kubelet がリクエストする            |
| CSR の `Approved` vs `Issued`                            | 人が承認                                      | signer が署名して `status.certificate` に入れる |
| `set-credentials` vs `set-context`                       | user の項目 (鍵、証明書)                      | cluster + user + namespace の組み合わせ         |
| ClusterRole + RoleBinding vs + ClusterRoleBinding        | その namespace の中。クラスタのリソースは不可 | 全体 + クラスタのリソース                       |
| `edit` vs `admin`                                        | RBAC オブジェクトは変更不可                   | namespace 内の Role/RoleBinding を変更可能      |
| 401 vs 403                                               | 認証失敗                                      | 認証成功、権限なし                              |

## 試験のポイント

### 速く解くコマンド

```bash
openssl genrsa -out u.key 2048
openssl req -new -key u.key -out u.csr -subj "/CN=u/O=g"
cat u.csr | base64 | tr -d "\n"
kubectl certificate approve u
kubectl get csr u -o jsonpath='{.status.certificate}' | base64 -d > u.crt
kubectl config set-credentials u --client-key=u.key --client-certificate=u.crt --embed-certs=true
kubectl config set-context u --cluster=kubernetes --user=u

kubectl create role|clusterrole <name> --verb=... --resource=...
kubectl create rolebinding|clusterrolebinding <name> --role|--clusterrole=... --user|--group|--serviceaccount=...
kubectl auth can-i <verb> <resource> [-n ns] --as <user> [--as-group <group>]
```

- CSR の YAML は公式ドキュメント「Certificate Signing Requests」の normal user の例をコピーして `request` だけ変えると速い
- `--resource` の subresource は `pods/log` のように書く

### kubectl explain

```bash
kubectl explain csr.spec            # request, signerName, usages, expirationSeconds
kubectl explain clusterrole.aggregationRule
kubectl explain rolebinding.subjects
```

## 参考ドキュメント

- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Certificates and Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Organizing Cluster Access Using kubeconfig Files](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [Configure Access to Multiple Clusters](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
