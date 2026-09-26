---
title: "CKAD 개념 노트: 모니터링, 로그, 디버깅"
description: "kubectl get/describe/events/top으로 상태를 보고, kubectl logs로 로그를 읽고, exec와 debug로 컨테이너 안을 들여다보는 흐름을 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:13:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "logging", "debugging"]
order: 14
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 개념

### 무엇을 보면 되나

| 보고 싶은 것                                  | 명령                                   | 출처                                    |
| --------------------------------------------- | -------------------------------------- | --------------------------------------- |
| Pod 목록과 STATUS, RESTARTS                   | `kubectl get pods`                     | API server                              |
| 컨테이너 State, Reason, Restart Count, 이벤트 | `kubectl describe pod <pod>`           | API server (Pod + Event)                |
| 시스템이 가진 전체 정보                       | `kubectl get pod <pod> -o yaml`        | API server                              |
| 네임스페이스 이벤트                           | `kubectl events`, `kubectl get events` | Event 리소스                            |
| CPU/메모리 사용량                             | `kubectl top pod`, `kubectl top node`  | Metrics API (metrics-server)            |
| 애플리케이션 출력                             | `kubectl logs`                         | kubelet이 노드에 저장한 stdout/stderr   |
| 컨테이너 내부                                 | `kubectl exec`, `kubectl debug`        | 실행 중인 컨테이너 / 새로 붙인 컨테이너 |

### Pod phase와 kubectl의 STATUS는 다른 값

- `phase`는 API 필드. 값은 `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown` 다섯 개뿐
- `kubectl get pods`의 STATUS 열은 사람이 보기 좋게 만든 표시값. `CrashLoopBackOff`, `Terminating`, `OOMKilled`가 여기 뜨지만 phase 값은 아님
- 실제 원인은 컨테이너 단위로 봐야 함. 컨테이너 state는 `Waiting`, `Running`, `Terminated` 셋이고, `Waiting`과 `Terminated`에는 Reason이 붙음

### 컨테이너 로그는 어디에 있나

- 컨테이너가 stdout/stderr로 쓴 출력을 container runtime이 받아 kubelet이 노드의 `/var/log/pods` 아래에 파일로 저장
- 컨테이너가 재시작되면 kubelet은 기본적으로 종료된 컨테이너 하나와 그 로그를 남김 → `--previous`로 읽는 대상
- Pod가 노드에서 evict되면 컨테이너와 로그가 같이 삭제됨
- 로그 rotation은 kubelet 담당. `containerLogMaxSize` 기본 10Mi, `containerLogMaxFiles` 기본 5
- `kubectl logs`는 가장 최근 로그 파일만 읽음. 40MiB를 쓰고 10MiB마다 rotation되면 최대 10MiB만 보임
- 파일로만 로그를 쓰는 앱이면 `kubectl logs`에 아무것도 안 나옴. 이 경우 streaming sidecar가 파일을 `tail`해서 자기 stdout으로 내보내는 패턴이 공식 문서에 있음

### ephemeral container

- 이미 만들어진 Pod에 임시로 추가하는 컨테이너. 트러블슈팅 전용
- Pod spec에 직접 넣는 게 아니라 API의 `ephemeralcontainers` 핸들러로 추가 → `kubectl edit`로는 못 붙임
- 제약
  - `ports`, `livenessProbe`, `readinessProbe` 불가
  - `resources` 불가 (Pod의 리소스 할당은 immutable)
  - 자동 재시작 없음, 리소스·실행 보장 없음
  - 한 번 추가하면 수정·삭제 불가
  - static Pod에서는 지원 안 함

## 동작 방식

### 흔한 실패 상태 읽기

| 표시               | 어디서 보이나                | 의미                                                                                 | 먼저 볼 것                                                                                    |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `Pending`          | phase                        | 스케줄 대기 또는 이미지 다운로드 중                                                  | `describe`의 Events. `FailedScheduling`이면 리소스 부족, nodeSelector 불일치, `hostPort` 충돌 |
| `ImagePullBackOff` | 컨테이너 `Waiting` Reason    | 이미지를 못 가져옴. 이미지 이름 오류, private registry인데 `imagePullSecret` 없음 등 | 이미지 이름·태그, registry 접근                                                               |
| `CrashLoopBackOff` | 컨테이너 `Waiting` Reason    | 시작 → 종료를 반복하고 있고 재시작 back-off가 걸린 상태                              | `logs --previous`, `describe`의 Last State와 Exit Code                                        |
| `OOMKilled`        | 컨테이너 `Terminated` Reason | memory limit을 넘겨 커널이 종료. `exitCode: 137`                                     | `resources.limits.memory`, `top pod`                                                          |

### back-off 타이밍

- 컨테이너 재시작: 10s, 20s, 40s ... 식으로 늘어나고 300초(5분)에서 멈춤
- 10분 동안 문제 없이 돌면 back-off 타이머 초기화
- 이미지 pull 재시도도 같은 식으로 늘어나며 상한은 300초
- 그래서 고친 직후에도 한동안 `CrashLoopBackOff`로 보일 수 있음. 바로 확인하려면 Pod를 다시 만드는 게 빠름

### CrashLoopBackOff 원인 (공식 문서 목록)

- 애플리케이션 에러로 종료
- 설정 오류: 잘못된 환경 변수, 없는 설정 파일
- 메모리·CPU 부족
- liveness probe 또는 startup probe 실패

### kubectl debug의 세 가지 모드

```text
kubectl debug <pod> --image=...               # 기존 Pod에 ephemeral container 추가
kubectl debug <pod> --copy-to=<new> ...       # Pod를 복사해 새 Pod 생성 (원본은 그대로)
kubectl debug node/<node> --image=...         # 노드에 디버깅용 Pod 생성
```

- ephemeral container 모드: `--target=<container>`로 대상 컨테이너의 process namespace를 공유. runtime이 지원하지 않으면 `ps`에 대상 프로세스가 안 보일 수 있음
- copy 모드: 새 컨테이너 추가, `--container`로 기존 컨테이너의 command 교체, `--set-image`로 이미지 교체 가능. `--share-processes`로 Pod 안 컨테이너끼리 프로세스를 봄
- node 모드: 노드 root filesystem이 `/host`에 마운트, host IPC/Network/PID namespace 사용. privileged는 아니라서 필요하면 `--profile=sysadmin`
- `--profile` 값: `legacy`, `general`, `baseline`, `restricted`, `netadmin`, `sysadmin`. 문서 기준으로 지정 안 하면 `legacy`가 쓰이고, `general` 같은 다른 profile을 권장
- `-i`를 주면 새 컨테이너에 자동 attach. 연결이 끊기면 `kubectl attach`로 다시 붙음
- `--container`를 안 주면 컨테이너 이름은 자동 생성 (`debugger-xxxxx`)

## 예시

### 상태와 이벤트

```bash
kubectl get pods -o wide
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'
kubectl describe pod <pod>

# 이벤트는 namespace 단위
kubectl get events --sort-by='.lastTimestamp'
kubectl get events -n my-namespace
kubectl events --for pod/<pod> --watch
kubectl events --types=Warning

# 메트릭 (metrics-server 필요)
kubectl top node
kubectl top pod --sort-by=memory
kubectl top pod <pod> --containers
```

### 종료 사유만 뽑기

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
kubectl get pod <pod> -o go-template='{{range .status.containerStatuses}}{{.lastState.terminated.message}}{{end}}'
```

- termination message는 컨테이너가 `terminationMessagePath`(기본 `/dev/termination-log`)에 쓴 내용
- `terminationMessagePolicy: FallbackToLogsOnError`면 파일이 비어 있고 에러로 종료됐을 때 로그 마지막 부분(2048바이트 또는 80줄 중 작은 쪽)을 대신 사용

### 로그

```bash
kubectl logs <pod>
kubectl logs <pod> -c <container>          # multi-container Pod
kubectl logs <pod> --previous              # 직전에 종료된 컨테이너 (-p)
kubectl logs -f <pod>                      # 스트리밍
kubectl logs <pod> --all-containers=true
kubectl logs -l app=nginx --all-containers=true
kubectl logs deployment/nginx -c nginx-1
kubectl logs --tail=20 <pod>
kubectl logs --since=1h <pod>
kubectl logs <pod> --timestamps=true --prefix
```

### streaming sidecar

공식 문서 예제를 줄인 형태. 앱은 파일로만 로그를 쓰고, sidecar가 그 파일을 자기 stdout으로 흘려보냄.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: counter
spec:
  containers:
    - name: count
      image: busybox:1.28
      args:
        - /bin/sh
        - -c
        - >
          i=0;
          while true;
          do
            echo "$i: $(date)" >> /var/log/1.log;
            i=$((i+1));
            sleep 1;
          done
      volumeMounts:
        - name: varlog
          mountPath: /var/log
    - name: count-log-1
      image: busybox:1.28
      args: [/bin/sh, -c, "tail -n+1 -F /var/log/1.log"]
      volumeMounts:
        - name: varlog
          mountPath: /var/log
  volumes:
    - name: varlog
      emptyDir: {}
```

```bash
kubectl logs counter count-log-1
```

### exec

```bash
kubectl exec <pod> -- ls /
kubectl exec <pod> -c <container> -- cat /etc/config/app.conf
kubectl exec -it <pod> -- sh
```

- `--` 뒤가 컨테이너에서 실행할 명령
- 이미지에 `sh`가 없으면 `executable file not found in $PATH`로 실패 → `kubectl debug`로 넘어감

### debug

```bash
# shell 없는 이미지에 ephemeral container 추가
kubectl run ephemeral-demo --image=registry.k8s.io/pause:3.1 --restart=Never
kubectl debug -it ephemeral-demo --image=busybox:1.28 --target=ephemeral-demo
kubectl describe pod ephemeral-demo        # "Ephemeral Containers:" 항목에 추가됨

# 시작하자마자 죽는 컨테이너: 복사본에서 command를 shell로 교체
kubectl run --image=busybox:1.28 myapp -- false
kubectl debug myapp -it --copy-to=myapp-debug --container=myapp -- sh

# 복사본에 디버깅 도구 컨테이너 추가 + 프로세스 공유
kubectl debug myapp -it --image=ubuntu --share-processes --copy-to=myapp-debug

# 복사본의 모든 컨테이너 이미지 교체
kubectl debug myapp --copy-to=myapp-debug --set-image=*=ubuntu

# 노드
kubectl debug node/mynode -it --image=ubuntu

# 정리
kubectl delete pod myapp myapp-debug
```

## 헷갈리는 것 비교

### exec, ephemeral container, copy

|                        | `kubectl exec`          | `kubectl debug <pod> --image`          | `kubectl debug <pod> --copy-to` |
| ---------------------- | ----------------------- | -------------------------------------- | ------------------------------- |
| 대상                   | 실행 중인 기존 컨테이너 | 기존 Pod에 새 컨테이너 추가            | 새 Pod                          |
| 이미지에 shell 필요    | 필요                    | 불필요 (디버그 이미지 사용)            | 불필요                          |
| 컨테이너가 죽어 있어도 | 불가                    | 가능                                   | 가능 (command 교체)             |
| 원본 Pod 변경          | 없음                    | ephemeral container가 남음 (삭제 불가) | 없음                            |
| 뒷정리                 | 없음                    | Pod를 지우기 전까지 남음               | 복사한 Pod 삭제                 |

### --target과 --share-processes

|           | `--target=<container>`                   | `--share-processes`        |
| --------- | ---------------------------------------- | -------------------------- |
| 쓰는 모드 | ephemeral container                      | `--copy-to`                |
| 범위      | 지정한 컨테이너 하나의 process namespace | 복사한 Pod의 모든 컨테이너 |
| 조건      | container runtime 지원 필요              | Pod 설정으로 적용          |

### logs 옵션

| 옵션               | 의미               | 주의                                        |
| ------------------ | ------------------ | ------------------------------------------- |
| `-c`               | 컨테이너 지정      | 컨테이너가 하나면 생략 가능                 |
| `-p`, `--previous` | 직전 종료 인스턴스 | kubelet이 남겨 둔 종료 컨테이너 하나가 대상 |
| `-f`               | 스트리밍           | 끝내려면 Ctrl+C                             |
| `--all-containers` | 모든 컨테이너      | `-l`과 같이 쓰면 여러 Pod의 모든 컨테이너   |
| `-l`               | label selector     | 동시 요청은 `--max-log-requests` 기본 5개   |

### get events와 events

|               | `kubectl get events`          | `kubectl events`             |
| ------------- | ----------------------------- | ---------------------------- |
| 시간순 정렬   | `--sort-by='.lastTimestamp'`  | 기본 출력이 최근 이벤트 목록 |
| 특정 리소스만 | `describe`의 Events로 대신 봄 | `--for pod/<name>`           |
| 타입 필터     | -                             | `--types=Warning`            |
| 계속 보기     | `--watch`                     | `--watch`                    |

## 시험 포인트

### 먼저 치는 명령

```bash
kubectl get pods -A | grep -v Running
kubectl describe pod <pod> | grep -A10 -E 'State|Events'
kubectl logs <pod> -c <container> --previous
kubectl get events -n <ns> --sort-by='.lastTimestamp'
```

- Pending은 `logs`로 봐도 소용없음. 컨테이너가 시작 전이라 로그가 없음. `describe`의 Events부터
- `CrashLoopBackOff`는 현재 컨테이너가 막 떴다가 죽는 중이라 `logs`가 비어 있을 수 있음. `--previous`
- `OOMKilled`는 `describe`의 Last State Reason과 Exit Code 137, 그리고 `resources.limits.memory`를 같이 봄
- 이벤트는 namespace 단위. `-n`을 빼면 default namespace만 봄
- `kubectl top`이 에러를 내면 명령보다 Metrics API(metrics-server) 배포 여부부터 의심

### 문서에서 찾는 위치

| 찾는 것                               | 페이지                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `kubectl debug` 예제 전체, profile 표 | Tasks > Monitoring, Logging, and Debugging > Troubleshooting Applications > Debug Running Pods |
| Pending/Waiting 원인                  | 같은 섹션 > Debug Pods                                                                         |
| logs 옵션 한 줄 요약                  | Reference > kubectl > Quick Reference, "Interacting with running Pods"                         |
| sidecar 로그 패턴 YAML                | Concepts > Cluster Administration > Logging Architecture                                       |
| CrashLoopBackOff, back-off 시간       | Concepts > Workloads > Pods > Pod Lifecycle                                                    |
| termination message                   | Debug > Determine the Reason for Pod Failure                                                   |

### 자주 하는 실수

- `kubectl exec <pod> ls` → `--` 빠뜨림. `kubectl exec <pod> -- ls`
- multi-container Pod에서 `-c`를 빠뜨림 → 원하는 컨테이너인지 확인 안 됨
- ephemeral container로 `ps`를 쳤는데 앱 프로세스가 안 보임 → `--target` 누락
- `--copy-to`로 command를 바꾸려는데 `--container`를 안 줌 → command 교체 대신 새 컨테이너가 추가됨
- 디버깅 후 `myapp-debug`, `node-debugger-*` Pod를 안 지움
- phase와 STATUS를 혼동해 `status.phase`에서 `CrashLoopBackOff`를 찾음 → 컨테이너 상태는 `status.containerStatuses[].state` / `lastState`

## 참고 문서

- [CKAD Curriculum v1.35 (cncf/curriculum)](https://github.com/cncf/curriculum/blob/master/CKAD_Curriculum_v1.35.pdf)
- [Troubleshooting Applications](https://kubernetes.io/docs/tasks/debug/debug-application/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Determine the Reason for Pod Failure](https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [kubectl events](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_events/)
- [Ephemeral Containers](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Images: ImagePullBackOff](https://kubernetes.io/docs/concepts/containers/images/#imagepullbackoff)
- [Assign Memory Resources to Containers and Pods](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
