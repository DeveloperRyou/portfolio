---
title: "CKA 개념 노트: 클러스터 upgrade, etcd 백업, 인증서"
description: "version skew 규칙, kubeadm으로 1.34에서 1.35로 올리는 순서와 drain/uncordon, etcdctl·etcdutl로 하는 etcd 백업과 복원, kubeadm 인증서 확인과 갱신을 VM 클러스터에서 직접 실행하며 정리했습니다."
pubDatetime: 2026-10-14T01:04:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "upgrade", "etcd", "certificates"]
order: 4
draft: true
---

> 기준: kubeadm 클러스터 v1.34.12 → v1.35.9 (libvirt VM 3대: control plane 1, worker 2), etcd 3.6.5 / 3.6.6, etcdctl·etcdutl 3.6.5에서 명령어 확인

## 목차

## version skew

upgrade 순서는 "어떤 컴포넌트가 apiserver보다 얼마나 앞서거나 뒤처져도 되는가"에서 나옴.

| 컴포넌트                                | kube-apiserver 대비 허용 범위          |
| --------------------------------------- | -------------------------------------- |
| kube-apiserver (HA)                     | apiserver끼리 minor 1 차이까지         |
| kube-controller-manager, kube-scheduler | 같거나 1 minor 낮음. 높으면 안 됨      |
| kubelet                                 | 같거나 최대 3 minor 낮음. 높으면 안 됨 |
| kube-proxy                              | 같거나 최대 3 minor 낮음. 높으면 안 됨 |
| kubectl                                 | ±1 minor                               |

여기서 나오는 규칙:

- control plane을 먼저, kubelet을 나중에 올림
- minor 버전은 건너뛸 수 없음. 1.33 → 1.35는 1.34를 거쳐야 함. patch는 건너뛰어도 됨

## upgrade 순서

| 순서 | 노드                 | 명령                                                                                              |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------- |
| 1    | 첫 control plane     | 저장소 변경 → kubeadm 설치 → `kubeadm upgrade plan` → `kubeadm upgrade apply v1.35.9`             |
| 2    | 나머지 control plane | kubeadm 설치 → `kubeadm upgrade node`                                                             |
| 3    | 각 control plane     | drain → kubelet, kubectl 설치 → kubelet 재시작 → uncordon                                         |
| 4    | worker 하나씩        | kubeadm 설치 → `kubeadm upgrade node` → drain → kubelet, kubectl 설치 → kubelet 재시작 → uncordon |

`kubeadm upgrade apply`는 클러스터 전체에서 한 번만. 나머지 노드는 전부 `kubeadm upgrade node`.

## control plane upgrade

### 저장소와 kubeadm

`pkgs.k8s.io`는 minor 버전마다 저장소가 달라서, 저장소 줄의 버전부터 바꿔야 새 버전이 보임.

```bash
sudo sed -i 's#v1.34#v1.35#g' /etc/apt/sources.list.d/kubernetes.list
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo apt-get update
sudo apt-cache madison kubeadm
#    kubeadm | 1.35.9-1.1 | https://pkgs.k8s.io/core:/stable:/v1.35/deb  Packages
#    kubeadm | 1.35.8-1.1 | ...

sudo apt-mark unhold kubeadm && \
sudo apt-get install -y kubeadm='1.35.9-*' && \
sudo apt-mark hold kubeadm
kubeadm version -o short   # v1.35.9
```

### upgrade plan

```bash
sudo kubeadm upgrade plan
```

```text
[upgrade/versions] Cluster version: 1.34.12
[upgrade/versions] kubeadm version: v1.35.9
remote version is much newer: v1.37.1; falling back to: stable-1.35
Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':
COMPONENT   NODE      CURRENT    TARGET
kubelet     cka-cp1   v1.34.12   v1.35.9
kubelet     cka-w1    v1.34.12   v1.35.9
kubelet     cka-w2    v1.34.12   v1.35.9

COMPONENT                 NODE      CURRENT    TARGET
kube-apiserver            cka-cp1   v1.34.12   v1.35.9
kube-controller-manager   cka-cp1   v1.34.12   v1.35.9
kube-scheduler            cka-cp1   v1.34.12   v1.35.9
kube-proxy                          1.34.12    v1.35.9
CoreDNS                             v1.12.1    v1.13.1
etcd                      cka-cp1   3.6.5-0    3.6.6-0
```

- kubelet은 kubeadm이 올려 주지 않음. 표 위쪽이 "직접 해야 하는 것"
- control plane static Pod를 막 재시작한 직후에 plan을 돌렸더니 `[ERROR CreateJob]: Job "upgrade-health-check-..." ... did not complete in 15s`로 실패함. 30초 뒤 다시 실행하니 통과. plan과 apply는 시작할 때 health check Job을 띄워서 클러스터 상태를 봄

### upgrade apply

```bash
sudo kubeadm upgrade apply v1.35.9
```

apply가 하는 일:

- etcd, kube-apiserver, kube-controller-manager, kube-scheduler 순서로 manifest를 새로 쓰고, kubelet이 static Pod를 다시 띄울 때까지 기다림
- 이전 manifest는 `/etc/kubernetes/tmp/kubeadm-backup-manifests-<날짜>/`에, etcd 데이터는 `kubeadm-backup-etcd-<날짜>/`에 백업
- 컴포넌트마다 인증서 갱신(`Renewing apiserver certificate` 등)
- `kube-system/kubelet-config` ConfigMap 갱신, CoreDNS와 kube-proxy addon upgrade
- 마지막 줄: `[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.35.9".`

apply가 끝나도 `kubectl get nodes`의 VERSION은 `v1.34.12` 그대로. 이 컬럼은 kubelet 버전이라서, kubelet을 올리기 전까지는 안 바뀜.

### kubelet, kubectl

```bash
kubectl drain cka-cp1 --ignore-daemonsets

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && \
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon cka-cp1
```

drain 중에는 `Ready,SchedulingDisabled`, uncordon 후 `Ready`와 `v1.35.9`.

## worker upgrade

```bash
# worker에서: 저장소 변경 후
sudo apt-mark unhold kubeadm && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade node
# [upgrade/addon] Skipping the addon/kube-proxy phase. Not a control plane node.

# control plane(kubectl 있는 곳)에서
kubectl drain cka-w1 --ignore-daemonsets

# worker에서
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet

# control plane에서
kubectl uncordon cka-w1
```

worker의 `kubeadm upgrade node`는 kubelet 설정(`/var/lib/kubelet/config.yaml`)만 새로 받음. drain은 worker가 아니라 kubeconfig가 있는 곳에서 실행.

## drain, cordon, uncordon

| 명령                      | 스케줄 막기     | 기존 Pod            |
| ------------------------- | --------------- | ------------------- |
| `kubectl cordon <node>`   | O               | 그대로              |
| `kubectl drain <node>`    | O (먼저 cordon) | eviction으로 내보냄 |
| `kubectl uncordon <node>` | 해제            | 변화 없음           |

옵션 없이 drain하면 거부되는 경우:

```text
cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore):
  calico-system/calico-node-..., calico-system/csi-node-driver-..., kube-system/kube-proxy-...
cannot delete Pods that declare no controller (use --force to override): default/plain
```

| 상황                     | 옵션                     | 결과                           |
| ------------------------ | ------------------------ | ------------------------------ |
| DaemonSet Pod            | `--ignore-daemonsets`    | 건너뜀. 노드에 그대로 남음     |
| controller 없는 Pod      | `--force`                | 삭제. 다시 만들어지지 않음     |
| emptyDir 쓰는 Pod        | `--delete-emptydir-data` | 삭제. emptyDir 데이터는 사라짐 |
| PodDisruptionBudget 위반 | (없음)                   | 계속 재시도                    |

- drain이 실패해도 cordon은 이미 걸려 있음. 다시 drain하면 `node/cka-w2 already cordoned`
- `minAvailable: 2`인 PDB가 걸린 replicas 2 Deployment의 노드를 drain하면 `Cannot evict pod as it would violate the pod's disruption budget.`가 5초마다 반복됨. `--timeout=10s`를 주면 `global timeout reached: 10s`로 끝남
- uncordon해도 Pod가 원래 노드로 돌아오지 않음. 실습에서는 worker 둘을 차례로 drain했더니 replicas 4개가 전부 cka-w1에 몰려 있었음

## etcd 백업과 복원

### 도구

| 도구      | 용도                             | 비고                                  |
| --------- | -------------------------------- | ------------------------------------- |
| `etcdctl` | 실행 중인 etcd에 네트워크로 접속 | `snapshot save`                       |
| `etcdutl` | etcd 데이터 파일을 직접 다룸     | `snapshot status`, `snapshot restore` |

etcd 3.6.5의 `etcdctl snapshot`에는 `save` 하나만 남아 있음. status와 restore는 `etcdutl`로.

```text
$ etcdctl snapshot --help
COMMANDS:
  save	Stores an etcd node backend snapshot to a given file
```

kubeadm 노드에는 둘 다 기본으로 설치되어 있지 않아서, etcd 이미지 버전(`registry.k8s.io/etcd:3.6.5-0`)에 맞춰 GitHub release에서 받음.

### 접속 정보 찾기

필요한 값은 전부 etcd static Pod manifest에 있음.

```bash
sudo grep -E "listen-client-urls|cert-file|key-file|trusted-ca-file|data-dir" /etc/kubernetes/manifests/etcd.yaml
#    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
#    - --data-dir=/var/lib/etcd
#    - --key-file=/etc/kubernetes/pki/etcd/server.key
#    - --listen-client-urls=https://127.0.0.1:2379,https://192.168.122.11:2379
#    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
```

### 백업

```bash
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db
# Snapshot saved at /opt/etcd-backup.db

sudo etcdutl --write-out=table snapshot status /opt/etcd-backup.db
```

```text
+----------+----------+------------+------------+---------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |
+----------+----------+------------+------------+---------+
| 2e711e8a |     2202 |        767 |      11 MB |   3.6.0 |
+----------+----------+------------+------------+---------+
```

### 복원

확인 방법: 백업 전에 ConfigMap `before-backup`, 백업 후에 `after-backup`을 만들고 복원. 복원 후에는 `before-backup`만 있어야 함.

```bash
# 1. 새 data dir에 복원
sudo etcdutl --data-dir /var/lib/etcd-from-backup snapshot restore /opt/etcd-backup.db

# 2. etcd manifest의 hostPath를 새 경로로
sudo vi /etc/kubernetes/manifests/etcd.yaml
```

```yaml
volumes:
  - hostPath:
      path: /var/lib/etcd-from-backup # 원래 /var/lib/etcd
      type: DirectoryOrCreate
    name: etcd-data
```

- 컨테이너 안의 `--data-dir=/var/lib/etcd`와 `mountPath`는 그대로 둠. 호스트 쪽 경로만 바꾸면 됨
- manifest를 고친 뒤 kubelet이 etcd Pod를 다시 띄우기까지 1분 넘게 걸렸음

여기서 한 번 헷갈렸음. etcd가 새 데이터로 뜬 뒤에도 `kubectl get cm`에는 `after-backup`이 계속 보였음. `etcdctl get /registry/configmaps/backup-test --prefix --keys-only`로 etcd를 직접 보면 `after-backup`은 이미 없었음. apiserver의 watch cache가 복원 전 상태를 들고 있었던 것.

```bash
# 3. control plane 컴포넌트 재시작 (static Pod는 manifest를 뺐다 넣으면 재시작됨)
cd /etc/kubernetes/manifests
sudo mv kube-apiserver.yaml kube-controller-manager.yaml kube-scheduler.yaml /tmp/
# 컨테이너가 내려갈 때까지 기다린 뒤
sudo mv /tmp/kube-apiserver.yaml /tmp/kube-controller-manager.yaml /tmp/kube-scheduler.yaml .
sudo systemctl restart kubelet
```

재시작 후에는 `before-backup`만 남음. 공식 문서도 복원 후 모든 apiserver 재시작, scheduler·controller-manager·kubelet 재시작을 권장함.

### 복원 후 upgrade 주의

hostPath만 바꿔 놓은 채로 `kubeadm upgrade apply`를 했더니, kubeadm이 etcd manifest를 `kubeadm-config`의 `etcd.local.dataDir`(`/var/lib/etcd`) 기준으로 다시 써서 hostPath가 `/var/lib/etcd`로 돌아감. 복원 전 데이터로 etcd가 다시 떴고, 이어서 apiserver 단계에서 `context deadline exceeded`로 upgrade가 실패함.

실제 클러스터라면 복원 데이터를 원래 경로에 두거나, `kubeadm-config`의 dataDir도 같이 바꿔야 함. 이 실습은 VM snapshot으로 되돌려 깨끗한 상태에서 upgrade를 다시 함.

## 인증서

### 만료 확인

```bash
sudo kubeadm certs check-expiration
```

```text
CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY
admin.conf                 Oct 13, 2027 16:21 UTC   364d            ca
apiserver                  Oct 13, 2027 16:21 UTC   364d            ca
apiserver-etcd-client      Oct 13, 2027 16:21 UTC   364d            etcd-ca
apiserver-kubelet-client   Oct 13, 2027 16:21 UTC   364d            ca
controller-manager.conf    Oct 13, 2027 16:21 UTC   364d            ca
etcd-healthcheck-client    Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-peer                  Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-server                Oct 13, 2027 16:21 UTC   364d            etcd-ca
front-proxy-client         Oct 13, 2027 16:21 UTC   364d            front-proxy-ca
scheduler.conf             Oct 13, 2027 16:21 UTC   364d            ca
super-admin.conf           Oct 13, 2027 16:21 UTC   364d            ca

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME
ca                      Oct 10, 2036 16:21 UTC   9y
etcd-ca                 Oct 10, 2036 16:21 UTC   9y
front-proxy-ca          Oct 10, 2036 16:21 UTC   9y
```

- leaf 인증서 1년, CA 10년
- `kubelet.conf`는 목록에 없음. kubelet 클라이언트 인증서는 kubelet이 스스로 갱신하고, `/var/lib/kubelet/pki/kubelet-client-current.pem` symlink가 최신 파일을 가리킴
- 개별 확인: `sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate`

### 갱신

| 방법                                     | 언제                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `kubeadm upgrade apply` / `upgrade node` | upgrade할 때 자동 갱신. 1년 안에 한 번씩 upgrade하면 따로 할 일 없음 |
| `kubeadm certs renew all`                | 수동 갱신. 이름을 주면 하나만 (`kubeadm certs renew apiserver`)      |

```bash
sudo kubeadm certs renew all
# Done renewing certificates. You must restart the kube-apiserver, kube-controller-manager,
# kube-scheduler and etcd, so that they can use the new certificates.
```

- 갱신 후 control plane static Pod 재시작 필요
- `~/.kube/config`는 `admin.conf`를 복사해 둔 것이라 자동으로 바뀌지 않음. 다시 복사

## 헷갈리는 것 비교

| 비교                                      | A                                                | B                                                                  |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `kubeadm upgrade apply` vs `upgrade node` | 첫 control plane에서 한 번. 클러스터 버전을 올림 | 나머지 control plane과 worker. 그 노드의 manifest와 kubelet 설정만 |
| `kubectl get nodes` VERSION               | kubelet 버전                                     | control plane 버전은 `kubectl version`이나 static Pod 이미지       |
| cordon vs drain                           | 스케줄만 막음                                    | 스케줄 막고 Pod 내보냄                                             |
| `--ignore-daemonsets` vs `--force`        | DaemonSet Pod를 건너뜀                           | controller 없는 Pod를 지움                                         |
| `etcdctl` vs `etcdutl`                    | 실행 중인 etcd에 접속. save                      | 파일 직접. status, restore                                         |
| `--data-dir` vs hostPath                  | 컨테이너 안 경로. 그대로 둠                      | 호스트 경로. 복원한 디렉터리로 바꿈                                |
| leaf vs CA 인증서                         | 1년. renew로 갱신                                | 10년. renew 대상 아님                                              |

## 시험 포인트

### 빨리 푸는 명령어

```bash
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9
sudo kubeadm upgrade node
kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
kubectl uncordon <node>

sudo cat /etc/kubernetes/manifests/etcd.yaml | grep -E "file|urls|data-dir"
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=... --cert=... --key=... snapshot save <file>
sudo etcdutl --data-dir <new-dir> snapshot restore <file>

sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
```

- upgrade 문제는 노드마다 어디서 실행하는지(ssh 대상 노드 vs kubectl 있는 노드)를 헷갈리기 쉬움
- etcd 인증서 경로는 외우지 말고 `etcd.yaml`에서 복사
- 복원 후 `kubectl` 결과가 그대로면 apiserver 재시작부터 의심

### kubectl explain

```bash
kubectl explain poddisruptionbudget.spec   # minAvailable, maxUnavailable, selector
kubectl explain node.spec.unschedulable    # cordon이 바꾸는 필드
kubectl drain --help
```

## 참고 문서

- [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [etcd: etcdutl](https://github.com/etcd-io/etcd/blob/main/etcdutl/README.md)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
