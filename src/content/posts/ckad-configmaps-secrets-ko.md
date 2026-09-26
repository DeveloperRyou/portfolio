---
title: "CKAD 개념 노트: ConfigMap과 Secret"
description: "ConfigMap과 Secret을 만드는 방법, Pod에 넣는 세 가지 방식(env, envFrom, volume), 값이 바뀌었을 때 반영되는 경로, projected volume과 Downward API까지 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:07:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "configmap", "secret", "downward-api"]
order: 8
---

> 기준: Kubernetes v1.35 (kind `kindest/node:v1.35.8`에서 명령어·YAML 확인)

## 목차

## 개념

### ConfigMap

키-값 형태의 비밀이 아닌 설정 데이터. 컨테이너 이미지와 환경별 설정을 분리하는 용도.

- 다른 오브젝트와 달리 `spec`이 없고 `data`, `binaryData` 필드를 가짐
  - `data`: UTF-8 문자열
  - `binaryData`: base64로 인코딩한 바이너리
  - 두 필드의 키는 겹치면 안 됨
- 키 이름: 영문자, 숫자, `-`, `_`, `.`만 허용
- 크기 제한: 1 MiB. 그보다 큰 설정은 volume이나 별도 저장소로
- 비밀 유지·암호화 기능 없음. 민감한 값은 Secret으로
- Pod와 같은 namespace에 있어야 참조 가능. static Pod는 ConfigMap을 참조할 수 없음

공식 문서가 꼽는 사용 방법은 네 가지.

1. 컨테이너 `command`/`args` 안에서 참조
2. 컨테이너 환경 변수
3. 읽기 전용 volume의 파일
4. Pod 안에서 Kubernetes API로 직접 읽기

시험에서 주로 손으로 쓰게 되는 건 2, 3번.

### Secret

비밀번호, 토큰, 키처럼 적은 양의 민감한 데이터. 구조는 ConfigMap과 비슷하지만 `type` 필드가 있고, `data` 값은 base64 인코딩이 필수.

- `data`: base64 인코딩한 값
- `stringData`: 평문으로 쓰면 API server가 인코딩해서 `data`에 합쳐 줌. 같은 키가 둘 다에 있으면 `stringData`가 우선
- 크기 제한: 개별 Secret당 1MiB
- Secret은 그 Secret이 필요한 Pod가 있는 노드에만 전달됨. volume으로 마운트하면 kubelet이 tmpfs에 복사해 디스크에 쓰지 않고, Pod가 삭제되면 로컬 사본도 지움

### base64 != 암호화

공식 문서의 경고를 그대로 옮기면, Secret은 기본적으로 API server의 저장소(etcd)에 **암호화되지 않은 상태로** 저장됨. API 접근 권한이 있는 사람, etcd에 접근할 수 있는 사람은 Secret을 읽고 바꿀 수 있음. namespace에 Pod를 만들 수 있는 권한이 있으면 그 Pod를 통해 같은 namespace의 Secret을 간접적으로 읽을 수도 있음.

문서가 제시하는 최소 조치:

- Secret에 Encryption at Rest 적용
- RBAC로 Secret 접근을 최소 권한으로 제한
- Secret 접근을 필요한 컨테이너로만 제한
- 외부 Secret store provider 검토

`data`에 있는 값은 `base64 -d` 한 번이면 원문으로 돌아감.

### Secret type

| type                                  | 용도                             |
| ------------------------------------- | -------------------------------- |
| `Opaque`                              | 기본값. 임의의 사용자 데이터     |
| `kubernetes.io/service-account-token` | ServiceAccount 토큰              |
| `kubernetes.io/dockercfg`             | 직렬화된 `~/.dockercfg`          |
| `kubernetes.io/dockerconfigjson`      | 직렬화된 `~/.docker/config.json` |
| `kubernetes.io/basic-auth`            | basic authentication 자격 증명   |
| `kubernetes.io/ssh-auth`              | SSH 인증 데이터                  |
| `kubernetes.io/tls`                   | TLS 인증서와 키                  |
| `bootstrap.kubernetes.io/token`       | bootstrap token                  |

`kubectl create secret`의 하위 명령과 대응: `generic` -> `Opaque`, `docker-registry` -> `kubernetes.io/dockerconfigjson`, `tls` -> `kubernetes.io/tls`.

### immutable

ConfigMap과 Secret 모두 `immutable: true`를 설정할 수 있음(v1.21부터 stable). 한번 immutable로 만들면 되돌리거나 `data`를 수정할 수 없고, 삭제 후 다시 만들어야 함. immutable 오브젝트는 watch를 닫으므로 kube-apiserver 부하도 줄어듦.

## 동작 방식

### 값을 넣는 방식별 동작

| 방식                      | 필드                                               | 결과                                                    |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| 키 하나 -> 환경 변수 하나 | `env[].valueFrom.configMapKeyRef` / `secretKeyRef` | 이름을 직접 정함                                        |
| 전체 키 -> 환경 변수      | `envFrom[].configMapRef` / `secretRef`             | 키 이름이 그대로 변수 이름                              |
| 파일                      | `volumes[].configMap` / `secret` + `volumeMounts`  | 키 하나당 파일 하나. `items`로 일부 키만 골라 경로 지정 |

- `env`로 참조한 ConfigMap이나 키가 없으면 Pod가 시작되지 않음. `optional: true`로 표시하면 없어도 시작
- `envFrom`은 키를 그대로 변수 이름으로 씀. v1.34부터 변수 이름 규칙이 완화돼(`=`을 뺀 출력 가능한 ASCII) v1.35 클러스터에서는 `Y-Z`, `1abc`, `.dot` 같은 키도 건너뛰지 않고 변수가 됨. "쓸 수 없는 키는 건너뛰고 `InvalidVariableNames` 이벤트"라는 설명은 규칙이 엄격하던 버전 이야기
- Secret volume의 파일 권한은 `defaultMode`(volume 전체) 또는 `items[].mode`(파일별)로 지정
- `.`으로 시작하는 키는 숨김 파일이 됨(`ls -la`로 확인)

### 업데이트 전파

| 소비 방식                 | 원본 변경 시                                                     |
| ------------------------- | ---------------------------------------------------------------- |
| volume 마운트             | 자동 반영. 지연 시간은 최대 kubelet sync period + 캐시 전파 지연 |
| volume + `subPath` 마운트 | 반영 안 됨                                                       |
| `env` / `envFrom`         | 반영 안 됨. Pod 재시작 필요                                      |
| API 직접 조회             | 애플리케이션이 watch해서 직접 처리                               |

kubelet이 변경을 감지하는 방식은 `configMapAndSecretChangeDetectionStrategy`로 정하고 기본값은 `Watch`. 그 밖에 TTL 기반 캐시, 매 sync마다 API server 조회 방식이 있음.

volume으로 받은 값이 바뀌어도 애플리케이션이 파일을 다시 읽지 않으면 효과가 없음. 반영 여부는 애플리케이션 구현에 달려 있음.

### projected volume

여러 volume 소스를 하나의 디렉터리에 합쳐 마운트. 지원 소스:

- `secret`
- `configMap`
- `downwardAPI`
- `serviceAccountToken`
- `clusterTrustBundle`
- `podCertificate`

주의점:

- 모든 소스는 Pod와 같은 namespace
- `subPath`로 마운트하면 업데이트를 받지 못함
- 일반 `secret` volume은 `secretName`이지만 projected 안의 `secret`은 `name`
- `defaultMode`는 projected volume 전체에 적용, 소스별로는 `items[].mode`로 덮어씀
- `serviceAccountToken`: `audience`, `expirationSeconds`(기본 1시간, 최소 10분), `path` 지정

### Downward API

Pod와 컨테이너 자신의 필드를 컨테이너에 노출하는 방법. 환경 변수와 `downwardAPI` volume 두 가지를 합쳐 Downward API라고 부름.

`fieldRef`로 노출 가능한 필드:

| 필드                                                               | env | volume |
| ------------------------------------------------------------------ | --- | ------ |
| `metadata.name`, `metadata.namespace`, `metadata.uid`              | O   | O      |
| `metadata.labels['<KEY>']`, `metadata.annotations['<KEY>']`        | O   | O      |
| `metadata.labels`, `metadata.annotations` (전체)                   | X   | O      |
| `spec.nodeName`, `spec.serviceAccountName`                         | O   | X      |
| `status.podIP`, `status.podIPs`, `status.hostIP`, `status.hostIPs` | O   | X      |

`resourceFieldRef`로는 컨테이너의 `requests`/`limits` 값(`cpu`, `memory`, `ephemeral-storage`, `hugepages-*`)을 노출. limit을 설정하지 않았으면 노드의 allocatable 최대값이 나옴. `divisor` 기본값이 `1`이라 아래 예시의 `limits.cpu: 500m`은 `1`로 올림돼서 나옴. millicore로 보려면 `divisor: 1m`.

label 전체, annotation 전체는 volume으로만 가능. 실행 중에 리소스가 resize되면 volume 쪽은 갱신되지만 env는 컨테이너가 재시작되기 전까지 그대로.

## 예시

### 생성

```bash
# ConfigMap
kubectl create configmap app-config --from-literal=MODE=prod --from-literal=LOG_LEVEL=info
kubectl create configmap app-files --from-file=app.properties            # 키 = 파일 이름
kubectl create configmap app-files2 --from-file=config=app.properties    # 키 이름 지정
kubectl create configmap app-env --from-env-file=app.env                 # VAR=VAL 줄 단위

# Secret
kubectl create secret generic db-cred --from-literal=username=admin --from-literal=password='s3cr3t'
kubectl create secret tls web-tls --cert=tls.crt --key=tls.key
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com --docker-username=user --docker-password=pass

# YAML 뽑기
kubectl create configmap app-config --from-literal=MODE=prod --dry-run=client -o yaml > cm.yaml

# 값 확인
kubectl get secret db-cred -o jsonpath='{.data.password}' | base64 -d
```

`--from-file`과 `--from-env-file`의 차이:

- `--from-file=app.env`: 파일 전체가 값 하나. 키는 `app.env`
- `--from-env-file=app.env`: 파일의 `VAR=VAL` 줄마다 키 하나. `#` 주석과 빈 줄은 무시

### Secret manifest

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-cred
type: Opaque
data:
  username: YWRtaW4= # "admin"
stringData:
  password: s3cr3t # 평문, 생성 시 base64로 변환
```

### env / envFrom / volume

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "env; ls /etc/config /etc/secret; sleep 3600"]
      env:
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: db-cred
              key: username
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
              optional: true
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config-vol
          mountPath: /etc/config
          readOnly: true
        - name: secret-vol
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: config-vol
      configMap:
        name: app-files
    - name: secret-vol
      secret:
        secretName: db-cred
        defaultMode: 0400
        items:
          - key: password
            path: db-password
```

### projected volume + Downward API

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: projected-demo
  labels:
    app: demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      resources:
        limits:
          cpu: 500m
          memory: 128Mi
      env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
      volumeMounts:
        - name: all-in-one
          mountPath: /projected
          readOnly: true
  volumes:
    - name: all-in-one
      projected:
        sources:
          - configMap:
              name: app-config
          - secret:
              name: db-cred # projected 안에서는 secretName이 아니라 name
              items:
                - key: password
                  path: secret/password
          - downwardAPI:
              items:
                - path: labels
                  fieldRef:
                    fieldPath: metadata.labels
                - path: cpu_limit
                  resourceFieldRef:
                    containerName: app
                    resource: limits.cpu
```

## 헷갈리는 것 비교

| 항목        | ConfigMap                           | Secret                                          |
| ----------- | ----------------------------------- | ----------------------------------------------- |
| 용도        | 비밀이 아닌 설정                    | 민감한 값                                       |
| 값 필드     | `data`(UTF-8), `binaryData`(base64) | `data`(base64), `stringData`(평문, 쓰기 전용)   |
| `type`      | 없음                                | `Opaque` 등                                     |
| 크기 제한   | 1 MiB                               | 1MiB                                            |
| env 참조    | `configMapKeyRef` / `configMapRef`  | `secretKeyRef` / `secretRef`                    |
| volume 필드 | `configMap.name`                    | `secret.secretName` (projected 안에서는 `name`) |
| 노드 저장   | -                                   | volume 마운트 시 tmpfs                          |

| 비교                               | 차이                                                |
| ---------------------------------- | --------------------------------------------------- |
| `env` vs `envFrom`                 | 키 하나를 원하는 이름으로 vs 전체 키를 그대로       |
| volume vs `subPath` volume         | 업데이트 반영 vs 반영 안 됨                         |
| `--from-file` vs `--from-env-file` | 파일 하나 = 키 하나 vs 줄 하나 = 키 하나            |
| `fieldRef` vs `resourceFieldRef`   | Pod 메타데이터·상태 vs 컨테이너 requests/limits     |
| Downward API env vs volume         | 실행 중 값 고정 vs label·annotation 전체, 갱신 반영 |

## 시험 포인트

### 명령어

- ConfigMap·Secret은 `kubectl create configmap` / `kubectl create secret generic`으로 바로 만들고 YAML은 `--dry-run=client -o yaml`로 뽑음
- Pod 쪽 `env`/`envFrom`/`volumes`는 imperative 명령이 없으므로 YAML로 작성. 기존 Deployment라면 `kubectl set env deployment/<name> --from=configmap/<cm>`도 가능
- Secret 값 확인: `kubectl get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`
- 환경 변수 확인: `kubectl exec <pod> -- env`

### kubectl explain

```bash
kubectl explain pod.spec.containers.env.valueFrom   # configMapKeyRef, secretKeyRef, fieldRef
kubectl explain pod.spec.containers.envFrom         # configMapRef, secretRef, prefix
kubectl explain pod.spec.volumes.configMap          # name, items, defaultMode
kubectl explain pod.spec.volumes.secret             # secretName (configMap과 필드명이 다름)
kubectl explain pod.spec.volumes.projected.sources  # projected volume에 넣을 수 있는 source
kubectl explain pod.spec.volumes.downwardAPI.items  # Downward API volume
kubectl explain secret.stringData                   # 평문으로 넣는 필드
```

## 참고 문서

- [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Projected Volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/)
- [Downward API](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
