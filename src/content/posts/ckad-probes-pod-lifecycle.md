---
title: "CKAD concept notes: probes and the Pod lifecycle"
description: "Pod phase, conditions, container states, and restartPolicy first, then what actually happens when a liveness, readiness, or startup probe fails, compared against the official docs."
pubDatetime: 2026-09-26T12:03:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "probe", "pod-lifecycle"]
order: 4
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Pod phase

`status.phase` is a summary of where the Pod is in its lifecycle. The official docs are explicit that it isn't a state machine covering every container and Pod state.

| phase       | Meaning                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Pending`   | the cluster accepted the Pod, but one or more containers aren't ready to run yet. Includes time waiting for scheduling and downloading images |
| `Running`   | bound to a node and all containers created. At least one is running, starting, or restarting                                                  |
| `Succeeded` | every container exited successfully and won't be restarted                                                                                    |
| `Failed`    | every container has exited, at least one failed (non-zero exit or killed by the system), and it won't be restarted automatically              |
| `Unknown`   | the Pod's state couldn't be obtained, usually a problem talking to the node                                                                   |

`CrashLoopBackOff` and `Terminating` in the `STATUS` column of `kubectl get pod` aren't phases. They're display values kubectl shows; the phase is a field in the Pod API.

## Pod conditions

`status.conditions` is the list of conditions the Pod has or hasn't passed yet. The ones the kubelet manages that tie directly into probes:

| condition                   | Becomes `True` when                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `PodScheduled`              | the Pod is scheduled to a node                                                          |
| `PodReadyToStartContainers` | the sandbox is created and networking is configured (beta, on by default)               |
| `Initialized`               | all init containers have exited successfully                                            |
| `ContainersReady`           | every container in the Pod is ready                                                     |
| `Ready`                     | the Pod can serve requests and is added to the load balancing pool of matching Services |

Each condition carries `status` (`True`/`False`/`Unknown`), `lastTransitionTime`, `reason`, `message`, and so on. If you add custom conditions with `readinessGates`, the Pod is only ready when all containers are ready and every gate condition is `True`.

## Container state

Each container is in one of three states: `Waiting`, `Running`, `Terminated`. Check with `kubectl describe pod <name>`.

- `Waiting`: neither `Running` nor `Terminated`. It's doing work needed to start, like pulling the image or applying Secrets. A `Reason` field is shown with it
- `Running`: executing without issues. If there was a `postStart` hook, it has already finished
- `Terminated`: it started and then either completed or failed. Shows the reason, exit code, and start/finish times. A `preStop` hook runs before a container enters this state

## restartPolicy

Pod `spec.restartPolicy`. Values are `Always` (default), `OnFailure`, `Never`. Applies to app containers and regular init containers.

| exit code          | `Always` | `OnFailure` | `Never`    |
| ------------------ | -------- | ----------- | ---------- |
| 0 (success)        | restart  | no restart  | no restart |
| non-zero (failure) | restart  | restart     | no restart |

- restart delays use exponential backoff: 10s, 20s, 40s ... capped at 300s (5 minutes). After running cleanly for 10 minutes the backoff resets
- while the backoff is in effect, kubectl shows `CrashLoopBackOff`
- liveness/startup probe failures can also lead to `CrashLoopBackOff`
- sidecar containers (init containers with a per-container `restartPolicy: Always`) ignore the Pod `restartPolicy` and always restart
- workload constraints: Deployments only allow `Always`, Jobs only allow `OnFailure` or `Never`

## Probe types

|                | startup probe                                            | liveness probe                                                            | readiness probe                                                                                                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| What it checks | has the application finished starting                    | should the container keep running                                         | can it take traffic                                                                                                                    |
| When it runs   | only at startup; done once it succeeds                   | periodically, forever (after the startup probe succeeds, if there is one) | periodically for the whole container lifecycle (after the startup probe succeeds, if there is one)                                     |
| On failure     | the kubelet kills the container, `restartPolicy` applies | the kubelet kills the container, `restartPolicy` applies                  | the container is marked not ready, the Pod's `Ready` condition goes `False`, and the Pod IP is removed from EndpointSlices. No restart |
| Main use       | slow-starting containers                                 | states like a deadlock where it's running but not making progress         | warm-up, temporary overload, checking backend dependencies                                                                             |

### What changes when there's a startup probe

Liveness and readiness probes don't run until the startup probe succeeds. Their `initialDelaySeconds` also counts from the moment the startup probe succeeds.

The official docs recommend a startup probe when startup takes longer than `initialDelaySeconds + failureThreshold × periodSeconds`. Point it at the same endpoint as the liveness probe and give it a generous `failureThreshold`. Leave the liveness defaults alone.

### Does the liveness probe wait for readiness?

No. The two probes don't depend on each other succeeding. If you want liveness to start later, use `initialDelaySeconds` or a startup probe.

### What if a probe isn't defined?

That probe's result is always treated as `Success`. The exception: a defined readiness probe reports `Failure` until its initial delay passes. So a Pod with a readiness probe starts without traffic and only gets traffic once the probe succeeds.

### When a liveness probe is set up wrong

This is something the official docs call out with a caution box. A liveness probe should only fail when the container is truly unrecoverable (a deadlock, for example). If liveness fails under heavy load, containers restart one after another, the remaining Pods take on even more load, and it turns into a cascading failure.

If the process already dies on its own when something goes wrong, the kubelet handles it through `restartPolicy` without any liveness probe. A common pattern is to use the same lightweight HTTP endpoint as readiness but give liveness a higher `failureThreshold`. That way the Pod stays not-ready for a while before it gets killed.

## Probe handlers

Each probe specifies exactly one of these four.

| Handler     | Success when                                                          | Notes                                                                                                                  |
| ----------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `exec`      | a command run inside the container exits 0                            | forks a process every time. With dense Pods and short periods it adds CPU load on the node                             |
| `httpGet`   | GET to the Pod IP returns a status of at least 200 and below 400      | `path` defaults to `/`, `scheme` to `HTTP`. HTTPS doesn't verify the certificate                                       |
| `tcpSocket` | a TCP connection to the port is established                           | the connection is made from the node. Putting a Service name in `host` won't work because the kubelet can't resolve it |
| `grpc`      | the `status` in a gRPC Health Checking Protocol response is `SERVING` | stable in v1.27. `port` is required, named ports aren't allowed                                                        |

The result is `Success`, `Failure`, or `Unknown`. `Unknown` means the diagnostic itself failed, so nothing happens and it moves on to the next check.

For `httpGet` and `tcpSocket`, `port` can take a `ports[].name` (named port) instead of a number.

## Timing fields

| Field                           | Default                              | Minimum | Meaning                                                                                                                                  |
| ------------------------------- | ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `initialDelaySeconds`           | 0                                    | 0       | wait after the container starts before the first probe                                                                                   |
| `periodSeconds`                 | 10                                   | 1       | probe interval                                                                                                                           |
| `timeoutSeconds`                | 1                                    | 1       | probe timeout                                                                                                                            |
| `successThreshold`              | 1                                    | 1       | consecutive successes needed after a failure to count as success. Must be 1 for liveness and startup                                     |
| `failureThreshold`              | 3                                    | 1       | when consecutive failures reach this, the check as a whole fails                                                                         |
| `terminationGracePeriodSeconds` | inherited from the Pod (30 if unset) | 1       | time to wait before SIGKILL when a probe failure takes the container down. Can't be set on a readiness probe (the API server rejects it) |

The maximum startup time a startup probe allows is `failureThreshold × periodSeconds`. With `failureThreshold: 30` and `periodSeconds: 10`, that's 300 seconds.

## Examples

### A Pod with all three probes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: probe-demo
spec:
  containers:
    - name: app
      image: registry.k8s.io/e2e-test-images/agnhost:2.40
      args: ["liveness"]
      ports:
        - name: http
          containerPort: 8080
      startupProbe:
        httpGet:
          path: /healthz
          port: http
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 10
        failureThreshold: 3
      readinessProbe:
        tcpSocket:
          port: 8080
        periodSeconds: 5
```

- for up to 300 seconds after start, the startup probe watches `/healthz`. Once it succeeds, liveness and readiness take over
- the image and `args` come from the HTTP liveness example in the official docs. This image's `/healthz` returns 200 for the first 10 seconds and 500 after that, so it's expected that this Pod keeps restarting on probe failures. Running it on a v1.35 kind cluster, the first liveness-failure restart shows up after about 40 seconds, and after the restart the startup probe misses the first 10 seconds, so `Startup probe failed ... statuscode: 500` events pile up

### exec, grpc

```yaml
livenessProbe:
  exec:
    command: ["cat", "/tmp/healthy"]
  initialDelaySeconds: 5
  periodSeconds: 5
```

```yaml
livenessProbe:
  grpc:
    port: 2379
  initialDelaySeconds: 10
```

### Commands to check

```bash
kubectl describe pod probe-demo      # Unhealthy / Killing and "Liveness probe failed" in Events
kubectl get pod probe-demo           # READY 0/1, whether RESTARTS goes up
kubectl get pod probe-demo -o jsonpath='{.status.phase}'
kubectl get pod probe-demo -o jsonpath='{.status.conditions}'
kubectl get pod probe-demo -o jsonpath='{.status.containerStatuses[0].state}'
kubectl explain pod.spec.containers.livenessProbe
```

`RESTARTS` goes up the moment a failed container is back in the running state.

## Probes vs. init containers

The requirement from the intro post, "check the DB connection before the app starts", is confusing because it looks like either one could handle it. They differ in when they run and what happens on failure.

|                   | init container                                                                                      | startup probe                                     | readiness probe                                    |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| Defined in        | `spec.initContainers`                                                                               | the app container's `startupProbe`                | the app container's `readinessProbe`               |
| When it runs      | before the app containers start, one at a time in order                                             | after the app container starts, until it succeeds | for the whole app container lifecycle              |
| Success means     | runs to completion and exits 0                                                                      | one successful handler run                        | `successThreshold` consecutive successes           |
| On failure        | retried per Pod `restartPolicy` (`Always` behaves as `OnFailure`). With `Never` the whole Pod fails | the container is killed, `restartPolicy` applies  | pulled out of traffic, the container keeps running |
| Related condition | `Initialized`                                                                                       | -                                                 | `ContainersReady`, `Ready`                         |
| Probe support     | none (`livenessProbe`, `readinessProbe`, `startupProbe` not allowed)                                | -                                                 | -                                                  |

- if the app process shouldn't even start until the dependency is ready: init container
- if the app stays up but you want to pull it out of traffic when the dependency drops: readiness probe. The official docs also suggest that apps with a strong backend dependency use liveness for the app's own health and readiness to also cover backend availability
- sidecar containers live in `initContainers` but keep running and do support probes

## Exam tips

- probes have no imperative flags. Build a skeleton with `kubectl run app --image=nginx --dry-run=client -o yaml > pod.yaml` and add the probe in YAML
- the field lives at `spec.containers[].livenessProbe`, not directly under `spec`
- field names are camelCase: `livenessProbe`, `readinessProbe`, `startupProbe`. Handlers are `httpGet`, `tcpSocket`, `exec`, `grpc`
- `successThreshold` for liveness and startup must be 1
- a readiness failure never causes a restart. If `RESTARTS` is climbing, look at liveness or startup
- if liveness fails in a Pod with `restartPolicy: Never`, the container is killed and doesn't come back
- `CrashLoopBackOff` in the `STATUS` column isn't a phase. If the question asks for the phase, check with `-o jsonpath='{.status.phase}'`

### kubectl explain

```bash
kubectl explain pod.spec.containers.livenessProbe          # common fields: periodSeconds, failureThreshold, etc.
kubectl explain pod.spec.containers.livenessProbe.httpGet  # path, port, httpHeaders
kubectl explain pod.spec.containers.startupProbe
kubectl explain pod.spec.containers.lifecycle              # postStart, preStop
kubectl explain pod.spec.terminationGracePeriodSeconds
kubectl explain pod.spec.restartPolicy                     # Always / OnFailure / Never
```

## References

- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
