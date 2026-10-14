---
title: "CKA 개념 노트: kubeadm 설치와 HA control plane"
description: "노드 준비(swap, sysctl, containerd cgroup driver)부터 kubeadm init/join, CNI 설치, 그리고 kube-vip로 묶은 stacked etcd HA control plane까지 VM 3대에서 직접 실행하며 정리했습니다."
pubDatetime: 2026-10-14T01:03:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "containerd", "high-availability"]
order: 3
draft: true
---

> 기준: Kubernetes v1.34.12 / v1.35.9, kubeadm. libvirt VM 3대(Ubuntu 24.04, 2 vCPU, 2.5~3GB), containerd 2.4.1, Calico v3.33.0에서 명령어 확인

## 목차

## 전체 흐름

kubeadm은 "노드 하나를 control plane으로 만들고, 나머지 노드를 붙이는" 도구. OS 준비와 container runtime 설치, CNI 설치는 kubeadm이 해 주지 않음.

| 단계           | 어디서           | 하는 일                                                    |
| -------------- | ---------------- | ---------------------------------------------------------- |
| 노드 준비      | 모든 노드        | swap, sysctl, container runtime, cgroup driver             |
| 패키지 설치    | 모든 노드        | kubeadm, kubelet, kubectl (+ cri-tools)                    |
| `kubeadm init` | 첫 control plane | 인증서, kubeconfig, static Pod, addon(CoreDNS, kube-proxy) |
| CNI 설치       | kubectl          | Pod 네트워크. 이게 없으면 노드가 `NotReady`                |
| `kubeadm join` | 나머지 노드      | worker 또는 추가 control plane으로 합류                    |

## 노드 준비

### 요구 사항

- 노드당 RAM 2GB 이상, control plane은 CPU 2개 이상
- 노드마다 hostname, MAC 주소, `product_uuid`가 달라야 함 (VM을 복제했을 때 주의)

```bash
ip link
sudo cat /sys/class/dmi/id/product_uuid
```

### 필요한 포트

| 노드          | 포트        | 용도                    |
| ------------- | ----------- | ----------------------- |
| control plane | 6443        | kube-apiserver          |
| control plane | 2379-2380   | etcd client / peer      |
| control plane | 10250       | kubelet API             |
| control plane | 10257       | kube-controller-manager |
| control plane | 10259       | kube-scheduler          |
| worker        | 10250       | kubelet API             |
| worker        | 10256       | kube-proxy              |
| worker        | 30000-32767 | NodePort Service        |

### swap

kubelet은 기본값으로 swap이 켜져 있으면 시작하지 않음. 끄거나(`swapoff -a` + `/etc/fstab` 정리), kubelet 설정에 `failSwapOn: false`를 넣어 허용.

worker 하나에 swap 파일을 켜고 kubelet을 재시작해 보면 `activating`에서 계속 재시작함.

```text
"command failed" err="failed to run Kubelet: running with swap on is not supported,
please disable swap or set --fail-swap-on flag to false"
```

Ubuntu cloud image는 처음부터 swap이 없어서 `swapon --show` 출력이 비어 있었음.

### sysctl

현재 공식 문서에서 필수로 적는 건 IPv4 forwarding 하나.

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # net.ipv4.ip_forward = 1
```

### container runtime과 cgroup driver

kubelet과 container runtime은 같은 cgroup driver를 써야 함. systemd가 init인 배포판, cgroup v2에서는 `systemd` driver 권장. kubeadm은 kubelet 설정에 `cgroupDriver: systemd`를 기본으로 넣으므로, 보통 고칠 쪽은 containerd.

Docker 저장소의 `containerd.io` 패키지로 containerd 2.4.1을 설치하고 기본 설정을 만들면 `SystemdCgroup = false`로 나옴.

```bash
sudo apt-get install -y containerd.io
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
grep -n SystemdCgroup /etc/containerd/config.toml
# 89:            SystemdCgroup = false
```

containerd 2.x 설정 파일(`version = 4`)에서 이 값은 아래 위치에 있음. 1.x 문서의 `[plugins."io.containerd.grpc.v1.cri"...]` 경로와 다름.

```toml
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
  SystemdCgroup = true
```

```bash
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

같은 파일에 sandbox(pause) 이미지도 지정되어 있음: `sandbox = 'registry.k8s.io/pause:3.10.2'`.

## 패키지 설치

`pkgs.k8s.io`는 minor 버전마다 저장소가 따로 있음. URL의 `v1.34` 부분이 설치할 minor 버전.

```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

- `apt-mark hold`: `apt upgrade`로 버전이 멋대로 올라가지 않게 고정. upgrade할 때만 `unhold`
- 이 시점의 kubelet은 설정 파일이 없어서 몇 초마다 재시작을 반복함. `kubeadm init`/`join`이 설정을 써 주면 정상
- `crictl`은 위 세 패키지만으로는 설치되지 않았음. `sudo apt-get install -y cri-tools`로 따로 설치
- `crictl`은 `/etc/crictl.yaml`이 없으면 endpoint 기본값이 deprecated라는 경고를 매번 출력함

```yaml
# /etc/crictl.yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
```

## kubeadm init

```bash
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=192.168.122.11
```

| 플래그                          | 의미                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `--pod-network-cidr`            | Pod IP 대역. CNI 설정과 맞춰야 함. 노드 네트워크와 겹치면 안 됨 |
| `--apiserver-advertise-address` | apiserver가 광고할 IP. 생략하면 default route가 있는 인터페이스 |
| `--control-plane-endpoint`      | HA용 공유 endpoint(LB 주소나 DNS). 아래 HA 절 참고              |
| `--service-cidr`                | Service IP 대역. 기본 `10.96.0.0/12`                            |
| `--kubernetes-version`          | control plane 버전 지정                                         |

이미지를 미리 받아 둘 수도 있음: `sudo kubeadm config images pull`.

### init이 하는 일

출력의 `[phase]` 순서가 그대로 kubeadm이 만드는 것들.

| phase                   | 결과물                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `preflight`             | swap, 포트, runtime 등 사전 점검. 이미지 pull                                                                      |
| `certs`                 | `/etc/kubernetes/pki/` 아래 CA와 인증서. apiserver 인증서 SAN에 `10.96.0.1`(kubernetes Service IP)과 노드 IP 포함  |
| `kubeconfig`            | `/etc/kubernetes/`에 `admin.conf`, `super-admin.conf`, `kubelet.conf`, `controller-manager.conf`, `scheduler.conf` |
| `etcd`, `control-plane` | `/etc/kubernetes/manifests/`에 etcd, kube-apiserver, kube-controller-manager, kube-scheduler static Pod manifest   |
| `kubelet-start`         | `/var/lib/kubelet/config.yaml`, `/var/lib/kubelet/kubeadm-flags.env` 작성 후 kubelet 시작                          |
| `upload-config`         | 사용한 설정을 `kube-system/kubeadm-config` ConfigMap에 저장                                                        |
| `mark-control-plane`    | label `node-role.kubernetes.io/control-plane`, taint `node-role.kubernetes.io/control-plane:NoSchedule`            |
| `bootstrap-token`       | join용 token과 관련 RBAC, `kube-public/cluster-info` ConfigMap                                                     |
| `addons`                | CoreDNS Deployment, kube-proxy DaemonSet                                                                           |

### 끝난 직후

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

root라면 `export KUBECONFIG=/etc/kubernetes/admin.conf`로도 됨.

CNI를 설치하기 전에는 노드가 `NotReady`이고 CoreDNS는 `Pending`.

```text
$ kubectl get nodes
NAME      STATUS     ROLES           AGE   VERSION
cka-cp1   NotReady   control-plane   7s    v1.34.12

$ kubectl describe node cka-cp1
Taints:  node.kubernetes.io/not-ready:NoExecute
         node.kubernetes.io/not-ready:NoSchedule
  Ready  False ... KubeletNotReady  container runtime network not ready: NetworkReady=false
         reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
```

`/opt/cni/bin`에는 이미 기본 플러그인 바이너리(bridge, host-device 등)가 있지만 `/etc/cni/net.d`가 비어 있어서 생기는 상태.

## CNI 설치

클러스터당 Pod 네트워크는 하나만. Calico v3.33.0을 operator 방식으로 설치함.

```bash
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/operator-crds.yaml
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/tigera-operator.yaml
curl -fsSLO https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/custom-resources.yaml
sed -i 's#cidr: 192.168.0.0/16#cidr: 10.244.0.0/16#' custom-resources.yaml
kubectl create -f custom-resources.yaml
```

- `custom-resources.yaml`의 기본 대역 `192.168.0.0/16`은 libvirt 기본 네트워크(`192.168.122.0/24`)와 겹쳐서, `--pod-network-cidr`와 같은 `10.244.0.0/16`으로 바꿈
- CRD가 등록되기 전에 custom resource를 만들면 `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`
- 설치 후 `/etc/cni/net.d/10-calico.conflist`가 생기고, 1분 정도 지나 노드가 `Ready`

## kubeadm join

init 출력 끝의 join 명령을 worker에서 root로 실행. 출력을 잃어버렸으면 control plane에서 다시 만들 수 있음.

```bash
# control plane에서
sudo kubeadm token create --print-join-command
# kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>

# worker에서
sudo kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

| 값                               | 의미                                                                    | 확인                 |
| -------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `--token`                        | worker가 처음 apiserver에 붙을 때 쓰는 bootstrap token. 기본 TTL 24시간 | `kubeadm token list` |
| `--discovery-token-ca-cert-hash` | worker가 접속한 apiserver가 진짜인지 확인하는 CA 공개키 hash            | 아래 openssl 명령    |

```bash
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
  | openssl rsa -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -hex | sed 's/^.* //'
```

이 값이 join 명령의 hash와 같은 것을 확인함.

join 출력에서 보이는 흐름: `kube-system/kubeadm-config` ConfigMap 읽기 → kubelet 설정 작성과 시작 → TLS Bootstrap(token으로 CSR을 보내 kubelet 클라이언트 인증서를 받음) → `This node has joined the cluster`.

```text
$ kubectl get nodes -o wide
NAME      STATUS   ROLES           VERSION    INTERNAL-IP      CONTAINER-RUNTIME
cka-cp1   Ready    control-plane   v1.34.12   192.168.122.11   containerd://2.4.1
cka-w1    Ready    <none>          v1.34.12   192.168.122.21   containerd://2.4.1
cka-w2    Ready    <none>          v1.34.12   192.168.122.22   containerd://2.4.1
```

worker의 ROLES가 `<none>`인 건 정상. label을 직접 붙이면 표시됨(`kubectl label node cka-w1 node-role.kubernetes.io/worker=`).

control plane에도 Pod를 띄우고 싶으면 taint 제거.

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

## HA control plane

### 토폴로지

|           | stacked etcd                                               | external etcd                                    |
| --------- | ---------------------------------------------------------- | ------------------------------------------------ |
| etcd 위치 | control plane 노드마다 etcd member가 같이 뜸               | 별도 etcd 노드                                   |
| 최소 노드 | control plane 3대                                          | control plane 3대 + etcd 3대                     |
| 장점      | 노드 수가 적고 설정이 단순. kubeadm 기본값                 | control plane 하나가 죽어도 etcd member는 그대로 |
| 단점      | 노드 하나가 죽으면 etcd member와 control plane이 같이 빠짐 | 노드가 두 배, 설정 복잡                          |

etcd는 과반(quorum)이 살아 있어야 쓰기가 됨. 3대면 1대까지 장애 허용. 그래서 stacked도 최소 3대.

### load balancer

control plane이 여러 대이면 kubelet, kubectl이 붙을 공유 주소가 필요함. 이게 `--control-plane-endpoint`이고, 처음 init할 때 정해야 함.

- 외부 LB(HAProxy 등)를 두거나, 노드 위에 keepalived + HAProxy, 또는 kube-vip 같은 static Pod를 띄움
- LB 헬스체크는 apiserver 포트(6443) TCP 체크
- 여기서는 kube-vip v1.2.4를 static Pod로 띄우고, ARP로 VIP `192.168.122.100`을 리더 노드에 붙임

```bash
export KVVERSION=v1.2.4 VIP=192.168.122.100 INTERFACE=enp1s0
sudo ctr image pull ghcr.io/kube-vip/kube-vip:$KVVERSION
sudo ctr run --rm --net-host ghcr.io/kube-vip/kube-vip:$KVVERSION vip /kube-vip \
  manifest pod --interface $INTERFACE --address $VIP --controlplane --arp --leaderElection \
  | sudo tee /etc/kubernetes/manifests/kube-vip.yaml
```

- 첫 control plane에서는 manifest의 kubeconfig hostPath를 `admin.conf` 대신 `super-admin.conf`로 바꿔야 함. v1.29부터 init 도중에는 `admin.conf`의 권한이 아직 없어서, kube-vip이 리더 선출을 못 하고 VIP가 안 뜸
- init이 끝나면 다시 `admin.conf`로 되돌림. 되돌리면 kube-vip Pod가 재시작되는 동안 VIP가 잠깐 사라졌고, 그 사이 kubectl은 `dial tcp 192.168.122.100:6443: connect: no route to host`로 실패함
- init 전에 `nc -zv -w 2 192.168.122.100 6443`을 해 보면 timeout. kube-vip도 kubelet이 띄우는 static Pod라서, init 전에는 VIP가 없음

### init과 control plane join

```bash
# 첫 control plane
sudo kubeadm init --control-plane-endpoint "192.168.122.100:6443" --upload-certs \
  --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=192.168.122.11

# 나머지 control plane (init 출력에 나온 명령)
sudo kubeadm join 192.168.122.100:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane --certificate-key <key>
```

| 플래그              | 의미                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--upload-certs`    | CA 등 control plane끼리 공유할 인증서를 암호화해서 `kube-system/kubeadm-certs` Secret에 올림 |
| `--control-plane`   | worker가 아니라 control plane으로 join                                                       |
| `--certificate-key` | 위 Secret을 복호화하는 키. 이 키로 인증서를 내려받음                                         |

- 올린 인증서와 키는 2시간 뒤 삭제됨. 그 뒤에 control plane을 추가하려면 `sudo kubeadm init phase upload-certs --upload-certs`로 다시 올리고 새 키를 받음
- worker join은 `--control-plane`, `--certificate-key` 없이 같은 endpoint로

결과: control plane 3대, etcd member 3개.

```text
$ etcdctl member list -w table
|  NAME   |         PEER ADDRS          | IS LEARNER |
|  cka-w2 | https://192.168.122.22:2380 |      false |
| cka-cp1 | https://192.168.122.11:2380 |      false |
|  cka-w1 | https://192.168.122.21:2380 |      false |
```

### 장애 테스트

VIP를 들고 있던 cka-cp1 VM을 강제로 껐음.

- 약 19초 뒤 VIP가 cka-w1로 옮겨 가고, VIP로 보낸 kubectl이 다시 응답함
- cka-cp1은 40~50초 정도 지나서 `NotReady`로 바뀜
- `etcdctl endpoint health`: 두 member는 healthy, cka-cp1은 `context deadline exceeded`, 전체 결과는 `unhealthy cluster`. 그래도 3대 중 2대가 살아 있어서 API는 계속 동작

## 헷갈리는 것 비교

| 비교                                                          | A                                                          | B                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `--apiserver-advertise-address` vs `--control-plane-endpoint` | 이 노드의 apiserver가 광고하는 자기 IP                     | 모든 노드가 붙는 공유 주소(LB). HA에 필요         |
| bootstrap token vs certificate key                            | 노드가 처음 클러스터에 붙을 때 인증. 24시간                | control plane 인증서를 받기 위한 복호화 키. 2시간 |
| worker join vs control plane join                             | `kubeadm join <ep> --token --discovery-token-ca-cert-hash` | 여기에 `--control-plane --certificate-key` 추가   |
| `/opt/cni/bin` vs `/etc/cni/net.d`                            | CNI 플러그인 바이너리                                      | CNI 설정. 이게 있어야 노드 `Ready`                |
| stacked vs external etcd                                      | control plane 노드에 etcd 같이. 최소 3대                   | etcd 별도. 최소 3+3대                             |
| `admin.conf` vs `super-admin.conf`                            | `kubeadm:cluster-admins` 그룹. 평소에 쓰는 kubeconfig      | `system:masters` 그룹. RBAC를 우회하는 비상용     |

## 시험 포인트

### 빨리 푸는 명령어

```bash
sudo kubeadm token create --print-join-command     # join 명령 재발급
sudo kubeadm token list
sudo kubeadm init phase upload-certs --upload-certs # control plane 추가용 키 재발급
kubectl -n kube-system get cm kubeadm-config -o yaml # podSubnet, serviceSubnet, etcd dataDir 확인
sudo kubeadm reset                                  # 노드를 init/join 이전으로 되돌림 (best-effort)
```

- 노드 준비 단계에서 확인할 것: `swapon --show`, `sysctl net.ipv4.ip_forward`, `grep SystemdCgroup /etc/containerd/config.toml`, `systemctl status containerd kubelet`
- init 직후 `NotReady`면 먼저 CNI 설치 여부 확인

### kubectl explain

kubeadm 설정은 Kubernetes 리소스가 아니라서 `kubectl explain`이 없음. 대신 아래로 확인.

```bash
kubeadm config print init-defaults   # InitConfiguration, ClusterConfiguration 기본값
kubeadm config print join-defaults
kubeadm init --help
```

## 참고 문서

- [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)
- [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/)
- [Options for Highly Available Topology](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/ha-topology/)
- [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [kubeadm HA considerations (kube-vip)](https://github.com/kubernetes/kubeadm/blob/main/docs/ha-considerations.md)
- [Calico: Install on on-premises deployments](https://docs.tigera.io/calico/latest/getting-started/kubernetes/self-managed-onprem/onpremises)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
