---
title: "CKA 개념 노트: 워크로드, 리소스 사용량, 네트워크 트러블슈팅"
description: "kubectl top으로 리소스 사용량을 보고, kubectl logs의 컨테이너 선택·이전 컨테이너·stdout/stderr와 노드의 로그 파일 위치를 확인하고, Service selector·targetPort·readiness·CoreDNS·NetworkPolicy를 하나씩 망가뜨려 증상을 비교했습니다."
pubDatetime: 2026-10-14T01:12:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "logging", "kubectl-top", "service"]
order: 12
---

> 기준: kubeadm 클러스터 v1.35.9, metrics-server 0.9.0, Calico v3.33.0에서 직접 고장 내고 확인

`kubectl describe`, events, `exec`, `kubectl debug`로 Pod를 들여다보는 기본 흐름은 [CKAD 개념 노트: 모니터링, 로그, 디버깅](/ko/posts/ckad-observability-debugging)에 정리했음. 노드와 control plane 고장은 [노드와 클러스터 컴포넌트 트러블슈팅](/ko/posts/cka-troubleshooting-cluster) 참고.

## 목차

## 리소스 사용량

`kubectl top`은 metrics-server가 있어야 동작함 (없으면 `error: Metrics API not available`).

```bash
kubectl top nodes --sort-by=cpu
kubectl top pods -A --sort-by=memory
kubectl top pod <pod> -n <ns> --containers
```

```text
$ kubectl top nodes --sort-by=cpu
NAME      CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
cka-cp1   214m         10%      1992Mi          70%
cka-w1    85m          4%       1156Mi          48%
cka-w2    69m          3%       743Mi           31%

$ kubectl top pods -A --sort-by=memory
NAMESPACE       NAME                     CPU(cores)   MEMORY(bytes)
kube-system     kube-apiserver-cka-cp1   55m          557Mi
calico-system   calico-node-lnw7f        32m          122Mi
```

- `--sort-by`는 `cpu` 또는 `memory`
- 값은 수집 주기마다 갱신되는 근사값. 컨테이너가 막 시작했으면 아직 안 보일 수 있음
- "가장 많이 쓰는 Pod 이름을 파일에 써라" 같은 문제는 `--sort-by`와 `--no-headers | head -1`로

`kubectl describe node`의 `Allocated resources`는 실제 사용량이 아니라 request/limit 합계. 둘을 헷갈리지 않기.

## 컨테이너 출력

컨테이너가 stdout, stderr로 쓴 것을 container runtime이 노드의 파일에 저장하고, `kubectl logs`는 그 파일을 kubelet을 통해 읽음.

### kubectl logs

컨테이너 두 개(`out`: 2초마다 stdout과 stderr에 한 줄씩, `crash`: 5초 뒤 exit 3)짜리 Pod로 확인.

| 명령                                                     | 결과                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `kubectl logs logger`                                    | `Defaulted container "out" out of: out, crash` 후 첫 번째 컨테이너 로그 |
| `kubectl logs logger -c out --tail=2`                    | `out-19`, `err-19` (stdout과 stderr가 섞여서 나옴)                      |
| `kubectl logs logger --all-containers --prefix --tail=1` | `[pod/logger/out] err-19`, `[pod/logger/crash] boom`                    |
| `kubectl logs logger -c out --since=5s --timestamps`     | 앞에 RFC3339 시각                                                       |
| `kubectl logs <pod> --previous`                          | 재시작 전 컨테이너 로그                                                 |
| `kubectl logs -f`                                        | 따라가기                                                                |
| `kubectl logs deploy/web`                                | Deployment의 Pod 하나                                                   |
| `kubectl logs -l app=web`                                | label로 여러 Pod                                                        |

`--previous` 확인: 25초 뒤 exit 1로 끝나는 컨테이너가 한 번 재시작한 뒤

```text
current:  run-at-02:35:59
previous: run-at-02:35:34
```

컨테이너가 계속 죽어서 원인을 봐야 할 때는 `--previous`. 지금 컨테이너는 막 시작해서 아무것도 안 찍혔을 수 있음. 종료 코드는 status에 남음.

```bash
kubectl get pod logger -o jsonpath='{.status.containerStatuses[?(@.name=="crash")].lastState.terminated}'
# {"exitCode":3,"reason":"Error","startedAt":"...","finishedAt":"..."}
```

`CrashLoopBackOff`로 기다리는 중에는 `--previous`가 `unable to retrieve container logs for containerd://...`로 실패할 때가 있었음. 그때는 `kubectl logs -c <container>`(마지막으로 끝난 컨테이너)가 같은 내용을 보여 줬음.

### 노드의 로그 파일

```text
/var/log/pods/<namespace>_<pod>_<uid>/<container>/<restart 번호>.log   ← 실제 파일
/var/log/containers/<pod>_<namespace>_<container>-<container id>.log   ← symlink
```

```text
$ sudo sh -c 'ls /var/log/pods/app_logger_*/crash/'
2.log  3.log
$ sudo sh -c 'tail -n2 /var/log/pods/app_logger_*/out/0.log'
2026-10-14T02:35:21.78145528Z stdout F out-29
2026-10-14T02:35:21.781537313Z stderr F err-29
```

- 한 줄 형식: `시각 stream 태그 내용`. stream으로 stdout과 stderr를 구분할 수 있음. `kubectl logs`는 둘을 섞어서 보여 줌
- 파일 이름 번호가 재시작 횟수. 최근 것만 남아 있음
- root 권한이 필요하고, glob은 `sudo sh -c '...'` 안에서 써야 펼쳐짐
- 로그 rotation은 kubelet 설정 `containerLogMaxSize`(기본 10Mi), `containerLogMaxFiles`(기본 5). 이 클러스터의 `config.yaml`에는 지정이 없어서 기본값
- kubelet과 containerd 자신의 로그는 파일이 아니라 `journalctl -u kubelet`, `journalctl -u containerd`

## Service 연결 문제

nginx Deployment(`app=web`, replicas 2)와 busybox 클라이언트로, 하나씩 망가뜨려 `wget` 결과를 비교함.

| 고장                               | EndpointSlice             | 클라이언트 결과                          |
| ---------------------------------- | ------------------------- | ---------------------------------------- |
| 정상                               | Pod IP 2개, port 80       | `Welcome to nginx!`                      |
| selector 불일치                    | `<unset>` (endpoint 없음) | `Connection refused`                     |
| targetPort 틀림 (8080)             | Pod IP 2개, port 8080     | `Connection refused`                     |
| readiness 실패 Pod                 | 그 Pod만 `ready=false`    | 나머지 Pod로 정상 응답                   |
| CoreDNS replicas 0                 | `kube-dns` endpoint 없음  | 이름은 `bad address`, ClusterIP로는 정상 |
| NetworkPolicy default deny ingress | 정상                      | `download timed out`                     |

### selector 불일치

`kubectl create svc clusterip web-bad-sel --tcp=80:80`은 selector를 `app: web-bad-sel`로 만듦. Pod label은 `app=web`.

```bash
kubectl get svc web-bad-sel -o jsonpath='{.spec.selector}'    # {"app":"web-bad-sel"}
kubectl get pods -l app=web --show-labels                       # app=web,pod-template-hash=...
kubectl get endpointslice -l kubernetes.io/service-name=web-bad-sel
# web-bad-sel-rcjwq   IPv4   <unset>   <unset>
```

endpoint가 비어 있으면 selector와 Pod label부터 비교.

### targetPort 틀림

endpoint는 있는데 port가 컨테이너가 듣지 않는 8080. EndpointSlice의 PORTS 컬럼에서 바로 보임. `refused`는 그 Pod IP:port에서 아무도 안 듣고 있다는 뜻.

### readiness 실패

`readinessProbe`가 없는 경로(`/nope`)를 보게 바꾼 새 Pod는 `0/1 Running`이고, EndpointSlice에 `ready=false`로 남음. rolling update라서 기존 Pod 2개는 그대로 Ready이고 요청도 그쪽으로 감. 새 Pod는 트래픽을 받지 않음.

### DNS

CoreDNS를 0으로 줄이면 이름 해석만 실패하고 ClusterIP 직접 접속은 됨. "Service가 안 된다"는 문제에서 이름과 IP를 따로 시험하면 DNS 문제인지 바로 갈림. replicas를 다시 2로 올린 직후에는 잠깐 더 실패하다가 곧 정상으로 돌아옴.

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=kube-dns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### NetworkPolicy

`podSelector: {}` + `policyTypes: [Ingress]`인 default deny가 있으면 연결이 거부되지 않고 응답 없이 timeout. `refused`(빠르게 실패)와 timeout(기다리다 실패)의 차이가 단서.

## 확인 순서

```text
1. kubectl get svc <svc> -o wide            selector, port, targetPort
2. kubectl get endpointslice -l kubernetes.io/service-name=<svc>
   ├─ 비었음 → selector vs Pod label, Pod Ready 여부
   └─ 있음 → port가 컨테이너 port와 맞는지
3. Pod IP:port로 직접 → 되면 Service/kube-proxy 쪽, 안 되면 Pod/NetworkPolicy 쪽
4. ClusterIP로 → 되면 DNS 문제
5. FQDN으로 nslookup
6. kubectl get networkpolicy -A
7. kube-proxy, CNI Pod 상태 (kubectl -n kube-system get pods, calico-system 등)
```

## 헷갈리는 것 비교

| 비교                                              | A                                                   | B                              |
| ------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| `kubectl top node` vs `describe node`의 Allocated | 실제 사용량                                         | request/limit 합계             |
| `logs` vs `logs --previous`                       | 현재(또는 마지막) 컨테이너                          | 그 이전 컨테이너               |
| `-c <name>` vs `--all-containers`                 | 한 컨테이너                                         | 전부. `--prefix`로 구분        |
| `/var/log/pods` vs `/var/log/containers`          | 실제 파일                                           | symlink                        |
| `Connection refused` vs `timed out`               | 그 주소에서 듣는 게 없음 (endpoint 없음, port 틀림) | 패킷이 막힘 (NetworkPolicy 등) |
| `bad address`                                     | 이름 해석 실패                                      | DNS(CoreDNS, dnsPolicy) 확인   |
| endpoint 없음 vs `ready=false`                    | selector 불일치 또는 Pod 없음                       | Pod는 있지만 readiness 실패    |

## 시험 포인트

### 빨리 보는 명령어

```bash
kubectl top pods -A --sort-by=cpu --no-headers | head -1
kubectl logs <pod> -c <container> --previous
kubectl logs <pod> --all-containers --prefix
kubectl logs <pod> > /path/to/file          # 로그를 파일로 저장하는 문제
kubectl get endpointslice -l kubernetes.io/service-name=<svc>
kubectl get pods -l <selector> --show-labels
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
```

- 결과를 파일에 쓰라는 문제는 경로와 형식(이름만인지, 줄 하나인지)을 문제 그대로
- busybox `wget`, `nslookup`에는 `-T3` 같은 timeout을 줘서 오래 기다리지 않게

### kubectl explain

```bash
kubectl explain endpointslice.endpoints.conditions
kubectl explain pod.status.containerStatuses.lastState.terminated
```

## 참고 문서

- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
