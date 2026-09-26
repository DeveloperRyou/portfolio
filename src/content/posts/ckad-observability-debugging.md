---
title: "CKAD concept notes: monitoring, logs, and debugging"
description: "Checking state with kubectl get/describe/events/top, reading logs with kubectl logs, and looking inside containers with exec and debug, based on the official docs."
pubDatetime: 2026-09-26T12:13:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "logging", "debugging"]
order: 14
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### What to look at

| What you want to see                           | Command                                | Source                                             |
| ---------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Pod list with STATUS and RESTARTS              | `kubectl get pods`                     | API server                                         |
| container State, Reason, Restart Count, events | `kubectl describe pod <pod>`           | API server (Pod + Event)                           |
| everything the system knows                    | `kubectl get pod <pod> -o yaml`        | API server                                         |
| namespace events                               | `kubectl events`, `kubectl get events` | Event resources                                    |
| CPU/memory usage                               | `kubectl top pod`, `kubectl top node`  | Metrics API (metrics-server)                       |
| application output                             | `kubectl logs`                         | stdout/stderr the kubelet saved on the node        |
| inside the container                           | `kubectl exec`, `kubectl debug`        | the running container / a newly attached container |

### Pod phase and kubectl's STATUS are different values

- `phase` is an API field. There are only five values: `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`
- the STATUS column of `kubectl get pods` is a display value built for humans. `CrashLoopBackOff`, `Terminating`, and `OOMKilled` show up there, but they aren't phase values
- the real cause has to be read per container. Container states are `Waiting`, `Running`, `Terminated`, and `Waiting` and `Terminated` carry a Reason

### Where container logs live

- the container runtime receives what a container writes to stdout/stderr, and the kubelet saves it as files under `/var/log/pods` on the node
- when a container restarts, the kubelet keeps one terminated container and its logs by default → that's what `--previous` reads
- if the Pod is evicted from the node, its containers and logs are deleted with it
- log rotation is the kubelet's job. `containerLogMaxSize` defaults to 10Mi, `containerLogMaxFiles` to 5
- `kubectl logs` only reads the latest log file. If 40MiB is written and rotated every 10MiB, you see at most 10MiB
- an app that only writes logs to files shows nothing in `kubectl logs`. For that case the official docs have a streaming sidecar pattern that `tail`s the file to its own stdout

### ephemeral containers

- a container temporarily added to an existing Pod. For troubleshooting only
- not put in the Pod spec directly but added through the API's `ephemeralcontainers` handler → `kubectl edit` can't add one
- constraints
  - no `ports`, `livenessProbe`, `readinessProbe`
  - no `resources` (a Pod's resource allocation is immutable)
  - no automatic restart, no resource or execution guarantees
  - can't be changed or removed once added
  - not supported for static Pods

## How it works

### Reading common failure states

| Shown as           | Where you see it              | Meaning                                                                                    | Check first                                                                                                            |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `Pending`          | phase                         | waiting to be scheduled or downloading the image                                           | Events in `describe`. `FailedScheduling` means not enough resources, a nodeSelector mismatch, or a `hostPort` conflict |
| `ImagePullBackOff` | container `Waiting` Reason    | can't pull the image. Wrong image name, a private registry with no `imagePullSecret`, etc. | image name and tag, registry access                                                                                    |
| `CrashLoopBackOff` | container `Waiting` Reason    | it keeps starting and exiting, and a restart back-off is in effect                         | `logs --previous`, Last State and Exit Code in `describe`                                                              |
| `OOMKilled`        | container `Terminated` Reason | went over its memory limit and the kernel killed it. `exitCode: 137`                       | `resources.limits.memory`, `top pod`                                                                                   |

### Back-off timing

- container restarts: grows like 10s, 20s, 40s ... and stops growing at 300 seconds (5 minutes)
- after running without problems for 10 minutes, the back-off timer resets
- image pull retries grow the same way, capped at 300 seconds
- so even right after a fix it can keep showing `CrashLoopBackOff` for a while. Recreating the Pod is faster if you want to check right away

### CrashLoopBackOff causes (the official docs' list)

- the application exits with an error
- configuration errors: wrong environment variables, missing config files
- not enough memory or CPU
- a failing liveness or startup probe

### The three modes of kubectl debug

```text
kubectl debug <pod> --image=...               # add an ephemeral container to an existing Pod
kubectl debug <pod> --copy-to=<new> ...       # copy the Pod into a new Pod (the original is untouched)
kubectl debug node/<node> --image=...         # create a debugging Pod on a node
```

- ephemeral container mode: `--target=<container>` shares the target container's process namespace. If the runtime doesn't support it, the target's processes may not show up in `ps`
- copy mode: add a new container, replace an existing container's command with `--container`, swap images with `--set-image`. `--share-processes` lets containers in the Pod see each other's processes
- node mode: the node's root filesystem is mounted at `/host`, and it uses the host IPC/Network/PID namespaces. It isn't privileged, so use `--profile=sysadmin` if you need that
- `--profile` values: `legacy`, `general`, `baseline`, `restricted`, `netadmin`, `sysadmin`. Without one, `legacy` is used, and kubectl 1.35 then warns `--profile=legacy is deprecated and will be removed in the future` and suggests passing `--profile=general` explicitly
- with `-i` it attaches to the new container automatically. If the connection drops, reattach with `kubectl attach`
- without `--container`, the container name is generated (`debugger-xxxxx`)

## Examples

### State and events

```bash
kubectl get pods -o wide
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'
kubectl describe pod <pod>

# events are per namespace
kubectl get events --sort-by='.lastTimestamp'
kubectl get events -n my-namespace
kubectl events --for pod/<pod> --watch
kubectl events --types=Warning

# metrics (needs metrics-server)
kubectl top node
kubectl top pod --sort-by=memory
kubectl top pod <pod> --containers
```

### Pulling out just the termination reason

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
kubectl get pod <pod> -o go-template='{{range .status.containerStatuses}}{{.lastState.terminated.message}}{{end}}'
```

- the termination message is what the container wrote to `terminationMessagePath` (default `/dev/termination-log`)
- with `terminationMessagePolicy: FallbackToLogsOnError`, if the file is empty and it exited with an error, the tail of the log (2048 bytes or 80 lines, whichever is smaller) is used instead

### Logs

```bash
kubectl logs <pod>
kubectl logs <pod> -c <container>          # multi-container Pod
kubectl logs <pod> --previous              # the container that terminated last (-p)
kubectl logs -f <pod>                      # stream
kubectl logs <pod> --all-containers=true
kubectl logs -l app=nginx --all-containers=true
kubectl logs deployment/nginx -c nginx-1
kubectl logs --tail=20 <pod>
kubectl logs --since=1h <pod>
kubectl logs <pod> --timestamps=true --prefix
```

### Streaming sidecar

A trimmed-down version of the example in the official docs. The app only writes logs to a file, and the sidecar streams that file to its own stdout.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: counter
spec:
  containers:
    - name: count
      image: busybox:1.28
      args:
        - /bin/sh
        - -c
        - >
          i=0;
          while true;
          do
            echo "$i: $(date)" >> /var/log/1.log;
            i=$((i+1));
            sleep 1;
          done
      volumeMounts:
        - name: varlog
          mountPath: /var/log
    - name: count-log-1
      image: busybox:1.28
      args: [/bin/sh, -c, "tail -n+1 -F /var/log/1.log"]
      volumeMounts:
        - name: varlog
          mountPath: /var/log
  volumes:
    - name: varlog
      emptyDir: {}
```

```bash
kubectl logs counter count-log-1
```

### exec

```bash
kubectl exec <pod> -- ls /
kubectl exec <pod> -c <container> -- cat /etc/config/app.conf
kubectl exec -it <pod> -- sh
```

- whatever comes after `--` is the command run in the container
- if the image has no `sh`, it fails with `executable file not found in $PATH` → move on to `kubectl debug`

### debug

```bash
# add an ephemeral container to an image with no shell
kubectl run ephemeral-demo --image=registry.k8s.io/pause:3.1 --restart=Never
kubectl debug -it ephemeral-demo --image=busybox:1.28 --target=ephemeral-demo
kubectl describe pod ephemeral-demo        # added under "Ephemeral Containers:"

# a container that dies right after starting: replace its command with a shell in a copy
kubectl run --image=busybox:1.28 myapp -- false
kubectl debug myapp -it --copy-to=myapp-debug --container=myapp -- sh

# add a debugging tools container to a copy + share processes
kubectl debug myapp -it --image=ubuntu --share-processes --copy-to=myapp-debug

# swap every container image in the copy
kubectl debug myapp --copy-to=myapp-debug --set-image=*=ubuntu

# node
kubectl debug node/mynode -it --image=ubuntu

# cleanup
kubectl delete pod myapp myapp-debug
```

## Easily confused

### exec, ephemeral container, copy

|                             | `kubectl exec`                | `kubectl debug <pod> --image`                   | `kubectl debug <pod> --copy-to` |
| --------------------------- | ----------------------------- | ----------------------------------------------- | ------------------------------- |
| Target                      | an existing running container | adds a new container to the existing Pod        | a new Pod                       |
| Needs a shell in the image  | yes                           | no (uses the debug image)                       | no                              |
| If the container is dead    | no                            | yes                                             | yes (replace the command)       |
| Changes to the original Pod | none                          | an ephemeral container stays (can't be removed) | none                            |
| Cleanup                     | none                          | stays until the Pod is deleted                  | delete the copied Pod           |

### --target vs --share-processes

|             | `--target=<container>`                           | `--share-processes`               |
| ----------- | ------------------------------------------------ | --------------------------------- |
| Mode        | ephemeral container                              | `--copy-to`                       |
| Scope       | the process namespace of one specified container | every container in the copied Pod |
| Requirement | container runtime support                        | applied through the Pod settings  |

### logs options

| Option             | Meaning                          | Note                                                              |
| ------------------ | -------------------------------- | ----------------------------------------------------------------- |
| `-c`               | pick a container                 | can be omitted if there's only one                                |
| `-p`, `--previous` | the previous terminated instance | reads the one terminated container the kubelet kept               |
| `-f`               | stream                           | Ctrl+C to stop                                                    |
| `--all-containers` | all containers                   | with `-l`, every container in several Pods                        |
| `-l`               | label selector                   | concurrent requests are capped by `--max-log-requests`, default 5 |

### get events vs events

|                     | `kubectl get events`                 | `kubectl events`                              |
| ------------------- | ------------------------------------ | --------------------------------------------- |
| Chronological order | `--sort-by='.lastTimestamp'`         | the default output is a list of recent events |
| One resource only   | look at Events in `describe` instead | `--for pod/<name>`                            |
| Type filter         | -                                    | `--types=Warning`                             |
| Keep watching       | `--watch`                            | `--watch`                                     |

## Exam tips

### Commands to type first

```bash
kubectl get pods -A | grep -v Running
kubectl describe pod <pod> | grep -A10 -E 'State|Events'
kubectl logs <pod> -c <container> --previous
kubectl get events -n <ns> --sort-by='.lastTimestamp'
```

- `logs` is no use for a Pending Pod. The container hasn't started, so there are no logs. Start with Events in `describe`
- with `CrashLoopBackOff`, the current container has just started and died, so `logs` can be empty. Use `--previous`
- for `OOMKilled`, look at the Last State Reason and Exit Code 137 in `describe` together with `resources.limits.memory`
- events are per namespace. Without `-n` you only see the default namespace
- if `kubectl top` errors out, suspect whether the Metrics API (metrics-server) is deployed before blaming the command

### kubectl explain

```bash
kubectl explain pod.status.containerStatuses.state            # waiting / running / terminated
kubectl explain pod.status.containerStatuses.lastState        # termination reason and exitCode before the restart
kubectl explain pod.spec.containers.terminationMessagePolicy  # File / FallbackToLogsOnError
kubectl explain pod.spec.ephemeralContainers                  # the containers kubectl debug adds
kubectl explain event                                         # reason, involvedObject, type
```

## References

- [CKAD Curriculum v1.35 (cncf/curriculum)](https://github.com/cncf/curriculum/blob/master/CKAD_Curriculum_v1.35.pdf)
- [Troubleshooting Applications](https://kubernetes.io/docs/tasks/debug/debug-application/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Determine the Reason for Pod Failure](https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [kubectl events](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_events/)
- [Ephemeral Containers](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Images: ImagePullBackOff](https://kubernetes.io/docs/concepts/containers/images/#imagepullbackoff)
- [Assign Memory Resources to Containers and Pods](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
