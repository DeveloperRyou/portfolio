---
title: "CKAD 概念ノート: Service、Ingress、NetworkPolicy"
description: "Service の type と selector から EndpointSlice につながる流れ、Service の DNS 名、接続できないときの確認手順、Ingress の rule と pathType、NetworkPolicy の default deny と selector の組み合わせを公式ドキュメントに沿ってまとめました。"
pubDatetime: 2026-09-26T12:12:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "service", "ingress", "networkpolicy", "dns"]
order: 13
---

> 基準: Kubernetes v1.35 (kind `kindest/node:v1.35.8` でコマンド・YAML を確認)

## 目次

## 概念

### Service

- Pod は作成・削除されるたびに IP が変わる。Service は selector に合う Pod の集合の前に安定した接点を提供する
- `spec.selector`: トラフィックを送る Pod のラベル
- `spec.ports[]`
  - `port`: Service が受けるポート
  - `targetPort`: Pod 側のポート。省略すると `port` と同じ値。数字か、Pod の `containerPort` の**名前**
  - `nodePort`: NodePort/LoadBalancer でノードが開くポート
  - `protocol`: デフォルト `TCP`
- Service 名は RFC 1123 label のルール (小文字、数字、`-`)

### Service type

| type           | 動作                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ClusterIP`    | デフォルト。クラスタ内部の IP を割り当て、クラスタの中からだけアクセス                                                                 |
| `NodePort`     | ClusterIP に加えて、すべてのノードの同じポート (デフォルトの範囲 30000-32767) で公開                                                   |
| `LoadBalancer` | 外部のロードバランサで公開。Kubernetes が直接提供するのではなく、クラウド連携などが必要。作成は非同期で、結果は `.status.loadBalancer` |
| `ExternalName` | selector なしで、`spec.externalName` の DNS 名への CNAME を返す。プロキシなし                                                          |

- type は入れ子の構造: NodePort は ClusterIP の上に、LoadBalancer は NodePort の上に積み重なる (LoadBalancer の NodePort 割り当てをオフにする例外あり)

### headless Service

- `spec.clusterIP: None` (type は ClusterIP)。`None` はフィールドを空にするのとは違う
- cluster IP の割り当てなし、kube-proxy が処理しない、ロードバランシングなし
- selector があれば EndpointSlice が作られ、DNS が **Pod の IP たち**を A/AAAA レコードとして返す
- クライアントが目的の Pod に直接つなぐときに使う

### selector → EndpointSlice

- Service controller が selector に合う Pod を常にスキャンして EndpointSlice を更新する
- EndpointSlice は Service の後ろにあるネットワーク endpoint の一部 (slice) を持つオブジェクト。デフォルトでは slice 一つに endpoint が 100 個たまると新しい slice を追加
- EndpointSlice には `kubernetes.io/service-name=<Service 名>` のラベルが付いていて、これで照会する
- `Endpoints` API は v1.33 から deprecated。公式ドキュメントは EndpointSlice の使用を推奨
- selector のない Service には EndpointSlice が自動で作られない。外部のバックエンドを指すときは EndpointSlice を自分で書く

### Service の DNS

| 対象             | レコード名                                                 | 結果                    |
| ---------------- | ---------------------------------------------------------- | ----------------------- |
| 普通の Service   | `<svc>.<ns>.svc.<cluster-domain>`                          | cluster IP              |
| headless Service | `<svc>.<ns>.svc.<cluster-domain>`                          | 選ばれた Pod の IP 全部 |
| named port (SRV) | `_<port-name>._<protocol>.<svc>.<ns>.svc.<cluster-domain>` | ポート番号 + 名前       |

- cluster-domain は普通 `cluster.local`
- Pod の `/etc/resolv.conf` の search リスト: `<ns>.svc.cluster.local svc.cluster.local cluster.local`
- だから同じ namespace なら `<svc>` だけで、別の namespace からなら最低 `<svc>.<ns>`
- 例: `test` namespace の Pod から `prod` の `data` Service → `data` は失敗、`data.prod` か `data.prod.svc.cluster.local` なら成功

### Ingress

- クラスタの外から入ってくる HTTP(S) のトラフィックを、host/path のルールで Service にルーティング
- `apiVersion: networking.k8s.io/v1` (v1.19 で stable)
- **Ingress controller がないと動かない**。Ingress リソースを作るだけでは効果なし
- Kubernetes プロジェクトは Ingress の代わりに Gateway API を推奨していて、Ingress API は frozen (GA のまま維持され削除の予定もないが、機能追加はもうない)
- HTTP(S) のみ対応。TLS は 443 ポート一つで、Ingress の地点で TLS を終端

rule の構成

- `host` (任意): なければすべての host に適用。`*.foo.com` のようなワイルドカードも可能
- `http.paths[]`: `path` + `pathType` + `backend.service.name` + `backend.service.port.number` (または `.name`)
- host と path の両方が合って初めてその backend へ
- `spec.defaultBackend`: どの rule にも合わないリクエストの行き先。rule がなければ必須

pathType (必須。なければ validation で失敗)

| pathType                 | マッチング                                                     |
| ------------------------ | -------------------------------------------------------------- |
| `Exact`                  | URL の path が完全一致、大文字小文字を区別                     |
| `Prefix`                 | `/` で区切った path element 単位の前方一致、大文字小文字を区別 |
| `ImplementationSpecific` | IngressClass (controller) が解釈                               |

`Prefix` の例 (公式ドキュメントの表から抜粋)

| path        | リクエスト      | 一致                         |
| ----------- | --------------- | ---------------------------- |
| `/foo`      | `/foo`、`/foo/` | O                            |
| `/aaa/bbb`  | `/aaa/bbb/ccc`  | O (下位のパス)               |
| `/aaa/bbb`  | `/aaa/bbbxyz`   | X (文字列の前方一致ではない) |
| `/aaa/bbb/` | `/aaa/bbb`      | O (末尾のスラッシュは無視)   |

- 複数の path が合えば最も長い path が優先、長さが同じなら `Exact` が `Prefix` より優先

IngressClass

- `spec.ingressClassName`: IngressClass リソースの名前を参照。IngressClass の `spec.controller` が担当の controller を指定
- 以前の annotation `kubernetes.io/ingress.class` は deprecated。`ingressClassName` が代わりになるが、完全に同じ意味ではない
- `ingressclass.kubernetes.io/is-default-class: "true"` の IngressClass があれば、`ingressClassName` のない Ingress に自動で指定される
- default が二つ以上あると、admission controller が `ingressClassName` のない Ingress の作成を防ぐ

### NetworkPolicy

- `apiVersion: networking.k8s.io/v1`、namespaced
- network plugin が対応していないと動かない。対応していなければ作っても効果なし
- L4 (TCP、UDP、任意で SCTP)。ICMP など他のプロトコルの動作は plugin ごとに違う

isolation のルール

- デフォルト: Pod は ingress、egress とも non-isolated (すべて許可)
- ある NetworkPolicy が Pod を選び、`policyTypes` に `Ingress` があれば、その Pod は ingress isolated。以降に許可されるのは**適用されたポリシーの `ingress` リストの和集合**と、Pod が動いているノードからの接続だけ
- egress も同じ方式
- ポリシー同士は衝突しない。すべて足し算 (許可の和集合) なので評価順は関係ない。deny のルールはない
- 許可された接続の応答トラフィックは自動で許可
- A → B の接続は **A の egress と B の ingress の両方**が許可して初めて成立

spec のフィールド

- `podSelector`: ポリシーを適用する Pod。`{}` なら namespace のすべての Pod
- `policyTypes`: `Ingress`、`Egress`、または両方。省略すると `Ingress` は常に、`Egress` は egress の rule があるときだけ設定される
- `ingress[].from[]` / `egress[].to[]`: 相手を指定
- `ingress[].ports[]` / `egress[].ports[]`: 許可するポート。`from`/`to` と `ports` の**両方**が合って初めて許可

`from`/`to` で使う selector

| selector                                               | 選ぶ対象                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `podSelector`                                          | NetworkPolicy と**同じ namespace** の Pod                                  |
| `namespaceSelector`                                    | 該当する namespace のすべての Pod                                          |
| `namespaceSelector` + `podSelector` (一つの項目の中に) | 特定の namespace の中の特定の Pod (AND)                                    |
| `ipBlock`                                              | CIDR の範囲。`except` で除外。Pod の IP は変わるので、クラスタ外部の IP 用 |

- namespace を名前で選ぶフィールドはない。すべての namespace に control plane が付ける不変のラベル `kubernetes.io/metadata.name: <名前>` を `namespaceSelector` で使う

## 動作の仕組み

### リクエストが Pod に届くまでの経路

```
外部のクライアント
  └─ Ingress controller (host/path のマッチング、Ingress の rule)
       └─ Service (ClusterIP)
            └─ EndpointSlice (selector に合い ready な Pod の IP:targetPort)
                 └─ Pod  ← NetworkPolicy が ingress を許可して初めて到達
```

- NodePort は Ingress なしで `<ノードの IP>:<nodePort>` → Service → Pod
- クラスタ内部の Pod 同士は DNS 名 → cluster IP → Pod

### AND と OR: YAML のインデント一つの違い

```yaml
# (1) 項目 1 つ: namespace のラベル user=alice かつ Pod のラベル role=client (AND)
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
        podSelector:
          matchLabels:
            role: client
```

```yaml
# (2) 項目 2 つ: user=alice の namespace のすべての Pod、または同じ namespace の role=client の Pod (OR)
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
      - podSelector:
          matchLabels:
            role: client
```

違いは `podSelector` の前の `-` 一つ。紛らわしければ `kubectl describe networkpolicy` で Kubernetes がどう解釈したかを確認せよ、と公式ドキュメントも言っている。

## 例

### Deployment を Service で公開

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80
kubectl expose deployment web --port=80 --target-port=80              # ClusterIP
kubectl expose deployment web --name=web-np --port=80 --type=NodePort
kubectl create service clusterip web2 --tcp=80:8080 --dry-run=client -o yaml
```

- `kubectl expose` は対象リソースの selector をそのまま Service の selector に使う (Deployment は selector が `matchLabels` だけのときに可能)
- `kubectl create service` は既存のリソースの selector を読まず、selector を `app: <Service 名>` で埋める (上の `web2` なら `app: web2`) → `-o yaml` で selector が Pod のラベルと合っているか確認

### named targetPort

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http-web
---
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: nginx
      image: nginx:1.27
      ports:
        - containerPort: 80
          name: http-web
```

Pod 側のポート番号が変わっても、名前さえ同じなら Service を直す必要はない。

### headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-headless
spec:
  clusterIP: None
  selector:
    app: web
  ports:
    - port: 80
```

### Ingress: host 一つ、path 二つ

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: nginx
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 8080
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

同じ内容を imperative で:

```bash
kubectl create ingress shop --class=nginx \
  --rule="shop.example.com/api*=api:8080" \
  --rule="shop.example.com/*=web:80"
```

kubectl reference の例に従えば、path の末尾に `*` を付けると `pathType: Prefix`、なければ `Exact`。作った後に `-o yaml` で pathType を確認するほうが安全。

### NetworkPolicy: default deny + 必要なものだけ許可

```yaml
# namespace のすべての Pod を ingress isolated に
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# role=db の Pod は role=backend の Pod からの TCP 5432 だけを許可
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-backend
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: backend
      ports:
        - protocol: TCP
          port: 5432
```

default deny の egress をかけると DNS も止まる。公式ドキュメントの警告どおり、クラスタの DNS への egress を別に開ける必要がある。

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

DNS の Pod の場所とラベルはクラスタごとに違うことがあるので、`kube-system` は例としての値。

### 接続できないときの確認手順

公式ドキュメントの "Debug Services" の流れを縮めたもの。

```bash
# 1. Service があり、port/targetPort が合っているか
kubectl get svc web -o yaml

# 2. selector が Pod を捕まえているか (ENDPOINTS が <none> なら selector/ラベルの不一致)
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl get pods -l app=web --show-labels

# 3. DNS が解決できるか (クラスタの中の一時的な Pod から、FQDN で)
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- nslookup web.default.svc.cluster.local

# 4. IP/ポートで直接つながるか
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- http://web.default:80

# 5. 対象の Pod にかかっている NetworkPolicy があるか
kubectl get networkpolicy -n default
kubectl describe networkpolicy -n default
```

busybox の `nslookup` は search リストをきちんと適用しないので、`nslookup web.default` は Service が正常でも `NXDOMAIN` で失敗する (busybox:1.36、v1.35 の kind で確認)。同じ名前でも `wget` は search リストどおりに解決するので、FQDN が必要なのは DNS の確認だけ。

`targetPort` のチェック項目 (公式ドキュメント): Service の `spec.ports[]` にアクセスしたいポートがあるか、`targetPort` が Pod が実際に listen しているポートか、named port なら Pod に同じ名前のポートがあるか、`protocol` が合っているか。

## 紛らわしいものの比較

| 項目         | `port`                 | `targetPort`                    | `nodePort`                 | `containerPort`                                                                                     |
| ------------ | ---------------------- | ------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| 場所         | Service                | Service                         | Service                    | Pod                                                                                                 |
| 意味         | Service が受けるポート | トラフィックを渡す Pod のポート | ノードが開くポート         | container が開くと宣言したポート                                                                    |
| 省略したとき | 必須                   | `port` と同じ値                 | 範囲の中から自動で割り当て | 省略しても container が listen しているポートにはネットワークからアクセスできる (Pod API reference) |

| 紛らわしいペア                                              | 違い                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ClusterIP vs headless                                       | 仮想 IP でロードバランシング vs IP なしで DNS が Pod の IP の一覧を返す           |
| Service vs Ingress                                          | L4、すべての TCP/UDP vs HTTP(S) のみ、host/path のルーティング、controller が必要 |
| `Exact` vs `Prefix`                                         | `/foo` は `/foo/` と不一致 vs path element 単位の前方一致                         |
| `ingressClassName` vs `kubernetes.io/ingress.class`         | IngressClass リソースを参照 vs deprecated な annotation                           |
| NetworkPolicy の `podSelector` (spec) vs `from.podSelector` | ポリシーを適用する Pod vs 許可する相手の Pod                                      |
| `from` の一つの項目に selector 二つ vs 項目二つ             | AND vs OR                                                                         |
| default deny の ingress vs egress                           | 入ってくる接続を遮断 vs 出ていく接続を遮断 (DNS を含む)                           |

## 試験のポイント

### 素早く解くコマンド

- `kubectl expose deployment <name> --port=<p> --target-port=<tp> [--type=NodePort]`
- `kubectl create service nodeport <name> --tcp=<port>:<targetPort> --node-port=<np>`
- `kubectl create ingress <name> --class=<c> --rule="host/path*=svc:port"`
- NetworkPolicy には imperative なコマンドがない → 公式ドキュメントの YAML をコピー
- テスト用の一時的な Pod: `kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- <cmd>`

### kubectl explain

```bash
kubectl explain service.spec.ports               # port、targetPort、nodePort、name
kubectl explain service.spec.type
kubectl explain ingress.spec.rules.http.paths    # path、pathType、backend
kubectl explain ingress.spec.ingressClassName
kubectl explain networkpolicy.spec.ingress.from  # podSelector、namespaceSelector、ipBlock
kubectl explain networkpolicy.spec.egress
kubectl explain networkpolicy.spec.policyTypes
```

## 参考ドキュメント

- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Pod API reference](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/) (`containers[].ports`)
- [kubectl expose](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_expose/)
- [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)
- [kubectl create service nodeport](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_service_nodeport/)
