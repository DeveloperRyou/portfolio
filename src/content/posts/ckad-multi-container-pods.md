---
title: "CKAD concept notes: multi-container Pod patterns"
description: "Init containers, native sidecars vs. the classic sidecar approach, the ambassador and adapter patterns, and ephemeral containers, compared against the official docs."
pubDatetime: 2026-09-26T12:02:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "pod", "init-container", "sidecar"]
order: 3
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Container types inside a Pod

| Type                | Defined in                                      | When it runs                                     | Restarts                       | Probes      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------ | ------------------------------ | ----------- |
| app container       | `spec.containers`                               | after the init phase, in parallel                | Pod `restartPolicy`            | supported   |
| init container      | `spec.initContainers`                           | before the app, one by one, to completion        | retried on failure (see below) | not allowed |
| sidecar (native)    | `spec.initContainers` + `restartPolicy: Always` | started in the defined order, then keeps running | always                         | supported   |
| ephemeral container | `ephemeralcontainers` subresource               | when a user adds one                             | never                          | not allowed |

### What they share

- network: one Pod IP shared by all. Containers talk to each other over `localhost:<port>`, so ports must not collide
- storage: each container mounts volumes defined in `spec.volumes` via `volumeMounts`. Files passed between containers usually go through an `emptyDir`
- IPC: SystemV semaphores and POSIX shared memory also work
- the process namespace is separate by default. Turn on process namespace sharing if you need it

## init containers

Containers that do preparation work before the Pod starts. The docs give examples like waiting for a Service to exist, cloning a Git repository into a volume, or rendering a config file from a template.

- they use a separate image from the app, so tools like `sed` or `dig` don't have to live in the app image
- they can be given access to Secrets the app containers can't see
- used to hold back the app until some condition is met

### How it works

1. Once networking and storage are ready, the kubelet runs the init containers in the order they appear in the spec
2. Each init container has to succeed (exit 0) before the next one starts
3. When they're all done, the app containers start

On failure:

- Pod `restartPolicy` is `Never`: the whole Pod is marked failed
- `OnFailure`: that init container is retried
- `Always`: init containers get `OnFailure` behavior

Other rules:

- until init finishes, the Pod phase is `Pending` and the `Initialized` condition is false. `kubectl get` shows STATUS as `Init:0/2`
- regular init containers can't use `lifecycle`, `livenessProbe`, `readinessProbe`, or `startupProbe`. Adding one gets the Pod rejected by the API server with `Forbidden: may not be set for init containers without restartPolicy=Always`
- they can run more than once, so write them to be idempotent. A file you write into an `emptyDir` may already be there
- on a running Pod, only an init container's `image` can be changed, and changing it doesn't restart the Pod
- container names must be unique across init and app containers
- ports on init containers aren't tied to Services

### Resource accounting

- the largest request/limit among the init containers = the effective init request/limit
- the Pod's effective request/limit = max(sum of app and sidecar containers, effective init value) + pod overhead
- scheduling uses these effective values, so a big init container reserves resources that are only used during initialization

## sidecars

A container running next to the main app to handle supporting work like log shipping, monitoring, or data sync. The point is to add functionality without touching the app code.

### native sidecars

The approach introduced by the `SidecarContainers` feature gate (enabled by default since v1.29). Put `restartPolicy: Always` on an `initContainers` entry and it becomes a sidecar.

- ordering is guaranteed like init containers. Once a sidecar reaches `started`, the next init container begins. If it has a `startupProbe`, that probe has to pass before it counts as `started`
- after starting, it keeps running until the Pod ends. If it exits, it's restarted regardless of the Pod `restartPolicy`
- probes are supported. The `readinessProbe` result feeds into the Pod's ready status
- on Pod shutdown: sidecars only get TERM after the main containers have fully stopped, and they stop in reverse order of definition
- in a Job, once the main container finishes the Job completes even if the sidecar is still running
- changing the image restarts just that container, not the Pod
- if the main containers use up the whole grace period during shutdown, sidecars can get SIGKILL right away. A non-zero exit code in that case can be treated as normal

### classic sidecars

Add another app container under `containers`. This works on older versions without per-container `restartPolicy`, and it's still valid today. Since it's just a regular app container, though:

- there's no guarantee it starts before the app
- it's a problem in Jobs. A Pod only becomes `Succeeded` when every container has exited, so a sidecar that keeps running means it never finishes

The official docs also say that if start and stop order don't matter and every container is needed for the Pod to work, this approach is good enough.

## ambassador and adapter

Patterns introduced alongside the sidecar in the 2015 Kubernetes blog post "Patterns for Composite Containers". The current concepts docs have no separate entry for them, and there's no dedicated field either; you just add containers.

| Pattern    | Role                                         | Example (from the blog)                                                                                                |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| sidecar    | extends the main container                   | nginx + a container that syncs a Git repo, sharing the filesystem                                                      |
| ambassador | local proxy that handles outside connections | the app connects to Redis on `localhost`, and the ambassador splits reads/writes and forwards them to the real servers |
| adapter    | converts output to a standard format         | turns each app's different monitoring data format into a common one                                                    |

The ambassador relies on the shared network namespace; the adapter relies on a shared volume or `localhost`. All three are implemented with `containers` or native sidecars.

## ephemeral containers

A temporary debugging container attached to a running Pod. Stable since v1.25.

- you can't add containers to a Pod after it's created, but ephemeral containers are added through the `ephemeralcontainers` subresource. That's also why `kubectl edit` can't add one
- once added, they can't be changed or removed
- no automatic restarts, no resource guarantees
- `ports`, `livenessProbe`, `readinessProbe`, and `resources` aren't allowed
- not available for static Pods
- when to use one: the container has crashed, or the image has no shell (distroless, for example) so `kubectl exec` doesn't work

```bash
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

`--target` joins the process namespace of the given container so you can see its processes. The container runtime has to support it; if it doesn't, the debug container may come up with a separate process namespace.

## Example

A Pod where an init container writes a config file and a native sidecar reads the app log.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  initContainers:
    - name: init-config
      image: busybox:1.36
      command: ["sh", "-c", 'echo "server_name=web" > /config/app.conf']
      volumeMounts:
        - name: config
          mountPath: /config
    - name: log-shipper
      image: busybox:1.36
      restartPolicy: Always
      command: ["sh", "-c", "touch /logs/app.log; tail -F /logs/app.log"]
      volumeMounts:
        - name: logs
          mountPath: /logs
  containers:
    - name: app
      image: busybox:1.36
      command:
        [
          "sh",
          "-c",
          "while true; do cat /config/app.conf >> /logs/app.log; sleep 5; done",
        ]
      volumeMounts:
        - name: config
          mountPath: /config
        - name: logs
          mountPath: /logs
  volumes:
    - name: config
      emptyDir: {}
    - name: logs
      emptyDir: {}
```

Order: `init-config` completes → `log-shipper` starts (started) → `app` starts. `log-shipper` keeps running alongside `app`.

To use the same sidecar the classic way, move it under `containers` and drop `restartPolicy`. `log-shipper` and `app` then start together, in no particular order.

```bash
kubectl apply -f web.yaml
kubectl get pod web                      # STATUS: Init:0/2 → Running
kubectl logs web -c init-config          # init container logs
kubectl logs web -c log-shipper -f       # sidecar logs
kubectl logs web --all-containers
kubectl exec -it web -c app -- sh
kubectl describe pod web                 # State/Reason under Init Containers
```

## Easily confused

### init container, native sidecar, classic sidecar

|                            | init container                 | native sidecar         | classic sidecar        |
| -------------------------- | ------------------------------ | ---------------------- | ---------------------- |
| Location                   | `initContainers`               | `initContainers`       | `containers`           |
| container `restartPolicy`  | none                           | `Always`               | none                   |
| Runs for                   | until it finishes              | the whole Pod lifetime | the whole Pod lifetime |
| Starts before the app      | yes (until complete)           | yes (until started)    | not guaranteed         |
| Probes                     | not allowed                    | supported              | supported              |
| Data exchange with the app | one way (leave it in a volume) | both ways              | both ways              |
| Blocks Job completion      | no                             | no                     | yes                    |
| Shutdown order             | n/a                            | after main, in reverse | no order               |

### `kubectl exec` vs `kubectl debug`

|                       | `kubectl exec`               | `kubectl debug` (ephemeral)         |
| --------------------- | ---------------------------- | ----------------------------------- |
| Image used            | the existing container image | a newly specified image             |
| Image without a shell | no                           | yes                                 |
| Crashed container     | no                           | yes                                 |
| Pod spec change       | none                         | an ephemeral container stays behind |

## Exam tips

### Commands

There's no imperative command that builds a multi-container Pod in one go. Generate a skeleton, then edit the YAML.

```bash
kubectl run web --image=busybox:1.36 --dry-run=client -o yaml \
  --command -- sh -c 'sleep 3600' > web.yaml
# write initContainers, the extra containers, and volumes by hand

kubectl logs <pod> -c <container>
kubectl exec -it <pod> -c <container> -- sh
kubectl debug -it <pod> --image=busybox:1.28 --target=<container>
```

### kubectl explain

```bash
kubectl explain pod.spec.initContainers
kubectl explain pod.spec.initContainers.restartPolicy  # Always = native sidecar
kubectl explain pod.spec.shareProcessNamespace         # sharing processes between containers
kubectl explain pod.spec.volumes.emptyDir              # sharing files between containers
kubectl explain pod.spec.containers.volumeMounts
```

## References

- [Init Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Ephemeral Containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [Pods: Pods with multiple containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/#how-pods-manage-multiple-containers)
- [Pod Lifecycle: Pod phase, Restart policy, Pod shutdown and sidecar containers | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Debug Running Pods: ephemeral container | Kubernetes](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#ephemeral-container)
- [Share Process Namespace between Containers in a Pod | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/)
- [The Distributed System ToolKit: Patterns for Composite Containers | Kubernetes Blog (2015)](https://kubernetes.io/blog/2015/06/the-distributed-system-toolkit-patterns/)
- [kubectl debug](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
