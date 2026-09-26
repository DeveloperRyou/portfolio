---
title: "CKAD 개념 노트: Service, Ingress, NetworkPolicy"
description: "Service type과 selector에서 EndpointSlice로 이어지는 흐름, Service DNS 이름, 연결이 안 될 때 확인 순서, Ingress rule과 pathType, NetworkPolicy default deny와 selector 조합을 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:12:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "service", "ingress", "networkpolicy", "dns"]
order: 13
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 개념

### Service

- Pod는 생성·삭제될 때마다 IP가 바뀜. Service는 selector에 맞는 Pod 집합 앞에 안정된 접점을 제공
- `spec.selector`: 트래픽을 보낼 Pod의 label
- `spec.ports[]`
  - `port`: Service가 받는 포트
  - `targetPort`: Pod 쪽 포트. 생략하면 `port`와 같은 값. 숫자 또는 Pod `containerPort`의 **이름**
  - `nodePort`: NodePort/LoadBalancer에서 노드가 여는 포트
  - `protocol`: 기본 `TCP`
- Service 이름은 RFC 1123 label 규칙 (소문자, 숫자, `-`)

### Service type

| type           | 동작                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ClusterIP`    | 기본값. 클러스터 내부 IP 할당, 클러스터 안에서만 접근                                                                         |
| `NodePort`     | ClusterIP에 더해 모든 노드의 같은 포트(기본 범위 30000-32767)로 노출                                                          |
| `LoadBalancer` | 외부 로드밸런서로 노출. Kubernetes가 직접 제공하지 않고 클라우드 연동 등이 필요. 생성은 비동기, 결과는 `.status.loadBalancer` |
| `ExternalName` | selector 없이 `spec.externalName`의 DNS 이름으로 CNAME 반환. 프록시 없음                                                      |

- type은 중첩 구조: NodePort는 ClusterIP 위에, LoadBalancer는 NodePort 위에 쌓임 (LoadBalancer의 NodePort 할당을 끄는 예외 있음)

### headless Service

- `spec.clusterIP: None` (type은 ClusterIP). `None`은 필드를 비워 두는 것과 다름
- cluster IP 할당 없음, kube-proxy가 처리하지 않음, 로드밸런싱 없음
- selector가 있으면 EndpointSlice가 만들어지고 DNS가 **Pod IP들**을 A/AAAA 레코드로 반환
- 클라이언트가 원하는 Pod에 직접 연결할 때 사용

### selector → EndpointSlice

- Service controller가 selector에 맞는 Pod를 계속 스캔해 EndpointSlice를 갱신
- EndpointSlice는 Service 뒤의 네트워크 endpoint 일부(slice)를 담는 객체. 기본적으로 slice 하나에 endpoint 100개가 차면 새 slice 추가
- EndpointSlice에는 label `kubernetes.io/service-name=<Service 이름>`이 붙어 있어 이걸로 조회
- `Endpoints` API는 v1.33부터 deprecated. 공식 문서는 EndpointSlice 사용 권장
- selector 없는 Service는 EndpointSlice가 자동으로 만들어지지 않음. 외부 백엔드를 가리킬 때 EndpointSlice를 직접 작성

### Service DNS

| 대상             | 레코드 이름                                                | 결과               |
| ---------------- | ---------------------------------------------------------- | ------------------ |
| 일반 Service     | `<svc>.<ns>.svc.<cluster-domain>`                          | cluster IP         |
| headless Service | `<svc>.<ns>.svc.<cluster-domain>`                          | 선택된 Pod IP 전체 |
| named port (SRV) | `_<port-name>._<protocol>.<svc>.<ns>.svc.<cluster-domain>` | 포트 번호 + 이름   |

- cluster-domain은 보통 `cluster.local`
- Pod의 `/etc/resolv.conf` search 목록: `<ns>.svc.cluster.local svc.cluster.local cluster.local`
- 그래서 같은 namespace에서는 `<svc>`만, 다른 namespace에서는 최소 `<svc>.<ns>`
- 예: `test` namespace의 Pod에서 `prod`의 `data` Service → `data`는 실패, `data.prod` 또는 `data.prod.svc.cluster.local`은 성공

### Ingress

- 클러스터 외부에서 들어오는 HTTP(S) 트래픽을 host/path 규칙으로 Service에 라우팅
- `apiVersion: networking.k8s.io/v1` (v1.19 stable)
- **Ingress controller가 있어야 동작**. Ingress 리소스만 만들면 효과 없음
- Kubernetes 프로젝트는 Ingress 대신 Gateway API를 권장, Ingress API는 frozen (GA로 유지되고 제거 계획은 없지만 더 이상 기능 추가 없음)
- HTTP(S)만 지원. TLS는 443 포트 하나, Ingress 지점에서 TLS 종료

rule 구성

- `host`(선택): 없으면 모든 host에 적용. `*.foo.com` 같은 와일드카드 가능
- `http.paths[]`: `path` + `pathType` + `backend.service.name` + `backend.service.port.number`(또는 `.name`)
- host와 path가 모두 맞아야 해당 backend로
- `spec.defaultBackend`: 어떤 rule에도 안 맞는 요청의 목적지. rule이 없으면 필수

pathType (필수. 없으면 validation 실패)

| pathType                 | 매칭                                                    |
| ------------------------ | ------------------------------------------------------- |
| `Exact`                  | URL path 정확히 일치, 대소문자 구분                     |
| `Prefix`                 | `/`로 나눈 path element 단위 prefix 일치, 대소문자 구분 |
| `ImplementationSpecific` | IngressClass(controller)가 해석                         |

`Prefix` 예 (공식 문서 표에서 발췌)

| path        | 요청            | 일치                     |
| ----------- | --------------- | ------------------------ |
| `/foo`      | `/foo`, `/foo/` | O                        |
| `/aaa/bbb`  | `/aaa/bbb/ccc`  | O (하위 경로)            |
| `/aaa/bbb`  | `/aaa/bbbxyz`   | X (문자열 prefix가 아님) |
| `/aaa/bbb/` | `/aaa/bbb`      | O (끝 슬래시 무시)       |

- 여러 path가 맞으면 가장 긴 path 우선, 길이가 같으면 `Exact`가 `Prefix`보다 우선

IngressClass

- `spec.ingressClassName`: IngressClass 리소스 이름 참조. IngressClass의 `spec.controller`가 담당 controller 지정
- 예전 annotation `kubernetes.io/ingress.class`는 deprecated. `ingressClassName`이 대체하지만 완전히 같은 의미는 아님
- `ingressclass.kubernetes.io/is-default-class: "true"`인 IngressClass가 있으면 `ingressClassName` 없는 Ingress에 자동 지정
- default가 둘 이상이면 admission controller가 `ingressClassName` 없는 Ingress 생성을 막음

### NetworkPolicy

- `apiVersion: networking.k8s.io/v1`, namespaced
- network plugin이 지원해야 동작. 지원 안 하면 만들어도 효과 없음
- L4 (TCP, UDP, 선택적으로 SCTP). ICMP 등 다른 프로토콜 동작은 plugin마다 다름

isolation 규칙

- 기본값: Pod는 ingress, egress 모두 non-isolated (전부 허용)
- 어떤 NetworkPolicy가 Pod를 선택하고 `policyTypes`에 `Ingress`가 있으면 그 Pod는 ingress isolated. 이후 허용되는 건 **적용된 정책들의 `ingress` 목록 합집합**과 Pod가 떠 있는 노드에서 오는 연결뿐
- egress도 같은 방식
- 정책끼리 충돌 없음. 전부 더하기(허용의 합집합)라 평가 순서 무관. deny 규칙은 없음
- 허용된 연결의 응답 트래픽은 자동 허용
- A → B 연결은 **A의 egress와 B의 ingress 둘 다** 허용해야 성립

spec 필드

- `podSelector`: 정책이 적용될 Pod. `{}`면 namespace의 모든 Pod
- `policyTypes`: `Ingress`, `Egress` 또는 둘 다. 생략하면 `Ingress`는 항상, `Egress`는 egress rule이 있을 때만 설정됨
- `ingress[].from[]` / `egress[].to[]`: 상대방 지정
- `ingress[].ports[]` / `egress[].ports[]`: 허용할 포트. `from`/`to`와 `ports`가 **둘 다** 맞아야 허용

`from`/`to`에 쓰는 selector

| selector                                           | 선택 대상                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `podSelector`                                      | NetworkPolicy와 **같은 namespace**의 Pod                         |
| `namespaceSelector`                                | 해당 namespace의 모든 Pod                                        |
| `namespaceSelector` + `podSelector` (한 항목 안에) | 특정 namespace 안의 특정 Pod (AND)                               |
| `ipBlock`                                          | CIDR 범위. `except`로 제외. Pod IP는 바뀌므로 클러스터 외부 IP용 |

- namespace를 이름으로 고르는 필드는 없음. 모든 namespace에 control plane이 붙이는 불변 label `kubernetes.io/metadata.name: <이름>`을 `namespaceSelector`로 사용

## 동작 방식

### 요청이 Pod까지 가는 경로

```
외부 클라이언트
  └─ Ingress controller (host/path 매칭, Ingress rule)
       └─ Service (ClusterIP)
            └─ EndpointSlice (selector에 맞고 ready인 Pod IP:targetPort)
                 └─ Pod  ← NetworkPolicy가 ingress 허용해야 도달
```

- NodePort는 Ingress 없이 `<노드 IP>:<nodePort>` → Service → Pod
- 클러스터 내부 Pod끼리는 DNS 이름 → cluster IP → Pod

### AND와 OR: YAML 들여쓰기 하나 차이

```yaml
# (1) 항목 1개: namespace label user=alice 이면서 Pod label role=client (AND)
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
# (2) 항목 2개: user=alice namespace의 모든 Pod, 또는 같은 namespace의 role=client Pod (OR)
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            user: alice
      - podSelector:
          matchLabels:
            role: client
```

차이는 `podSelector` 앞의 `-` 하나. 공식 문서는 헷갈리면 `kubectl describe networkpolicy`로 Kubernetes가 어떻게 해석했는지 확인하라고 한다.

## 예시

### Deployment를 Service로 노출

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80
kubectl expose deployment web --port=80 --target-port=80              # ClusterIP
kubectl expose deployment web --name=web-np --port=80 --type=NodePort
kubectl create service clusterip web2 --tcp=80:8080 --dry-run=client -o yaml
```

- `kubectl expose`는 대상 리소스의 selector를 그대로 Service selector로 사용 (Deployment는 selector가 `matchLabels`만일 때 가능)
- `kubectl create service`는 이름만 받고 기존 리소스의 selector를 읽지 않음 → `-o yaml`로 selector가 Pod label과 맞는지 확인

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

Pod 쪽 포트 번호가 바뀌어도 이름만 같으면 Service를 고칠 필요가 없다.

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

### Ingress: host 하나, path 둘

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

같은 내용을 imperative로:

```bash
kubectl create ingress shop --class=nginx \
  --rule="shop.example.com/api*=api:8080" \
  --rule="shop.example.com/*=web:80"
```

kubectl reference 예시 기준으로 path 끝에 `*`를 붙이면 `pathType: Prefix`, 없으면 `Exact`. 만든 뒤 `-o yaml`로 pathType을 확인하는 편이 안전하다.

### NetworkPolicy: default deny + 필요한 것만 허용

```yaml
# namespace의 모든 Pod를 ingress isolated로
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# role=db Pod는 role=backend Pod에서 오는 TCP 5432만 허용
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

default deny egress를 걸면 DNS도 막힌다. 공식 문서 경고대로 클러스터 DNS로 가는 egress를 따로 열어야 한다.

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

DNS Pod의 위치와 label은 클러스터마다 다를 수 있어 `kube-system`은 예시 값이다.

### 연결이 안 될 때 확인 순서

공식 문서 "Debug Services" 흐름을 줄인 것.

```bash
# 1. Service가 있고 port/targetPort가 맞는가
kubectl get svc web -o yaml

# 2. selector가 Pod를 잡았는가 (ENDPOINTS가 <none>이면 selector/label 불일치)
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl get pods -l app=web --show-labels

# 3. DNS가 풀리는가 (클러스터 안의 임시 Pod에서)
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- nslookup web.default

# 4. IP/포트로 직접 붙는가
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- http://web.default:80

# 5. 대상 Pod에 걸린 NetworkPolicy가 있는가
kubectl get networkpolicy -n default
kubectl describe networkpolicy -n default
```

`targetPort` 점검 항목(공식 문서): Service `spec.ports[]`에 접근하려는 포트가 있는가, `targetPort`가 Pod가 실제로 듣는 포트인가, named port라면 Pod에 같은 이름의 포트가 있는가, `protocol`이 맞는가.

## 헷갈리는 것 비교

| 항목    | `port`              | `targetPort`           | `nodePort`            | `containerPort`                                                             |
| ------- | ------------------- | ---------------------- | --------------------- | --------------------------------------------------------------------------- |
| 위치    | Service             | Service                | Service               | Pod                                                                         |
| 의미    | Service가 받는 포트 | 트래픽을 넘길 Pod 포트 | 노드가 여는 포트      | container가 연다고 선언한 포트                                              |
| 생략 시 | 필수                | `port`와 같은 값       | 범위 안에서 자동 할당 | 생략해도 container가 듣는 포트는 네트워크에서 접근 가능 (Pod API reference) |

| 헷갈리는 쌍                                              | 차이                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| ClusterIP vs headless                                    | 가상 IP로 로드밸런싱 vs IP 없이 DNS가 Pod IP 목록 반환           |
| Service vs Ingress                                       | L4, 모든 TCP/UDP vs HTTP(S)만, host/path 라우팅, controller 필요 |
| `Exact` vs `Prefix`                                      | `/foo`는 `/foo/`와 불일치 vs path element 단위 prefix            |
| `ingressClassName` vs `kubernetes.io/ingress.class`      | IngressClass 리소스 참조 vs deprecated annotation                |
| NetworkPolicy `podSelector` (spec) vs `from.podSelector` | 정책이 적용될 Pod vs 허용할 상대 Pod                             |
| `from`의 한 항목에 두 selector vs 두 항목                | AND vs OR                                                        |
| default deny ingress vs egress                           | 들어오는 연결 차단 vs 나가는 연결 차단(DNS 포함)                 |

## 시험 포인트

### 빨리 푸는 명령어

- `kubectl expose deployment <name> --port=<p> --target-port=<tp> [--type=NodePort]`
- `kubectl create service nodeport <name> --tcp=<port>:<targetPort> --node-port=<np>`
- `kubectl create ingress <name> --class=<c> --rule="host/path*=svc:port"`
- NetworkPolicy는 imperative 명령이 없음 → 공식 문서 YAML 복사
- 필드 확인: `kubectl explain ingress.spec.rules.http.paths`, `kubectl explain networkpolicy.spec.ingress.from`
- 테스트용 임시 Pod: `kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- <cmd>`

### 열어 볼 문서

| 필요한 것                          | 문서 위치                                                               |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Service YAML, named port, headless | Service 페이지                                                          |
| DNS 이름 형식                      | DNS for Services and Pods                                               |
| Ingress YAML, pathType 표          | Ingress 페이지 "The Ingress resource", "Path types", "Types of Ingress" |
| default deny 5종                   | Network Policies 페이지 "Default policies"                              |
| 트러블슈팅 순서                    | Tasks > Debug Services                                                  |

### 자주 하는 실수

- Service selector와 Pod label 불일치 → EndpointSlice가 비어 있음
- `targetPort`를 Service `port`로 착각하거나, container가 실제로 듣지 않는 포트 지정
- 다른 namespace의 Service를 `<svc>`만으로 호출
- Ingress의 `pathType` 누락 (validation 실패), `ingressClassName` 누락으로 controller가 무시
- Ingress backend가 Service 포트가 아니라 container 포트를 가리킴
- NetworkPolicy에서 AND를 의도했는데 `-`를 하나 더 붙여 OR로 만듦
- `from.podSelector`는 NetworkPolicy와 같은 namespace만 본다는 점을 놓침 → 다른 namespace는 `namespaceSelector` 필요
- egress default deny 후 DNS를 안 열어서 이름 해석 실패
- NetworkPolicy는 허용 목록뿐이라 "특정 Pod만 차단"은 다른 Pod를 허용하는 방식으로 표현해야 함

## 참고 문서

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
