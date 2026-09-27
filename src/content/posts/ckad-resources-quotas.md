---
title: "CKAD concept notes: requests, limits, and quotas"
description: "Requests drive scheduling, limits are enforced at runtime. CPU throttling vs. OOMKill, QoS classes, LimitRange defaults, and namespace-wide ResourceQuotas, based on the official docs."
pubDatetime: 2026-09-26T12:08:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "resources", "qos", "resourcequota", "limitrange"]
order: 9
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### Resource types and units

| Resource            | Base unit | Examples               |
| ------------------- | --------- | ---------------------- |
| `cpu`               | core      | `1`, `0.5`, `500m`     |
| `memory`            | byte      | `128Mi`, `1Gi`, `129M` |
| `ephemeral-storage` | byte      | `2Gi`                  |
| `hugepages-<size>`  | byte      | Linux only             |

- CPU: `0.1` = `100m` (100 millicpu). Always an absolute amount, independent of the node's core count
- memory: `Mi`/`Gi` are powers of 2, `M`/`G` are powers of 10
- watch the case: memory `400m` is 0.4 bytes. You almost always meant `400Mi` or `400M`

### requests and limits

Set per container under `spec.containers[].resources`.

```yaml
resources:
  requests:
    cpu: 250m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

- if you set only a limit and no request (and nothing injects a default at admission time), the limit is copied into the request
- if the node has room, a container can use more than its request. It can't use more than its limit (for memory, see below)
- there's also a Pod-level `spec.resources` for requests/limits across the whole Pod (beta). This post sticks to container-level

## How it works

### requests: scheduling

For each resource type, the scheduler only picks nodes where "the sum of requests of containers already on the node + the new Pod's requests" fits within the node's capacity. It doesn't look at actual usage. Even if a node's real CPU and memory usage is low, it refuses placement once the request total is full.

If no node fits, the Pod stays `Pending` and a `FailedScheduling` event is created.

```bash
kubectl describe pod <pod>          # look for FailedScheduling in Events
kubectl describe node <node>        # request/limit totals under Allocated resources
```

### limits: enforced at runtime

On Linux nodes the kubelet and container runtime set limits through cgroups, and the kernel enforces them. CPU and memory behave differently.

|                          | CPU limit                                                    | memory limit                                                                           |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Enforcement              | throttling                                                   | OOM kill                                                                               |
| When it tries to go over | the kernel limits CPU time. It can't use more than the limit | the kernel may kill the container that went over                                       |
| Timing                   | immediate (hard limit)                                       | when memory pressure is detected. It may not die the instant it crosses (reactive)     |
| How it shows up          | slower responses, no restart                                 | `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137`, Restart Count goes up |

A container that went over its limit is killed and restarted by the kubelet; other containers in the same Pod aren't affected.

### Using more than the request, and eviction

Separately from limits, if a container is using more than its request when the node comes under resource pressure, that Pod becomes an eviction candidate. When it's evicted, every container in the Pod is terminated, and if there's a controller it usually creates a new Pod on another node.

### QoS class

Kubernetes looks at each Pod's container requests/limits and assigns a QoS class. Check it at `status.qosClass` in `kubectl get pod <pod> -o yaml`.

| class        | Condition                                                                        | Eviction order   |
| ------------ | -------------------------------------------------------------------------------- | ---------------- |
| `Guaranteed` | every container has CPU and memory requests and limits, and each request = limit | last             |
| `Burstable`  | not Guaranteed, but at least one container has a CPU or memory request or limit  | after BestEffort |
| `BestEffort` | no container has any CPU or memory request or limit                              | first            |

- when a node runs short, eviction goes BestEffort -> Burstable -> Guaranteed. For eviction due to resource pressure, only Pods using more than their request are candidates
- Guaranteed Pods aren't killed unless they exceed their limits or there are no lower-priority preemptible Pods left on the node
- since a limit alone is copied to the request, a Pod where every container sets only CPU and memory limits is Guaranteed

### LimitRange

A policy placed in a namespace. It constrains the requests/limits of each individual Pod, container, and PersistentVolumeClaim created in that namespace.

What it can do:

- min/max compute resources per Pod or container
- min/max storage requests per PersistentVolumeClaim
- a limit-to-request ratio (`maxLimitRequestRatio`)
- inject a default request (`defaultRequest`) and default limit (`default`) into containers that don't set them

Order of operations:

1. the LimitRange admission controller fills in defaults for containers with no requests/limits
2. it checks min/max/ratio violations. On a violation the API server rejects with `403 Forbidden`

Things to watch:

- checks only happen at Pod admission. Adding or changing a LimitRange leaves existing Pods alone
- with more than one LimitRange in a namespace, which defaults get applied is undefined
- consistency between defaults isn't checked. For example, in a LimitRange with `default.cpu: 500m`, a container that sets only `requests.cpu: 700m` gets the 500m default limit, ends up with request > limit, and Pod creation fails

### ResourceQuota

Caps the total across a whole namespace. Used where teams share a cluster by namespace, so one team can't hog the cluster's resources.

| Target         | Examples                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| compute totals | `requests.cpu`, `requests.memory`, `limits.cpu`, `limits.memory` (`cpu` and `memory` mean the same as `requests.*`) |
| storage totals | `requests.storage`, `persistentvolumeclaims`                                                                        |
| object counts  | `pods`, `services`, `secrets`, `configmaps`, `count/deployments.apps`                                               |

- compute totals count all Pods in a non-terminal state
- a request that would exceed the quota is rejected with `403 Forbidden`, and the message names the violated constraint
- in a namespace with a `cpu`/`memory` quota, Pods must set those requests/limits. Without them creation can be rejected. Injecting defaults with a LimitRange fixes that
- changing a quota doesn't affect resources that already exist
- a quota isn't a per-node limit. Pods from several namespaces can land on the same node
- `scopes` narrow what's measured (`BestEffort`, `NotBestEffort`, `Terminating`, `NotTerminating`, `PriorityClass`, etc.)

## Examples

### Container resources

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        requests:
          cpu: 250m
          memory: 64Mi
        limits:
          cpu: 500m
          memory: 128Mi
```

→ request != limit, so `Burstable`. Make request and limit equal for both CPU and memory and it's `Guaranteed`.

### Setting resources on an existing workload

```bash
kubectl set resources deployment web -c=app \
  --requests=cpu=100m,memory=256Mi --limits=cpu=200m,memory=512Mi

kubectl get pod <pod> -o jsonpath='{.status.qosClass}'
```

### LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-mem-defaults
  namespace: dev
spec:
  limits:
    - type: Container
      default: # default limit
        cpu: 500m
        memory: 256Mi
      defaultRequest: # default request
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 512Mi
      min:
        cpu: 50m
        memory: 64Mi
```

```bash
kubectl describe limitrange -n dev
```

### ResourceQuota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
  namespace: dev
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
    pods: "10"
```

```bash
kubectl create quota compute-resources -n dev \
  --hard=requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi,pods=10

kubectl create quota object-counts -n dev \
  --hard=count/deployments.apps=2,count/pods=3,count/secrets=4

kubectl describe quota -n dev        # check Used / Hard
```

## Easily confused

| Comparison                               | Difference                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| request vs limit                         | scheduling input (before placement) vs runtime ceiling (after placement)                      |
| over CPU limit vs over memory limit      | throttling, no restart vs OOMKilled, restart                                                  |
| OOMKilled vs eviction                    | one container killed for exceeding its limit vs the whole Pod terminated due to node pressure |
| LimitRange vs ResourceQuota              | per object (defaults, min, max) vs namespace total                                            |
| LimitRange `default` vs `defaultRequest` | default limit vs default request                                                              |
| quota `cpu` vs `limits.cpu`              | same as `requests.cpu` vs total of limits                                                     |
| `Guaranteed` vs `Burstable`              | every container's CPU and memory request = limit vs anything else with at least one set       |

## Exam tips

### Commands

- setting resources: `kubectl set resources`, or add a `resources` block to YAML dumped with `--dry-run=client -o yaml`
- quota: `kubectl create quota <name> --hard=...`
- LimitRange has no imperative create command, so write it in YAML
- checking: `kubectl describe quota`, `kubectl describe limitrange`, `kubectl describe node`, `kubectl describe pod` (OOMKilled, FailedScheduling)
- checking QoS: `-o jsonpath='{.status.qosClass}'`

### kubectl explain

```bash
kubectl explain pod.spec.containers.resources  # requests, limits
kubectl explain resourcequota.spec             # hard, scopes
kubectl explain limitrange.spec.limits         # default, defaultRequest, max, min
kubectl explain pod.status.qosClass
```

## References

- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Configure Quality of Service for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [kubectl set resources](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_resources/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
