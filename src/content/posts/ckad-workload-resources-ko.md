---
title: "CKAD 개념 노트: 워크로드 리소스 고르기"
description: "Deployment, StatefulSet, DaemonSet, Job, CronJob이 각각 무엇을 보장하는지, 언제 어느 것을 고르는지 공식 문서 기준으로 비교합니다."
pubDatetime: 2026-09-26T12:04:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  [
    "kubernetes",
    "ckad",
    "deployment",
    "statefulset",
    "daemonset",
    "job",
    "cronjob",
  ]
order: 5
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 고르는 기준

| 질문                                                                                   | 선택        |
| -------------------------------------------------------------------------------------- | ----------- |
| 상태 없는 replica를 원하는 개수만큼, 롤링 업데이트·롤백 필요                           | Deployment  |
| Pod마다 고정 이름·DNS, Pod마다 전용 PersistentVolume, 순서 있는 배포·스케일            | StatefulSet |
| 모든 노드(또는 조건에 맞는 노드)에 Pod 하나씩. 로그 수집, 노드 모니터링, 스토리지 데몬 | DaemonSet   |
| 끝까지 실행되고 성공 횟수를 세야 하는 작업                                             | Job         |
| 백업, 리포트 생성처럼 정해진 일정에 반복하는 작업                                      | CronJob     |

StatefulSet 문서는 고정 identifier나 순서 보장이 필요 없으면 Deployment나 ReplicaSet을 쓰라고 한다. DaemonSet 문서도 replica 수 조절과 롤아웃이 중요하면 Deployment, 어느 노드에 뜨느냐가 중요하면 DaemonSet이라고 구분한다.

## Deployment와 ReplicaSet

Deployment는 Pod와 ReplicaSet에 대한 선언적 업데이트를 제공한다. 원하는 상태를 적으면 Deployment controller가 실제 상태를 그쪽으로 맞춰 간다.

- 구조: Deployment → ReplicaSet → Pod. ReplicaSet 이름과 Pod 라벨의 `pod-template-hash`는 Deployment controller가 붙인다
- Deployment가 소유한 ReplicaSet은 직접 건드리지 않는다
- 롤아웃은 `.spec.template`이 바뀔 때만 일어난다. 이미지나 template 라벨 변경은 롤아웃, `replicas` 변경(스케일)은 롤아웃 아님
- 롤아웃마다 새 ReplicaSet이 생기고 revision이 올라간다. 예전 ReplicaSet은 `.spec.revisionHistoryLimit`(기본 10)만큼 남는다. 0이면 롤백 불가
- `apps/v1`에서 `.spec.selector`는 필수이고, 만든 뒤에는 바꿀 수 없다. `.spec.template.metadata.labels`와 맞아야 API가 받아 준다
- template의 `restartPolicy`는 `Always`만 허용

### 업데이트 전략

| `.spec.strategy.type`  | 동작                                                      |
| ---------------------- | --------------------------------------------------------- |
| `RollingUpdate` (기본) | 새 ReplicaSet을 늘리고 예전 것을 줄이면서 점진적으로 교체 |
| `Recreate`             | 기존 Pod를 전부 종료한 뒤 새 Pod 생성                     |

`RollingUpdate` 세부값:

- `maxUnavailable`: 업데이트 중 사용 불가 Pod 최대치. 기본 25%, 퍼센트는 내림
- `maxSurge`: 원하는 개수 위로 더 만들 수 있는 Pod 최대치. 기본 25%, 퍼센트는 올림
- 둘 다 0일 수는 없다

## StatefulSet

StatefulSet은 Pod마다 고정 identity를 유지한다. 아래 중 하나 이상이 필요할 때 쓴다.

- 고정되고 유일한 네트워크 identifier
- 고정된 영구 저장소
- 순서 있는 배포와 스케일
- 순서 있는 자동 롤링 업데이트

여기서 "고정"은 Pod가 다시 스케줄돼도 유지된다는 뜻.

### identity

- Pod 이름: `$(statefulset name)-$(ordinal)`. replica 3이면 `web-0`, `web-1`, `web-2`
- DNS: headless Service(`clusterIP: None`)가 도메인을 관리한다. Pod별 이름은 `$(podname).$(service name).$(namespace).svc.cluster.local`
- headless Service는 StatefulSet이 만들어 주지 않는다. 직접 만들고 `.spec.serviceName`에 이름을 적는다
- 저장소: `volumeClaimTemplates` 항목마다 Pod별 PersistentVolumeClaim이 하나씩 생긴다. Pod가 다른 노드로 다시 스케줄돼도 같은 PVC를 마운트

### 순서 보장

- 생성은 0부터 N-1까지 순서대로, 삭제는 N-1부터 0까지 역순
- 다음 Pod를 만들기 전에 앞 번호 Pod가 전부 Running and Ready여야 한다
- 이 동작이 `.spec.podManagementPolicy: OrderedReady`(기본). `Parallel`이면 기다리지 않고 동시에 만들고 지운다. 고유 identity 보장은 그대로 유지

### 업데이트와 삭제

- `.spec.updateStrategy.type`: `RollingUpdate`(기본)는 가장 큰 ordinal부터 작은 쪽으로 하나씩 삭제 후 재생성. `OnDelete`는 자동 업데이트를 안 하고, 사용자가 Pod를 지워야 새 template으로 다시 만든다
- `rollingUpdate.partition`을 주면 그 값 이상 ordinal의 Pod만 업데이트
- StatefulSet을 삭제하거나 스케일다운해도 볼륨은 지우지 않는다. `.spec.persistentVolumeClaimRetentionPolicy`의 `whenDeleted`, `whenScaled` 기본값이 `Retain`
- StatefulSet을 삭제할 때 Pod 종료 순서는 보장하지 않는다. 순서대로 내리려면 먼저 replicas를 0으로 스케일

## DaemonSet

DaemonSet은 모든(또는 일부) 노드에서 Pod 사본이 하나씩 돌도록 보장한다.

- 노드가 추가되면 Pod도 추가, 노드가 빠지면 그 Pod는 garbage collection. DaemonSet을 지우면 만든 Pod도 정리
- 일부 노드만: `.spec.template.spec.nodeSelector`나 `affinity`를 지정. 둘 다 없으면 모든 노드
- `node.kubernetes.io/unschedulable:NoSchedule` 같은 toleration이 자동으로 붙어서 unschedulable 표시된 노드에도 뜰 수 있다
- template의 `restartPolicy`는 `Always`이거나 비워 둬야 한다(기본 `Always`)
- `.spec.selector`는 만든 뒤 변경 불가, template 라벨과 맞아야 한다
- `.spec.updateStrategy.type`: `RollingUpdate`(기본) 또는 `OnDelete`
- replica 수 필드가 없다. 개수는 조건에 맞는 노드 수로 정해진다

## Job

Job은 Pod를 하나 이상 만들고, 지정한 개수만큼 성공 종료할 때까지 재시도한다. 성공 횟수가 채워지면 Job 완료.

- template의 `restartPolicy`는 `Never` 또는 `OnFailure`만 허용
- `.spec.template`이 `.spec`의 유일한 필수 필드. `.spec.selector`는 거의 항상 지정하지 않는다

### completions와 parallelism

| 유형           | 설정                                             | 완료 조건                       |
| -------------- | ------------------------------------------------ | ------------------------------- |
| 비병렬         | 둘 다 비움 (둘 다 기본 1)                        | Pod 하나가 성공 종료            |
| 고정 완료 횟수 | `completions`를 양수로. `parallelism`은 비우면 1 | 성공한 Pod가 `completions`개    |
| work queue     | `completions` 비우고 `parallelism`만 지정        | Pod 하나라도 성공하고 전부 종료 |

- `parallelism: 0`이면 사실상 일시정지
- 고정 완료 횟수 Job에서 실제 동시 실행 수는 남은 completions를 넘지 않는다
- `.spec.completionMode`: `NonIndexed`(기본) 또는 `Indexed`. `Indexed`면 Pod마다 0부터 `completions-1`까지 인덱스가 붙고, 컨테이너 안에서는 `JOB_COMPLETION_INDEX` 환경변수로 읽는다. 인덱스마다 성공한 Pod가 하나씩 있어야 완료

### 실패 처리

- `.spec.backoffLimit`: Job을 실패로 보기 전 재시도 횟수. 기본 6 (`backoffLimitPerIndex`를 쓰면 기본값이 달라짐)
- 실패한 Pod는 10s, 20s, 40s ... 최대 6분 간격으로 다시 만든다
- `restartPolicy: OnFailure`면 Pod는 노드에 남고 컨테이너만 재실행. `Never`면 Pod가 실패하고 Job controller가 새 Pod를 만든다
- `OnFailure`는 backoffLimit에 닿으면 Pod가 종료돼 로그 보기가 어려워진다. 문서는 디버깅할 때 `Never`를 권한다
- `.spec.activeDeadlineSeconds`: Job 전체 실행 시간 제한. `backoffLimit`보다 우선. 넘기면 실행 중 Pod를 전부 종료하고 `reason: DeadlineExceeded`로 실패
- `activeDeadlineSeconds`는 Job spec과 Pod spec 양쪽에 있는 필드라서 위치를 헷갈리기 쉽다
- 실패로 끝난 Job은 자동으로 다시 시작되지 않는다

### 정리

- 완료된 Job과 Pod는 기본적으로 남는다. 로그와 상태를 볼 수 있게 하려는 것
- `kubectl delete job <name>`으로 지우면 Pod도 같이 지워진다
- `.spec.ttlSecondsAfterFinished`를 주면 끝난 뒤 그 시간이 지나 자동 삭제

## CronJob

CronJob은 반복 일정에 따라 Job을 만든다. crontab 한 줄에 해당.

- `.spec.schedule`(필수): Cron 형식 `분 시 일 월 요일`. `0 3 * * 1`은 매주 월요일 03시. `*/2` 같은 step, `@monthly` 같은 매크로도 가능
- `.spec.jobTemplate`(필수): Job spec과 같은 스키마, `apiVersion`·`kind`만 없음
- `.spec.timeZone`: 지정하지 않으면 kube-controller-manager의 로컬 시간대 기준. `schedule` 안에 `CRON_TZ`나 `TZ`를 쓰면 validation 에러
- 이름은 52자 이하. controller가 Job 이름에 11자를 덧붙이고 Job 이름 제한이 63자라서

### 동시 실행과 지연

| `.spec.concurrencyPolicy` | 이전 Job이 아직 실행 중일 때    |
| ------------------------- | ------------------------------- |
| `Allow` (기본)            | 동시에 실행                     |
| `Forbid`                  | 이번 실행을 건너뜀              |
| `Replace`                 | 실행 중인 Job을 새 Job으로 교체 |

- 같은 CronJob이 만든 Job끼리만 적용. 서로 다른 CronJob의 Job은 항상 동시 실행 가능
- `.spec.startingDeadlineSeconds`: 예정 시각을 놓쳤을 때 늦게라도 시작할 수 있는 한도(초). 넘기면 그 회차는 건너뛰고 실패로 취급. 10초 미만이면 controller가 10초마다 확인하기 때문에 아예 스케줄되지 않을 수 있다
- 놓친 스케줄이 100회를 넘으면 Job을 시작하지 않고 에러를 남긴다
- `.spec.suspend: true`: 이후 실행을 멈춤. 이미 시작한 Job에는 영향 없음
- `.spec.successfulJobsHistoryLimit` 기본 3, `.spec.failedJobsHistoryLimit` 기본 1
- CronJob을 수정해도 이미 시작한 Job은 그대로. 변경은 이후 새 Job부터
- 한 회차에 Job이 둘 생기거나 하나도 안 생길 수 있어서 Job은 idempotent하게 만들어야 한다

## 예시

### imperative로 뼈대 만들기

```bash
kubectl create deployment web --image=nginx --replicas=3
kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle 'print bpi(2000)'
kubectl create cronjob hello --image=busybox:1.28 --schedule="*/1 * * * *" -- date
kubectl create job hello-manual --from=cronjob/hello

# YAML로 뽑아서 수정
kubectl create job pi --image=perl:5.34.0 --dry-run=client -o yaml > job.yaml
```

`kubectl create`에는 `statefulset`, `daemonset` 서브커맨드가 없다. YAML을 직접 쓰거나, Deployment YAML을 뽑아서 고친다. DaemonSet으로 바꿀 때는 `kind`를 바꾸고 `replicas`와 `strategy`를 지운다(DaemonSet의 필드 이름은 `updateStrategy`).

### Deployment 롤아웃

```bash
kubectl set image deployment/web nginx=nginx:1.16.1
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=2
kubectl rollout pause deployment/web
kubectl rollout resume deployment/web
kubectl scale deployment/web --replicas=5
kubectl annotate deployment/web kubernetes.io/change-cause="image updated to 1.16.1"
```

`CHANGE-CAUSE`는 `kubernetes.io/change-cause` annotation에서 온다. `--record` 플래그는 deprecated.

### Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: batch-demo
spec:
  completions: 5
  parallelism: 2
  backoffLimit: 4
  activeDeadlineSeconds: 120
  ttlSecondsAfterFinished: 100
  template:
    spec:
      containers:
        - name: worker
          image: busybox:1.28
          command: ["sh", "-c", "echo done"]
      restartPolicy: Never
```

### CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "*/5 * * * *"
  timeZone: "Etc/UTC"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 200
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: hello
              image: busybox:1.28
              command: ["/bin/sh", "-c", "date; echo Hello"]
          restartPolicy: OnFailure
```

### StatefulSet과 headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  clusterIP: None
  selector:
    app: nginx
  ports:
    - port: 80
      name: web
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: nginx
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: registry.k8s.io/nginx-slim:0.24
          ports:
            - containerPort: 80
              name: web
          volumeMounts:
            - name: www
              mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
    - metadata:
        name: www
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

`storageClassName`을 비우면 default StorageClass가 쓰인다.

### DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
spec:
  selector:
    matchLabels:
      app: node-agent
  template:
    metadata:
      labels:
        app: node-agent
    spec:
      nodeSelector:
        kubernetes.io/os: linux
      containers:
        - name: agent
          image: busybox:1.28
          command: ["sh", "-c", "sleep 3600"]
```

## 헷갈리는 것 비교

|                      | Deployment                             | StatefulSet                                  | DaemonSet                                    | Job                                         | CronJob                |
| -------------------- | -------------------------------------- | -------------------------------------------- | -------------------------------------------- | ------------------------------------------- | ---------------------- |
| apiVersion           | `apps/v1`                              | `apps/v1`                                    | `apps/v1`                                    | `batch/v1`                                  | `batch/v1`             |
| 개수 결정            | `replicas`                             | `replicas`                                   | 조건 맞는 노드 수                            | `completions`, `parallelism`                | 일정마다 Job 1개       |
| Pod 이름             | `이름-hash-랜덤`                       | `이름-ordinal` 고정                          | 랜덤                                         | 랜덤 (`Indexed`면 hostname이 `이름-인덱스`) | CronJob 이름 기반      |
| 저장소               | 공유 또는 없음                         | Pod별 PVC                                    | 보통 노드 로컬                               | -                                           | -                      |
| 업데이트 전략 필드   | `strategy`: `RollingUpdate`/`Recreate` | `updateStrategy`: `RollingUpdate`/`OnDelete` | `updateStrategy`: `RollingUpdate`/`OnDelete` | -                                           | 수정은 새 Job부터 적용 |
| 허용 `restartPolicy` | `Always`                               | -                                            | `Always`                                     | `OnFailure`, `Never`                        | `OnFailure`, `Never`   |
| imperative 생성      | 가능                                   | 불가                                         | 불가                                         | 가능                                        | 가능                   |

- Deployment는 `strategy`, StatefulSet·DaemonSet은 `updateStrategy`. 필드 이름부터 다르다
- `Recreate`는 업그레이드할 때 기존 Pod 종료를 먼저 보장할 뿐이다. Pod를 수동으로 지우면 ReplicaSet이 곧바로 대체 Pod를 만든다. "최대 하나" 보장이 필요하면 StatefulSet을 보라는 게 문서 설명
- Job의 `restartPolicy`는 Pod에 적용되는 것. Job 자체가 실패하면 다시 돌지 않는다

## 시험 포인트

- 먼저 imperative로 되는 것(Deployment, Job, CronJob)은 `kubectl create ... --dry-run=client -o yaml`로 뼈대를 만들고 필요한 필드만 추가
- StatefulSet, DaemonSet은 문서 예시를 복사하는 게 빠르다. Concepts > Workloads > Workload Management 아래 각 페이지 첫 예시
- CronJob에서 `jobTemplate.spec.template.spec`까지 들여쓰기가 세 단계라 `restartPolicy` 위치를 자주 틀린다
- Job template에 `restartPolicy`를 빠뜨리거나 `Always`를 넣으면 거부된다
- `completions`와 `parallelism`을 뒤바꾸지 않는다. 총 성공 횟수가 `completions`, 동시 실행 수가 `parallelism`
- `activeDeadlineSeconds`는 Job `spec` 바로 아래에 둔다. Pod template spec에도 같은 필드가 있다
- `kubectl rollout undo`는 이전 revision으로. 특정 revision은 `--to-revision`
- CronJob 수동 실행 확인은 `kubectl create job <name> --from=cronjob/<cronjob>`
- selector는 Deployment·DaemonSet 모두 만든 뒤 못 바꾼다. 틀렸으면 지우고 다시 만든다

## 참고 문서

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- [Perform a Rolling Update on a DaemonSet](https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/)
- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Pod Lifecycle: Container restarts](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
- [kubectl create deployment](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_deployment/)
- [kubectl create job](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_job/)
- [kubectl create cronjob](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_cronjob/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
