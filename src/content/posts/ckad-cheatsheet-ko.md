---
title: "CKAD 치트 시트"
description: "CKAD v1.35 커리큘럼 도메인별 kubectl 명령어, 최소 YAML, 시험 중 열어 볼 kubernetes.io 문서 위치 정리."
pubDatetime: 2026-09-26T12:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "cheatsheet"]
order: 1
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 요약

CKAD v1.35 커리큘럼 5개 도메인 순서의 명령어·YAML 모음. 원칙은 imperative 명령어로 뼈대 생성, 명령어로 안 되는 필드만 YAML 수정, 모르는 필드는 `kubectl explain` 또는 공식 문서 예제 복사.

| 도메인                                              | 비중 |
| --------------------------------------------------- | ---- |
| Application Design and Build                        | 20%  |
| Application Deployment                              | 20%  |
| Application Observability and Maintenance           | 15%  |
| Application Environment, Configuration and Security | 25%  |
| Services and Networking                             | 20%  |

시험 중 열람 가능 사이트: `kubernetes.io/docs`, `kubernetes.io/blog`, `helm.sh/docs` (Linux Foundation 허용 리소스 기준).

## 시험 환경 세팅

### alias, completion

```bash
alias k=kubectl
source <(kubectl completion bash)
complete -o default -F __start_kubectl k

export do="--dry-run=client -o yaml"
export now="--force --grace-period=0"
```

- `k run web --image=nginx $do > pod.yaml` -- 파일로 뽑고 수정 후 `k apply -f`
- `k delete pod web $now` -- 즉시 삭제 (graceful termination 생략)
- 수정 불가 필드 변경: `k replace --force -f pod.yaml`

### kubectl explain

```bash
k explain pod.spec.containers.livenessProbe
k explain deploy.spec.strategy.rollingUpdate
k explain pod.spec --recursive | less        # 필드 트리 전체
k explain networkpolicy.spec.ingress --recursive
k api-resources | grep -i ingress            # 이름·shortname·apiVersion 확인
```

### context, namespace

```bash
k config get-contexts
k config current-context
k config use-context <context>                       # 문제마다 첫 줄에 주어진 명령 그대로 실행
k config set-context --current --namespace=<ns>      # 기본 namespace 고정
k config view --minify | grep namespace
```

- 문제별 context 전환 누락이 가장 흔한 감점 원인
- `-n <ns>` 명시가 set-context보다 안전한 경우 많음

### vim

```vim
" ~/.vimrc
set expandtab
set tabstop=2
set shiftwidth=2
```

| 동작                               | 키                    |
| ---------------------------------- | --------------------- |
| 붙여넣기 모드 (자동 들여쓰기 방지) | `:set paste`          |
| 여러 줄 들여쓰기                   | `V` 선택 후 `>` / `<` |
| 줄 번호                            | `:set nu`             |

## Application Design and Build

커리큘럼: container image 정의·빌드·수정, workload 리소스 선택, multi-container Pod 패턴 (sidecar, init 등), persistent·ephemeral volume.

### container image

```bash
docker build -t myapp:v1 .          # 또는 podman build
docker tag myapp:v1 registry.example.com/myapp:v1
docker push registry.example.com/myapp:v1
docker save myapp:v1 -o myapp.tar   # 이미지 파일로 저장
```

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

- 환경에 docker와 podman 중 무엇이 있는지 먼저 확인 (`which docker podman`)
- 이미지 참조 규칙: kubernetes.io `concepts/containers/images`

### workload 선택

| 리소스      | 용도                     | 생성                                                        |
| ----------- | ------------------------ | ----------------------------------------------------------- |
| Pod         | 단발성, 테스트           | `k run`                                                     |
| Deployment  | stateless, 롤링 업데이트 | `k create deploy`                                           |
| StatefulSet | 고정 이름·스토리지       | YAML                                                        |
| DaemonSet   | 노드마다 1개             | Deployment YAML에서 `kind` 변경, `replicas`·`strategy` 삭제 |
| Job         | 완료까지 실행            | `k create job`                                              |
| CronJob     | 스케줄 실행              | `k create cronjob`                                          |

```bash
k run web --image=nginx --port=80 --labels=app=web,tier=fe
k run tmp --image=busybox --restart=Never --rm -it -- sh
k run box --image=busybox $do --command -- sh -c 'sleep 3600' > pod.yaml

k create deploy web --image=nginx --replicas=3 --port=80
k create job hello --image=busybox -- echo "Hello World"
k create cronjob hello --image=busybox --schedule="*/1 * * * *" -- echo "Hello World"
k create job manual-run --from=cronjob/hello     # CronJob 즉시 1회 실행
```

- `--command --` 없으면 뒤 인자가 `args`, 있으면 `command`

Job·CronJob 추가 필드 (명령어 옵션 없음):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      completions: 3
      parallelism: 2
      backoffLimit: 4
      activeDeadlineSeconds: 60
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: hello
              image: busybox
              command: ["sh", "-c", "date"]
```

- Job Pod의 `restartPolicy`는 `Never` 또는 `OnFailure`만 허용
- 문서: `concepts/workloads/controllers/job`, `.../cron-jobs`

### multi-container Pod

| 패턴                 | 정의 위치                                  | 동작                                            |
| -------------------- | ------------------------------------------ | ----------------------------------------------- |
| init container       | `initContainers`                           | 순서대로 실행, 모두 성공해야 app container 시작 |
| sidecar (native)     | `initContainers` + `restartPolicy: Always` | Pod 수명 동안 계속 실행, v1.33부터 stable       |
| 일반 multi-container | `containers`에 여러 개                     | 동시에 시작, 순서 보장 없음                     |

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  initContainers:
    - name: wait-db
      image: busybox
      command: ["sh", "-c", "until nslookup db; do sleep 2; done"]
    - name: logshipper
      image: alpine
      restartPolicy: Always # sidecar
      command: ["sh", "-c", "tail -F /opt/logs.txt"]
      volumeMounts:
        - name: data
          mountPath: /opt
  containers:
    - name: app
      image: alpine
      command:
        [
          "sh",
          "-c",
          "while true; do echo logging >> /opt/logs.txt; sleep 1; done",
        ]
      volumeMounts:
        - name: data
          mountPath: /opt
  volumes:
    - name: data
      emptyDir: {}
```

- 컨테이너 간 파일 공유는 같은 `emptyDir` 마운트
- 특정 컨테이너 로그·exec: `k logs app -c logshipper`, `k exec -it app -c app -- sh`
- 문서: `concepts/workloads/pods/init-containers`, `.../sidecar-containers`

### volume

| 종류                            | 수명        | 비고                     |
| ------------------------------- | ----------- | ------------------------ |
| `emptyDir`                      | Pod         | `medium: Memory`로 tmpfs |
| `hostPath`                      | 노드        | 테스트용                 |
| `configMap` / `secret`          | 원본 리소스 | 파일로 마운트            |
| `persistentVolumeClaim`         | PVC         | PV와 바인딩              |
| generic ephemeral (`ephemeral`) | Pod         | Pod별 PVC 자동 생성·삭제 |

PV, PVC, 마운트 (명령어 생성 불가):

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  resources:
    requests:
      storage: 500Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: pvc-data
```

- PVC `Pending`: `storageClassName`·`accessModes`·용량 불일치 확인 (`k describe pvc`)
- 문서: `tasks/configure-pod-container/configure-persistent-volume-storage` (PV·PVC·Pod 예제 한 번에), `concepts/storage/volumes`, `concepts/storage/ephemeral-volumes`

## Application Deployment

커리큘럼: 배포 전략 (blue/green, canary), Deployment rolling update, Helm으로 기존 패키지 배포, Kustomize.

### rolling update, rollout

```bash
k set image deploy/web nginx=nginx:1.27          # 컨테이너명=이미지
k annotate deploy/web kubernetes.io/change-cause="nginx 1.27"
k rollout status deploy/web
k rollout history deploy/web
k rollout history deploy/web --revision=2
k rollout undo deploy/web
k rollout undo deploy/web --to-revision=1
k rollout pause deploy/web      # 여러 변경 묶기
k rollout resume deploy/web
k rollout restart deploy/web    # 설정 변경 없이 Pod 재생성
k scale deploy/web --replicas=5
```

```yaml
spec:
  strategy:
    type: RollingUpdate # 또는 Recreate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
```

- `Recreate`로 바꿀 때 `rollingUpdate` 블록 삭제 필수
- 문서: `concepts/workloads/controllers/deployment`

### blue/green, canary

전용 리소스 없음. Deployment 2개 + Service selector 조합.

| 전략       | 방법                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| blue/green | `web-blue`, `web-green` Deployment 공존, Service selector를 `version=green`으로 전환                  |
| canary     | 두 Deployment가 공통 label (`app=web`) 공유, Service는 공통 label만 선택, replicas 비율로 트래픽 분배 |

```bash
# blue/green 전환
k set selector svc web 'app=web,version=green'
# 또는
k patch svc web -p '{"spec":{"selector":{"app":"web","version":"green"}}}'

# canary: stable 9, canary 1 -> 약 10%
k scale deploy/web-stable --replicas=9
k scale deploy/web-canary --replicas=1
```

- 확인: `k get endpointslices -l kubernetes.io/service-name=web`, `k get pod -l app=web --show-labels`
- 문서: `concepts/workloads/management` (canary deployments 절)

### Helm

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo nginx
helm show values bitnami/nginx > values.yaml

helm install web bitnami/nginx -n web --create-namespace --set replicaCount=2
helm install web bitnami/nginx -f values.yaml
helm upgrade web bitnami/nginx --set replicaCount=3
helm list -A
helm history web -n web
helm rollback web 1 -n web
helm get values web -n web
helm template web bitnami/nginx     # 렌더링만, 설치 없음
helm uninstall web -n web
```

- release는 namespace 단위, `-n` 누락 시 `helm list`에 안 보임
- 문서: `helm.sh/docs` (Using Helm, `helm install` 명령어 페이지)

### Kustomize

```bash
k kustomize ./overlay        # 렌더링 결과 출력
k apply -k ./overlay
k delete -k ./overlay
```

```yaml
# kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
namespace: prod
namePrefix: prod-
labels:
  - pairs:
      env: prod
images:
  - name: nginx
    newTag: "1.27"
configMapGenerator:
  - name: app-config
    literals:
      - LOG_LEVEL=info
patches:
  - target:
      kind: Deployment
      name: web
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
```

- `commonLabels`는 deprecated, `labels` 사용
- `configMapGenerator` 결과 이름에 hash suffix 추가
- 문서: `tasks/manage-kubernetes-objects/kustomization`

## Application Observability and Maintenance

커리큘럼: API deprecation, probe·health check, 내장 CLI로 모니터링, container log, 디버깅.

### API deprecation

```bash
k api-versions
k api-resources -o wide
k explain cronjob | head -5       # GROUP / VERSION 확인
k convert -f old.yaml --output-version apps/v1   # kubectl-convert plugin 설치 필요
```

- apply 시 deprecated API 경고 메시지 확인
- 문서: `reference/using-api/deprecation-guide`, `reference/using-api/deprecation-policy`, kubectl-convert 설치는 `tasks/tools/install-kubectl-linux`

### probe

| probe     | 실패 시                                             |
| --------- | --------------------------------------------------- |
| liveness  | 컨테이너 재시작                                     |
| readiness | Service endpoint에서 제외 (재시작 없음)             |
| startup   | 성공 전까지 liveness·readiness 중단, 실패 시 재시작 |

| handler | 필드                     |
| ------- | ------------------------ |
| HTTP    | `httpGet: {path, port}`  |
| TCP     | `tcpSocket: {port}`      |
| command | `exec: {command: [...]}` |
| gRPC    | `grpc: {port}`           |

```yaml
spec:
  containers:
    - name: web
      image: nginx
      ports:
        - containerPort: 80
      startupProbe:
        httpGet:
          path: /
          port: 80
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /healthz
          port: 80
        initialDelaySeconds: 5
        periodSeconds: 10
      readinessProbe:
        exec:
          command: ["cat", "/tmp/ready"]
        periodSeconds: 5
```

- probe는 container 단위 필드 (`spec.containers[].livenessProbe`)
- 문서: `tasks/configure-pod-container/configure-liveness-readiness-startup-probes`

### 모니터링 CLI

```bash
k get pod -o wide
k get pod -w
k get pod --show-labels -l app=web
k get pod --sort-by=.status.containerStatuses[0].restartCount
k get events --sort-by=.metadata.creationTimestamp
k events --for pod/web
k top pod --sort-by=cpu          # metrics-server 필요
k top node
k describe pod web
```

- 문서: `reference/kubectl/quick-reference`, `tasks/debug/debug-cluster/resource-metrics-pipeline`

### container log

```bash
k logs web
k logs web -c sidecar            # multi-container
k logs web --all-containers
k logs web --previous            # 재시작 전 컨테이너
k logs web -f --tail=50
k logs deploy/web
k logs -l app=web --prefix
```

### 디버깅

| 상태                         | 확인                                              |
| ---------------------------- | ------------------------------------------------- |
| `Pending`                    | `describe` Events: 리소스 부족, nodeSelector, PVC |
| `ImagePullBackOff`           | 이미지 이름·태그, `imagePullSecrets`              |
| `CrashLoopBackOff`           | `logs --previous`, command·args, liveness probe   |
| `Running`인데 접속 불가      | readiness, Service selector, `targetPort`         |
| `CreateContainerConfigError` | 참조한 ConfigMap·Secret·key 누락                  |

```bash
k exec -it web -- sh
k debug web -it --image=busybox --target=web                   # ephemeral container
k debug web --copy-to=web-debug --share-processes
k debug web --copy-to=web-debug --set-image=web=busybox
k debug node/<node> -it --image=busybox
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web:80
```

- 문서: `tasks/debug/debug-application/debug-pods`, `.../debug-running-pod`, `.../debug-service`

## Application Environment, Configuration and Security

커리큘럼: CRD·Operator, authentication·authorization·admission control, requests·limits·quota, ConfigMap, Secret, ServiceAccount, SecurityContext·capabilities.

### CRD, Operator

```bash
k get crd
k api-resources --api-group=<group>
k explain <kind>.spec              # CRD schema 기반 필드 확인
k get <plural> -A
k describe crd <name>
```

- CR은 일반 리소스처럼 `apply`·`get`·`delete`
- 문서: `concepts/extend-kubernetes/api-extension/custom-resources`, `concepts/extend-kubernetes/operator`, `tasks/extend-kubernetes/custom-resources/custom-resource-definitions`

### authentication, authorization, admission control

```bash
k create role pod-reader --verb=get,list,watch --resource=pods
k create rolebinding pod-reader-rb --role=pod-reader --serviceaccount=default:app-sa
k create clusterrole node-reader --verb=get,list --resource=nodes
k create clusterrolebinding node-reader-rb --clusterrole=node-reader --user=jane

k auth can-i list pods
k auth can-i list pods --as=system:serviceaccount:default:app-sa -n default
k auth whoami
```

| 단계              | 역할                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| authentication    | 누구인지 (인증서, token, ServiceAccount)                              |
| authorization     | 할 수 있는지 (RBAC Role·ClusterRole)                                  |
| admission control | 요청 변형·검증 (LimitRange, ResourceQuota, Pod Security Admission 등) |

- `--serviceaccount` 형식은 `<namespace>:<name>`
- admission plugin 확인: control plane 노드의 `/etc/kubernetes/manifests/kube-apiserver.yaml` 안 `--enable-admission-plugins` (kubeadm 클러스터 기준)
- 문서: `reference/access-authn-authz/rbac`, `.../admission-controllers`, `concepts/security/controlling-access`

### requests, limits, quota

```bash
k set resources deploy/web --requests=cpu=100m,memory=128Mi --limits=cpu=200m,memory=256Mi
k create quota ns-quota --hard=pods=10,requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi
k describe quota -n <ns>
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 200m
          memory: 256Mi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 1Gi
```

- ResourceQuota에 cpu·memory가 걸린 namespace는 requests·limits 없는 Pod 생성 거부 (LimitRange 기본값으로 보완 가능)
- memory limit 초과 시 OOMKilled, cpu limit 초과 시 throttling
- 문서: `concepts/configuration/manage-resources-containers`, `concepts/policy/resource-quotas`, `concepts/policy/limit-range`

### ConfigMap

```bash
k create cm app-config --from-literal=LOG_LEVEL=info --from-literal=PORT=8080
k create cm app-file --from-file=app.properties
k create cm app-env --from-env-file=app.env
k set env deploy/web --from=configmap/app-config
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      env:
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config
          mountPath: /etc/app
  volumes:
    - name: config
      configMap:
        name: app-file
```

- env로 주입한 값은 ConfigMap 수정 후 Pod 재시작 전까지 반영 안 됨, volume 마운트는 자동 갱신 (`subPath` 마운트 제외)
- 문서: `tasks/configure-pod-container/configure-pod-configmap`

### Secret

```bash
k create secret generic db-secret --from-literal=user=admin --from-literal=password=pass123
k create secret tls web-tls --cert=tls.crt --key=tls.key
k create secret docker-registry regcred --docker-server=<registry> --docker-username=<u> --docker-password=<p>
k get secret db-secret -o jsonpath='{.data.password}' | base64 -d
k set env deploy/web --from=secret/db-secret
```

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: app
      image: nginx
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
      volumeMounts:
        - name: secret
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: secret
      secret:
        secretName: db-secret
```

- YAML `data`는 base64, `stringData`는 평문
- volume 필드명 차이: ConfigMap은 `configMap.name`, Secret은 `secret.secretName`
- 문서: `concepts/configuration/secret`, `tasks/inject-data-application/distribute-credentials-secure`

### ServiceAccount

```bash
k create sa app-sa
k set serviceaccount deploy/web app-sa
k create token app-sa --duration=1h
```

```yaml
spec:
  serviceAccountName: app-sa
  automountServiceAccountToken: false
```

- Pod의 `serviceAccountName`은 생성 후 변경 불가, Deployment 수정으로 재생성
- 문서: `tasks/configure-pod-container/configure-service-account`

### SecurityContext, capabilities

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure
spec:
  securityContext: # Pod 수준
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
    - name: app
      image: busybox
      command: ["sh", "-c", "sleep 3600"]
      securityContext: # container 수준, Pod 수준보다 우선
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          add: ["NET_ADMIN"]
          drop: ["ALL"]
```

| 필드                                                                               | 위치                 |
| ---------------------------------------------------------------------------------- | -------------------- |
| `runAsUser`, `runAsGroup`, `runAsNonRoot`                                          | Pod, container 둘 다 |
| `fsGroup`                                                                          | Pod만                |
| `capabilities`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem`, `privileged` | container만          |

- 확인: `k exec secure -- id`
- 문서: `tasks/configure-pod-container/security-context`

## Services and Networking

커리큘럼: NetworkPolicy 기본 이해, Service로 접근 제공·트러블슈팅, Ingress 규칙.

### Service

```bash
k expose deploy/web --port=80 --target-port=8080 --name=web-svc
k expose deploy/web --port=80 --type=NodePort
k expose pod web --port=80 --name=web-svc
k create svc nodeport web --tcp=80:8080 --node-port=30080
k run web --image=nginx --port=80 --expose          # Pod + ClusterIP Service
```

| type         | 접근 범위                                     |
| ------------ | --------------------------------------------- |
| ClusterIP    | 클러스터 내부                                 |
| NodePort     | `<NodeIP>:<nodePort>` (기본 범위 30000-32767) |
| LoadBalancer | 외부 LB (클라우드 등)                         |
| ExternalName | DNS CNAME                                     |

- `k create svc`는 selector를 `app=<이름>`으로 고정, 다른 label이면 YAML 수정
- `expose`는 원본 리소스의 selector 재사용

트러블슈팅 순서:

```bash
k get svc web-svc -o wide                                    # selector, port
k get endpointslices -l kubernetes.io/service-name=web-svc   # endpoint 비었는지
k get pod -l app=web --show-labels                           # selector와 label 일치 여부
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web-svc.<ns>.svc.cluster.local
```

- endpoint 없음: selector 불일치 또는 readiness 실패
- 연결 거부: `targetPort`와 `containerPort` 불일치
- 문서: `concepts/services-networking/service`, `tasks/debug/debug-application/debug-service`, DNS 이름 규칙은 `concepts/services-networking/dns-pod-service`

### Ingress

```bash
k create ingress web --class=nginx --rule="foo.com/=web-svc:80"
k create ingress web --rule="foo.com/api*=api-svc:8080"            # * -> pathType Prefix
k create ingress web --rule="foo.com/=web-svc:80,tls=web-tls"
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  rules:
    - host: foo.com
      http:
        paths:
          - path: /api
            pathType: Prefix # Exact / Prefix / ImplementationSpecific
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
```

- 확인: `k describe ingress web` (backend endpoint), `curl -H 'Host: foo.com' http://<ingress-ip>/api`
- Ingress controller 없으면 규칙만 있고 동작 안 함
- 문서: `concepts/services-networking/ingress`, `reference/kubectl/generated/kubectl_create/kubectl_create_ingress`

### NetworkPolicy

명령어 생성 불가. 문서 예제 복사 후 수정.

```yaml
# namespace 전체 ingress 차단
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# app=db는 app=api에서 오는 5432만 허용, egress는 DNS만
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-policy
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - protocol: TCP
          port: 5432
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

`from` 안 selector 조합:

```yaml
# AND: namespace label 그리고 Pod label 둘 다 만족
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
      podSelector:
        matchLabels:
          role: frontend
# OR: 해당 namespace 전체 또는 (정책과 같은 namespace의) role=frontend Pod
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
    - podSelector:
        matchLabels:
          role: frontend
```

- `-` 하나 차이로 AND/OR 갈림
- 정책은 허용 목록 누적 (OR), 선택된 Pod는 명시 허용 외 차단
- `policyTypes`에 `Egress` 넣고 DNS 허용 누락 시 Service 이름 해석 실패
- CNI가 NetworkPolicy 미지원이면 적용 안 됨
- namespace label 확인: `k get ns --show-labels` (`kubernetes.io/metadata.name` 자동 부여)
- 문서: `concepts/services-networking/network-policies`

## 참고 문서

- [CNCF curriculum: CKAD_Curriculum_v1.35.pdf](https://github.com/cncf/curriculum)
- [Linux Foundation: Resources Allowed During the Exam](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tasks/configure-pod-container/configure-persistent-volume-storage/), [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/), [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Managing Workloads](https://kubernetes.io/docs/concepts/workloads/management/)
- [Helm Docs](https://helm.sh/docs/)
- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/), [Install kubectl on Linux (kubectl convert)](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/), [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/), [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/), [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/), [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/), [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/), [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
