---
title: "CKA 개념 노트: CNI, CSI, CRI와 Operator"
description: "kubelet과 container runtime 사이의 CRI, Pod 네트워크를 붙이는 CNI, 스토리지를 붙이는 CSI가 노드의 어디에 설정되어 있는지 확인하고, Helm과 Kustomize로 클러스터 컴포넌트를 설치하고, Operator가 CRD로 컴포넌트를 관리하는 방식을 kubeadm 클러스터에서 정리했습니다."
pubDatetime: 2026-10-14T01:06:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "cni", "csi", "cri", "operator", "helm"]
order: 6
draft: true
---

> 기준: kubeadm 클러스터 v1.35.9 (libvirt VM 3대), containerd 2.4.1, Calico v3.33.0, Helm v4.3.0에서 명령어 확인

Helm chart·release·values와 Kustomize base/overlay 기본은 [CKAD 개념 노트: Helm과 Kustomize](/ko/posts/ckad-helm-kustomize), CRD 정의와 custom resource 기본은 [CKAD 개념 노트: CRD, Operator, API deprecation](/ko/posts/ckad-crds-api-deprecations)에 정리했음. 여기서는 클러스터 컴포넌트를 설치하고 관리하는 쪽만 다룸.

## 목차

## 세 인터페이스

Kubernetes는 컨테이너 실행, 네트워크, 스토리지를 직접 구현하지 않고 표준 인터페이스 뒤의 플러그인에 맡김.

| 인터페이스                        | 누가 호출                       | 누구를                | 하는 일                             | 이 클러스터                   |
| --------------------------------- | ------------------------------- | --------------------- | ----------------------------------- | ----------------------------- |
| CRI (Container Runtime Interface) | kubelet                         | container runtime     | sandbox·컨테이너 생성, 이미지 pull  | containerd 2.4.1              |
| CNI (Container Network Interface) | container runtime               | CNI 플러그인 바이너리 | Pod에 네트워크 인터페이스와 IP 연결 | Calico                        |
| CSI (Container Storage Interface) | kubelet, CSI sidecar controller | CSI driver            | volume 생성, attach, mount          | `csi.tigera.io` (Calico 내장) |

```text
kubelet ──CRI(gRPC)──▶ containerd ──▶ runc (컨테이너)
                          └──CNI──▶ /opt/cni/bin/calico (Pod 네트워크)
kubelet ──CSI(gRPC)──▶ CSI node plugin (DaemonSet)
```

## CRI

kubelet은 Unix socket으로 runtime에 CRI gRPC 요청을 보냄. socket 경로는 kubelet 설정에 있음.

```bash
sudo grep containerRuntimeEndpoint /var/lib/kubelet/config.yaml
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock

sudo crictl version
# RuntimeName:  containerd
# RuntimeVersion:  v2.4.1
# RuntimeApiVersion:  v1
```

- `crictl`은 CRI 클라이언트. 노드에서 Pod와 컨테이너를 runtime 관점으로 봄 (`crictl pods`, `crictl ps`, `crictl logs`, `crictl images`)
- Kubernetes v1.24에 dockershim이 제거됨. Docker Engine을 쓰려면 cri-dockerd 같은 어댑터가 필요
- 컨테이너를 실제로 만드는 저수준 runtime은 runc. 다른 저수준 runtime(gVisor, Kata 등)을 쓰려면 RuntimeClass로 선택. 이 클러스터에는 RuntimeClass가 없음 (`kubectl get runtimeclass` → `No resources found`)

## CNI

CNI 설정은 노드 파일 두 곳.

| 경로              | 내용                                          |
| ----------------- | --------------------------------------------- |
| `/etc/cni/net.d/` | CNI 설정 파일. 이름순으로 첫 번째 파일을 사용 |
| `/opt/cni/bin/`   | CNI 플러그인 바이너리                         |

containerd가 이 경로를 쓰는지 확인:

```bash
sudo crictl info | grep -A3 '"cni"'
# confDir: /etc/cni/net.d, binDirs: ["/opt/cni/bin"]
```

Calico 설치 후:

```text
$ sudo ls /etc/cni/net.d
10-calico.conflist
calico-kubeconfig
```

`10-calico.conflist` 안에는 플러그인 체인이 있음: `calico`(ipam `calico-ipam`) 다음에 `portmap`(hostPort 처리).

CNI 플러그인이 하는 일:

- Pod sandbox가 만들어질 때 network namespace에 인터페이스를 만들고 IP 할당
- 다른 노드의 Pod까지 라우팅 (Calico는 여기서 VXLAN 사용)
- NetworkPolicy 적용은 CNI마다 다름. Calico는 지원, flannel 단독으로는 미지원

CNI가 없거나 설정이 비어 있으면 노드가 `NotReady`이고 이유는 `cni plugin not initialized`. ([kubeadm 설치 노트](/ko/posts/cka-kubeadm-install-ha) 참고)

## CSI

CSI driver는 보통 두 부분으로 설치됨.

| 부분              | 형태                                                                          | 하는 일                        |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| controller plugin | Deployment/StatefulSet + sidecar (external-provisioner, external-attacher 등) | PVC를 보고 volume 생성, attach |
| node plugin       | DaemonSet + node-driver-registrar                                             | 각 노드에서 mount              |

클러스터에 등록된 driver는 CSIDriver 객체로 보임.

```text
$ kubectl get csidriver
NAME            ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   MODES       AGE
csi.tigera.io   true             true             false             Ephemeral   61m
```

```text
$ kubectl -n calico-system get ds
NAME              DESIRED   CURRENT   READY
calico-node       3         3         3
csi-node-driver   3         3         3
```

- StorageClass의 `provisioner`가 CSI driver 이름. dynamic provisioning이 안 되면 StorageClass provisioner와 `kubectl get csidriver`부터 맞춰 봄
- `csi.tigera.io`는 Calico가 쓰는 ephemeral 전용 driver라서 PV를 만들지 않음
- PV, PVC, StorageClass, reclaim policy, access mode는 [CKAD 개념 노트: persistent volume과 ephemeral volume](/ko/posts/ckad-volumes) 참고

## Helm으로 컴포넌트 설치

metrics-server를 Helm으로 설치.

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo metrics-server
# metrics-server/metrics-server   3.14.0   0.9.0

helm show values metrics-server/metrics-server | grep -A1 '^args'
# args: []

helm install metrics-server metrics-server/metrics-server -n kube-system \
  --set 'args={--kubelet-insecure-tls}'
kubectl top nodes
```

`--kubelet-insecure-tls`를 빼고 upgrade하면 새 Pod가 `0/1 Running`에서 Ready가 되지 않음.

```text
"Failed to scrape node" err="Get \"https://192.168.122.21:10250/metrics/resource\":
tls: failed to verify certificate: x509: cannot validate certificate for 192.168.122.21
because it doesn't contain any IP SANs" node="cka-w1"
```

kubeadm 기본 kubelet serving 인증서는 자체 서명이고 노드 IP SAN이 없어서 생기는 일. 실습에서는 TLS 검증을 끄고, 운영에서는 kubelet `serverTLSBootstrap: true`로 클러스터 CA가 서명한 serving 인증서를 받게 함.

```bash
helm list -n kube-system
helm history metrics-server -n kube-system
helm rollback metrics-server 1 -n kube-system
helm get values metrics-server -n kube-system
# USER-SUPPLIED VALUES:
# args:
# - --kubelet-insecure-tls
```

## Kustomize로 컴포넌트 설치

kustomization이 있는 디렉터리나 원격 URL을 `kubectl apply -k`로 바로 적용할 수 있음. Gateway API CRD를 설치해 봄.

```bash
kubectl kustomize 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3' \
  | grep -c '^kind: CustomResourceDefinition'
# 10

kubectl apply -k 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3'
kubectl get crd | grep gateway.networking
```

- `kubectl kustomize`(= `kustomize build`)로 결과 YAML을 먼저 보고 apply
- 이 kustomization은 CRD 10개와 ValidatingAdmissionPolicy(`safe-upgrades.gateway.networking.k8s.io`)를 만듦

## Operator

Operator = CRD + 그 CRD를 watch하는 controller. 사람이 하던 운영 절차(설치, 설정 변경, 복구)를 controller가 대신 함.

Calico는 operator 방식으로 설치했음.

| 구성                | 이 클러스터                                    |
| ------------------- | ---------------------------------------------- |
| operator Deployment | `tigera-operator/tigera-operator`              |
| CRD                 | `operator.tigera.io` 그룹 등 (`kubectl get crd | grep tigera` → 9개) |
| custom resource     | `Installation default`, `APIServer default` 등 |
| 상태                | `kubectl get tigerastatus`                     |

```bash
kubectl get installation default -o jsonpath='{.spec.calicoNetwork.ipPools}'
# [{"cidr":"10.244.0.0/16","encapsulation":"VXLANCrossSubnet",...}]
```

```text
$ kubectl get tigerastatus
NAME        AVAILABLE   PROGRESSING   DEGRADED
apiserver   True        False         False
calico      True        False         False
...
```

operator가 관리하는 리소스를 직접 지우면 다시 만들어짐.

```bash
kubectl -n calico-system delete ds calico-node
# 15초 뒤
kubectl -n calico-system get ds calico-node    # DESIRED 3, READY 3
```

그래서 operator가 관리하는 DaemonSet이나 Deployment를 고치려면 그 리소스가 아니라 custom resource(`Installation`)를 고쳐야 함. 직접 수정한 내용은 operator가 되돌림.

### operator 설치 순서

1. CRD 설치 (`operator-crds.yaml`)
2. operator 설치 (Deployment, RBAC)
3. custom resource 생성 (`custom-resources.yaml`)

순서가 바뀌면 `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`.

## 헷갈리는 것 비교

| 비교                                              | A                                | B                                       |
| ------------------------------------------------- | -------------------------------- | --------------------------------------- |
| CRI vs CNI                                        | kubelet ↔ runtime. 컨테이너 실행 | runtime ↔ 네트워크 플러그인. Pod IP     |
| `/etc/cni/net.d` vs `/opt/cni/bin`                | 설정                             | 바이너리                                |
| containerd vs runc                                | CRI를 구현하는 고수준 runtime    | 실제로 컨테이너를 만드는 저수준 runtime |
| CSI controller plugin vs node plugin              | volume 생성, attach (Deployment) | 노드에서 mount (DaemonSet)              |
| `helm install --set` vs `-f values.yaml`          | 값 몇 개                         | 값이 많을 때                            |
| `kubectl apply -k` vs `kubectl kustomize`         | 빌드 후 적용                     | 빌드 결과만 출력                        |
| operator 리소스 직접 수정 vs custom resource 수정 | operator가 되돌림                | operator가 반영                         |

## 시험 포인트

### 빨리 보는 명령어

```bash
sudo crictl version; sudo crictl info | grep -A3 '"cni"'
ls /etc/cni/net.d /opt/cni/bin
kubectl get csidriver; kubectl get storageclass
kubectl get runtimeclass

helm repo add <name> <url>; helm repo update; helm search repo <keyword>
helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback / uninstall / list -A / get values

kubectl kustomize <dir|url>
kubectl apply -k <dir|url>

kubectl get crd; kubectl api-resources --api-group=<group>
```

- "설치된 CNI가 무엇인가": `/etc/cni/net.d` 파일 이름과 `kube-system`/전용 namespace의 DaemonSet
- Helm 문제는 namespace와 release 이름을 정확히. `-n`을 빼면 default namespace에 설치됨

### kubectl explain

```bash
kubectl explain csidriver.spec
kubectl explain runtimeclass.handler
kubectl explain storageclass.provisioner
```

## 참고 문서

- [Extending Kubernetes](https://kubernetes.io/docs/concepts/extend-kubernetes/)
- [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [Volumes: CSI](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [Runtime Class](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [metrics-server Helm chart](https://github.com/kubernetes-sigs/metrics-server/tree/master/charts/metrics-server)
- [Gateway API: Getting started](https://gateway-api.sigs.k8s.io/guides/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
