---
title: "CKA 개념 노트: Pod 네트워크와 CoreDNS"
description: "Kubernetes 네트워크 모델, 노드 사이 Pod 통신, kube-proxy가 Service를 iptables 규칙으로 바꾸는 모습, NodePort와 LoadBalancer, CoreDNS의 Corefile 수정과 Pod dnsPolicy를 kubeadm + Calico 클러스터에서 직접 확인했습니다."
pubDatetime: 2026-10-14T01:09:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "networking", "kube-proxy", "coredns", "dns"]
order: 9
draft: true
---

> 기준: kubeadm 클러스터 v1.35.9 (libvirt VM 3대, 노드 네트워크 192.168.122.0/24), Calico v3.33.0, CoreDNS v1.13.1에서 명령어 확인

Service type, selector와 EndpointSlice, Ingress, NetworkPolicy 기본은 [CKAD 개념 노트: Service, Ingress, NetworkPolicy](/ko/posts/ckad-services-ingress-networkpolicy)에 정리했음. 여기서는 노드와 클러스터 쪽에서 보는 것만.

## 목차

## 네트워크 모델

Kubernetes가 CNI에게 요구하는 것:

- Pod마다 클러스터 안에서 고유한 IP
- 모든 Pod는 NAT 없이 다른 모든 Pod와 통신 (같은 노드든 다른 노드든)
- 노드의 agent(kubelet 등)는 그 노드의 Pod와 통신

IP 대역 세 가지가 겹치면 안 됨.

| 대역             | 이 클러스터        | 정하는 곳                                   |
| ---------------- | ------------------ | ------------------------------------------- |
| 노드 네트워크    | `192.168.122.0/24` | 인프라 (libvirt)                            |
| Pod 네트워크     | `10.244.0.0/16`    | `kubeadm init --pod-network-cidr`, CNI 설정 |
| Service 네트워크 | `10.96.0.0/12`     | `kubeadm init --service-cidr` (기본값)      |

## Pod IP는 어디서 오나

```text
$ kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR
NAME      PODCIDR
cka-cp1   10.244.0.0/24
cka-w1    10.244.1.0/24
cka-w2    10.244.2.0/24
```

controller-manager가 `--allocate-node-cidrs=true`라서 노드마다 `/24`를 나눠 줌. 그런데 실제 Pod IP는 `10.244.95.x`, `10.244.62.x`였음. Calico는 `node.spec.podCIDR`를 쓰지 않고 자체 IPAM 블록을 씀.

```text
$ kubectl get blockaffinities -o custom-columns=NODE:.spec.node,CIDR:.spec.cidr
NODE      CIDR
cka-cp1   10.244.212.128/26
cka-w1    10.244.95.128/26
cka-w2    10.244.62.128/26
```

`podCIDR`를 쓰는 CNI(flannel 등)도 있어서, Pod IP가 어느 대역에서 나오는지는 CNI마다 다름.

## 노드를 넘는 Pod 통신

cka-w1의 busybox Pod에서 cka-w2의 nginx Pod IP로 직접 요청:

```bash
kubectl exec c -- wget -qO- -T3 http://10.244.62.167
# <title>Welcome to nginx!</title>
```

Service 없이 Pod IP로 바로 됨. Calico는 노드 사이를 VXLAN(`vxlan.calico` 인터페이스)으로 감쌈.

## kube-proxy

Service는 실체가 없는 가상 IP. 각 노드의 kube-proxy가 Service와 EndpointSlice를 watch해서 패킷 규칙으로 바꿈.

| mode       | 방식              | 비고       |
| ---------- | ----------------- | ---------- |
| `iptables` | iptables NAT 규칙 | Linux 기본 |
| `ipvs`     | 커널 IPVS         |            |
| `nftables` | nftables 규칙     |            |

```bash
kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep '^mode'
# mode: ""        ← 빈 값 = Linux에서 iptables
```

Service `net/web`(ClusterIP `10.111.80.136`, endpoint 2개)가 만든 규칙:

```text
-A KUBE-SERVICES -d 10.111.80.136/32 -p tcp -m comment --comment "net/web cluster IP" -m tcp --dport 80 -j KUBE-SVC-RTHZXQ2YZKSHM2PI
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.62.167:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-S3UT2MK4P7AJ67WG
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.95.170:80" -j KUBE-SEP-JIQR6UIXHEWKPI63
-A KUBE-NODEPORTS -p tcp -m comment --comment "net/web" -m tcp --dport 31777 -j KUBE-EXT-RTHZXQ2YZKSHM2PI
```

- `KUBE-SERVICES`: ClusterIP:port를 보고 Service 체인으로
- `KUBE-SVC-*`: endpoint 중 하나를 확률로 고름 (2개면 0.5)
- `KUBE-SEP-*`: 실제 Pod IP:port로 DNAT
- `KUBE-NODEPORTS`: NodePort로 들어온 것

Service에 endpoint가 없으면 `KUBE-SVC-*`에 갈 곳이 없음. "Service는 있는데 연결이 안 된다"면 EndpointSlice부터 확인.

```bash
kubectl get endpointslice -l kubernetes.io/service-name=web
# NAME        ADDRESSTYPE   PORTS   ENDPOINTS
# web-4bnv6   IPv4          80      10.244.62.167,10.244.95.170
```

## NodePort와 LoadBalancer

```bash
kubectl expose deploy web --port=80 --type=NodePort
# web   NodePort   10.111.80.136   <none>   80:31777/TCP
```

NodePort는 모든 노드에서 열림. Pod가 없는 control plane IP로 요청해도 응답함.

```text
192.168.122.11:31777  <title>Welcome to nginx!</title>   (cka-cp1, Pod 없음)
192.168.122.21:31777  <title>Welcome to nginx!</title>
192.168.122.22:31777  <title>Welcome to nginx!</title>
```

LoadBalancer는 외부 LB를 만들어 주는 구현(클라우드 controller, MetalLB 등)이 있어야 IP가 붙음. 이 클러스터에는 없어서 `<pending>`.

```text
$ kubectl create svc loadbalancer lb --tcp=80:80
lb   LoadBalancer   10.111.57.195   <pending>   80:30363/TCP
```

LoadBalancer Service도 NodePort(`30363`)를 같이 받기 때문에 `<pending>` 상태에서도 NodePort로는 접근 가능.

## CoreDNS

### 구성

```text
$ kubectl -n kube-system get deploy coredns
coredns   2/2

$ kubectl -n kube-system get svc kube-dns
kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP,9153/TCP
```

- Deployment 이름은 `coredns`, Service 이름은 호환성 때문에 `kube-dns`
- `10.96.0.10`은 kubelet 설정의 `clusterDNS`와 같은 값. kubelet이 Pod의 `/etc/resolv.conf`에 이 주소를 넣음

### Corefile

설정은 `kube-system/coredns` ConfigMap의 `Corefile`.

```text
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
```

| plugin                         | 하는 일                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `kubernetes cluster.local ...` | Service, Pod 레코드 응답. `pods insecure`면 Pod IP 레코드도 |
| `forward . /etc/resolv.conf`   | 클러스터 밖 이름은 노드(CoreDNS Pod)의 resolv.conf 서버로   |
| `cache 30`                     | 30초 캐시                                                   |
| `reload`                       | Corefile이 바뀌면 재시작 없이 다시 읽음                     |
| `health`, `ready`              | liveness(8080), readiness(8181)                             |

### Corefile 수정

`hosts` plugin으로 클러스터 밖 이름 하나를 고정해 봄.

```bash
kubectl -n kube-system edit cm coredns
```

```text
    ready
    hosts {
       192.168.122.200 legacy.example.internal
       fallthrough
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
```

- `reload` plugin이 있어서 CoreDNS를 재시작하지 않아도 반영됨. 로그에 `[INFO] Reloading`
- 반영까지 82초 걸렸음. ConfigMap volume이 Pod 안 파일에 반영되는 시간 + reload 주기. 급하면 `kubectl -n kube-system rollout restart deploy coredns`
- 특정 도메인만 다른 DNS 서버로 보내려면 server block을 추가 (`example.internal:53 { forward . 10.0.0.53 }`)

## DNS 이름

| 대상                   | 이름                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Service                | `<service>.<namespace>.svc.cluster.local`                                                    |
| Pod                    | `<IP의 . 를 - 로>.<namespace>.pod.cluster.local` (예: `10-244-62-167.net.pod.cluster.local`) |
| headless Service의 Pod | `<hostname>.<service>.<namespace>.svc.cluster.local`                                         |

Pod의 `/etc/resolv.conf` (`dnsPolicy: ClusterFirst`, 기본값):

```text
search net.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

- 같은 namespace면 `web`, 다른 namespace면 `web.other`로도 찾아야 정상
- busybox:1.36의 `nslookup web`은 `** server can't find web.svc.cluster.local: NXDOMAIN`으로 실패했음. FQDN(`web.net.svc.cluster.local`)으로는 성공. busybox로 확인할 때는 FQDN을 쓰는 게 안전

## dnsPolicy

| dnsPolicy                 | resolv.conf                          | 실습 결과                                            |
| ------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `ClusterFirst` (기본)     | CoreDNS + search 목록                | 위와 같음                                            |
| `Default`                 | Pod가 뜬 노드의 resolv.conf를 그대로 | `nameserver 192.168.122.1`. 클러스터 이름 해석 안 됨 |
| `ClusterFirstWithHostNet` | hostNetwork Pod에서도 CoreDNS 사용   | `nameserver 10.96.0.10` + search 목록                |
| `None`                    | `dnsConfig`만 사용                   | 아래                                                 |

- 이름과 달리 `Default`가 기본값이 아님
- `hostNetwork: true`에 `dnsPolicy`를 안 쓰면(`ClusterFirst`) 노드 resolv.conf(`192.168.122.1`)가 들어감. CoreDNS를 쓰려면 `ClusterFirstWithHostNet`

```yaml
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers: [1.1.1.1]
    searches: [example.internal]
    options:
      - name: ndots
        value: "2"
```

```text
search example.internal
nameserver 1.1.1.1
options ndots:2
```

## 헷갈리는 것 비교

| 비교                                       | A                                 | B                                                         |
| ------------------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `--pod-network-cidr` vs `--service-cidr`   | Pod IP                            | Service ClusterIP                                         |
| `node.spec.podCIDR` vs 실제 Pod IP         | controller-manager가 나눠 준 대역 | CNI IPAM이 정함. Calico는 자체 블록                       |
| kube-proxy vs CNI                          | Service → Pod (DNAT)              | Pod ↔ Pod 연결                                            |
| ClusterIP vs NodePort                      | 클러스터 안에서만                 | 모든 노드 IP의 30000-32767                                |
| NodePort vs LoadBalancer                   | 노드 IP:port                      | 외부 LB IP. 구현 없으면 `<pending>`. NodePort도 같이 받음 |
| `kube-dns` Service vs `coredns` Deployment | 이름만 kube-dns                   | 실제 서버                                                 |
| `dnsPolicy: Default` vs `ClusterFirst`     | 노드 DNS                          | CoreDNS (실제 기본값)                                     |

## 시험 포인트

### 빨리 보는 명령어

```bash
kubectl get nodes -o wide; kubectl get pods -o wide            # 노드 IP, Pod IP
kubectl -n kube-system get cm kubeadm-config -o yaml | grep -E "podSubnet|serviceSubnet"
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode
kubectl get svc,endpointslice
kubectl -n kube-system get cm coredns -o yaml
kubectl -n kube-system edit cm coredns
kubectl -n kube-system rollout restart deploy coredns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup <svc>.<ns>.svc.cluster.local
sudo iptables -t nat -S | grep <namespace>/<service>
```

- Pod CIDR, Service CIDR를 묻는 문제는 `kubeadm-config` ConfigMap이나 apiserver(`--service-cluster-ip-range`), controller-manager(`--cluster-cidr`) manifest에서 찾음
- Pod 레코드 이름은 IP의 점을 대시로

### kubectl explain

```bash
kubectl explain pod.spec.dnsPolicy
kubectl explain pod.spec.dnsConfig
kubectl explain service.spec.type
```

## 참고 문서

- [Services, Load Balancing, and Networking](https://kubernetes.io/docs/concepts/services-networking/)
- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [CoreDNS plugins](https://coredns.io/plugins/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
