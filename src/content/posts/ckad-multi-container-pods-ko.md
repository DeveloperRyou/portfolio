---
title: "CKAD 개념 노트: 멀티 컨테이너 Pod 패턴"
description: "init container, native sidecar와 기존 방식의 sidecar, ambassador·adapter 패턴, ephemeral container를 공식 문서 기준으로 비교했습니다."
pubDatetime: 2026-09-26T12:02:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "pod", "init-container", "sidecar"]
order: 3
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## Pod 안의 container 종류

| 종류                | 정의 위치                                       | 언제 실행                      | 재시작                     | probe |
| ------------------- | ----------------------------------------------- | ------------------------------ | -------------------------- | ----- |
| app container       | `spec.containers`                               | init 단계가 끝난 뒤, 병렬      | Pod `restartPolicy`        | 지원  |
| init container      | `spec.initContainers`                           | app보다 먼저, 순서대로, 끝까지 | 실패 시 재시도 (아래 참고) | 불가  |
| sidecar (native)    | `spec.initContainers` + `restartPolicy: Always` | 정의된 순서대로 시작 후 계속   | 항상                       | 지원  |
| ephemeral container | `ephemeralcontainers` subresource               | 사용자가 추가할 때             | 안 함                      | 불가  |

### 공유하는 것

- network: Pod IP 하나를 같이 씀. container끼리 `localhost:<port>`로 통신, 대신 포트가 겹치면 안 됨
- storage: `spec.volumes`에 정의한 volume을 각 container가 `volumeMounts`로 mount. 주고받는 파일은 보통 `emptyDir`
- IPC: SystemV semaphore, POSIX shared memory도 사용 가능
- process namespace는 기본으로 분리. 필요하면 process namespace sharing을 켬

## init container

Pod 시작 전에 준비 작업을 하는 container. 문서가 드는 용도는 Service가 생길 때까지 기다리기, Git repository를 volume에 clone, 설정 파일 템플릿 렌더링 같은 것들.

- app 이미지와 별도 이미지라서 `sed`, `dig` 같은 도구를 app 이미지에 넣을 필요 없음
- app container가 못 보는 Secret에 접근하게 할 수 있음
- 조건이 맞을 때까지 app 시작을 막는 용도로 씀

### 동작 방식

1. kubelet은 network와 storage가 준비된 뒤 init container를 spec에 적힌 순서대로 실행
2. 각 init container는 성공(exit 0)해야 다음 것이 시작됨
3. 전부 끝나면 app container들을 시작

실패하면:

- Pod `restartPolicy`가 `Never`: Pod 전체가 실패 처리
- `OnFailure`: 해당 init container를 재시도
- `Always`: init container에는 `OnFailure`로 적용됨

그 밖의 규칙:

- init이 끝나기 전 Pod phase는 `Pending`, condition `Initialized`는 false. `kubectl get` STATUS에는 `Init:0/2` 형태로 표시
- 일반 init container는 `lifecycle`, `livenessProbe`, `readinessProbe`, `startupProbe`를 쓸 수 없음. `readinessProbe`는 validation 단계에서 거부
- 다시 실행될 수 있으므로 idempotent하게 작성. `emptyDir`에 쓸 파일이 이미 있을 수 있음
- 실행 중인 Pod에서 init container는 `image`만 바꿀 수 있고, 바꿔도 Pod가 재시작되지 않음
- container 이름은 init·app 전체에서 유일해야 함
- init container의 포트는 Service에 묶이지 않음

### 리소스 계산

- init container들 중 가장 큰 request/limit = effective init request/limit
- Pod의 effective request/limit = max(app·sidecar container 합, effective init 값) + pod overhead
- 스케줄링은 이 effective 값 기준이라, init이 크면 초기화 때만 쓰는 리소스도 예약됨

## sidecar

메인 앱 옆에서 로그 수집, 모니터링, 데이터 동기화 같은 보조 기능을 하는 container. 앱 코드를 고치지 않고 기능을 붙이는 게 목적입니다.

### native sidecar

`SidecarContainers` feature gate(v1.29부터 기본 활성화)로 생긴 방식. `initContainers` 항목에 `restartPolicy: Always`를 주면 sidecar가 됩니다.

- init container처럼 순서가 보장됨. sidecar가 `started` 상태가 되면 다음 init container가 시작. `startupProbe`가 있으면 그게 성공해야 `started`
- 시작 후 Pod가 끝날 때까지 계속 실행. 종료되면 Pod `restartPolicy`와 상관없이 재시작
- probe 지원. `readinessProbe` 결과가 Pod ready 판정에 들어감
- Pod 종료 시: 메인 container가 완전히 끝난 뒤에야 sidecar에 TERM을 보내고, 정의된 순서의 역순으로 종료
- Job에서 메인 container가 끝나면 sidecar가 남아 있어도 Job은 완료됨
- image를 바꾸면 Pod가 아니라 그 container만 재시작
- 종료 과정에서 grace period를 메인 container가 다 쓰면 sidecar는 곧바로 SIGKILL을 받을 수 있음. 이때 0이 아닌 exit code는 정상으로 봐도 됨

### 기존 방식 sidecar

`containers`에 app container를 하나 더 넣는 방식. container 단위 `restartPolicy`를 지원하지 않는 옛 버전에서도 동작하고, 지금도 유효합니다. 다만 일반 app container라서:

- 앱보다 먼저 뜬다는 보장이 없음
- Job에서는 문제가 됨. Pod가 `Succeeded`가 되려면 모든 container가 종료돼야 하는데, 계속 도는 sidecar가 있으면 끝나지 않음

시작·종료 순서가 상관없고 모든 container가 Pod 동작에 필요하다면 이 방식으로도 충분하다고 공식 문서도 설명합니다.

## ambassador와 adapter

Kubernetes 블로그 2015년 글 "Patterns for Composite Containers"에서 sidecar와 함께 소개한 패턴. 현재 concepts 문서에는 따로 항목이 없고, 구현도 별도 필드 없이 container를 추가하는 방식입니다.

| 패턴       | 역할                            | 예시 (블로그 기준)                                                              |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------- |
| sidecar    | 메인 container 기능 확장        | nginx + Git 저장소를 동기화하는 container, 파일 시스템 공유                     |
| ambassador | 외부 연결을 대신하는 로컬 proxy | 앱은 `localhost`의 Redis에 붙고, ambassador가 읽기/쓰기를 나눠 실제 서버로 전달 |
| adapter    | 출력을 표준 형식으로 변환       | 앱마다 다른 모니터링 데이터 형식을 공통 형식으로 바꿔 내보냄                    |

ambassador는 network namespace 공유, adapter는 volume이나 `localhost` 공유에 기대는 구조. 셋 다 구현은 `containers` 또는 native sidecar로 합니다.

## ephemeral container

실행 중인 Pod에 임시로 붙이는 디버깅용 container. v1.25부터 stable.

- Pod에는 생성 후 container를 추가할 수 없지만, ephemeral container는 `ephemeralcontainers` subresource로 추가. 그래서 `kubectl edit`로는 못 넣음
- 추가한 뒤에는 수정·삭제 불가
- 자동 재시작 없음, 리소스 보장 없음
- `ports`, `livenessProbe`, `readinessProbe`, `resources` 사용 불가
- static Pod에는 사용 불가
- 쓰는 상황: container가 crash했거나, distroless처럼 shell이 없어 `kubectl exec`가 안 될 때

```bash
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

`--target`은 지정한 container의 process namespace에 붙어서 그 프로세스를 볼 수 있게 함. container runtime이 지원해야 동작하고, 지원하지 않으면 process namespace가 분리된 채로 뜰 수 있음.

## 예시

init container로 설정 파일을 만들고, native sidecar가 앱 로그를 읽는 Pod.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  initContainers:
    - name: init-config
      image: busybox:1.36
      command: ["sh", "-c", 'echo "server_name=web" > /config/app.conf']
      volumeMounts:
        - name: config
          mountPath: /config
    - name: log-shipper
      image: busybox:1.36
      restartPolicy: Always
      command: ["sh", "-c", "touch /logs/app.log; tail -F /logs/app.log"]
      volumeMounts:
        - name: logs
          mountPath: /logs
  containers:
    - name: app
      image: busybox:1.36
      command:
        [
          "sh",
          "-c",
          "while true; do cat /config/app.conf >> /logs/app.log; sleep 5; done",
        ]
      volumeMounts:
        - name: config
          mountPath: /config
        - name: logs
          mountPath: /logs
  volumes:
    - name: config
      emptyDir: {}
    - name: logs
      emptyDir: {}
```

실행 순서: `init-config` 완료 → `log-shipper` 시작(started) → `app` 시작. `log-shipper`는 `app`과 함께 계속 실행.

같은 sidecar를 기존 방식으로 쓰면 `containers` 아래로 옮기고 `restartPolicy`를 빼면 됩니다. 이 경우 `log-shipper`와 `app`은 순서 없이 함께 시작.

```bash
kubectl apply -f web.yaml
kubectl get pod web                      # STATUS: Init:0/2 → Running
kubectl logs web -c init-config          # init container 로그
kubectl logs web -c log-shipper -f       # sidecar 로그
kubectl logs web --all-containers
kubectl exec -it web -c app -- sh
kubectl describe pod web                 # Init Containers 섹션의 State/Reason
```

## 헷갈리는 것 비교

### init container, native sidecar, 기존 sidecar

|                           | init container             | native sidecar   | 기존 sidecar  |
| ------------------------- | -------------------------- | ---------------- | ------------- |
| 위치                      | `initContainers`           | `initContainers` | `containers`  |
| container `restartPolicy` | 없음                       | `Always`         | 없음          |
| 실행 기간                 | 끝날 때까지만              | Pod 수명 전체    | Pod 수명 전체 |
| app보다 먼저 시작         | 예 (완료까지)              | 예 (started까지) | 보장 없음     |
| probe                     | 불가                       | 지원             | 지원          |
| app과 데이터 교환         | 한 방향 (volume에 써 두기) | 양방향           | 양방향        |
| Job 완료 막음             | 아니오                     | 아니오           | 예            |
| 종료 순서                 | 해당 없음                  | 메인 뒤, 역순    | 순서 없음     |

### `kubectl exec` vs `kubectl debug`

|                   | `kubectl exec`        | `kubectl debug` (ephemeral) |
| ----------------- | --------------------- | --------------------------- |
| 사용하는 이미지   | 기존 container 이미지 | 새로 지정한 이미지          |
| shell 없는 이미지 | 불가                  | 가능                        |
| crash한 container | 불가                  | 가능                        |
| Pod spec 변화     | 없음                  | ephemeral container가 남음  |

## 시험 포인트

### 명령어

멀티 container Pod를 한 번에 만드는 imperative 명령어는 없음. 뼈대를 만든 뒤 YAML을 고치는 흐름.

```bash
kubectl run web --image=busybox:1.36 --dry-run=client -o yaml \
  --command -- sh -c 'sleep 3600' > web.yaml
# initContainers, 추가 container, volumes를 직접 작성

kubectl logs <pod> -c <container>
kubectl exec -it <pod> -c <container> -- sh
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

### 문서에서 찾을 위치

- init container 예시 YAML: Concepts > Workloads > Pods > Init Containers, "Init containers in use"
- native sidecar Deployment/Job 예시: Concepts > Workloads > Pods > Sidecar Containers
- `kubectl debug` 예시: Tasks > Monitoring, Logging, and Debugging > Debug Running Pods, "Debugging with an ephemeral debug container"

### 자주 하는 실수

- `restartPolicy: Always`를 `containers` 항목에 넣음. native sidecar는 `initContainers` 안에서만 의미가 있음 (일반 container의 container 단위 `restartPolicy`는 `ContainerRestartRules` feature gate가 켜진 클러스터에서만 허용)
- 일반 init container에 `readinessProbe`를 넣어 validation 에러
- `volumes`만 정의하고 한쪽 container의 `volumeMounts`를 빠뜨림
- 두 container가 같은 포트를 listen. network namespace를 공유하므로 충돌
- `kubectl logs`에 `-c`를 빼먹음. container가 여럿이면 어떤 container인지 지정해야 함
- init container가 끝나지 않는 명령(`sleep 3600` 등)을 실행해 Pod가 `Init:0/1`에서 멈춤

## 참고 문서

- [Init Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Ephemeral Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pods: Pods with multiple containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/#how-pods-manage-multiple-containers)
- [Pod Lifecycle: Pod phase, Restart policy, Pod shutdown and sidecar containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Debug Running Pods: ephemeral container | Kubernetes](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#ephemeral-container)
- [Share Process Namespace between Containers in a Pod | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/)
- [The Distributed System ToolKit: Patterns for Composite Containers | Kubernetes Blog (2015)](https://kubernetes.io/blog/2015/06/the-distributed-system-toolkit-patterns/)
- [kubectl debug](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
