---
title: "CKAD 개념 노트: 컨테이너 이미지와 Pod"
description: "이미지 이름·tag·digest, imagePullPolicy 기본값 규칙, private registry와 imagePullSecrets, 이미지 build·push, 그리고 Pod spec 기본을 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:01:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "container-image", "pod"]
order: 2
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 요약

- 커리큘럼 위치: Application Design and Build -- Define, build and modify container images
- 이미지 참조 = `[registry[:port]/]name[:tag][@digest]`. registry 생략 시 Docker Hub, tag 생략 시 `latest`
- `imagePullPolicy`는 생략하면 Pod 생성 시점의 tag 기준으로 한 번 정해지고, 이후 image를 바꿔도 다시 계산되지 않음
- private registry는 같은 namespace의 `docker-registry` 타입 Secret을 `spec.imagePullSecrets`에 지정
- Pod는 배포 가능한 가장 작은 단위. 안의 container들은 network namespace(IP·포트)와 volume을 공유
- 실행 중인 Pod에서 바꿀 수 있는 필드는 image 등 몇 개뿐이라, 나머지는 지우고 다시 만들어야 함

## 이미지 이름

형식은 `[REGISTRY_HOST[:PORT]/]NAME[:TAG][@DIGEST]`.

| 표기                                       | 실제 의미                                  |
| ------------------------------------------ | ------------------------------------------ |
| `busybox`                                  | `docker.io/library/busybox:latest`         |
| `busybox:1.32.0`                           | `docker.io/library/busybox:1.32.0`         |
| `registry.k8s.io/pause:3.5`                | 지정한 registry, tag `3.5`                 |
| `registry.k8s.io/pause@sha256:1ff6...`     | digest로 고정                              |
| `registry.k8s.io/pause:3.5@sha256:1ff6...` | tag와 digest 둘 다. pull에는 digest만 사용 |

- 기본 registry(Docker Hub)는 container runtime 설정에서 바꿀 수 있음
- tag 규칙: 영문 대소문자·숫자·`_`·`.`·`-`, 최대 128자, 정규식 `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`
- tag는 다른 이미지를 가리키도록 옮길 수 있지만 digest(`sha256:<hash>`)는 이미지 내용의 hash라서 바뀌지 않음

### tag 대신 digest를 쓰는 이유

같은 tag가 registry에서 다른 이미지로 바뀌면, 먼저 뜬 Pod와 나중에 뜬 Pod가 서로 다른 코드를 돌릴 수 있습니다. digest로 지정하면 항상 같은 이미지. 공식 문서도 운영 환경에서는 `:latest`를 피하고 `v1.42.0` 같은 의미 있는 tag나 digest를 쓰라고 권합니다. `:latest`는 지금 어떤 버전이 떠 있는지 추적하기 어렵고 롤백도 번거롭습니다.

## imagePullPolicy

kubelet이 언제 이미지를 pull할지 정하는 container 단위 필드.

| 값             | 동작                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `IfNotPresent` | 노드에 이미지가 없을 때만 pull                                                                                  |
| `Always`       | container를 띄울 때마다 runtime에 pull 요청. registry에서 digest를 확인하고, 이미 캐시된 layer는 다시 받지 않음 |
| `Never`        | pull하지 않음. 노드에 이미지가 있으면 실행, 없으면 시작 실패                                                    |

`Always`라도 layer 캐시가 있어서, registry에 안정적으로 접근할 수 있다면 생각만큼 비싸지 않습니다.

### 생략했을 때 기본값

API server에 Pod가 제출될 때 이렇게 채워집니다.

| image 표기               | 기본 `imagePullPolicy` |
| ------------------------ | ---------------------- |
| digest 지정              | `IfNotPresent`         |
| tag가 `:latest`          | `Always`               |
| tag 생략 (결국 `latest`) | `Always`               |
| `:latest`가 아닌 tag     | `IfNotPresent`         |

이 값은 오브젝트가 처음 **생성될 때** 한 번만 정해집니다. 예를 들어 `nginx:1.27`로 만든 Deployment의 image를 나중에 `nginx:latest`로 바꿔도 `imagePullPolicy`는 `IfNotPresent` 그대로. 필요하면 직접 바꿔야 함.

항상 pull하게 만드는 방법:

- `imagePullPolicy: Always` 명시
- policy 생략 + `:latest` 또는 tag 생략
- 클러스터에 `AlwaysPullImages` admission controller 활성화 (관리자 영역)

### ImagePullBackOff

pull 실패로 container가 Waiting 상태에 머무는 것. 원인은 보통 잘못된 image 이름, 또는 private registry인데 `imagePullSecrets`가 없는 경우. kubelet은 재시도 간격을 늘려 가며 계속 pull하고, 간격 상한은 300초(5분).

## private registry

인증 방법은 여러 가지인데 (노드 설정, kubelet credential provider, pre-pulled image), 공식 문서가 권장하는 건 Pod에 `imagePullSecrets`를 지정하는 방식. 개발자가 namespace 안에서 끝낼 수 있어서 CKAD 범위와도 맞습니다.

- Secret 타입: `kubernetes.io/dockerconfigjson` (또는 옛 형식 `kubernetes.io/dockercfg`)
- Secret은 Pod와 **같은 namespace**에 있어야 함. namespace마다 따로 만들어야 함
- `imagePullSecrets`의 항목 하나는 Secret 하나를 가리킴
- `kubectl create secret docker-registry`로 만든 Secret은 registry 하나에만 유효. 여러 registry를 쓰면 기존 `~/.docker/config.json`을 `--from-file`로 가져오는 편이 나음
- ServiceAccount에 `imagePullSecrets`를 넣어 두면 그 ServiceAccount를 쓰는 Pod에 자동으로 붙음

## 이미지 build와 수정

Kubernetes 문서는 이미지를 쓰는 쪽만 다루고, build 자체는 Docker/Podman 문서 영역입니다.

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

```bash
# build: -t로 이름 지정, 마지막 인자는 build context
docker build -t registry.example.com/team/web:v2 .
podman build -t registry.example.com/team/web:v2 .

# 다른 Dockerfile 사용
docker build -t web:v2 -f Dockerfile.prod .

# 기존 이미지에 새 이름 붙이기, registry로 push
docker tag web:v2 registry.example.com/team/web:v2
docker push registry.example.com/team/web:v2

# tar 파일로 내보내기
docker save -o web-v2.tar web:v2
podman save -o web-v2.tar web:v2
```

- `docker build`는 `docker buildx build`의 alias. `-f`를 안 주면 context 루트의 `Dockerfile` 사용
- `podman build`는 `Containerfile`과 `Dockerfile`을 같게 취급
- podman에서 registry 없이 `-t web:v2`로 build하면 이름 앞에 `localhost/`가 붙음. Pod spec에 이 이미지를 쓸 때 헷갈리는 지점

"이미지 수정"은 결국 Dockerfile을 고쳐서 새 tag로 다시 build하는 것. 실행 중인 container를 고치는 게 아닙니다.

## Pod

Pod는 Kubernetes에서 만들고 관리할 수 있는 가장 작은 배포 단위. container 하나 이상과 공유 storage·network, 그리고 실행 방법에 대한 spec을 묶은 것입니다.

- 같은 Pod의 container는 항상 같은 노드에 함께 스케줄링됨
- network namespace 공유: Pod IP 하나(address family별), 포트 공간 공유, 서로 `localhost`로 통신
- `volumes`에 정의한 volume을 여러 container가 mount해서 파일 공유
- container 안의 hostname은 Pod 이름
- 가장 흔한 형태는 container 하나짜리 Pod. 여러 container는 강하게 결합된 경우에만 (다음 편 주제)
- Pod는 일회용으로 설계됨. 보통은 Deployment, Job, StatefulSet 같은 workload resource가 pod template으로 Pod를 만들고 관리
- replica가 필요하면 Pod 안에 container를 늘리는 게 아니라 Pod 수를 늘림
- container 재시작과 Pod 재시작은 다름. Pod는 프로세스가 아니라 container를 실행하는 환경이고, 지워질 때까지 유지됨

### 최소 Pod spec

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: web
      image: nginx:1.27
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 80
  imagePullSecrets:
    - name: regcred
  restartPolicy: Always
```

- 필수: `apiVersion: v1`, `kind: Pod`, `metadata.name`, `spec.containers[].name`·`image`
- Pod 이름은 DNS subdomain 규칙을 따라야 하고, hostname 호환성을 생각하면 더 엄격한 DNS label 규칙이 안전
- `restartPolicy`: `Always`(기본) / `OnFailure` / `Never`. Pod 단위 필드
- `.spec.os.name`에 `linux`/`windows`를 지정할 수 있고, 노드 OS와 다르면 kubelet이 실행을 거부

### 실행 중인 Pod에서 바꿀 수 있는 것

`patch`/`replace`로 바꿀 수 있는 spec 필드는 이것뿐:

- `spec.containers[*].image`
- `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds` (미설정 → 양수, 또는 더 작은 값으로만)
- `spec.terminationGracePeriodSeconds`
- `spec.tolerations` (항목 추가만)
- `spec.schedulingGates`

`namespace`, `name`, `uid` 같은 metadata도 바꿀 수 없음. env, ports, command 등을 바꾸려면 Pod를 지우고 다시 생성. workload resource의 pod template을 바꾸면 controller가 기존 Pod를 수정하지 않고 새 Pod로 교체합니다.

## 헷갈리는 것 비교

### tag와 digest

|                           | tag                                         | digest                   |
| ------------------------- | ------------------------------------------- | ------------------------ |
| 형태                      | `:v1.2.3`                                   | `@sha256:<hash>`         |
| 가리키는 대상             | 옮길 수 있음                                | 이미지 내용의 hash, 고정 |
| 둘 다 쓰면                | 무시됨                                      | pull에 사용              |
| 생략 시 `imagePullPolicy` | `:latest`면 `Always`, 아니면 `IfNotPresent` | `IfNotPresent`           |

### imagePullSecrets를 어디에 두나

| 위치                                           | 적용 범위                         |
| ---------------------------------------------- | --------------------------------- |
| Pod `spec.imagePullSecrets`                    | 그 Pod만                          |
| ServiceAccount `imagePullSecrets`              | 그 ServiceAccount를 쓰는 Pod 전부 |
| 노드 설정 (`config.json`, credential provider) | 노드의 모든 Pod. 관리자 작업      |

### Pod를 직접 고칠 때와 pod template을 고칠 때

|                        | 실행 중인 Pod    | workload resource의 pod template              |
| ---------------------- | ---------------- | --------------------------------------------- |
| 바꿀 수 있는 필드      | image 등 일부만  | 거의 전부                                     |
| 기존 Pod에 미치는 영향 | 그 자리에서 반영 | 기존 Pod는 그대로, controller가 새 Pod로 교체 |
| 나머지 필드를 바꾸려면 | 지우고 다시 생성 | template 수정만으로 끝                        |

## 시험 포인트

### 명령어

```bash
# Pod YAML 뼈대 만들기
kubectl run web --image=nginx:1.27 --port=80 \
  --image-pull-policy=IfNotPresent --dry-run=client -o yaml > pod.yaml

# 한 번 실행하고 끝나는 Pod
kubectl run tmp --image=busybox:1.36 --restart=Never -- sh -c 'echo hi'

# private registry Secret
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=<user> --docker-password=<password> \
  --docker-email=<email>

# ServiceAccount에 imagePullSecrets 추가
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "regcred"}]}'

# image 교체 (Pod·Deployment 모두 가능, 형식은 container이름=이미지)
kubectl set image pod/web web=nginx:1.28
kubectl set image deployment/web web=nginx:1.28

# 실제 적용된 imagePullPolicy 확인
kubectl get pod web -o jsonpath='{.spec.containers[0].imagePullPolicy}'
```

### 문서에서 찾을 위치

- `imagePullPolicy` 기본값 표: Concepts > Containers > Images, "Default image pull policy"
- Secret 생성 명령어와 Pod YAML: 같은 페이지 "Creating a Secret with a Docker config"
- 변경 가능한 Pod 필드 목록: Concepts > Workloads > Pods, "Pod update and replacement"

### 자주 하는 실수

- `kubectl set image`에서 container 이름 대신 Pod 이름을 씀. `=` 왼쪽은 container 이름
- Secret을 다른 namespace에 만듦. Pod와 같은 namespace여야 함
- image tag만 `latest`로 바꾸고 `Always`로 바뀌었을 거라 생각함. 생성 시점 값이 유지됨
- `imagePullPolicy: Never`인데 노드에 이미지가 없음. 로컬에서 build한 이미지는 노드의 runtime에 있어야 함
- podman으로 build한 이미지를 tag 그대로 쓰는데, 실제 이름은 `localhost/web:v2`
- 실행 중인 Pod의 env나 command를 `kubectl edit`로 바꾸려다 거부됨. `kubectl replace --force -f pod.yaml`로 지우고 다시 만듦

## 참고 문서

- [Images | Kubernetes](https://kubernetes.io/docs/concepts/containers/images/)
- [Pods | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/)
- [Pod Lifecycle: Restart policy | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
- [Pull an Image from a Private Registry | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
- [Add ImagePullSecrets to a service account | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)
- [kubectl run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_run/), [kubectl set image](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_image/), [kubectl create secret docker-registry](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_secret_docker-registry/)
- [docker buildx build | Docker Docs](https://docs.docker.com/reference/cli/docker/buildx/build/), [docker image push](https://docs.docker.com/reference/cli/docker/image/push/), [docker image save](https://docs.docker.com/reference/cli/docker/image/save/)
- [podman-build | Podman](https://docs.podman.io/en/latest/markdown/podman-build.1.html)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
