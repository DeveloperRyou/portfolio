---
title: "CKA 치트 시트"
description: "CKA v1.35 커리큘럼 도메인별 kubeadm·etcdctl·systemctl·crictl·kubectl 명령어와 최소 YAML, 시험 중 열어 볼 kubernetes.io 문서 위치 정리."
pubDatetime: 2026-10-14T01:01:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubectl", "kubeadm", "cheatsheet"]
order: 1
draft: true
---

> 기준: Kubernetes v1.35. 명령어는 kubeadm 클러스터(v1.34.12 → v1.35.9, libvirt VM 3대)에서 확인

## 요약

CKA 명령어·YAML 모음. CKAD와 겹치는 kubectl 기본(Pod, Deployment, ConfigMap, Service, probe 등)은 [CKAD 치트 시트](/ko/posts/ckad-cheatsheet) 참고.

CKAD와 다른 점: 커리큘럼에 노드 준비, kubeadm, etcd, 컴포넌트 트러블슈팅이 들어 있어서 노드에 ssh해서 kubelet, containerd, static Pod manifest를 직접 다룰 일이 많음. apiserver가 죽어 kubectl을 못 쓰는 상황도 대비.

| 도메인                                               | 비중 |
| ---------------------------------------------------- | ---- |
| Troubleshooting                                      | 30%  |
| Cluster Architecture, Installation and Configuration | 25%  |
| Services and Networking                              | 20%  |
| Workloads and Scheduling                             | 15%  |
| Storage                                              | 10%  |

열람 가능한 사이트는 시험 전에 Linux Foundation의 허용 리소스 목록에서 확인.

## 시험 환경

- 문제마다 지정된 호스트로 `ssh`, 끝나면 `exit`. 노드 작업은 `sudo -i` 또는 `sudo`
- context 전환 지시가 있으면 `kubectl config use-context`부터
- namespace는 명령마다 `-n <ns>`

```bash
k run tmp --image=nginx --dry-run=client -o yaml > pod.yaml
k explain pod.spec.affinity.nodeAffinity
k explain pod.spec --recursive | less
```

### 노드에서 자주 보는 곳

| 경로                                                        | 내용                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/etc/kubernetes/manifests/`                                | static Pod (etcd, kube-apiserver, kube-controller-manager, kube-scheduler) |
| `/etc/kubernetes/pki/`                                      | CA와 인증서. `etcd/` 아래 etcd 전용                                        |
| `/etc/kubernetes/admin.conf`                                | 관리자 kubeconfig                                                          |
| `/etc/kubernetes/kubelet.conf`                              | kubelet kubeconfig                                                         |
| `/var/lib/kubelet/config.yaml`                              | kubelet 설정 (`staticPodPath`, `clusterDNS`, `cgroupDriver`)               |
| `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf` | kubelet systemd drop-in                                                    |
| `/etc/containerd/config.toml`                               | containerd 설정 (`SystemdCgroup`)                                          |
| `/etc/cni/net.d/`, `/opt/cni/bin/`                          | CNI 설정, 바이너리                                                         |
| `/var/log/pods/`, `/var/log/containers/`                    | 컨테이너 로그 파일                                                         |

## Cluster Architecture, Installation and Configuration

커리큘럼: RBAC, 설치 인프라 준비, kubeadm 설치와 관리, 클러스터 lifecycle, HA control plane, Helm·Kustomize로 컴포넌트 설치, CNI·CSI·CRI, CRD·Operator.

노트: [클러스터 구조](/ko/posts/cka-cluster-architecture), [kubeadm 설치와 HA](/ko/posts/cka-kubeadm-install-ha), [upgrade·etcd·인증서](/ko/posts/cka-cluster-lifecycle), [RBAC·사용자](/ko/posts/cka-rbac-users), [CNI·CSI·CRI·Operator](/ko/posts/cka-extension-interfaces)

### 노드 준비

```bash
swapon --show                                   # 비어 있어야 함 (또는 kubelet failSwapOn: false)
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

### 패키지 (pkgs.k8s.io, minor마다 저장소)

```bash
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -y kubelet kubeadm kubectl cri-tools
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

### kubeadm

```bash
sudo kubeadm init --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=<ip>
sudo kubeadm init --control-plane-endpoint "<lb>:6443" --upload-certs --pod-network-cidr=...   # HA
mkdir -p $HOME/.kube && sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config && sudo chown $(id -u):$(id -g) $HOME/.kube/config

sudo kubeadm token create --print-join-command
sudo kubeadm join <ep>:6443 --token <t> --discovery-token-ca-cert-hash sha256:<h>
sudo kubeadm join <ep>:6443 --token <t> --discovery-token-ca-cert-hash sha256:<h> --control-plane --certificate-key <k>
sudo kubeadm init phase upload-certs --upload-certs        # certificate-key 재발급 (2시간 만료)
kubectl -n kube-system get cm kubeadm-config -o yaml        # podSubnet, serviceSubnet, etcd dataDir
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
sudo kubeadm reset
```

- init 직후 노드 `NotReady` + `cni plugin not initialized` → CNI 설치

### upgrade (control plane → worker 한 대씩)

```bash
# 저장소 줄의 v1.34 → v1.35 로 바꾼 뒤
sudo apt-mark unhold kubeadm && sudo apt-get update && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9           # 첫 control plane만
sudo kubeadm upgrade node                    # 나머지 control plane, worker

kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <node>
```

- minor는 하나씩. kubelet은 apiserver보다 높으면 안 됨
- `kubectl get nodes` VERSION은 kubelet 버전

### etcd

```bash
sudo grep -E "file|urls|data-dir" /etc/kubernetes/manifests/etcd.yaml

sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db
sudo etcdutl --write-out=table snapshot status /opt/etcd-backup.db
sudo etcdutl --data-dir /var/lib/etcd-from-backup snapshot restore /opt/etcd-backup.db
# etcd.yaml 의 etcd-data hostPath 를 /var/lib/etcd-from-backup 으로
# 이후 kube-apiserver, controller-manager, scheduler 재시작 (manifest 뺐다 넣기), kubelet 재시작
```

- etcd 3.6의 `etcdctl snapshot`은 `save`만. status·restore는 `etcdutl`

### 인증서

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all          # 후 control plane static Pod 재시작, ~/.kube/config 다시 복사
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
```

### RBAC와 사용자

```bash
openssl genrsa -out u.key 2048
openssl req -new -key u.key -out u.csr -subj "/CN=u/O=g"
cat u.csr | base64 | tr -d "\n"                          # CSR 객체의 spec.request
kubectl certificate approve u
kubectl get csr u -o jsonpath='{.status.certificate}' | base64 -d > u.crt
kubectl config set-credentials u --client-key=u.key --client-certificate=u.crt --embed-certs=true
kubectl config set-context u --cluster=kubernetes --user=u --namespace=<ns>

kubectl create role r --verb=get,list --resource=pods -n <ns>
kubectl create clusterrole cr --verb=get,list --resource=nodes
kubectl create rolebinding rb --role=r --user=u -n <ns>
kubectl create clusterrolebinding crb --clusterrole=cr --group=g
kubectl create rolebinding rb2 --clusterrole=edit --serviceaccount=<ns>:<sa> -n <ns>
kubectl auth can-i list pods -n <ns> --as u
kubectl auth can-i --list -n <ns> --as=system:serviceaccount:<ns>:<sa>
```

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: u
spec:
  request: <base64>
  signerName: kubernetes.io/kube-apiserver-client
  usages: [client auth]
```

### Helm, Kustomize, CRD

```bash
helm repo add <name> <url> && helm repo update
helm search repo <keyword>; helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback <release> <rev> / uninstall / list -A / history / get values
kubectl kustomize <dir|url>; kubectl apply -k <dir|url>
kubectl get crd; kubectl api-resources --api-group=<group>
```

CRD·Helm·Kustomize 기본: [CKAD: Helm과 Kustomize](/ko/posts/ckad-helm-kustomize), [CKAD: CRD, Operator, API deprecation](/ko/posts/ckad-crds-api-deprecations)

### 문서

- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Operating etcd clusters](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/), [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)

## Workloads and Scheduling

커리큘럼: rolling update·rollback, ConfigMap·Secret, autoscaling, self-healing primitive, Pod admission·scheduling.

노트: [Pod scheduling](/ko/posts/cka-scheduling), [autoscaling](/ko/posts/cka-autoscaling). rolling update는 [CKAD: Rolling update와 배포 전략](/ko/posts/ckad-deployment-strategies), ConfigMap·Secret은 [CKAD: ConfigMap과 Secret](/ko/posts/ckad-configmaps-secrets), requests·limits·LimitRange·ResourceQuota는 [CKAD: requests, limits, quota](/ko/posts/ckad-resources-quotas)

```bash
k label node <node> disk=ssd
k taint node <node> key=value:NoSchedule
k taint node <node> key=value:NoSchedule-
k create priorityclass high --value=1000
k autoscale deploy <name> --cpu=50% --min=1 --max=5     # 대상에 cpu request 필요
k scale deploy <name> --replicas=3
k rollout status|history|undo deploy <name>
```

```yaml
spec:
  nodeSelector: { disk: ssd }
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - { key: disk, operator: In, values: [ssd] }
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector: { matchLabels: { app: web } }
          topologyKey: kubernetes.io/hostname
  tolerations:
    - { key: key, operator: Equal, value: value, effect: NoSchedule }
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      nodeTaintsPolicy: Honor # control plane이 도메인으로 세어져 Pending 되는 것 방지
      labelSelector: { matchLabels: { app: web } }
  priorityClassName: high
```

- static Pod: 해당 노드의 `staticPodPath`(`/var/lib/kubelet/config.yaml`)에 YAML 두기

### 문서

- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/), [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)

## Services and Networking

커리큘럼: Pod 간 연결, NetworkPolicy, Service type과 endpoint, Gateway API, Ingress controller·Ingress, CoreDNS.

노트: [Pod 네트워크와 CoreDNS](/ko/posts/cka-pod-network-coredns), [Gateway API와 Ingress](/ko/posts/cka-gateway-api). Service·Ingress·NetworkPolicy 기본은 [CKAD: Service, Ingress, NetworkPolicy](/ko/posts/ckad-services-ingress-networkpolicy)

```bash
k expose deploy web --port=80 --target-port=8080 --type=NodePort
k get svc,endpointslice
k create ingress web --class=nginx --rule="web.example.com/*=web:80"
k get ingressclass; k get gatewayclass; k get gateway,httproute -A
k -n kube-system get cm coredns -o yaml          # Corefile
k -n kube-system edit cm coredns                 # reload plugin이 다시 읽음 (1분 남짓)
k -n kube-system rollout restart deploy coredns
k -n kube-system get cm kube-proxy -o yaml | grep mode
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: app }
spec:
  parentRefs: [{ name: web-gw }]
  hostnames: [app.example.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /v2 } }]
      backendRefs: [{ name: app-v2, port: 80 }]
    - backendRefs:
        - { name: app-v1, port: 80, weight: 80 }
        - { name: app-v2, port: 80, weight: 20 }
```

- Route가 안 붙으면 `status.parents[].conditions` (`NotAllowedByListeners`, `BackendNotFound`, `RefNotPermitted`)
- 다른 namespace: Route → Gateway는 `allowedRoutes`, Route → Service는 ReferenceGrant
- DNS: `<svc>.<ns>.svc.cluster.local`, Pod `<ip-대시>.<ns>.pod.cluster.local`. hostNetwork Pod는 `dnsPolicy: ClusterFirstWithHostNet`

### 문서

- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/), [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/), [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)

## Storage

커리큘럼: StorageClass와 dynamic provisioning, volume type·access mode·reclaim policy, PV·PVC.

노트: [CKAD: persistent volume과 ephemeral volume](/ko/posts/ckad-volumes)

```bash
k get sc,pv,pvc
k get csidriver
k describe pvc <pvc>             # Pending 이유 (StorageClass, provisioner)
k patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## Troubleshooting

커리큘럼: 클러스터와 노드, 클러스터 컴포넌트, 리소스 사용량, 컨테이너 출력, Service·네트워크.

노트: [노드와 클러스터 컴포넌트](/ko/posts/cka-troubleshooting-cluster), [워크로드·리소스·네트워크](/ko/posts/cka-troubleshooting-apps)

### 노드, 컴포넌트

```bash
k get nodes; k describe node <node> | grep -A8 Conditions
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -iE "error|failed"
sudo crictl ps -a; sudo crictl logs <id>
sudo sh -c 'ls /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/'
```

| 증상                                 | 원인 후보                                                          |
| ------------------------------------ | ------------------------------------------------------------------ |
| 노드 `NotReady`, condition `Unknown` | kubelet 중지                                                       |
| kubelet `activating (auto-restart)`  | 설정 파일 경로 오류, containerd 없음 → journalctl `command failed` |
| kubectl `TLS handshake timeout`      | apiserver가 etcd에 못 붙음                                         |
| kubectl `connection refused`         | apiserver 안 뜸, kubeconfig 주소·포트                              |
| control plane Pod `CrashLoopBackOff` | manifest command·flag 오류                                         |
| control plane Pod가 목록에 없음      | manifest YAML 문법 → journalctl `Could not process manifest file`  |
| Pod `Pending` + Events 없음          | scheduler 고장                                                     |
| Deployment `0/N`, ReplicaSet 없음    | controller-manager 고장                                            |

### 리소스, 로그

```bash
k top nodes --sort-by=cpu
k top pods -A --sort-by=memory --no-headers | head -1
k top pod <pod> --containers
k logs <pod> -c <container> [--previous] [--tail=N] [--since=5m] [--timestamps]
k logs <pod> --all-containers --prefix
k logs -l app=web
```

### Service, 네트워크

| 증상                                 | 확인                        |
| ------------------------------------ | --------------------------- |
| `Connection refused` + endpoint 없음 | selector vs Pod label       |
| `Connection refused` + endpoint 있음 | targetPort vs 컨테이너 port |
| endpoint `ready=false`               | readinessProbe              |
| 이름은 `bad address`, ClusterIP는 됨 | CoreDNS                     |
| `timed out`                          | NetworkPolicy               |

```bash
k get endpointslice -l kubernetes.io/service-name=<svc>
k run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
k run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### 문서

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/), [crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/), [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)

## 참고 문서

- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [CKAD 치트 시트](/ko/posts/ckad-cheatsheet)
