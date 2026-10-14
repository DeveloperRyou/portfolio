---
title: "CKA 개념 노트: Gateway API와 Ingress"
description: "GatewayClass, Gateway, HTTPRoute의 역할 분리, host·path·header 매칭과 가중치 분할, 다른 namespace의 Route와 backend를 허용하는 allowedRoutes와 ReferenceGrant, 그리고 Ingress와의 차이를 NGINX Gateway Fabric과 ingress-nginx를 설치한 kubeadm 클러스터에서 확인했습니다."
pubDatetime: 2026-10-14T01:10:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "gateway-api", "ingress", "httproute"]
order: 10
---

> 기준: kubeadm 클러스터 v1.35.9, Gateway API v1.6.1 CRD (standard channel), NGINX Gateway Fabric v2.7.2, ingress-nginx chart 4.15.1 (controller 1.15.1)에서 명령어 확인

Ingress 리소스 기본(host·path 규칙, pathType, TLS)은 [CKAD 개념 노트: Service, Ingress, NetworkPolicy](/ko/posts/ckad-services-ingress-networkpolicy)에 정리했음.

## 목차

## Gateway API

Ingress의 후속으로 만든 Kubernetes 공식 API(`gateway.networking.k8s.io`). Kubernetes 본체에 포함되지 않아서 CRD를 따로 설치함.

| 리소스                   | 누가 관리                   | 내용                                                                     |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| GatewayClass             | 인프라 제공자               | 어떤 controller가 처리하는지 (`controllerName`). 클러스터 범위           |
| Gateway                  | 클러스터 운영자             | listener(포트, 프로토콜, hostname, TLS), 어떤 namespace의 Route를 받을지 |
| HTTPRoute (GRPCRoute 등) | 앱 개발자                   | 매칭 규칙과 backend Service                                              |
| ReferenceGrant           | backend 쪽 namespace 소유자 | 다른 namespace에서 내 Service를 참조해도 된다는 허가                     |

Ingress 하나에 몰려 있던 설정을 역할별 리소스로 나눈 것.

```text
GatewayClass (nginx) ◀── Gateway (web-gw, :80) ◀── HTTPRoute (app) ──▶ Service app-v1, app-v2
```

## 설치

1. Gateway API CRD
2. Gateway controller (구현체). controller가 GatewayClass를 만들거나, 직접 만듦

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

- CRD에는 standard channel(GA·beta)과 experimental channel이 있음. 위 kustomization은 standard(`bundle-version: v1.6.1`)
- 앞서 v1.6.3 CRD를 설치해 둔 상태에서 v1.6.1을 apply했는데 그대로 적용됨. CRD와 같이 설치되는 ValidatingAdmissionPolicy `safe-upgrades.gateway.networking.k8s.io`가 있음
- `--set nginx.service.type=NodePort`: 기본은 LoadBalancer라서, LB 구현이 없는 클러스터에서는 NodePort로 바꿈

## Gateway와 HTTPRoute

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

Gateway를 만들면 NGINX Gateway Fabric이 Gateway마다 data plane(Deployment + Service `web-gw-nginx`)을 만듦.

```text
$ kubectl get gateway,httproute
gateway.gateway.networking.k8s.io/web-gw   nginx   10.111.208.129   True (PROGRAMMED)
httproute.gateway.networking.k8s.io/app    ["app.example.com"]
```

요청 결과 (`Host: app.example.com`):

| 요청                                             | 결과                                |
| ------------------------------------------------ | ----------------------------------- |
| `/v2/x`                                          | `v2` (PathPrefix)                   |
| `/` + `x-canary: true`                           | `v2` (header 매칭)                  |
| `/` 100번                                        | `v1` 75번, `v2` 25번 (weight 80:20) |
| `Host: foo.example.com` (Route 없음)             | 404                                 |
| `Host: app.other.org` (listener hostname 불일치) | 404                                 |

- `weight`는 비율이라서 100번에 정확히 80:20이 나오지는 않음
- 매칭: `path`(Exact, PathPrefix, RegularExpression), `headers`, `queryParams`, `method`. 한 `matches` 항목 안은 AND, 항목 여러 개는 OR
- `filters`로 header 수정, redirect, URL rewrite, mirror

## status 읽기

Gateway API는 문제가 생기면 대부분 status condition에 이유가 남음.

```bash
kubectl get gateway web-gw -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}'
# Accepted=True Programmed=True

kubectl get httproute app -o jsonpath='{range .status.parents[0].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
# Accepted=True Accepted
# ResolvedRefs=True ResolvedRefs
```

backend 이름을 없는 Service(`app-v3`)로 바꿨을 때:

```text
Accepted=True Accepted
ResolvedRefs=False BackendNotFound: spec.rules[0].backendRefs[0].name: Not found: "app-v3"
```

해당 경로(`/v2`)는 500을 반환함. 다른 rule은 계속 동작.

## 다른 namespace

### Route가 다른 namespace에 있을 때: allowedRoutes

listener의 `allowedRoutes` 기본값은 `{"namespaces":{"from":"Same"}}`. `other` namespace의 HTTPRoute가 `gw/web-gw`를 parent로 지정하면:

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

바꾼 뒤 `Accepted=True`.

### backend가 다른 namespace에 있을 때: ReferenceGrant

`gw` namespace의 HTTPRoute가 `other` namespace의 Service를 backend로 지정하면:

```text
ResolvedRefs=False RefNotPermitted: spec.rules[0].backendRefs[0].namespace: Forbidden:
Backend ref to Service other/echo not permitted by any ReferenceGrant
```

허가는 backend 쪽(`other`) namespace에 만듦.

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

적용 후 `ResolvedRefs=True`, `/v2` 요청이 `other`의 Service로 감. v1.6 CRD에는 ReferenceGrant `v1`도 있지만 여기서는 `v1beta1`로 확인함.

| 방향                             | 누가 허가  | 리소스                      |
| -------------------------------- | ---------- | --------------------------- |
| Route → 다른 namespace의 Gateway | Gateway 쪽 | `listeners[].allowedRoutes` |
| Route → 다른 namespace의 Service | Service 쪽 | ReferenceGrant              |

## NodePort와 externalTrafficPolicy

Gateway data plane Service는 `externalTrafficPolicy: Local`로 만들어졌음. data plane Pod가 cka-w2에만 있어서, cka-w1의 NodePort로 보낸 요청은 응답 없이 timeout(`000`), cka-w2로 보낸 요청만 200.

| externalTrafficPolicy | 동작                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `Cluster` (기본)      | 아무 노드로 들어와도 다른 노드의 Pod로 전달. 클라이언트 IP는 SNAT로 바뀜 |
| `Local`               | 그 노드에 있는 Pod로만. 없으면 drop. 클라이언트 IP 보존                  |

## Ingress controller

Ingress 리소스만으로는 아무 일도 안 일어남. controller가 있어야 함. ingress-nginx를 Helm으로 설치해 봄.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.service.type=NodePort
kubectl get ingressclass
# nginx   k8s.io/ingress-nginx

kubectl create ingress a --class=nginx --rule="a.example.com/*=a:80"
```

- 이 chart의 controller Service는 `externalTrafficPolicy: Cluster`. 두 worker NodePort 모두 응답
- `Host: a.example.com`이면 backend 응답, Host가 없으면 controller의 기본 404
- `--class`를 빼고 만든 Ingress(`b`)는 CLASS가 `<none>`이고 404. default IngressClass(`ingressclass.kubernetes.io/is-default-class: "true"` annotation)가 없으면 어느 controller도 처리하지 않음

## Ingress vs Gateway API

|                          | Ingress                            | Gateway API                                                                                     |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| 리소스                   | Ingress 하나 (+ IngressClass)      | GatewayClass, Gateway, *Route, ReferenceGrant                                                   |
| 프로토콜                 | HTTP/HTTPS                         | HTTPRoute, GRPCRoute, TCPRoute, UDPRoute, TLSRoute (v1.6 CRD 기준 모두 standard channel의 `v1`) |
| header 매칭, 가중치 분할 | 표준에 없음. controller annotation | 표준 필드                                                                                       |
| 다른 namespace           | 같은 namespace Service만           | allowedRoutes, ReferenceGrant로 명시적 허용                                                     |
| 상태 확인                | `ADDRESS` 정도                     | Gateway·Route status condition에 이유                                                           |
| 설치                     | API는 기본 포함, controller만 설치 | CRD + controller                                                                                |

## 헷갈리는 것 비교

| 비교                                             | A                                            | B                                                     |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------- |
| GatewayClass vs IngressClass                     | Gateway가 쓸 controller                      | Ingress가 쓸 controller                               |
| `parentRefs` vs `backendRefs`                    | Route를 붙일 Gateway                         | 트래픽을 보낼 Service                                 |
| Gateway listener `hostname` vs Route `hostnames` | Gateway가 받을 이름 범위                     | Route가 처리할 이름. 둘이 겹쳐야 함                   |
| `Accepted=False` vs `ResolvedRefs=False`         | Gateway가 Route를 안 받음 (allowedRoutes 등) | backend 참조 문제 (없는 Service, ReferenceGrant 없음) |
| allowedRoutes vs ReferenceGrant                  | Gateway 쪽이 Route를 허용                    | Service 쪽이 참조를 허용                              |

## 시험 포인트

### 빨리 보는 명령어

```bash
kubectl get gatewayclass
kubectl get gateway,httproute -A
kubectl describe httproute <name>          # Status.Parents.Conditions
kubectl get httproute <name> -o yaml | grep -A20 "^status"
kubectl get ingressclass
kubectl create ingress <name> --class=<class> --rule="host/path*=svc:port"
```

- Gateway API YAML은 `kubectl create` 생성기가 없음. gateway-api.sigs.k8s.io의 예제나 kubernetes.io의 Gateway API 페이지에서 복사
- Ingress → Gateway API 이전 문제: Ingress의 host는 `hostnames`, path는 `matches.path`, backend는 `backendRefs`로 옮기고, `parentRefs`로 Gateway에 연결
- Route가 안 붙으면 Gateway listener의 `hostname`, `allowedRoutes`, `protocol`부터 확인

### kubectl explain

```bash
kubectl explain gateway.spec.listeners
kubectl explain httproute.spec.rules.matches
kubectl explain httproute.spec.rules.backendRefs
kubectl explain referencegrant.spec
```

## 참고 문서

- [Gateway API (kubernetes.io)](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Gateway API 문서](https://gateway-api.sigs.k8s.io/)
- [HTTPRoute](https://gateway-api.sigs.k8s.io/api-types/httproute/)
- [ReferenceGrant](https://gateway-api.sigs.k8s.io/api-types/referencegrant/)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [NGINX Gateway Fabric: Install with Helm](https://docs.nginx.com/nginx-gateway-fabric/install/helm/)
- [Service: externalTrafficPolicy](https://kubernetes.io/docs/reference/networking/virtual-ips/#external-traffic-policy)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
