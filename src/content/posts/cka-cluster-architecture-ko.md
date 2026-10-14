---
title: "CKA 개념 노트: 클러스터 구조와 컴포넌트"
description: "control plane 컴포넌트(kube-apiserver, etcd, scheduler, controller-manager)와 node 컴포넌트(kubelet, kube-proxy, container runtime)가 서로 어떻게 연결되는지, static Pod와 /etc/kubernetes 아래 파일들을 kubeadm 클러스터에서 직접 확인하며 정리했습니다."
pubDatetime: 2026-10-14T01:02:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "control-plane", "kubelet", "static-pod"]
order: 2
---

> 기준: kubeadm 클러스터 v1.35.9 (libvirt VM 3대: control plane 1, worker 2), containerd 2.4.1에서 명령어 확인

## 목차

## 컴포넌트 지도

```text
              kubectl / 사용자
                    │ :6443
┌───────────────────▼──── control plane (cka-cp1) ───────────────┐
│  kube-apiserver ──── etcd (:2379)                              │
│     ▲      ▲                                                   │
│     │      └── kube-scheduler, kube-controller-manager         │
│     │          (apiserver를 watch, 결과를 apiserver에 기록)      │
└─────┼──────────────────────────────────────────────────────────┘
      │ :6443                       ▲ :10250 (logs, exec)
┌─────┴──────────── worker (cka-w1, cka-w2) ──┴──────────────────┐
│  kubelet ── CRI ── containerd ── runc                          │
│  kube-proxy (Service → iptables 규칙)                           │
│  CNI 플러그인 (Pod 네트워크)                                     │
└────────────────────────────────────────────────────────────────┘
```

- etcd에 직접 붙는 건 kube-apiserver 하나. 나머지는 전부 apiserver를 거침
- 컴포넌트끼리 직접 명령하지 않음. 각자 apiserver를 watch하다가 원하는 상태와 실제 상태가 다르면 맞추는 방식

## control plane 컴포넌트

| 컴포넌트                 | 하는 일                                                                  | kubeadm에서 실행 방식       |
| ------------------------ | ------------------------------------------------------------------------ | --------------------------- |
| kube-apiserver           | 모든 요청의 입구. 인증, 인가, admission, 검증 후 etcd에 저장             | static Pod                  |
| etcd                     | 클러스터 상태를 저장하는 key-value store                                 | static Pod                  |
| kube-scheduler           | `nodeName`이 비어 있는 Pod에 노드를 골라 줌                              | static Pod                  |
| kube-controller-manager  | Deployment, ReplicaSet, Node, Job 등 controller 묶음. 원하는 상태로 맞춤 | static Pod                  |
| cloud-controller-manager | 클라우드 API 연동 (LB, 노드 등)                                          | 온프레미스 kubeadm에는 없음 |

manifest의 주요 플래그:

```bash
sudo grep -E "etcd-servers|service-cluster-ip-range|authorization-mode|enable-admission" \
  /etc/kubernetes/manifests/kube-apiserver.yaml
#    - --authorization-mode=Node,RBAC
#    - --enable-admission-plugins=NodeRestriction
#    - --etcd-servers=https://127.0.0.1:2379
#    - --service-cluster-ip-range=10.96.0.0/12

sudo grep -E "cluster-cidr|allocate-node-cidrs|leader-elect" \
  /etc/kubernetes/manifests/kube-controller-manager.yaml
#    - --allocate-node-cidrs=true
#    - --cluster-cidr=10.244.0.0/16
#    - --leader-elect=true
```

- `--service-cluster-ip-range`: Service ClusterIP 대역. `kubeadm init --service-cidr`
- `--cluster-cidr`: Pod 대역. `kubeadm init --pod-network-cidr`
- scheduler와 controller-manager는 `--leader-elect=true`. HA에서 여러 대가 떠 있어도 일하는 건 Lease를 잡은 하나

```text
$ kubectl -n kube-system get lease
NAME                      HOLDER
kube-controller-manager   cka-cp1_570f3ff0-...
kube-scheduler            cka-cp1_af5d04d1-...
```

## node 컴포넌트

| 컴포넌트          | 하는 일                                                                | 실행 방식                                  |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| kubelet           | 노드에 배정된 Pod를 container runtime으로 실행하고 상태를 보고         | systemd 서비스                             |
| container runtime | 이미지 pull, 컨테이너 실행. kubelet과 CRI로 통신                       | systemd 서비스 (containerd)                |
| kube-proxy        | Service와 EndpointSlice를 보고 노드의 iptables/IPVS/nftables 규칙 작성 | DaemonSet                                  |
| CNI 플러그인      | Pod에 IP와 네트워크 인터페이스 연결                                    | 대부분 DaemonSet + `/opt/cni/bin` 바이너리 |

kubelet만 Pod가 아님. kubelet이 있어야 Pod가 뜨니까. control plane 노드에도 kubelet, container runtime, kube-proxy가 다 있음.

```text
$ kubectl -n kube-system get pods -o wide
coredns-7d764666f9-9w4dz          cka-cp1
coredns-7d764666f9-bwvwh          cka-w1
etcd-cka-cp1                      cka-cp1
kube-apiserver-cka-cp1            cka-cp1
kube-controller-manager-cka-cp1   cka-cp1
kube-proxy-44chc                  cka-w1
kube-proxy-ckfkj                  cka-w2
kube-proxy-mjtnj                  cka-cp1
kube-scheduler-cka-cp1            cka-cp1
```

- 이름 끝에 노드 이름이 붙은 것(`etcd-cka-cp1`)이 static Pod
- 랜덤 접미사가 붙은 것은 Deployment(CoreDNS)나 DaemonSet(kube-proxy)

## kubelet

### 설정 위치

```bash
systemctl cat kubelet
```

```text
# /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
EnvironmentFile=-/etc/default/kubelet
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

| 파일                                 | 내용                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `/etc/kubernetes/kubelet.conf`       | apiserver 접속용 kubeconfig                                            |
| `/var/lib/kubelet/config.yaml`       | KubeletConfiguration. `staticPodPath`, `cgroupDriver`, `clusterDNS` 등 |
| `/var/lib/kubelet/kubeadm-flags.env` | kubeadm이 넣는 추가 플래그 (`KUBELET_KUBEADM_ARGS`)                    |
| `/etc/default/kubelet`               | 사용자가 넣는 추가 플래그 (`KUBELET_EXTRA_ARGS`)                       |

```bash
sudo grep -E "staticPodPath|cgroupDriver|containerRuntimeEndpoint|clusterDomain" /var/lib/kubelet/config.yaml
# cgroupDriver: systemd
# clusterDomain: cluster.local
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock
# staticPodPath: /etc/kubernetes/manifests
```

`clusterDNS: [10.96.0.10]`도 이 파일에 있음. Pod의 `/etc/resolv.conf` nameserver가 여기서 나옴.

## static Pod

kubelet이 apiserver 없이 로컬 디렉터리(`staticPodPath`)의 manifest를 보고 직접 띄우는 Pod. control plane이 apiserver 없이 뜰 수 있는 이유.

### mirror Pod

kubelet은 static Pod마다 apiserver에 mirror Pod를 만들어서 `kubectl get pods`에 보이게 함. 이름은 `<metadata.name>-<노드 이름>`.

worker(cka-w1)의 `/etc/kubernetes/manifests/`에 파일을 하나 넣어 봄.

```yaml
# /etc/kubernetes/manifests/static-web.yaml (cka-w1)
apiVersion: v1
kind: Pod
metadata:
  name: static-web
  labels:
    role: static
spec:
  containers:
    - name: web
      image: nginx:1.27
```

```text
$ kubectl get pod -o wide
static-web-cka-w1   Running   cka-w1

$ kubectl get pod static-web-cka-w1 -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
Node/cka-w1
```

| 동작                                   | 결과                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `kubectl delete pod static-web-cka-w1` | `deleted`라고 나오지만 몇 초 뒤 다시 `Running`. kubelet이 mirror Pod를 다시 만듦 |
| manifest 파일 삭제                     | Pod가 실제로 사라짐 (`NotFound`)                                                 |
| manifest 파일 수정                     | kubelet이 Pod를 새로 만듦                                                        |

static Pod를 지우거나 고치려면 그 노드에 ssh해서 파일을 다뤄야 함. 어느 노드인지는 이름 끝이나 `-o wide`로.

- worker의 `/etc/kubernetes/manifests/`는 처음에 비어 있음. 디렉터리와 `staticPodPath` 설정은 worker에도 똑같이 있음
- static Pod는 ConfigMap, Secret, ServiceAccount 같은 다른 API 객체를 참조할 수 없음

## /etc/kubernetes 아래 파일

control plane:

```text
/etc/kubernetes/
├── admin.conf               # kubeadm:cluster-admins 그룹. kubectl용
├── super-admin.conf         # system:masters 그룹. 비상용
├── controller-manager.conf  # controller-manager가 apiserver에 붙을 때
├── scheduler.conf           # scheduler가 apiserver에 붙을 때
├── kubelet.conf             # kubelet이 apiserver에 붙을 때
├── manifests/               # static Pod: etcd, kube-apiserver, kube-controller-manager, kube-scheduler
└── pki/
    ├── ca.crt, ca.key                     # 클러스터 CA
    ├── apiserver.crt/key                  # apiserver 서버 인증서
    ├── apiserver-kubelet-client.crt/key   # apiserver → kubelet (logs, exec)
    ├── apiserver-etcd-client.crt/key      # apiserver → etcd
    ├── front-proxy-ca.*, front-proxy-client.*  # aggregation layer
    ├── sa.key, sa.pub                     # ServiceAccount token 서명
    └── etcd/                              # etcd 전용 CA와 server/peer 인증서
```

worker에는 `kubelet.conf`, `manifests/`(비어 있음), `pki/ca.crt`만 있음. worker의 `kubelet.conf`는 `server: https://192.168.122.11:6443`을 가리킴.

## 포트

control plane에서 `ss -tlnp`로 본 것:

| 주소                                    | 프로세스                | 용도                                |
| --------------------------------------- | ----------------------- | ----------------------------------- |
| `*:6443`                                | kube-apiserver          | API                                 |
| `192.168.122.11:2379`, `127.0.0.1:2379` | etcd                    | client                              |
| `192.168.122.11:2380`                   | etcd                    | peer (HA에서 member끼리)            |
| `127.0.0.1:2381`                        | etcd                    | metrics, health                     |
| `127.0.0.1:10257`                       | kube-controller-manager | health                              |
| `127.0.0.1:10259`                       | kube-scheduler          | health                              |
| `*:10250`                               | kubelet                 | API (apiserver가 logs, exec로 접속) |
| `127.0.0.1:10248`                       | kubelet                 | healthz                             |
| `*:10256`, `127.0.0.1:10249`            | kube-proxy              | healthz, metrics                    |

## 요청 하나가 Pod가 되기까지

`kubectl create deploy web --image=nginx --replicas=2`:

1. kubectl → apiserver: 인증, 인가(RBAC), admission 후 Deployment를 etcd에 저장
2. controller-manager의 Deployment controller가 ReplicaSet 생성
3. ReplicaSet controller가 Pod 2개 생성 (`nodeName` 비어 있음)
4. scheduler가 Pod마다 노드를 골라 `nodeName`을 씀(binding)
5. 해당 노드 kubelet이 자기 노드의 Pod를 보고 CRI로 containerd에 sandbox와 컨테이너 생성 요청, CNI가 Pod IP 할당
6. kubelet이 Pod status를 apiserver에 보고

어느 단계에서 멈췄는지에 따라 보는 곳이 다름:

| 증상                                                 | 의심할 곳                       |
| ---------------------------------------------------- | ------------------------------- |
| Deployment는 있는데 ReplicaSet/Pod가 안 생김         | kube-controller-manager         |
| Pod가 `Pending`, Events에 아무것도 없음              | kube-scheduler                  |
| Pod가 노드에 배정됐는데 `ContainerCreating`에서 멈춤 | kubelet, container runtime, CNI |
| `kubectl`이 아예 응답 없음                           | kube-apiserver, etcd            |

## 헷갈리는 것 비교

| 비교                                             | A                                                       | B                                               |
| ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------- |
| static Pod vs DaemonSet                          | kubelet이 로컬 파일로 띄움. apiserver 불필요. 노드 하나 | controller가 API로 관리. 모든(또는 선택한) 노드 |
| mirror Pod 삭제 vs manifest 삭제                 | 다시 생김                                               | 실제로 사라짐                                   |
| kubelet vs 나머지 컴포넌트                       | systemd 서비스. `systemctl`, `journalctl`               | Pod. `kubectl logs`, `crictl logs`              |
| `--service-cluster-ip-range` vs `--cluster-cidr` | Service IP 대역 (apiserver)                             | Pod IP 대역 (controller-manager)                |
| `admin.conf` vs `kubelet.conf`                   | 사람이 쓰는 관리자 kubeconfig                           | kubelet의 노드 신원 (`system:node:<노드>`)      |

## 시험 포인트

### 빨리 보는 명령어

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide        # static Pod는 이름 끝에 노드 이름
ls /etc/kubernetes/manifests/                  # 어떤 static Pod가 있는지
sudo grep staticPodPath /var/lib/kubelet/config.yaml
systemctl status kubelet
sudo crictl ps                                  # apiserver가 죽었을 때도 컨테이너 확인 가능
kubectl get --raw='/readyz?verbose'             # apiserver 상태
```

- "static Pod를 만들어라" 문제는 해당 노드의 `staticPodPath`에 YAML을 두면 끝. `kubectl run --dry-run=client -o yaml`로 뼈대를 만들면 빠름
- `staticPodPath`가 기본값이 아닐 수 있음. 먼저 `config.yaml`에서 확인
- `kubectl get componentstatuses`는 v1.19부터 deprecated라는 경고가 나옴. 상태 확인은 `/readyz`, `/livez`나 Pod 상태로

### kubectl explain

```bash
kubectl explain pod.spec.nodeName
kubectl explain lease.spec            # holderIdentity, renewTime
```

## 참고 문서

- [Cluster Architecture](https://kubernetes.io/docs/concepts/architecture/)
- [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/)
- [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [Communication between Nodes and the Control Plane](https://kubernetes.io/docs/concepts/architecture/control-plane-node-communication/)
- [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
