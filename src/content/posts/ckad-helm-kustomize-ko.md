---
title: "CKAD 개념 노트: Helm과 Kustomize"
description: "Helm의 chart·repository·release 개념과 install/upgrade/rollback/uninstall, values override, 그리고 Kustomize의 base/overlay·patches·generator와 kubectl apply -k를 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:06:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "helm", "kustomize"]
order: 7
---

> 기준: Kubernetes v1.35 (kind `kindest/node:v1.35.8`에서 명령어·YAML 확인)
> Helm 명령·플래그는 helm.sh 문서 4.3.0 기준. Helm 4.3.0과 3.19.0 둘 다로 실행해 봄

## 목차

## Helm 개념

공식 문서가 Helm을 설명하는 세 요소:

| 요소       | 정의 (helm.sh Introduction 기준)                                                  |
| ---------- | --------------------------------------------------------------------------------- |
| chart      | Helm package. 애플리케이션 실행에 필요한 resource 정의 묶음                       |
| repository | chart를 모아 공유하는 곳                                                          |
| release    | cluster에서 돌고 있는 chart의 instance. 같은 chart를 두 번 설치하면 release 두 개 |

release를 만들 때 Helm은 chart와 configuration(values, 보통 `values.yaml`)을 합친다.

### release revision

- install, upgrade, rollback 할 때마다 revision이 1씩 증가. 첫 revision은 항상 1
- rollback도 revision을 되돌리는 게 아니라 **새 revision을 하나 추가**
- `helm history <release>`로 revision 목록 확인
- `helm uninstall`은 release 기록까지 삭제. 그래서 uninstall 뒤에는 rollback 불가. 기록을 남기려면 `--keep-history`

## Helm 동작 방식

### repo → search → install

```shell
helm repo add bitnami <repo-url>
helm repo update
helm search repo wordpress        # 추가한 repo에서 검색 (로컬 데이터)
helm search hub wordpress         # Artifact Hub 검색
helm show values bitnami/wordpress
helm install my-wp bitnami/wordpress
```

- `helm search repo`는 로컬에 받아 둔 repo 데이터를 검색. `helm repo update`로 갱신
- Helm 3부터 기본 repository가 없음. 필요한 repo를 직접 `helm repo add`
- install 인자는 release 이름과 chart. 이름을 Helm이 정하게 하려면 `--generate-name`
- chart 소스: repo 참조(`bitnami/wordpress`), 로컬 `.tgz`, 압축 풀린 디렉터리, URL, OCI registry(`oci://...`)
- Helm은 기본적으로 resource가 다 뜰 때까지 기다리지 않고 종료. Helm 4의 `--wait`는 전략을 받음: 플래그를 안 주면 `hookOnly`, `--wait`만 주면 `watcher`. Helm 3의 `--wait`는 켜고 끄는 플래그일 뿐. 대기 한도는 둘 다 `--timeout` (기본 `5m0s`)

### values override

```shell
helm install my-wp bitnami/wordpress -f values.yaml
helm install my-wp bitnami/wordpress -f base.yaml -f override.yaml   # 오른쪽 파일 우선
helm install my-wp bitnami/wordpress --set service.type=NodePort
helm get values my-wp              # 이 release에 준 값 확인
```

| 방식                  | 우선순위                                  |
| --------------------- | ----------------------------------------- |
| chart의 `values.yaml` | 가장 낮음 (기본값)                        |
| `-f` / `--values`     | 여러 번 주면 오른쪽 파일이 우선           |
| `--set`               | `-f`보다 높음. 여러 번 주면 오른쪽이 우선 |

`--set` 문법:

| `--set`               | YAML                            |
| --------------------- | ------------------------------- |
| `a=b,c=d`             | `a: b` / `c: d`                 |
| `outer.inner=value`   | `outer:` 아래 `inner: value`    |
| `name={a,b,c}`        | 리스트                          |
| `servers[0].port=80`  | 리스트 원소의 필드              |
| `name=value1\,value2` | 쉼표 escape → `"value1,value2"` |

### upgrade / rollback / uninstall

```shell
helm upgrade my-wp bitnami/wordpress -f new-values.yaml
helm upgrade --install my-wp bitnami/wordpress     # 없으면 install
helm upgrade my-wp bitnami/wordpress --reuse-values --set image.tag=6.6
helm history my-wp
helm rollback my-wp 1       # revision 1로
helm rollback my-wp         # revision 생략(또는 0) → 직전 release로
helm uninstall my-wp
helm list                   # 현재 context namespace의 release
helm list -A                # 전체 namespace
```

- upgrade는 바뀐 것만 갱신 ("least invasive upgrade")
- chart 참조로 upgrade하면 `--version`이 없을 때 최신 chart 버전을 씀
- upgrade 때 values 처리:

| 플래그                      | 동작                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `--reuse-values`            | 직전 release의 값 + 이번 `--set`/`-f`를 병합                        |
| `--reset-values`            | chart 기본값으로 초기화                                             |
| `--reset-then-reuse-values` | chart 기본값으로 초기화 → 직전 release 값 적용 → 이번 override 병합 |

- `-n <ns>`: 대상 namespace. `--create-namespace`로 없으면 생성 (upgrade에서는 `--install`과 함께일 때)

### 설치 전에 결과 보기

```shell
helm template my-wp bitnami/wordpress -f values.yaml     # 로컬 렌더링, cluster 조회 없음
helm install my-wp bitnami/wordpress --dry-run=server     # cluster에서 시뮬레이션
```

`--dry-run` 출력에는 Secret도 그대로 나온다. 숨기려면 `--hide-secret`.

## Kustomize 개념

Kubernetes 문서 기준 Kustomize의 역할:

- 다른 소스에서 resource 생성 (`configMapGenerator`, `secretGenerator`)
- 모든 resource에 공통 필드 설정 (namespace, name prefix/suffix, labels, annotations)
- resource 묶음을 조합하고 customize (`resources`, `patches`)

kubectl은 1.14부터 kustomization 파일을 지원. 진입점은 디렉터리 안의 `kustomization.yaml`.

```shell
kubectl kustomize <dir>      # 렌더링 결과만 출력
kubectl apply -k <dir>       # 적용
kubectl get -k <dir>
kubectl describe -k <dir>
kubectl diff -k <dir>        # 적용했을 때와의 차이
kubectl delete -k <dir>
```

`-k`는 파일이 아니라 kustomization **디렉터리**를 가리켜야 함.

### base와 overlay

- base: `kustomization.yaml`이 있는 디렉터리. resource와 customization 묶음. 로컬 또는 원격 repo
- overlay: 다른 kustomization 디렉터리를 참조하는 `kustomization.yaml` 디렉터리
- base는 overlay를 모름. 하나의 base를 여러 overlay가 재사용

```text
.
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
├── dev/
│   └── kustomization.yaml    # resources: [../base], namePrefix: dev-
└── prod/
    └── kustomization.yaml    # resources: [../base], namePrefix: prod-
```

## Kustomize 예시

### base

```yaml
# base/kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
```

```yaml
# base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      run: my-nginx
  template:
    metadata:
      labels:
        run: my-nginx
    spec:
      containers:
        - name: my-nginx
          image: nginx
```

### overlay: 공통 필드 + image + patch

```yaml
# prod/kustomization.yaml
resources:
  - ../base
namespace: prod
namePrefix: prod-
labels:
  - pairs:
      env: prod
images:
  - name: nginx
    newTag: "1.27"
patches:
  - path: increase_replicas.yaml
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: my-nginx
    path: set_memory.json.yaml
```

```yaml
# prod/increase_replicas.yaml  (strategic merge patch)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 3
```

```yaml
# prod/set_memory.json.yaml  (JSON 6902 patch)
- op: add
  path: /spec/template/spec/containers/0/resources
  value:
    limits:
      memory: 512Mi
```

- patch 두 종류 모두 `patches` 필드 하나에 씀
  - strategic merge: patch 파일 안의 `group`/`version`/`kind`/`name`으로 대상을 찾음
  - JSON 6902: 대상 정보가 파일에 없으므로 `target` **필수**
- `patches`는 적힌 순서대로 적용. 문서 권장은 "한 가지만 하는 작은 patch"
- `images`: patch 없이 image 이름·tag·digest 변경
- `labels`는 selector에 label을 넣지 않음. selector에도 넣으려면 `includeSelectors: true`. 예전 `commonLabels`도 selector까지 바꾸지만 kubectl 1.35 번들 Kustomize는 `'commonLabels' is deprecated. Please use 'labels' instead` 경고를 냄

### generator

```yaml
# kustomization.yaml
configMapGenerator:
  - name: app-config
    files:
      - application.properties
    literals:
      - FOO=Bar
secretGenerator:
  - name: app-secret
    files:
      - password.txt
```

- 생성된 ConfigMap/Secret 이름에 content hash 접미사가 붙음 (`app-config-8mbdf7882g` 형태). 내용이 바뀌면 이름이 바뀜
- 같은 kustomization 안에서 이 ConfigMap을 참조하는 Deployment의 `name: app-config`도 hash 붙은 이름으로 바뀜. 결과적으로 Pod template이 바뀌어 rollout이 일어남
- 접미사를 끄려면 `generatorOptions.disableNameSuffixHash: true`

## Helm vs Kustomize

|                  | Helm                             | Kustomize                          |
| ---------------- | -------------------------------- | ---------------------------------- |
| 입력             | chart (template + `values.yaml`) | 평범한 YAML + `kustomization.yaml` |
| 환경별 차이 표현 | values를 다르게                  | overlay 디렉터리 + patch           |
| 설치 도구        | 별도 `helm` CLI                  | `kubectl` 내장 (`-k`)              |
| 설치 기록        | release·revision을 Helm이 저장   | 없음. 적용된 object만 남음         |
| rollback         | `helm rollback`                  | 이전 manifest를 다시 `apply -k`    |
| 배포 단위 공유   | repository, OCI registry         | base 디렉터리(로컬·원격 repo)      |
| 렌더링만 보기    | `helm template`                  | `kubectl kustomize`                |

언제 무엇을:

- 남이 만든 소프트웨어(DB, ingress controller 등)를 설정만 바꿔 설치 → Helm chart
- 내가 가진 manifest를 dev/prod처럼 조금씩 다르게 → Kustomize overlay
- CKAD 문제 문장이 "chart", "release", "repository"를 말하면 Helm, "kustomization", "overlay", `-k`를 말하면 Kustomize

## 시험 포인트

**빠른 명령**

```shell
helm repo list
helm search repo <keyword>
helm show values <repo>/<chart> | less
helm install <release> <repo>/<chart> -n <ns> --create-namespace --set key=value
helm upgrade <release> <repo>/<chart> --reuse-values --set key=value
helm list -A
helm history <release> -n <ns>
helm rollback <release> <revision> -n <ns>
helm uninstall <release> -n <ns>

kubectl kustomize <dir>
kubectl apply -k <dir>
```

**kubectl explain**

```bash
# Helm·Kustomize 설정은 API 리소스가 아니라 explain 대상이 아님. 결과물 리소스 필드만 explain
kubectl explain deployment.spec.replicas                                      # Kustomize patch·Helm values가 바꾸는 필드 확인
kubectl explain deployment.spec.template.spec.containers.image
# 옵션은 CLI help로
helm install --help | grep -E -- '--(set|values|namespace|create-namespace)'
helm upgrade --help | grep -E -- '--(install|reuse-values|reset-values)'
kubectl kustomize --help
```

## 참고 문서

- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Helm Docs](https://helm.sh/docs/)
- [Introduction to Helm](https://helm.sh/docs/intro/introduction/)
- [Using Helm](https://helm.sh/docs/intro/using_helm/)
- [helm install](https://helm.sh/docs/helm/helm_install/), [helm upgrade](https://helm.sh/docs/helm/helm_upgrade/), [helm rollback](https://helm.sh/docs/helm/helm_rollback/), [helm uninstall](https://helm.sh/docs/helm/helm_uninstall/), [helm template](https://helm.sh/docs/helm/helm_template/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
