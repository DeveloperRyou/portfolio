---
title: "CKAD 概念ノート: ServiceAccount、アクセス制御、SecurityContext"
description: "API リクエストが authentication、authorization、admission を通る流れと、ServiceAccount・RBAC・SecurityContext・Pod Security Standards を公式ドキュメントに沿ってまとめたノート。"
pubDatetime: 2026-09-26T12:09:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  [
    "kubernetes",
    "ckad",
    "rbac",
    "serviceaccount",
    "securitycontext",
    "security",
  ]
order: 10
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## リクエストの流れ

```
kubectl / Pod
   │  (client certificate, bearer token ...)
   ▼
[1] Authentication   失敗 → 401 Unauthorized
   ▼
[2] Authorization    失敗 → 403 Forbidden
   ▼
[3] Admission        mutating → validating、一つでも拒否するとリクエスト全体を拒否
   ▼
etcd に保存
```

### Authentication: 誰なのか

- ユーザーの種類は二つ
  - normal user: Kubernetes の外で管理。API で User オブジェクトは作れない
  - ServiceAccount: Kubernetes API が管理し、namespace に属する
- 方式: client certificate、bearer token、authenticating proxy などの authentication plugin
- 結果としてリクエストに付く属性: username、UID、groups、extra
- ServiceAccount の username: `system:serviceaccount:<namespace>:<name>`
  - groups: `system:serviceaccounts`、`system:serviceaccounts:<namespace>`
- どの方式でも拒否されなかったリクエストは (anonymous を許可していれば) `system:anonymous` / `system:unauthenticated` として扱う
- 不正な bearer token → `401 Unauthorized`

### Authorization: してもよいか

- 確認する属性: user、group、verb、resource、subresource、namespace、API group など
- HTTP method → verb の対応

| HTTP      | verb                                           |
| --------- | ---------------------------------------------- |
| POST      | create                                         |
| GET、HEAD | get (単一)、list (コレクション)、watch         |
| PUT       | update                                         |
| PATCH     | patch                                          |
| DELETE    | delete (単一)、deletecollection (コレクション) |

- mode: `Node`、`RBAC`、`ABAC`、`Webhook`、`AlwaysAllow`、`AlwaysDeny`
- 複数の authorizer があれば順番に問い合わせ、最初に allow/deny を出したものが決める。すべて「意見なし」なら拒否
- デフォルトは deny。RBAC には許可のルールしかなく、拒否のルールはない
- 拒否 → `403 Forbidden`

### Admission: 受け入れてよいか

- authentication・authorization を通過した後、保存の直前にリクエストを横取りする kube-apiserver 組み込みのコード
- 二段階: mutating (オブジェクトを変更できる) → validating (検査だけ)
- 読み取りのリクエスト (get、list、watch) は admission を通らない
- 有効・無効の切り替え: `kube-apiserver --enable-admission-plugins=...` / `--disable-admission-plugins=...`
- v1.35 のデフォルト有効リストのうち CKAD に関わるもの

| plugin               | 役割                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `NamespaceLifecycle` | 削除中、または存在しない namespace へのオブジェクト作成を防ぐ       |
| `LimitRanger`        | LimitRange を適用 (デフォルトの requests/limits を注入、範囲を検査) |
| `ResourceQuota`      | namespace 単位の総量制限                                            |
| `ServiceAccount`     | Pod に ServiceAccount・token を自動設定                             |
| `PodSecurity`        | Pod Security Standards を適用                                       |

- 「作成はできたのに Pod が立ち上がらない」ではなく「作成そのものが拒否される」なら、admission の段階で止められた可能性が高い

## RBAC

API group `rbac.authorization.k8s.io/v1`、オブジェクトは 4 種類。

| オブジェクト       | 範囲      | 内容                                                                         |
| ------------------ | --------- | ---------------------------------------------------------------------------- |
| Role               | namespace | 一つの namespace の中の権限ルール                                            |
| ClusterRole        | クラスタ  | クラスタ範囲のリソースの権限、または複数の namespace で使い回すルール        |
| RoleBinding        | namespace | Role か ClusterRole を subject に結び付ける。効果はその namespace の中に限定 |
| ClusterRoleBinding | クラスタ  | ClusterRole をクラスタ全体に結び付ける                                       |

- subject の種類: `User`、`Group`、`ServiceAccount`
- binding を作った後は `roleRef` を変更できない。変えるなら削除して作り直す
- 組み込みのユーザー向け ClusterRole: `cluster-admin`、`admin`、`edit`、`view`

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
  - apiGroups: [""] # "" = core API group
    resources: ["pods"]
    verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: default
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: default
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

## ServiceAccount

- 人ではないアカウント。Pod の中のプロセスが API server にアクセスするときの身元
- namespace ごとに `default` ServiceAccount が自動で作られる。消しても control plane が作り直す
- `default` ServiceAccount には、RBAC 上 API discovery 以外の権限がない
- Pod への指定: `spec.serviceAccountName`
  - 既存の Pod の `serviceAccountName` は変更できない。Deployment などは template を変えて新しい Pod に入れ替える
  - `spec.serviceAccount` は deprecated な alias
- token
  - v1.22 から、`TokenRequest` API で取得した短命・自動更新の token を projected volume としてマウント
  - パス: `/var/run/secrets/kubernetes.io/serviceaccount/` (`token`、`ca.crt`、`namespace`)
  - 手動発行: `kubectl create token <sa>` (`--duration` で有効期間を要求)
- 自動マウントをオフにする: `automountServiceAccountToken: false`
  - ServiceAccount と Pod の両方に書けて、両方にあれば Pod 側が優先

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: default
automountServiceAccountToken: false
---
apiVersion: v1
kind: Pod
metadata:
  name: api-client
  namespace: default
spec:
  serviceAccountName: my-sa
  automountServiceAccountToken: true # Pod の設定が優先
  containers:
    - name: app
      image: busybox:1.28
      command: ["sh", "-c", "sleep 1h"]
```

## SecurityContext

Pod・container がノード上でどのユーザー・権限で実行されるかを決める設定。RBAC と違って API の権限とは関係ない。

- 場所
  - Pod レベル: `spec.securityContext`、すべての container に適用
  - container レベル: `spec.containers[].securityContext`
  - 両方あれば container レベルが上書き

| フィールド                 | Pod | container | 意味                                                        |
| -------------------------- | --- | --------- | ----------------------------------------------------------- |
| `runAsUser` / `runAsGroup` | O   | O         | プロセスの UID / 基本 GID                                   |
| `runAsNonRoot`             | O   | O         | `true` なら UID 0 で実行しようとすると kubelet が起動を拒否 |
| `seccompProfile`           | O   | O         | `RuntimeDefault`、`Localhost`、`Unconfined`                 |
| `fsGroup`                  | O   | X         | volume の所有グループ                                       |
| `supplementalGroups`       | O   | X         | 追加のグループ                                              |
| `sysctls`                  | O   | X         | Pod の sysctl                                               |
| `capabilities`             | X   | O         | Linux capability の add/drop                                |
| `readOnlyRootFilesystem`   | X   | O         | root filesystem を読み取り専用に                            |
| `allowPrivilegeEscalation` | X   | O         | setuid などによる権限昇格を許すか (`no_new_privs`)          |
| `privileged`               | X   | O         | privileged モード                                           |

- `allowPrivilegeEscalation`: container が `privileged` か `CAP_SYS_ADMIN` を持っていれば常に true
- capability 名は `CAP_` 接頭辞なしで: `CAP_SYS_TIME` → `SYS_TIME`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  volumes:
    - name: tmp
      emptyDir: {}
  containers:
    - name: app
      image: busybox:1.28
      command: ["sh", "-c", "sleep 1h"]
      volumeMounts:
        - name: tmp
          mountPath: /tmp # readOnlyRootFilesystem のときの書き込み先
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
          add: ["NET_BIND_SERVICE"]
```

## Pod Security Standards

Pod のセキュリティレベルを三段階のポリシーとして定義したもの。強制は `PodSecurity` admission controller (Pod Security Admission) が担当する。

| レベル     | 内容                                                                  |
| ---------- | --------------------------------------------------------------------- |
| Privileged | 制限なし。既知の権限昇格も許可                                        |
| Baseline   | 既知の権限昇格をブロック。デフォルト (最小限の指定) の Pod 設定は許可 |
| Restricted | 現在の Pod hardening の best practice に沿った強い制限                |

Restricted が要求する container の設定 (抜粋):

- `allowPrivilegeEscalation: false`
- `runAsNonRoot: true`、`runAsUser` は 0 禁止
- `capabilities.drop` に `ALL`、add は `NET_BIND_SERVICE` のみ
- `seccompProfile.type`: `RuntimeDefault` か `Localhost` (未指定・`Unconfined` は不可)
- volume の種類の制限: configMap、csi、downwardAPI、emptyDir、ephemeral、persistentVolumeClaim、projected、secret

namespace のラベルで適用:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: secure-ns
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
```

| mode      | 違反したとき                         |
| --------- | ------------------------------------ |
| `enforce` | Pod を拒否                           |
| `audit`   | audit log に annotation を追加、許可 |
| `warn`    | ユーザーに警告、許可                 |

## 紛らわしいものの比較

| 項目                                | A                                                      | B                                                                                    |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 401 vs 403                          | 401: authentication の失敗 (誰なのかわからない)        | 403: authorization の拒否 (誰かはわかるが権限がない)                                 |
| authorization vs admission          | リクエストの属性 (user、verb、resource) だけを見て判断 | オブジェクトの中身 (フィールドの値) まで見て変更・拒否。読み取りのリクエストは対象外 |
| Role vs ClusterRole                 | namespace の範囲                                       | クラスタの範囲。RoleBinding で一つの namespace にだけ付けることもできる              |
| RoleBinding + ClusterRole           | 効果は RoleBinding の namespace の中に限定             | ClusterRoleBinding なら全 namespace                                                  |
| RBAC vs SecurityContext             | API server に対する権限                                | ノード上でプロセスが持つ権限                                                         |
| `runAsNonRoot` vs `runAsUser`       | 条件の検査 (root なら実行を拒否)                       | 実際の UID を指定                                                                    |
| `privileged` vs capabilities        | 事実上ホストレベルの権限すべて                         | 必要な capability だけを選んで add/drop                                              |
| Pod vs container の securityContext | 共通のデフォルト、`fsGroup` など Pod 専用のフィールド  | 上書き、`capabilities` など container 専用のフィールド                               |

## 試験のポイント

### imperative なコマンド

```bash
# ServiceAccount
kubectl create serviceaccount my-sa -n dev
kubectl set serviceaccount deployment/web my-sa -n dev
kubectl create token my-sa -n dev

# RBAC
kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev
kubectl create rolebinding pod-reader-binding --role=pod-reader \
  --serviceaccount=dev:my-sa -n dev
kubectl create clusterrole secret-reader --verb=get,list,watch --resource=secrets
kubectl create rolebinding view-binding --clusterrole=view \
  --serviceaccount=dev:my-sa -n dev

# 権限の確認
kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:my-sa
kubectl auth can-i --list -n dev --as=system:serviceaccount:dev:my-sa

# Pod Security Admission
kubectl label namespace secure-ns pod-security.kubernetes.io/enforce=restricted
```

- SecurityContext には imperative なフラグがない。`kubectl run ... --dry-run=client -o yaml` で骨組みを作ってから YAML に追加

### kubectl explain

```bash
kubectl explain pod.spec.securityContext                          # Pod レベル: runAsUser、fsGroup など
kubectl explain pod.spec.containers.securityContext               # container レベル: capabilities、readOnlyRootFilesystem など
kubectl explain pod.spec.containers.securityContext.capabilities  # add、drop
kubectl explain pod.spec.automountServiceAccountToken
kubectl explain role.rules                                        # apiGroups、resources、verbs
kubectl explain rolebinding.subjects                              # kind、name、namespace
```

## 参考ドキュメント

- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Authorization](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Service Accounts](https://kubernetes.io/docs/concepts/security/service-accounts/)
- [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [Pod API reference (`runAsNonRoot`)](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
