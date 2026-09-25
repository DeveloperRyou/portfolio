---
title: "CKAD 개념 노트: Probe와 Pod lifecycle"
description: "Pod phase, condition, container state, restartPolicy를 먼저 정리하고, liveness·readiness·startup probe가 실패했을 때 각각 무엇이 일어나는지 공식 문서 기준으로 비교합니다."
pubDatetime: 2026-09-26T12:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "probe", "pod-lifecycle"]
order: 4
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 요약

- 커리큘럼 위치: Application Observability and Maintenance -- Implement probes and health checks
- Pod 상태는 세 층으로 본다. Pod 전체의 `phase`, Pod의 `conditions`, 컨테이너별 state
- probe는 kubelet이 컨테이너에 주기적으로 하는 진단. 결과에 따라 컨테이너를 재시작하거나 트래픽에서 뺀다
- liveness/startup probe 실패는 컨테이너 kill 후 `restartPolicy` 적용, readiness probe 실패는 재시작 없이 Service endpoint에서 제외
- init container는 앱 컨테이너보다 먼저 끝까지 실행되고 끝나는 작업. probe를 붙일 수 없다

## Pod phase

`status.phase`는 Pod가 lifecycle 어디쯤에 있는지 보여 주는 요약값. 공식 문서도 컨테이너·Pod 상태를 전부 담은 state machine이 아니라고 못 박는다.

| phase       | 의미                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `Pending`   | 클러스터가 Pod를 받았지만 컨테이너 하나 이상이 아직 실행 준비 전. 스케줄링 대기, 이미지 다운로드 시간 포함 |
| `Running`   | 노드에 bind됐고 컨테이너가 전부 생성됨. 적어도 하나가 실행 중이거나 시작·재시작 중                         |
| `Succeeded` | 모든 컨테이너가 성공 종료, 재시작 안 함                                                                    |
| `Failed`    | 모든 컨테이너가 종료, 하나 이상은 실패(non-zero exit 또는 시스템이 종료)했고 자동 재시작 대상 아님         |
| `Unknown`   | Pod 상태를 얻지 못함. 보통 노드와 통신 문제                                                                |

`kubectl get pod`의 `STATUS` 열에 보이는 `CrashLoopBackOff`, `Terminating`은 phase가 아니다. kubectl이 보여 주는 표시용 값이고, phase는 Pod API의 필드.

## Pod conditions

`status.conditions`는 Pod가 통과했거나 아직 못 통과한 조건 목록. kubelet이 관리하는 것 중 probe와 직접 관련 있는 것들:

| condition                   | `True`가 되는 시점                                                   |
| --------------------------- | -------------------------------------------------------------------- |
| `PodScheduled`              | 노드에 스케줄됨                                                      |
| `PodReadyToStartContainers` | sandbox 생성과 네트워크 설정 완료 (beta, 기본 활성)                  |
| `Initialized`               | init container가 전부 성공 종료                                      |
| `ContainersReady`           | Pod의 모든 컨테이너가 ready                                          |
| `Ready`                     | 요청을 받을 수 있음. 매칭되는 Service의 load balancing pool에 들어감 |

각 condition에는 `status`(`True`/`False`/`Unknown`), `lastTransitionTime`, `reason`, `message` 등이 붙는다. `readinessGates`로 커스텀 condition을 추가하면, 컨테이너가 전부 ready이고 gate condition도 전부 `True`일 때만 Pod가 ready.

## Container state

컨테이너별 state는 `Waiting`, `Running`, `Terminated` 세 가지. `kubectl describe pod <name>`으로 확인.

- `Waiting`: `Running`도 `Terminated`도 아닌 상태. 이미지 pull, Secret 적용처럼 시작에 필요한 작업 중. `Reason` 필드가 같이 보인다
- `Running`: 문제없이 실행 중. `postStart` hook이 있었다면 이미 끝난 상태
- `Terminated`: 실행을 시작했다가 완료했거나 실패한 상태. reason, exit code, 시작·종료 시각이 보인다. `preStop` hook은 이 상태로 들어가기 전에 실행

## restartPolicy

Pod `spec.restartPolicy`. 값은 `Always`(기본), `OnFailure`, `Never`. 앱 컨테이너와 일반 init container에 적용된다.

| exit code       | `Always` | `OnFailure`  | `Never`      |
| --------------- | -------- | ------------ | ------------ |
| 0 (성공)        | 재시작   | 재시작 안 함 | 재시작 안 함 |
| non-zero (실패) | 재시작   | 재시작       | 재시작 안 함 |

- 재시작 간격은 exponential backoff: 10s, 20s, 40s ... 최대 300s(5분). 10분 동안 문제없이 돌면 backoff 초기화
- backoff가 걸려 있는 동안 kubectl에 보이는 게 `CrashLoopBackOff`
- liveness/startup probe 실패도 `CrashLoopBackOff`의 원인이 될 수 있다
- sidecar container(`initContainers` 안에서 컨테이너 단위 `restartPolicy: Always`를 지정한 것)는 Pod의 `restartPolicy`를 무시하고 항상 재시작
- 워크로드별 제약: Deployment는 `Always`만 허용, Job은 `OnFailure`나 `Never`만 허용

## Probe 종류

|             | startup probe                                 | liveness probe                                          | readiness probe                                                                                            |
| ----------- | --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 확인하는 것 | 애플리케이션이 시작을 마쳤나                  | 컨테이너가 계속 살아 있어야 하나                        | 트래픽을 받아도 되나                                                                                       |
| 실행 시점   | 시작할 때만. 성공하면 끝                      | 주기적으로 계속 (startup probe가 있으면 그게 성공한 뒤) | 컨테이너 lifecycle 내내 주기적으로 (startup probe가 있으면 그게 성공한 뒤)                                 |
| 실패 시     | kubelet이 컨테이너 kill, `restartPolicy` 적용 | kubelet이 컨테이너 kill, `restartPolicy` 적용           | 컨테이너를 not ready로 표시, Pod의 `Ready` condition이 `False`, EndpointSlice에서 Pod IP 제외. 재시작 없음 |
| 주 용도     | 시작이 느린 컨테이너                          | deadlock처럼 실행은 되는데 진행을 못 하는 상태          | 워밍업, 일시적 과부하, 백엔드 의존성 확인                                                                  |

### startup probe가 있으면 무엇이 달라지나

startup probe가 성공할 때까지 liveness와 readiness probe는 실행되지 않는다. liveness·readiness의 `initialDelaySeconds`도 startup probe가 성공한 뒤부터 센다.

시작에 걸리는 시간이 `initialDelaySeconds + failureThreshold × periodSeconds`보다 길면 startup probe를 쓰라는 게 공식 문서 권장. liveness probe와 같은 endpoint를 보게 하고, `failureThreshold`를 넉넉히 준다. liveness 쪽 기본값은 건드리지 않는다.

### liveness probe는 readiness를 기다리나?

기다리지 않는다. 두 probe는 서로의 성공에 의존하지 않는다. liveness를 늦게 시작하고 싶으면 `initialDelaySeconds`나 startup probe를 쓴다.

### probe를 안 정의하면?

해당 probe 결과는 항상 `Success`로 간주. 단 readiness probe는 정의돼 있으면 initial delay가 지나기 전까지 `Failure`. 그래서 readiness probe가 있는 Pod는 트래픽 없이 시작해서 probe가 성공한 뒤부터 트래픽을 받는다.

### liveness probe를 잘못 걸면

공식 문서가 caution으로 경고하는 부분. liveness probe는 정말 복구 불가능한 상태(deadlock 등)에서만 실패해야 한다. 부하가 높을 때 liveness가 실패하면 컨테이너가 연쇄적으로 재시작되고, 남은 Pod에 부하가 몰리는 cascading failure로 이어진다.

프로세스가 문제 생기면 스스로 죽는 구조라면 liveness probe가 없어도 kubelet이 `restartPolicy`대로 처리한다. 흔한 패턴은 readiness와 같은 가벼운 HTTP endpoint를 쓰되 liveness 쪽 `failureThreshold`를 더 높게 두는 것. 그러면 kill 전에 not ready 상태가 먼저 한동안 이어진다.

## Probe 핸들러

probe 하나에 아래 네 가지 중 정확히 하나를 지정한다.

| 핸들러      | 성공 조건                                                 | 메모                                                                         |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `exec`      | 컨테이너 안에서 명령 실행, exit code 0                    | 실행할 때마다 프로세스를 fork. Pod 밀도가 높고 주기가 짧으면 노드 CPU 부담   |
| `httpGet`   | Pod IP로 GET, 상태 코드 200 이상 400 미만                 | `path` 기본 `/`, `scheme` 기본 `HTTP`. HTTPS는 인증서 검증 안 함             |
| `tcpSocket` | 지정 포트로 TCP 연결 성립                                 | 연결은 노드에서 한다. `host`에 Service 이름을 넣어도 kubelet이 resolve 못 함 |
| `grpc`      | gRPC Health Checking Protocol 응답의 `status`가 `SERVING` | v1.27 stable. `port` 필수, named port 불가                                   |

결과는 `Success`, `Failure`, `Unknown`. `Unknown`은 진단 자체가 실패한 경우라 아무 조치 없이 다음 체크로 넘어간다.

`httpGet`과 `tcpSocket`의 `port`에는 숫자 대신 `ports[].name`(named port)을 쓸 수 있다.

## 타이밍 필드

| 필드                            | 기본값                     | 최소값 | 의미                                                                                                    |
| ------------------------------- | -------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `initialDelaySeconds`           | 0                          | 0      | 컨테이너 시작 후 첫 probe까지 대기                                                                      |
| `periodSeconds`                 | 10                         | 1      | probe 주기                                                                                              |
| `timeoutSeconds`                | 1                          | 1      | probe 타임아웃                                                                                          |
| `successThreshold`              | 1                          | 1      | 실패 후 성공으로 보기 위한 연속 성공 횟수. liveness·startup은 반드시 1                                  |
| `failureThreshold`              | 3                          | 1      | 연속 실패가 이 횟수에 닿으면 전체 체크 실패                                                             |
| `terminationGracePeriodSeconds` | Pod 값 상속 (미지정 시 30) | 1      | probe 실패로 컨테이너를 내릴 때 SIGKILL 전 대기 시간. readiness probe에는 설정 불가 (API server가 거부) |

startup probe의 최대 허용 시작 시간은 `failureThreshold × periodSeconds`. `failureThreshold: 30`, `periodSeconds: 10`이면 300초.

## 예시

### 세 probe를 같이 쓰는 Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: probe-demo
spec:
  containers:
    - name: app
      image: registry.k8s.io/e2e-test-images/agnhost:2.40
      args: ["liveness"]
      ports:
        - name: http
          containerPort: 8080
      startupProbe:
        httpGet:
          path: /healthz
          port: http
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
        failureThreshold: 3
      readinessProbe:
        tcpSocket:
          port: 8080
        periodSeconds: 5
```

- 시작 후 최대 300초까지 startup probe가 `/healthz`를 본다. 한 번 성공하면 liveness·readiness가 넘겨받는다
- 이미지와 `args`는 공식 문서 HTTP liveness 예시에서 가져온 것. 이 이미지의 `/healthz`는 처음 10초 동안만 200을 주고 그 뒤로는 500을 준다. 그래서 이 Pod는 liveness 실패로 재시작을 반복하는 게 정상

### exec, grpc

```yaml
livenessProbe:
  exec:
    command: ["cat", "/tmp/healthy"]
  initialDelaySeconds: 5
  periodSeconds: 5
```

```yaml
livenessProbe:
  grpc:
    port: 2379
  initialDelaySeconds: 10
```

### 확인 명령

```bash
kubectl describe pod probe-demo      # Events에 Unhealthy / Killing, Liveness probe failed 메시지
kubectl get pod probe-demo           # READY 0/1, RESTARTS 증가 여부
kubectl get pod probe-demo -o jsonpath='{.status.phase}'
kubectl get pod probe-demo -o jsonpath='{.status.conditions}'
kubectl get pod probe-demo -o jsonpath='{.status.containerStatuses[0].state}'
kubectl explain pod.spec.containers.livenessProbe
```

`RESTARTS`는 실패한 컨테이너가 다시 running 상태로 돌아오는 순간 올라간다.

## probe와 init container

입문 글에서 예로 든 "앱이 뜨기 전에 DB 접속부터 확인하고 싶다"는 요구는 둘 다로 풀 수 있을 것 같아서 헷갈린다. 동작 시점과 실패 시 결과가 다르다.

|                | init container                                                                          | startup probe                       | readiness probe                       |
| -------------- | --------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| 정의 위치      | `spec.initContainers`                                                                   | 앱 컨테이너의 `startupProbe`        | 앱 컨테이너의 `readinessProbe`        |
| 실행 시점      | 앱 컨테이너가 시작되기 전, 순서대로 하나씩                                              | 앱 컨테이너 시작 후, 성공할 때까지  | 앱 컨테이너 lifecycle 내내            |
| 성공 기준      | 끝까지 실행되고 exit 0                                                                  | 핸들러 성공 1회                     | 연속 `successThreshold`회 성공        |
| 실패 시        | Pod `restartPolicy`대로 재시도 (`Always`면 `OnFailure`로 동작). `Never`면 Pod 전체 실패 | 컨테이너 kill, `restartPolicy` 적용 | 트래픽에서 제외, 컨테이너는 계속 실행 |
| 관련 condition | `Initialized`                                                                           | -                                   | `ContainersReady`, `Ready`            |
| probe 지원     | 없음 (`livenessProbe`, `readinessProbe`, `startupProbe` 필드 불가)                      | -                                   | -                                     |

- 의존성이 준비되기 전엔 앱 프로세스 자체를 띄우지 않을 때: init container
- 앱은 떠 있되 의존성이 끊기면 트래픽만 빼고 싶을 때: readiness probe. 공식 문서도 백엔드 의존성이 강한 앱은 liveness로 앱 자체의 건강을, readiness로 백엔드 가용성까지 보라고 권한다
- sidecar container는 `initContainers`에 들어가지만 계속 실행되고, probe도 지원한다

## 시험 포인트

- probe에는 imperative 플래그가 없다. `kubectl run app --image=nginx --dry-run=client -o yaml > pod.yaml`로 뼈대를 만들고 probe를 YAML로 붙인다
- 문서에서 찾을 곳: Tasks > Configure Pods and Containers > Configure Liveness, Readiness and Startup Probes. exec, HTTP, TCP, gRPC, named port, startup probe 예시가 한 페이지에 있다
- 필드 위치는 `spec.containers[].livenessProbe`. `spec` 바로 아래가 아니다
- 필드 이름이 `livenessProbe`, `readinessProbe`, `startupProbe`로 camelCase. 핸들러는 `httpGet`, `tcpSocket`, `exec`, `grpc`
- liveness·startup의 `successThreshold`는 1 외의 값을 넣으면 안 된다
- readiness 실패로는 재시작이 일어나지 않는다. `RESTARTS`가 오르면 liveness나 startup 쪽을 본다
- `restartPolicy: Never`인 Pod에서 liveness가 실패하면 컨테이너는 kill되고 다시 뜨지 않는다
- `STATUS` 열의 `CrashLoopBackOff`는 phase가 아니다. phase를 물으면 `-o jsonpath='{.status.phase}'`로 확인

## 참고 문서

- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
