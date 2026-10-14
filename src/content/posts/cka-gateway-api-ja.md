---
title: "CKA 概念ノート: Gateway API と Ingress"
description: "GatewayClass、Gateway、HTTPRoute の役割分担、host・path・header のマッチングと重み付け分割、別の namespace の Route と backend を許可する allowedRoutes と ReferenceGrant、そして Ingress との違いを、NGINX Gateway Fabric と ingress-nginx を入れた kubeadm クラスタで確認しました。"
pubDatetime: 2026-10-14T01:10:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "gateway-api", "ingress", "httproute"]
order: 10
---

> 基準: kubeadm クラスタ v1.35.9、Gateway API v1.6.1 CRD (standard channel)、NGINX Gateway Fabric v2.7.2、ingress-nginx chart 4.15.1 (controller 1.15.1) でコマンドを確認

Ingress リソースの基本 (host・path のルール、pathType、TLS) は [CKAD 概念ノート: Service、Ingress、NetworkPolicy](/ja/posts/ckad-services-ingress-networkpolicy) にまとめた。

## 目次

## Gateway API

Ingress の後継として作られた Kubernetes の公式 API (`gateway.networking.k8s.io`)。Kubernetes 本体には含まれていないので、CRD を別途インストールする。

| リソース                   | 誰が管理                        | 内容                                                                             |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| GatewayClass               | インフラ提供者                  | どの controller が処理するか (`controllerName`)。クラスタスコープ                |
| Gateway                    | クラスタ運用者                  | listener (ポート、プロトコル、hostname、TLS)、どの namespace の Route を受けるか |
| HTTPRoute (GRPCRoute など) | アプリ開発者                    | マッチングのルールと backend の Service                                          |
| ReferenceGrant             | backend 側の namespace の所有者 | 別の namespace から自分の Service を参照してもいいという許可                     |

Ingress 1 つに詰め込まれていた設定を、役割ごとのリソースに分けたもの。

```text
GatewayClass (nginx) ◀── Gateway (web-gw, :80) ◀── HTTPRoute (app) ──▶ Service app-v1, app-v2
```

## インストール

1. Gateway API の CRD
2. Gateway controller (実装)。controller が GatewayClass を作るか、自分で作る

```bash
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=v2.7.2" \
  | kubectl apply -f -
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric --version 2.7.2 \
  --create-namespace -n nginx-gateway --set nginx.service.type=NodePort
```

```text
$ kubectl get gatewayclass
NAME    CONTROLLER                                   ACCEPTED
nginx   gateway.nginx.org/nginx-gateway-controller   True
```

- CRD には standard channel (GA・beta) と experimental channel がある。上の kustomization は standard (`bundle-version: v1.6.1`)
- 先に v1.6.3 の CRD を入れた状態で v1.6.1 を apply したが、そのまま適用された。CRD と一緒にインストールされる ValidatingAdmissionPolicy `safe-upgrades.gateway.networking.k8s.io` がある
- `--set nginx.service.type=NodePort`: デフォルトは LoadBalancer なので、LB の実装がないクラスタでは NodePort に変える

## Gateway と HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gw
  namespace: gw
spec:
  gatewayClassName: nginx
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: "*.example.com"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app
  namespace: gw
spec:
  parentRefs:
    - name: web-gw
  hostnames: [app.example.com]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v2 }
      backendRefs:
        - { name: app-v2, port: 80 }
    - matches:
        - headers:
            - { name: x-canary, value: "true" }
      backendRefs:
        - { name: app-v2, port: 80 }
    - backendRefs:
        - { name: app-v1, port: 80, weight: 80 }
        - { name: app-v2, port: 80, weight: 20 }
```

Gateway を作ると、NGINX Gateway Fabric が Gateway ごとに data plane (Deployment + Service `web-gw-nginx`) を作る。

```text
$ kubectl get gateway,httproute
gateway.gateway.networking.k8s.io/web-gw   nginx   10.111.208.129   True (PROGRAMMED)
httproute.gateway.networking.k8s.io/app    ["app.example.com"]
```

リクエストの結果 (`Host: app.example.com`):

| リクエスト                                            | 結果                                  |
| ----------------------------------------------------- | ------------------------------------- |
| `/v2/x`                                               | `v2` (PathPrefix)                     |
| `/` + `x-canary: true`                                | `v2` (header のマッチング)            |
| `/` を 100 回                                         | `v1` 75 回、`v2` 25 回 (weight 80:20) |
| `Host: foo.example.com` (Route なし)                  | 404                                   |
| `Host: app.other.org` (listener の hostname と不一致) | 404                                   |

- `weight` は比率なので、100 回でぴったり 80:20 にはならない
- マッチング: `path` (Exact、PathPrefix、RegularExpression)、`headers`、`queryParams`、`method`。1 つの `matches` 項目の中は AND、項目が複数なら OR
- `filters` で header の変更、redirect、URL rewrite、mirror

## status を読む

Gateway API は、問題が起きるとたいてい status condition に理由が残る。

```bash
kubectl get gateway web-gw -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}'
# Accepted=True Programmed=True

kubectl get httproute app -o jsonpath='{range .status.parents[0].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
# Accepted=True Accepted
# ResolvedRefs=True ResolvedRefs
```

backend の名前を存在しない Service (`app-v3`) に変えたとき:

```text
Accepted=True Accepted
ResolvedRefs=False BackendNotFound: spec.rules[0].backendRefs[0].name: Not found: "app-v3"
```

そのパス (`/v2`) は 500 を返す。他の rule は動き続ける。

## 別の namespace

### Route が別の namespace にあるとき: allowedRoutes

listener の `allowedRoutes` のデフォルトは `{"namespaces":{"from":"Same"}}`。`other` namespace の HTTPRoute が `gw/web-gw` を parent に指定すると:

```text
Accepted=False NotAllowedByListeners: The Route is not allowed by any listener
```

```yaml
  listeners:
  - name: http
    ...
    allowedRoutes:
      namespaces:
        from: All        # Same | All | Selector
```

変えた後は `Accepted=True`。

### backend が別の namespace にあるとき: ReferenceGrant

`gw` namespace の HTTPRoute が `other` namespace の Service を backend に指定すると:

```text
ResolvedRefs=False RefNotPermitted: spec.rules[0].backendRefs[0].namespace: Forbidden:
Backend ref to Service other/echo not permitted by any ReferenceGrant
```

許可は backend 側 (`other`) の namespace に作る。

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gw-routes
  namespace: other
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: gw
  to:
    - group: ""
      kind: Service
```

適用後は `ResolvedRefs=True` で、`/v2` のリクエストが `other` の Service に行く。v1.6 の CRD には ReferenceGrant の `v1` もあるが、ここでは `v1beta1` で確認した。

| 方向                              | 誰が許可   | リソース                    |
| --------------------------------- | ---------- | --------------------------- |
| Route → 別の namespace の Gateway | Gateway 側 | `listeners[].allowedRoutes` |
| Route → 別の namespace の Service | Service 側 | ReferenceGrant              |

## NodePort と externalTrafficPolicy

Gateway の data plane の Service は `externalTrafficPolicy: Local` で作られていた。data plane の Pod が cka-w2 にしかなかったので、cka-w1 の NodePort に送ったリクエストは応答なしで timeout (`000`)、cka-w2 に送ったリクエストだけが 200。

| externalTrafficPolicy  | 動作                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `Cluster` (デフォルト) | どのノードに入ってきても他のノードの Pod に転送。クライアント IP は SNAT で変わる |
| `Local`                | そのノードにある Pod にだけ。なければ drop。クライアント IP は保たれる            |

## Ingress controller

Ingress リソースだけでは何も起きない。controller が必要。ingress-nginx を Helm でインストールしてみた。

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.service.type=NodePort
kubectl get ingressclass
# nginx   k8s.io/ingress-nginx

kubectl create ingress a --class=nginx --rule="a.example.com/*=a:80"
```

- この chart の controller の Service は `externalTrafficPolicy: Cluster`。2 台の worker の NodePort どちらも応答した
- `Host: a.example.com` なら backend の応答、Host がなければ controller のデフォルトの 404
- `--class` なしで作った Ingress (`b`) は CLASS が `<none>` で 404。デフォルトの IngressClass (`ingressclass.kubernetes.io/is-default-class: "true"` annotation) がなければ、どの controller も処理しない

## Ingress vs Gateway API

|                                   | Ingress                                         | Gateway API                                                                                          |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| リソース                          | Ingress 1 つ (+ IngressClass)                   | GatewayClass、Gateway、*Route、ReferenceGrant                                                        |
| プロトコル                        | HTTP/HTTPS                                      | HTTPRoute、GRPCRoute、TCPRoute、UDPRoute、TLSRoute (v1.6 の CRD ではすべて standard channel の `v1`) |
| header のマッチング、重み付け分割 | 標準にはない。controller の annotation          | 標準のフィールド                                                                                     |
| 別の namespace                    | 同じ namespace の Service だけ                  | allowedRoutes、ReferenceGrant で明示的に許可                                                         |
| 状態の確認                        | `ADDRESS` くらい                                | Gateway・Route の status condition に理由                                                            |
| インストール                      | API は標準で含まれ、controller だけインストール | CRD + controller                                                                                     |

## 紛らわしいものの比較

| 比較                                                   | A                                                | B                                                              |
| ------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------- |
| GatewayClass vs IngressClass                           | Gateway が使う controller                        | Ingress が使う controller                                      |
| `parentRefs` vs `backendRefs`                          | Route を付ける Gateway                           | トラフィックを送る Service                                     |
| Gateway listener の `hostname` vs Route の `hostnames` | Gateway が受ける名前の範囲                       | Route が処理する名前。2 つが重なる必要がある                   |
| `Accepted=False` vs `ResolvedRefs=False`               | Gateway が Route を受けない (allowedRoutes など) | backend の参照の問題 (存在しない Service、ReferenceGrant なし) |
| allowedRoutes vs ReferenceGrant                        | Gateway 側が Route を許可                        | Service 側が参照を許可                                         |

## 試験のポイント

### すぐ確認するコマンド

```bash
kubectl get gatewayclass
kubectl get gateway,httproute -A
kubectl describe httproute <name>          # Status.Parents.Conditions
kubectl get httproute <name> -o yaml | grep -A20 "^status"
kubectl get ingressclass
kubectl create ingress <name> --class=<class> --rule="host/path*=svc:port"
```

- Gateway API の YAML は `kubectl create` のジェネレータがない。gateway-api.sigs.k8s.io の例か、kubernetes.io の Gateway API のページからコピー
- Ingress → Gateway API の移行の問題: Ingress の host は `hostnames`、path は `matches.path`、backend は `backendRefs` に移し、`parentRefs` で Gateway につなぐ
- Route が付かなければ、Gateway listener の `hostname`、`allowedRoutes`、`protocol` から確認

### kubectl explain

```bash
kubectl explain gateway.spec.listeners
kubectl explain httproute.spec.rules.matches
kubectl explain httproute.spec.rules.backendRefs
kubectl explain referencegrant.spec
```

## 参考ドキュメント

- [Gateway API (kubernetes.io)](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Gateway API ドキュメント](https://gateway-api.sigs.k8s.io/)
- [HTTPRoute](https://gateway-api.sigs.k8s.io/api-types/httproute/)
- [ReferenceGrant](https://gateway-api.sigs.k8s.io/api-types/referencegrant/)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [NGINX Gateway Fabric: Install with Helm](https://docs.nginx.com/nginx-gateway-fabric/install/helm/)
- [Service: externalTrafficPolicy](https://kubernetes.io/docs/reference/networking/virtual-ips/#external-traffic-policy)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
