---
title: "CKAD 개념 노트: persistent volume과 ephemeral volume"
description: "container filesystem과 volume의 차이부터 emptyDir, hostPath, configMap volume, PV/PVC binding, access mode, reclaim policy, StorageClass, generic ephemeral volume까지 공식 문서 기준으로 정리했습니다."
pubDatetime: 2026-09-26T12:11:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "volume", "persistentvolume", "storageclass"]
order: 12
---

> 기준: Kubernetes v1.35 (명령어·YAML 클러스터 검증 전)

## 목차

## 개념

### container filesystem만으로 부족한 이유

- container가 crash하면 kubelet이 container를 **깨끗한 상태로** 재시작. container 안에서 쓴 파일은 사라짐
- 같은 Pod 안의 container 여러 개가 파일을 공유할 방법이 없음
- volume은 이 두 문제를 푸는 수단. 공식 문서 정의: "a directory, possibly with some data in it, which is accessible to the containers in a pod"

### ephemeral vs persistent

| 구분              | 수명                                   | 예                                                                         |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| ephemeral volume  | Pod와 같음. Pod가 사라지면 같이 삭제   | `emptyDir`, `configMap`, `secret`, `downwardAPI`, generic ephemeral volume |
| persistent volume | Pod와 무관. Pod가 교체돼도 데이터 유지 | `persistentVolumeClaim`으로 붙인 PV                                        |

둘 다 **container 재시작**에는 데이터가 남는다. 차이는 Pod가 삭제될 때 드러난다.

### volume 선언 구조

- `spec.volumes[]`: Pod가 쓸 volume 정의 (종류와 소스)
- `spec.containers[].volumeMounts[]`: container별로 어디에 마운트할지. container마다 따로 지정해야 함
- `volumeMounts[].name`은 `spec.volumes[].name`과 일치해야 함
- volume 안에 다른 volume을 마운트할 수 없음 (비슷한 용도로 `subPath`)

### 주요 volume 종류

**emptyDir**

- Pod가 노드에 배정될 때 빈 디렉터리로 생성, Pod가 노드에서 제거되면 영구 삭제
- container crash로는 Pod가 제거되지 않으므로 데이터 유지
- 용도: scratch 공간, 같은 Pod의 container 간 파일 공유 (sidecar 패턴)
- `medium: Memory` → tmpfs. 빠르지만 쓴 파일이 해당 container의 memory limit에 합산
- `sizeLimit`로 크기 상한

**hostPath**

- 노드의 파일/디렉터리를 Pod에 마운트
- 공식 문서 경고: 보안 위험이 많으니 피할 수 있으면 피할 것 (대안으로 `local` PV 제시)
- 같은 설정의 Pod라도 노드마다 파일 내용이 달라 동작이 달라질 수 있음
- `type`: `""`(검사 안 함), `DirectoryOrCreate`, `Directory`, `FileOrCreate`, `File`, `Socket`, `CharDevice`, `BlockDevice`

**configMap**

- ConfigMap 데이터를 파일로 마운트. 키 하나가 파일 하나
- `items[].key`/`items[].path`로 특정 키만, 원하는 파일명으로
- 항상 read-only로 마운트
- ConfigMap을 먼저 만들어 둬야 함
- `subPath`로 마운트하면 ConfigMap이 바뀌어도 container에 갱신이 안 됨

**persistentVolumeClaim**

- PVC를 통해 PV를 Pod에 마운트. 아래 "동작 방식" 참고

## 동작 방식

### PV와 PVC

- **PersistentVolume (PV)**: 클러스터의 스토리지 한 조각. 관리자가 만들거나 StorageClass로 동적 생성. cluster-scoped, Pod와 독립된 수명
- **PersistentVolumeClaim (PVC)**: 사용자의 스토리지 요청. 크기와 access mode를 요구. namespace 리소스라 **사용하는 Pod와 같은 namespace**여야 함
- Pod는 PV를 직접 참조하지 않고 PVC를 참조

### provisioning

| 방식    | 흐름                                                                        |
| ------- | --------------------------------------------------------------------------- |
| static  | 관리자가 PV를 미리 생성 → PVC가 조건 맞는 PV에 binding                      |
| dynamic | 맞는 static PV가 없으면 PVC가 요청한 StorageClass의 provisioner가 PV를 생성 |

- `storageClassName: ""`인 PVC는 dynamic provisioning을 스스로 끔
- dynamic provisioning 기본 동작에는 API server의 `DefaultStorageClass` admission controller가 필요

### binding 규칙

- control plane의 control loop가 새 PVC를 보고 맞는 PV를 찾아 binding
- 1:1 매핑. PV와 PVC 양쪽이 `claimRef`로 서로를 가리킴. 한 번 묶이면 배타적
- 요청 이상을 받을 수는 있음 (8Gi 요청에 10Gi PV가 묶일 수 있음)
- 맞는 PV가 없으면 PVC는 **무기한 Pending**. 조건 맞는 PV가 생기면 그때 binding
- 매칭 조건: 크기, access mode, `storageClassName` 일치, `selector`(있으면), `volumeMode`
- `volumeName`으로 특정 PV를 지정해 미리 binding 가능. 그 PV가 이미 다른 PVC에 묶여 있으면 Pending에서 멈춤

### storageClassName 세 가지 경우

| PVC 설정                 | 동작                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `storageClassName: fast` | 같은 class의 PV만 binding. 없으면 `fast` class로 dynamic provisioning                                  |
| `storageClassName: ""`   | class 없는 PV만 binding. dynamic provisioning 안 함                                                    |
| 필드 생략                | default StorageClass가 있으면 그 값이 채워짐. 없으면 unset으로 남았다가 나중에 default가 생기면 갱신됨 |

`""`과 생략은 다르다. static PV에 묶고 싶은데 클러스터에 default StorageClass가 있으면 `""`를 명시해야 한다.

### access mode

| 모드             | 약어 | 의미                                                                     |
| ---------------- | ---- | ------------------------------------------------------------------------ |
| ReadWriteOnce    | RWO  | **노드 하나**에서 read-write 마운트. 같은 노드의 Pod 여러 개는 접근 가능 |
| ReadOnlyMany     | ROX  | 여러 노드에서 read-only                                                  |
| ReadWriteMany    | RWX  | 여러 노드에서 read-write                                                 |
| ReadWriteOncePod | RWOP | **Pod 하나**에서만 read-write (v1.29 stable, CSI volume만)               |

- volume은 여러 모드를 지원해도 **한 번에 하나의 모드로만** 마운트
- RWO/ROX/RWX는 volume에 실제 제약을 걸지 않음. ROX로 만들어도 read-only가 보장되지는 않음. RWOP만 단일 Pod로 제약
- 지원 모드는 volume plugin마다 다름 (예: HostPath는 RWO만)

### volumeMode

- `Filesystem`(기본): 디렉터리로 마운트
- `Block`: 파일시스템 없는 raw block device로 노출

### reclaim policy

PVC가 삭제된 뒤 PV를 어떻게 할지. PV의 `persistentVolumeReclaimPolicy` 필드.

| 정책      | 동작                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `Retain`  | PV가 남고 `Released` 상태. 이전 데이터가 남아 있어 다른 PVC에 바로 binding 안 됨. 관리자가 수동 정리 |
| `Delete`  | PV 객체와 외부 스토리지 자산을 함께 삭제                                                             |
| `Recycle` | deprecated. `rm -rf /thevolume/*` 후 재사용. 공식 문서는 dynamic provisioning 권장                   |

- 수동으로 만든 PV의 기본값은 `Retain`
- dynamic provisioning으로 만든 PV는 StorageClass의 `reclaimPolicy`를 물려받고, 그 기본값은 `Delete`

### PV phase

| phase       | 의미                          |
| ----------- | ----------------------------- |
| `Available` | 아직 어느 PVC에도 묶이지 않음 |
| `Bound`     | PVC에 묶임                    |
| `Released`  | PVC는 삭제됐지만 아직 회수 전 |
| `Failed`    | 자동 회수 실패                |

### Storage Object in Use Protection

- Pod가 사용 중인 PVC, PVC에 묶인 PV는 삭제 요청을 해도 바로 지워지지 않음 (finalizer로 보류)
- PVC를 쓰는 Pod가 사라진 뒤에 실제 삭제

### StorageClass

- `apiVersion: storage.k8s.io/v1`, cluster-scoped
- 필드: `provisioner`(필수), `parameters`, `reclaimPolicy`(기본 `Delete`), `allowVolumeExpansion`, `volumeBindingMode`(기본 `Immediate`), `mountOptions`
- 이름이 곧 PVC가 요청하는 class 이름. 관리자가 처음 만들 때 이름과 파라미터를 정함
- default 지정: annotation `storageclass.kubernetes.io/is-default-class: "true"`. 여러 개면 가장 최근 것이 사용됨

| volumeBindingMode      | 동작                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `Immediate`            | PVC 생성 즉시 binding·provisioning                                                   |
| `WaitForFirstConsumer` | 그 PVC를 쓰는 Pod가 생길 때까지 지연. scheduler가 Pod 배치를 고려해 volume 위치 결정 |

`WaitForFirstConsumer`에서 Pod에 `nodeName`을 쓰면 scheduler를 우회해 PVC가 Pending에 머문다. 공식 문서는 `kubernetes.io/hostname` nodeSelector를 대안으로 제시.

### PVC 확장

- StorageClass에 `allowVolumeExpansion: true`일 때 PVC의 `spec.resources.requests.storage`를 늘리면 확장
- 축소는 지원 안 함

### generic ephemeral volume

- Pod spec의 `volumes[].ephemeral.volumeClaimTemplate`에 PVC 스펙을 인라인으로 작성 (v1.23 stable)
- Pod 생성 시 ephemeral volume controller가 같은 namespace에 PVC를 만들고, Pod가 그 PVC의 owner
- PVC 이름: `<Pod 이름>-<volume 이름>`. 예: Pod `my-app` + volume `scratch-volume` → `my-app-scratch-volume`
- Pod가 삭제되면 garbage collector가 PVC 삭제. StorageClass reclaim policy가 기본 `Delete`라 보통 volume도 같이 삭제
- `emptyDir`과 비슷한 용도지만 네트워크 스토리지, 고정 크기, snapshot/clone/resize 같은 스토리지 드라이버 기능을 쓸 수 있음
- 이름 충돌 주의: Pod `pod-a` + volume `scratch`와 Pod `pod` + volume `a-scratch`는 둘 다 `pod-a-scratch`. 같은 namespace의 수동 PVC와도 충돌 가능. 충돌하면 기존 PVC는 건드리지 않지만 Pod가 시작되지 못함
- 공식 문서 권장 binding mode: `WaitForFirstConsumer`

## 예시

### emptyDir: container 간 공유

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-scratch
spec:
  containers:
    - name: writer
      image: busybox:1.36
      command:
        ["sh", "-c", "while true; do date >> /data/log.txt; sleep 5; done"]
      volumeMounts:
        - name: scratch
          mountPath: /data
    - name: reader
      image: busybox:1.36
      command: ["sh", "-c", "tail -F /data/log.txt"]
      volumeMounts:
        - name: scratch
          mountPath: /data
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 500Mi
```

### configMap volume: 키 하나만 파일로

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: configmap-pod
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "cat /etc/config/log_level.conf && sleep 3600"]
      volumeMounts:
        - name: config-vol
          mountPath: /etc/config
  volumes:
    - name: config-vol
      configMap:
        name: log-config
        items:
          - key: log_level
            path: log_level.conf
```

`log-config`의 `log_level` 키가 `/etc/config/log_level.conf`로 들어간다.

### static PV + PVC + Pod

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi
  storageClassName: ""
---
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
  namespace: default
spec:
  containers:
    - name: web
      image: nginx:1.27
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: pvc-data
```

- PV·PVC 모두 `storageClassName: ""`라 default StorageClass가 있어도 dynamic provisioning 없이 이 PV에 묶임
- 500Mi 요청에 1Gi PV가 묶임 (요청 이상 허용)
- `hostPath` PV는 공식 문서상 단일 노드 테스트용

### StorageClass + dynamic provisioning

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: csi-driver.example-vendor.example
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-fast
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
  storageClassName: fast
```

`provisioner`는 클러스터에 설치된 CSI 드라이버 이름으로 바꿔야 한다. `WaitForFirstConsumer`라 이 PVC를 쓰는 Pod가 생기기 전까지 PVC는 `Pending`이 정상.

### generic ephemeral volume

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "1000000"]
      volumeMounts:
        - name: scratch-volume
          mountPath: /scratch
  volumes:
    - name: scratch-volume
      ephemeral:
        volumeClaimTemplate:
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: fast
            resources:
              requests:
                storage: 1Gi
```

### 확인용 kubectl

```bash
kubectl get pv
kubectl get pvc -A
kubectl describe pvc pvc-data          # Events에서 Pending 원인 확인
kubectl get storageclass               # (default) 표시로 default class 확인
kubectl get pvc my-app-scratch-volume  # generic ephemeral volume이 만든 PVC
kubectl patch pv pv-data -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## 헷갈리는 것 비교

| 항목                    | emptyDir                  | hostPath            | generic ephemeral   | PVC (persistent)                  |
| ----------------------- | ------------------------- | ------------------- | ------------------- | --------------------------------- |
| 수명                    | Pod                       | 노드 (Pod와 무관)   | Pod                 | PV 기준, Pod와 무관               |
| 데이터 위치             | 노드 로컬 디스크 또는 RAM | 노드의 특정 경로    | 스토리지 드라이버   | 스토리지 드라이버                 |
| 다른 노드에서 재배치 시 | 데이터 없음               | 그 노드의 경로 내용 | 새 PVC              | 같은 데이터 (access mode 허용 시) |
| PVC 객체                | 없음                      | 없음                | 자동 생성·자동 삭제 | 사용자가 생성·삭제                |

| 헷갈리는 쌍                           | 차이                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| RWO vs RWOP                           | RWO는 노드 단위, 같은 노드의 Pod 여럿 가능. RWOP는 클러스터 전체에서 Pod 하나 |
| `Retain` vs `Delete`                  | PVC 삭제 후 PV가 `Released`로 남음 vs PV와 실제 스토리지까지 삭제             |
| `storageClassName: ""` vs 생략        | class 없는 PV만 vs default StorageClass 적용                                  |
| `Immediate` vs `WaitForFirstConsumer` | PVC 생성 즉시 binding vs Pod가 생길 때까지 Pending                            |
| PV vs PVC 범위                        | PV는 cluster-scoped, PVC는 namespaced                                         |
| configMap volume vs `subPath` 마운트  | 전체 마운트는 ConfigMap 변경이 반영, `subPath`는 반영 안 됨                   |

## 시험 포인트

### 빨리 푸는 방법

- PV·PVC·StorageClass는 `kubectl create` 하위 명령이 없음 → 공식 문서 YAML을 복사해 수정
- Pod는 `kubectl run <name> --image=<img> --dry-run=client -o yaml > pod.yaml`로 뼈대를 만든 뒤 `volumes`/`volumeMounts` 추가

### kubectl explain

```bash
kubectl explain pod.spec.volumes                                # volume type 목록
kubectl explain pod.spec.volumes.persistentVolumeClaim          # claimName, readOnly
kubectl explain pod.spec.volumes.emptyDir                       # medium, sizeLimit
kubectl explain pod.spec.volumes.ephemeral.volumeClaimTemplate  # generic ephemeral volume
kubectl explain pv.spec --recursive | less                      # PV 필드 트리
kubectl explain pvc.spec                                        # accessModes, resources, storageClassName
kubectl explain storageclass                                    # provisioner, volumeBindingMode
```

## 참고 문서

- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)
- [PersistentVolume API reference](https://kubernetes.io/docs/reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1/) (`persistentVolumeReclaimPolicy` 기본값)
