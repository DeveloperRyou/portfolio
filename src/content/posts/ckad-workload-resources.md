---
title: "CKAD concept notes: choosing a workload resource"
description: "What Deployment, StatefulSet, DaemonSet, Job, and CronJob each guarantee, and when to pick which, compared against the official docs."
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

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## How to choose

| Question                                                                                         | Pick        |
| ------------------------------------------------------------------------------------------------ | ----------- |
| a set number of stateless replicas, with rolling updates and rollbacks                           | Deployment  |
| a fixed name and DNS per Pod, a dedicated PersistentVolume per Pod, ordered rollout and scaling  | StatefulSet |
| one Pod on every node (or every matching node). Log collection, node monitoring, storage daemons | DaemonSet   |
| work that runs to completion and needs its successes counted                                     | Job         |
| work that repeats on a schedule, like backups or report generation                               | CronJob     |

The StatefulSet docs say to use a Deployment or ReplicaSet if you don't need stable identifiers or ordering. The DaemonSet docs draw the same line: use a Deployment when replica count and rollouts matter, a DaemonSet when it matters which node the Pod lands on.

## Deployment and ReplicaSet

A Deployment provides declarative updates for Pods and ReplicaSets. You write the desired state and the Deployment controller moves the actual state toward it.

- structure: Deployment → ReplicaSet → Pod. The ReplicaSet name and the `pod-template-hash` label on Pods are added by the Deployment controller
- don't touch ReplicaSets owned by a Deployment directly
- a rollout only happens when `.spec.template` changes. Changing the image or template labels triggers one; changing `replicas` (scaling) doesn't
- each rollout creates a new ReplicaSet and bumps the revision. Old ReplicaSets are kept up to `.spec.revisionHistoryLimit` (default 10). At 0 you can't roll back
- in `apps/v1`, `.spec.selector` is required and can't be changed after creation. It has to match `.spec.template.metadata.labels` or the API rejects it
- the template's `restartPolicy` only allows `Always`

### Update strategy

| `.spec.strategy.type`     | Behavior                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `RollingUpdate` (default) | gradually scales the new ReplicaSet up and the old one down |
| `Recreate`                | kills all existing Pods before creating new ones            |

`RollingUpdate` settings:

- `maxUnavailable`: max Pods that can be unavailable during the update. Default 25%, percentages round down
- `maxSurge`: max Pods that can be created above the desired count. Default 25%, percentages round up
- they can't both be 0

## StatefulSet

A StatefulSet keeps a stable identity for each Pod. Use it when you need one or more of:

- stable, unique network identifiers
- stable persistent storage
- ordered deployment and scaling
- ordered automated rolling updates

"Stable" here means it survives the Pod being rescheduled.

### Identity

- Pod name: `$(statefulset name)-$(ordinal)`. With 3 replicas: `web-0`, `web-1`, `web-2`
- DNS: a headless Service (`clusterIP: None`) controls the domain. Each Pod gets `$(podname).$(service name).$(namespace).svc.cluster.local`
- the StatefulSet doesn't create the headless Service for you. Create it yourself and put its name in `.spec.serviceName`
- storage: each `volumeClaimTemplates` entry gives every Pod its own PersistentVolumeClaim. If the Pod is rescheduled onto another node it mounts the same PVC

### Ordering

- creation goes from 0 to N-1 in order, deletion from N-1 down to 0
- before the next Pod is created, every lower-numbered Pod has to be Running and Ready
- this is `.spec.podManagementPolicy: OrderedReady` (the default). With `Parallel` it creates and deletes Pods all at once without waiting. The unique identity guarantee still holds

### Updates and deletion

- `.spec.updateStrategy.type`: `RollingUpdate` (default) deletes and recreates Pods one at a time from the highest ordinal down. `OnDelete` doesn't update automatically; a Pod gets the new template only when you delete it
- setting `rollingUpdate.partition` updates only Pods with an ordinal at or above that value
- deleting or scaling down a StatefulSet doesn't delete its volumes. The `whenDeleted` and `whenScaled` defaults in `.spec.persistentVolumeClaimRetentionPolicy` are `Retain`
- deleting a StatefulSet doesn't guarantee any Pod termination order. To bring them down in order, scale replicas to 0 first

## DaemonSet

A DaemonSet ensures that all (or some) nodes run one copy of a Pod.

- when a node is added a Pod is added; when a node goes away its Pod is garbage collected. Deleting the DaemonSet cleans up the Pods it created
- only some nodes: set `.spec.template.spec.nodeSelector` or `affinity`. With neither, it's every node
- tolerations like `node.kubernetes.io/unschedulable:NoSchedule` are added automatically, so it can run on nodes marked unschedulable
- the template's `restartPolicy` must be `Always` or left empty (defaults to `Always`)
- `.spec.selector` can't be changed after creation and must match the template labels
- `.spec.updateStrategy.type`: `RollingUpdate` (default) or `OnDelete`
- there's no replica count field. The count comes from the number of matching nodes

## Job

A Job creates one or more Pods and keeps retrying until a given number of them terminate successfully. When enough successes are reached, the Job is complete.

- the template's `restartPolicy` only allows `Never` or `OnFailure`
- `.spec.template` is the only required field in `.spec`. You almost never set `.spec.selector`

### completions and parallelism

| Kind                   | Settings                                                                     | Complete when                                     |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| non-parallel           | leave both empty (both default to 1)                                         | one Pod terminates successfully                   |
| fixed completion count | set `completions` to a positive number. `parallelism` defaults to 1 if empty | `completions` Pods have succeeded                 |
| work queue             | leave `completions` empty and set only `parallelism`                         | at least one Pod succeeds and all have terminated |

- `parallelism: 0` effectively pauses the Job
- in a fixed completion count Job, the actual number running at once never exceeds the remaining completions
- `.spec.completionMode`: `NonIndexed` (default) or `Indexed`. With `Indexed`, each Pod gets an index from 0 to `completions-1`, readable inside the container as the `JOB_COMPLETION_INDEX` environment variable. It's complete when there's one successful Pod per index

### Failure handling

- `.spec.backoffLimit`: retries before the Job is considered failed. Default 6 (the default changes if you use `backoffLimitPerIndex`)
- failed Pods are recreated with delays of 10s, 20s, 40s ... up to 6 minutes
- with `restartPolicy: OnFailure`, the Pod stays on the node and only the container reruns. With `Never`, the Pod fails and the Job controller creates a new Pod
- with `OnFailure`, hitting backoffLimit terminates the Pod, which makes the logs hard to get at. The docs recommend `Never` while debugging
- `.spec.activeDeadlineSeconds`: time limit for the whole Job. Takes precedence over `backoffLimit`. When exceeded, all running Pods are terminated and the Job fails with `reason: DeadlineExceeded`
- `activeDeadlineSeconds` exists in both the Job spec and the Pod spec, so it's easy to put in the wrong place
- a Job that ended in failure doesn't restart on its own

### Cleanup

- finished Jobs and their Pods stay around by default, so you can still read logs and status
- `kubectl delete job <name>` deletes the Pods as well
- set `.spec.ttlSecondsAfterFinished` to have it deleted automatically that long after it finishes

## CronJob

A CronJob creates Jobs on a repeating schedule. It's one line of a crontab.

- `.spec.schedule` (required): Cron format `minute hour day-of-month month day-of-week`. `0 3 * * 1` is every Monday at 03:00. Steps like `*/2` and macros like `@monthly` work too
- `.spec.jobTemplate` (required): the same schema as a Job spec, minus `apiVersion` and `kind`
- `.spec.timeZone`: without it, the kube-controller-manager's local time zone is used. Putting `CRON_TZ` or `TZ` inside `schedule` is a validation error
- the name can be at most 52 characters, because the controller appends 11 characters to form Job names and Job names are limited to 63

### Concurrency and delays

| `.spec.concurrencyPolicy` | If the previous Job is still running     |
| ------------------------- | ---------------------------------------- |
| `Allow` (default)         | run concurrently                         |
| `Forbid`                  | skip this run                            |
| `Replace`                 | replace the running Job with the new one |

- only applies between Jobs created by the same CronJob. Jobs from different CronJobs can always run concurrently
- `.spec.startingDeadlineSeconds`: how late (in seconds) a run can still start if it missed its scheduled time. Past that, the run is skipped and counted as failed. Under 10 seconds it may never get scheduled, since the controller checks every 10 seconds
- if more than 100 schedules have been missed, it doesn't start the Job and logs an error
- `.spec.suspend: true`: stops future runs. Jobs already started aren't affected
- `.spec.successfulJobsHistoryLimit` defaults to 3, `.spec.failedJobsHistoryLimit` to 1
- editing a CronJob doesn't touch Jobs already started. Changes apply from the next new Job
- a single scheduled run can produce two Jobs or none, so Jobs should be idempotent

## Examples

### Imperative skeletons

```bash
kubectl create deployment web --image=nginx --replicas=3
kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle 'print bpi(2000)'
kubectl create cronjob hello --image=busybox:1.28 --schedule="*/1 * * * *" -- date
kubectl create job hello-manual --from=cronjob/hello

# dump to YAML and edit
kubectl create job pi --image=perl:5.34.0 --dry-run=client -o yaml > job.yaml
```

`kubectl create` has no `statefulset` or `daemonset` subcommand. Write the YAML yourself, or dump a Deployment YAML and edit it. To turn it into a DaemonSet, change `kind` and delete `replicas` and `strategy` (the DaemonSet field is called `updateStrategy`).

### Deployment rollout

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

`CHANGE-CAUSE` comes from the `kubernetes.io/change-cause` annotation. The `--record` flag is deprecated.

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

### StatefulSet and headless Service

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

If `storageClassName` is left empty, the default StorageClass is used.

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

## Easily confused

|                         | Deployment                             | StatefulSet                                  | DaemonSet                                    | Job                                               | CronJob                       |
| ----------------------- | -------------------------------------- | -------------------------------------------- | -------------------------------------------- | ------------------------------------------------- | ----------------------------- |
| apiVersion              | `apps/v1`                              | `apps/v1`                                    | `apps/v1`                                    | `batch/v1`                                        | `batch/v1`                    |
| How many                | `replicas`                             | `replicas`                                   | number of matching nodes                     | `completions`, `parallelism`                      | one Job per schedule          |
| Pod name                | `name-hash-random`                     | `name-ordinal`, fixed                        | random                                       | random (with `Indexed`, hostname is `name-index`) | based on the CronJob name     |
| Storage                 | shared or none                         | PVC per Pod                                  | usually node-local                           | -                                                 | -                             |
| Update strategy field   | `strategy`: `RollingUpdate`/`Recreate` | `updateStrategy`: `RollingUpdate`/`OnDelete` | `updateStrategy`: `RollingUpdate`/`OnDelete` | -                                                 | edits apply from the next Job |
| Allowed `restartPolicy` | `Always`                               | `Always`                                     | `Always`                                     | `OnFailure`, `Never`                              | `OnFailure`, `Never`          |
| Imperative create       | yes                                    | no                                           | no                                           | yes                                               | yes                           |

- Deployment uses `strategy`, StatefulSet and DaemonSet use `updateStrategy`. Even the field names differ
- `Recreate` only guarantees that old Pods are terminated first during an upgrade. If you delete a Pod by hand, the ReplicaSet creates a replacement right away. If you need an "at most one" guarantee, the docs point you to StatefulSet
- a Job's `restartPolicy` applies to its Pods. If the Job itself fails, it doesn't run again

## Exam tips

- for the ones that can be created imperatively (Deployment, Job, CronJob), generate a skeleton with `kubectl create ... --dry-run=client -o yaml` and add only the fields you need
- StatefulSet and DaemonSet have no imperative command → copy the example from the docs and check fields with the explain commands below
- in a CronJob, `jobTemplate.spec.template.spec` is three levels of nesting, so `restartPolicy` often ends up in the wrong spot
- a Job template with no `restartPolicy`, or with `Always`, is rejected
- don't mix up `completions` and `parallelism`. Total successes is `completions`, how many run at once is `parallelism`
- `activeDeadlineSeconds` goes directly under the Job `spec`. The Pod template spec has a field with the same name
- `kubectl rollout undo` goes back to the previous revision. For a specific one, use `--to-revision`
- to test a CronJob by hand: `kubectl create job <name> --from=cronjob/<cronjob>`
- neither a Deployment's nor a DaemonSet's selector can be changed after creation. If it's wrong, delete and recreate

### kubectl explain

```bash
kubectl explain job.spec                                                   # completions, parallelism, backoffLimit, activeDeadlineSeconds
kubectl explain cronjob.spec                                               # schedule, concurrencyPolicy, history limits
kubectl explain cronjob.spec.jobTemplate.spec.template.spec.restartPolicy  # check the deep path in one go
kubectl explain statefulset.spec                                           # serviceName, volumeClaimTemplates
kubectl explain daemonset.spec.updateStrategy
```

## References

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
