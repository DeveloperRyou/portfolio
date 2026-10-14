---
title: "CKA 개념 노트: 노드와 클러스터 컴포넌트 트러블슈팅"
description: "kubelet과 containerd를 멈추고, kubelet 설정과 static Pod manifest를 일부러 망가뜨린 뒤 kubectl, systemctl, journalctl, crictl, /var/log/pods로 원인을 찾는 과정을 kubeadm 클러스터에서 기록했습니다."
pubDatetime: 2026-10-14T01:11:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "kubelet", "crictl", "static-pod"]
order: 11
---

> 기준: kubeadm 클러스터 v1.35.9 (libvirt VM 3대), containerd 2.4.1, crictl v1.35.0에서 직접 고장 내고 확인

컴포넌트 구조와 static Pod, `/etc/kubernetes` 파일 위치는 [클러스터 구조 노트](/ko/posts/cka-cluster-architecture), 인증서 만료 확인은 [lifecycle 노트](/ko/posts/cka-cluster-lifecycle)에 정리했음.

## 목차

## 어디부터 볼까

```text
kubectl이 응답하나?
├─ 아니오 → control plane 노드에 ssh
│           crictl ps -a (apiserver, etcd 상태)
│           crictl logs / /var/log/pods
│           journalctl -u kubelet (manifest를 못 읽는지)
└─ 예 → kubectl get nodes
         ├─ NotReady 노드 → 그 노드에 ssh
         │                 systemctl status kubelet containerd
         │                 journalctl -u kubelet
         └─ 노드는 정상 → kubectl -n kube-system get pods
                         (scheduler, controller-manager, CoreDNS, CNI, kube-proxy)
```

| 컴포넌트                                       | 실행 방식              | 상태                                                                   | 로그                                            |
| ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| kubelet, containerd                            | systemd                | `systemctl status`                                                     | `journalctl -u kubelet`                         |
| apiserver, etcd, scheduler, controller-manager | static Pod             | `kubectl -n kube-system get pods`, apiserver가 죽었으면 `crictl ps -a` | `kubectl logs`, `crictl logs`, `/var/log/pods/` |
| kube-proxy, CoreDNS, CNI                       | DaemonSet / Deployment | `kubectl get pods`                                                     | `kubectl logs`                                  |

## 노드가 NotReady

### kubelet이 멈춤

worker에서 `sudo systemctl stop kubelet`.

- 48초 뒤 `NotReady`. node lease가 갱신되지 않아서 node lifecycle controller가 상태를 바꿈
- condition이 `False`가 아니라 `Unknown`

```text
$ kubectl describe node cka-w1
  MemoryPressure  Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
  Ready           Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
Taints:  node.kubernetes.io/unreachable:NoExecute
         node.kubernetes.io/unreachable:NoSchedule
```

노드에서:

```bash
systemctl status kubelet
#  ○ kubelet.service - kubelet: The Kubernetes Node Agent
#     Loaded: loaded (/usr/lib/systemd/system/kubelet.service; enabled; ...)
#     Drop-In: /usr/lib/systemd/system/kubelet.service.d
#              └─10-kubeadm.conf
sudo systemctl start kubelet
sudo systemctl enable kubelet     # 재부팅 후에도 뜨게
```

`○`(inactive)는 멈춘 상태. `enabled`가 아니면 재부팅 후 다시 멈춤.

### containerd가 없음

containerd를 멈춘 상태에서 kubelet을 시작하면 kubelet 자체가 실패함.

```text
"command failed" err="failed to run Kubelet: validate service connection:
validate CRI v1 runtime API for endpoint \"unix:///var/run/containerd/containerd.sock\": rpc error ..."
```

`sudo systemctl start containerd` 후 30초 안에 `Ready`로 돌아옴.

### kubelet 설정 오류

`/var/lib/kubelet/config.yaml`의 `clientCAFile`을 없는 파일로 바꾸고 재시작.

```text
$ systemctl status kubelet
     Active: activating (auto-restart) (Result: exit-code) since ...; 9s ago

$ sudo journalctl -u kubelet --since "-1min"
"command failed" err="failed to construct kubelet dependencies: unable to load client CA file
/etc/kubernetes/pki/ca-wrong.crt: open /etc/kubernetes/pki/ca-wrong.crt: no such file or directory"
```

- `activating (auto-restart)`가 계속 보이면 시작하자마자 죽는 것. 이유는 journalctl의 `command failed` 줄에 있음
- kubelet 설정이 들어 있는 곳: `/var/lib/kubelet/config.yaml`, `/var/lib/kubelet/kubeadm-flags.env`, `/etc/default/kubelet`, `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf`, `/etc/kubernetes/kubelet.conf`
- systemd unit 파일을 고쳤으면 `systemctl daemon-reload` 후 재시작

```bash
sudo journalctl -u kubelet -f                  # 따라가며 보기
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -i -E "error|failed"
```

## control plane 컴포넌트

### apiserver가 etcd에 못 붙음

`kube-apiserver.yaml`의 `--etcd-servers`를 `https://127.0.0.1:2399`로 바꿈.

```text
$ kubectl get nodes
Unable to connect to the server: net/http: TLS handshake timeout
```

kubectl을 못 쓰니 노드에서 컨테이너를 직접 봄.

```bash
sudo crictl ps -a --name kube-apiserver
# ea5139c8c6d5a   ...   19 seconds ago   Running   kube-apiserver   0
sudo crictl logs --tail 3 <container-id>
# grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ...
```

- 컨테이너는 `Running`인데 etcd에 못 붙어서 요청을 처리하지 못하는 상태. 상태만 보면 놓침. 로그를 봐야 함
- 같은 로그가 노드의 `/var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log`에도 있음. `/var/log/containers/*.log`는 여기로 가는 symlink. 둘 다 root 권한 필요
- manifest를 되돌리면 kubelet이 다시 띄우고 1분 안에 kubectl이 응답함

kubectl 에러 메시지로 짐작할 수 있는 것:

| 메시지                            | 의심                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| `connect: connection refused`     | apiserver가 그 포트에 없음 (안 떴거나, kubeconfig의 주소·포트가 틀림) |
| `net/http: TLS handshake timeout` | apiserver 프로세스는 있는데 응답을 못 함 (etcd 연결 등)               |
| `x509: certificate ...`           | kubeconfig의 인증서나 CA 문제                                         |
| `Unauthorized`                    | 인증 정보 문제                                                        |

`~/.kube/config`의 포트를 `6444`로 바꿔 보면 `dial tcp 192.168.122.11:6444: connect: connection refused`.

### static Pod manifest의 command 오타

`kube-scheduler.yaml`의 `- kube-scheduler`를 `- kube-schedulerr`로 바꿈.

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
kube-scheduler-cka-cp1   0/1   CrashLoopBackOff   2 (14s ago)   26s

$ kubectl -n kube-system describe pod kube-scheduler-cka-cp1
      Reason:   StartError
      Message:  failed to create containerd task: failed to create shim task: OCI runtime create failed:
                runc create failed: unable to start container process: error during container init: exec: "kube-schedulerr": ...
```

이 상태에서 Pod를 만들면:

```text
$ kubectl get pod sched-test
sched-test   0/1   Pending   0   10s

$ kubectl describe pod sched-test
Events:  <none>
```

`Pending`인데 Events가 비어 있음. scheduler가 아예 보지 않았다는 뜻. `FailedScheduling`이 있으면 scheduler는 살아 있고 조건이 안 맞는 것. manifest를 되돌리니 Pod가 `Scheduled` 이벤트와 함께 배치됨.

### controller-manager 고장

같은 방식으로 `kube-controller-manager.yaml`의 command를 망가뜨림.

```text
$ kubectl create deploy cm-test --image=nginx:1.27
$ kubectl get deploy cm-test
cm-test   0/1   0     0     10s
$ kubectl get rs -l app=cm-test
No resources found in default namespace.
```

Deployment 객체는 저장됐지만 ReplicaSet이 안 생김. Deployment controller가 없어서. 고치고 50초 뒤 `1/1`.

### manifest YAML 문법 오류

들여쓰기를 깨뜨린 `kube-scheduler.yaml`을 넣으면, 컨테이너도 mirror Pod도 생기지 않음.

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
Error from server (NotFound): pods "kube-scheduler-cka-cp1" not found
$ sudo crictl ps --name kube-scheduler -q | wc -l
0
$ sudo journalctl -u kubelet --since "-1min" | grep kube-scheduler.yaml
"Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml:
couldn't parse as pod(yaml: line 11: did not find expected key), please check config file"
```

Pod가 목록에서 아예 사라졌으면 manifest 파싱 실패. kubelet 로그에 줄 번호가 나옴.

## 증상별 정리

| 증상                                 | 확인                                       | 이번 실습의 원인                       |
| ------------------------------------ | ------------------------------------------ | -------------------------------------- |
| 노드 `NotReady`, condition `Unknown` | 노드에서 `systemctl status kubelet`        | kubelet 중지                           |
| kubelet `activating (auto-restart)`  | `journalctl -u kubelet`의 `command failed` | config.yaml 경로 오류, containerd 없음 |
| kubectl `TLS handshake timeout`      | `crictl ps -a`, `crictl logs`              | apiserver의 etcd 주소 오류             |
| kubectl `connection refused`         | kubeconfig server 주소, apiserver 컨테이너 | kubeconfig 포트 오류                   |
| control plane Pod `CrashLoopBackOff` | `describe pod`의 Last State, `crictl logs` | manifest command 오타                  |
| control plane Pod가 목록에 없음      | `journalctl -u kubelet`                    | manifest YAML 문법                     |
| Pod `Pending` + Events 없음          | scheduler Pod                              | scheduler 고장                         |
| Deployment `0/1`, ReplicaSet 없음    | controller-manager Pod                     | controller-manager 고장                |

## 헷갈리는 것 비교

| 비교                                                         | A                                                | B                                          |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| node condition `False` vs `Unknown`                          | kubelet이 보고한 상태가 나쁨                     | kubelet이 보고를 안 함 (죽었거나 네트워크) |
| `systemctl status` `inactive` vs `activating (auto-restart)` | 멈춰 있음. start하면 됨                          | 시작하자마자 죽는 중. 로그 확인            |
| `kubectl logs` vs `crictl logs`                              | apiserver 필요                                   | 노드에서 직접. apiserver가 죽어도 됨       |
| `/var/log/pods` vs `/var/log/containers`                     | 실제 파일 (`<ns>_<pod>_<uid>/<container>/N.log`) | symlink                                    |
| `Pending` + `FailedScheduling` vs `Pending` + Events 없음    | 조건 불일치                                      | scheduler가 안 돌고 있음                   |

## 시험 포인트

### 빨리 보는 명령어

```bash
kubectl get nodes; kubectl describe node <node> | grep -A8 Conditions
ssh <node>
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | tail -30
sudo crictl ps -a
sudo crictl logs <container-id>
ls /etc/kubernetes/manifests/
sudo cat /var/lib/kubelet/config.yaml
```

- 고친 뒤 노드 `Ready`, Pod `Running`까지 직접 확인
- manifest를 고칠 때는 원본을 먼저 복사 (`cp kube-apiserver.yaml /tmp/`). 백업은 `/etc/kubernetes/manifests/` 밖에 둠. kubelet은 확장자와 상관없이 이 디렉터리의 파일을 읽어서, `kube-scheduler.yaml.bak`을 넣어 두자 scheduler Pod가 다시 만들어졌음
- kubelet 문제는 대부분 경로 오타, 인증서 경로, 멈춘 서비스. `journalctl`에 그대로 나옴

### kubectl explain

```bash
kubectl explain node.status.conditions
kubectl explain pod.status.containerStatuses.lastState
```

## 참고 문서

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Node status](https://kubernetes.io/docs/reference/node/node-status/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
