---
title: "CKAD concept notes: persistent and ephemeral volumes"
description: "From why the container filesystem isn't enough to emptyDir, hostPath, configMap volumes, PV/PVC binding, access modes, reclaim policies, StorageClasses, and generic ephemeral volumes, based on the official docs."
pubDatetime: 2026-09-26T12:11:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "volume", "persistentvolume", "storageclass"]
order: 12
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### Why the container filesystem isn't enough

- when a container crashes, the kubelet restarts it **in a clean state**. Files written inside the container are gone
- containers in the same Pod have no way to share files
- volumes solve both problems. The official definition: "a directory, possibly with some data in it, which is accessible to the containers in a pod"

### ephemeral vs persistent

| Kind              | Lifetime                                              | Examples                                                                   |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| ephemeral volume  | same as the Pod. Deleted along with it                | `emptyDir`, `configMap`, `secret`, `downwardAPI`, generic ephemeral volume |
| persistent volume | independent of the Pod. Data survives Pod replacement | a PV attached through `persistentVolumeClaim`                              |

Both keep their data across a **container restart**. The difference shows up when the Pod is deleted.

### How volumes are declared

- `spec.volumes[]`: the volumes the Pod uses (type and source)
- `spec.containers[].volumeMounts[]`: where each container mounts them. Has to be set per container
- `volumeMounts[].name` has to match `spec.volumes[].name`
- you can't mount a volume inside another volume (use `subPath` for something similar)

### Main volume types

**emptyDir**

- created as an empty directory when the Pod is assigned to a node, deleted permanently when the Pod is removed from the node
- a container crash doesn't remove the Pod, so the data stays
- uses: scratch space, sharing files between containers in the same Pod (the sidecar pattern)
- `medium: Memory` → tmpfs. Fast, but files written count toward that container's memory limit
- `sizeLimit` caps the size

**hostPath**

- mounts a file or directory from the node into the Pod
- the official docs warn it carries many security risks and should be avoided when possible (they suggest a `local` PV instead)
- Pods with identical config can behave differently on different nodes because the file contents differ
- `type`: `""` (no check), `DirectoryOrCreate`, `Directory`, `FileOrCreate`, `File`, `Socket`, `CharDevice`, `BlockDevice`

**configMap**

- mounts ConfigMap data as files. One file per key
- `items[].key`/`items[].path` for specific keys under the file names you want
- always mounted read-only
- the ConfigMap has to exist first
- if mounted with `subPath`, ConfigMap changes don't reach the container

**persistentVolumeClaim**

- mounts a PV into the Pod through a PVC. See "How it works" below

## How it works

### PV and PVC

- **PersistentVolume (PV)**: a piece of storage in the cluster. Created by an admin or dynamically through a StorageClass. Cluster-scoped, with a lifetime independent of Pods
- **PersistentVolumeClaim (PVC)**: a user's request for storage. Asks for a size and access modes. It's a namespaced resource, so it has to be in **the same namespace as the Pod using it**
- Pods don't reference PVs directly; they reference PVCs

### Provisioning

| Method  | Flow                                                                                        |
| ------- | ------------------------------------------------------------------------------------------- |
| static  | an admin creates PVs ahead of time → a PVC binds to a matching PV                           |
| dynamic | if no static PV matches, the provisioner of the StorageClass the PVC asked for creates a PV |

- a PVC with `storageClassName: ""` turns off dynamic provisioning for itself
- default dynamic provisioning needs the API server's `DefaultStorageClass` admission controller

### Binding rules

- a control loop in the control plane watches for new PVCs, finds a matching PV, and binds them
- 1:1 mapping. PV and PVC point at each other through `claimRef`. Once bound, it's exclusive
- you can get more than you asked for (an 8Gi request can bind to a 10Gi PV)
- if no PV matches, the PVC stays **Pending indefinitely**. It binds once a matching PV appears
- matching criteria: size, access modes, matching `storageClassName`, `selector` (if set), `volumeMode`
- `volumeName` pre-binds to a specific PV. If that PV is already bound to another PVC, it gets stuck in Pending

### The three storageClassName cases

| PVC setting              | Behavior                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `storageClassName: fast` | only binds PVs of the same class. If none, dynamically provisions with the `fast` class                                          |
| `storageClassName: ""`   | only binds PVs with no class. No dynamic provisioning                                                                            |
| field omitted            | if there's a default StorageClass, that value is filled in. If not, it stays unset and gets updated later when a default appears |

`""` and omitting it are different. If you want to bind to a static PV and the cluster has a default StorageClass, you have to write `""` explicitly.

### Access modes

| Mode             | Abbreviation | Meaning                                                                        |
| ---------------- | ------------ | ------------------------------------------------------------------------------ |
| ReadWriteOnce    | RWO          | read-write mount on **one node**. Multiple Pods on the same node can access it |
| ReadOnlyMany     | ROX          | read-only from many nodes                                                      |
| ReadWriteMany    | RWX          | read-write from many nodes                                                     |
| ReadWriteOncePod | RWOP         | read-write from **one Pod** only (stable in v1.29, CSI volumes only)           |

- even if a volume supports several modes, it's mounted in **only one mode at a time**
- RWO/ROX/RWX don't actually constrain the volume. Creating it as ROX doesn't guarantee read-only. Only RWOP enforces a single Pod
- supported modes differ per volume plugin (for example, HostPath only does RWO)

### volumeMode

- `Filesystem` (default): mounted as a directory
- `Block`: exposed as a raw block device with no filesystem

### Reclaim policy

What happens to the PV after its PVC is deleted. The PV's `persistentVolumeReclaimPolicy` field.

| Policy    | Behavior                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Retain`  | the PV stays, in `Released` state. The old data is still there, so it can't bind to another PVC right away. An admin cleans it up manually |
| `Delete`  | deletes both the PV object and the external storage asset                                                                                  |
| `Recycle` | deprecated. `rm -rf /thevolume/*` then reuse. The official docs recommend dynamic provisioning instead                                     |

- manually created PVs default to `Retain`
- dynamically provisioned PVs inherit the StorageClass's `reclaimPolicy`, which defaults to `Delete`

### PV phases

| phase       | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `Available` | not yet bound to any PVC                             |
| `Bound`     | bound to a PVC                                       |
| `Released`  | the PVC is deleted, but it hasn't been reclaimed yet |
| `Failed`    | automatic reclamation failed                         |

### Storage Object in Use Protection

- a PVC in use by a Pod, or a PV bound to a PVC, isn't deleted right away even if you ask (held by a finalizer)
- it's actually deleted after the Pod using the PVC is gone

### StorageClass

- `apiVersion: storage.k8s.io/v1`, cluster-scoped
- fields: `provisioner` (required), `parameters`, `reclaimPolicy` (default `Delete`), `allowVolumeExpansion`, `volumeBindingMode` (default `Immediate`), `mountOptions`
- its name is the class name PVCs ask for. The admin sets the name and parameters when first creating it
- marking a default: annotation `storageclass.kubernetes.io/is-default-class: "true"`. If there are several, the most recent one is used

| volumeBindingMode      | Behavior                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Immediate`            | binds and provisions as soon as the PVC is created                                                                          |
| `WaitForFirstConsumer` | waits until a Pod using that PVC exists. The scheduler takes Pod placement into account when choosing the volume's location |

With `WaitForFirstConsumer`, using `nodeName` in the Pod bypasses the scheduler and the PVC stays Pending. The official docs suggest a `kubernetes.io/hostname` nodeSelector instead.

### Expanding a PVC

- when the StorageClass has `allowVolumeExpansion: true`, increasing the PVC's `spec.resources.requests.storage` expands it
- shrinking isn't supported

### Generic ephemeral volumes

- write a PVC spec inline in the Pod spec's `volumes[].ephemeral.volumeClaimTemplate` (stable in v1.23)
- when the Pod is created, the ephemeral volume controller creates a PVC in the same namespace, and the Pod owns that PVC
- PVC name: `<Pod name>-<volume name>`. For example, Pod `my-app` + volume `scratch-volume` → `my-app-scratch-volume`
- when the Pod is deleted, the garbage collector deletes the PVC. The StorageClass reclaim policy defaults to `Delete`, so the volume usually goes too
- similar use to `emptyDir`, but you get storage driver features like network storage, a fixed size, and snapshot/clone/resize
- watch for name collisions: Pod `pod-a` + volume `scratch` and Pod `pod` + volume `a-scratch` both give `pod-a-scratch`. It can also collide with a manually created PVC in the same namespace. On a collision the existing PVC is left alone, but the Pod can't start
- binding mode the official docs recommend: `WaitForFirstConsumer`

## Examples

### emptyDir: sharing between containers

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

### configMap volume: just one key as a file

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

The `log_level` key of `log-config` lands at `/etc/config/log_level.conf`.

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

- both PV and PVC use `storageClassName: ""`, so even with a default StorageClass it binds to this PV without dynamic provisioning
- a 500Mi request binds to a 1Gi PV (getting more than requested is allowed)
- per the official docs, `hostPath` PVs are for single-node testing

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

Replace `provisioner` with the name of a CSI driver installed in your cluster. Because of `WaitForFirstConsumer`, it's normal for this PVC to stay `Pending` until a Pod using it exists.

### Generic ephemeral volume

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

The `fast` class's provisioner above is a placeholder name, so as written the PVC and the Pod stay `Pending`. To try it on kind, change `storageClassName` to the default class `standard`: the `my-app-scratch-volume` PVC gets Bound, and deleting the Pod takes the PVC with it.

### kubectl for checking

```bash
kubectl get pv
kubectl get pvc -A
kubectl describe pvc pvc-data          # find why it's Pending in Events
kubectl get storageclass               # the default class is marked (default)
kubectl get pvc my-app-scratch-volume  # the PVC a generic ephemeral volume created
kubectl patch pv pv-data -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## Easily confused

| Item                             | emptyDir               | hostPath                        | generic ephemeral                 | PVC (persistent)                          |
| -------------------------------- | ---------------------- | ------------------------------- | --------------------------------- | ----------------------------------------- |
| Lifetime                         | Pod                    | node (independent of the Pod)   | Pod                               | the PV's, independent of the Pod          |
| Where the data lives             | node-local disk or RAM | a specific path on the node     | storage driver                    | storage driver                            |
| When rescheduled to another node | no data                | whatever is at that node's path | a new PVC                         | the same data (if the access mode allows) |
| PVC object                       | none                   | none                            | created and deleted automatically | created and deleted by the user           |

| Easily confused pair                  | Difference                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| RWO vs RWOP                           | RWO is per node; several Pods on the same node are fine. RWOP is one Pod in the whole cluster |
| `Retain` vs `Delete`                  | after the PVC is deleted the PV stays `Released` vs the PV and the actual storage are deleted |
| `storageClassName: ""` vs omitted     | only PVs with no class vs the default StorageClass applies                                    |
| `Immediate` vs `WaitForFirstConsumer` | binds as soon as the PVC is created vs Pending until a Pod exists                             |
| PV vs PVC scope                       | PV is cluster-scoped, PVC is namespaced                                                       |
| configMap volume vs `subPath` mount   | a full mount picks up ConfigMap changes, `subPath` doesn't                                    |

## Exam tips

### Solving it quickly

- PV, PVC, and StorageClass have no `kubectl create` subcommand → copy the YAML from the official docs and edit it
- for the Pod, build a skeleton with `kubectl run <name> --image=<img> --dry-run=client -o yaml > pod.yaml`, then add `volumes`/`volumeMounts`

### kubectl explain

```bash
kubectl explain pod.spec.volumes                                # list of volume types
kubectl explain pod.spec.volumes.persistentVolumeClaim          # claimName, readOnly
kubectl explain pod.spec.volumes.emptyDir                       # medium, sizeLimit
kubectl explain pod.spec.volumes.ephemeral.volumeClaimTemplate  # generic ephemeral volume
kubectl explain pv.spec --recursive | less                      # PV field tree
kubectl explain pvc.spec                                        # accessModes, resources, storageClassName
kubectl explain storageclass                                    # provisioner, volumeBindingMode
```

## References

- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)
- [PersistentVolume API reference](https://kubernetes.io/docs/reference/kubernetes-api/config-and-storage-resources/persistent-volume-v1/) (default for `persistentVolumeReclaimPolicy`)
