---
title: "CKA concept notes: troubleshooting workloads, resource usage, and networking"
description: "Checking resource usage with kubectl top, kubectl logs container selection, previous containers, and stdout/stderr, where log files live on the node, and comparing symptoms after breaking Service selectors, targetPort, readiness, CoreDNS, and NetworkPolicy one at a time."
pubDatetime: 2026-10-14T01:12:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "logging", "kubectl-top", "service"]
order: 12
---

> Based on: broken on purpose and checked on a kubeadm cluster v1.35.9, metrics-server 0.9.0, Calico v3.33.0

The basic flow of inspecting Pods with `kubectl describe`, events, `exec`, and `kubectl debug` is in [CKAD concept notes: monitoring, logs, debugging](/posts/ckad-observability-debugging). For node and control plane failures, see [troubleshooting nodes and cluster components](/posts/cka-troubleshooting-cluster).

## Contents

## Resource usage

`kubectl top` needs metrics-server (without it: `error: Metrics API not available`).

```bash
kubectl top nodes --sort-by=cpu
kubectl top pods -A --sort-by=memory
kubectl top pod <pod> -n <ns> --containers
```

```text
$ kubectl top nodes --sort-by=cpu
NAME      CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
cka-cp1   214m         10%      1992Mi          70%
cka-w1    85m          4%       1156Mi          48%
cka-w2    69m          3%       743Mi           31%

$ kubectl top pods -A --sort-by=memory
NAMESPACE       NAME                     CPU(cores)   MEMORY(bytes)
kube-system     kube-apiserver-cka-cp1   55m          557Mi
calico-system   calico-node-lnw7f        32m          122Mi
```

- `--sort-by` is `cpu` or `memory`
- values are approximations refreshed every collection interval. A container that just started may not show up yet
- for tasks like "write the name of the Pod using the most to a file," use `--sort-by` with `--no-headers | head -1`

`Allocated resources` in `kubectl describe node` isn't actual usage; it's the sum of requests/limits. Don't mix the two up.

## Container output

What a container writes to stdout and stderr gets saved to a file on the node by the container runtime, and `kubectl logs` reads that file through the kubelet.

### kubectl logs

Checked with a Pod with two containers (`out`: one line each to stdout and stderr every 2 seconds, `crash`: exits with 3 after 5 seconds).

| Command                                                  | Result                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `kubectl logs logger`                                    | `Defaulted container "out" out of: out, crash`, then the first container's logs |
| `kubectl logs logger -c out --tail=2`                    | `out-19`, `err-19` (stdout and stderr come out mixed)                           |
| `kubectl logs logger --all-containers --prefix --tail=1` | `[pod/logger/out] err-19`, `[pod/logger/crash] boom`                            |
| `kubectl logs logger -c out --since=5s --timestamps`     | RFC3339 timestamps in front                                                     |
| `kubectl logs <pod> --previous`                          | logs of the container before the restart                                        |
| `kubectl logs -f`                                        | follow                                                                          |
| `kubectl logs deploy/web`                                | one Pod of the Deployment                                                       |
| `kubectl logs -l app=web`                                | multiple Pods by label                                                          |

Checking `--previous`: after a container that exits with 1 after 25 seconds had restarted once

```text
current:  run-at-02:35:59
previous: run-at-02:35:34
```

When a container keeps dying and you need the cause, use `--previous`. The current container may have just started and printed nothing yet. The exit code stays in the status.

```bash
kubectl get pod logger -o jsonpath='{.status.containerStatuses[?(@.name=="crash")].lastState.terminated}'
# {"exitCode":3,"reason":"Error","startedAt":"...","finishedAt":"..."}
```

While waiting in `CrashLoopBackOff`, `--previous` sometimes failed with `unable to retrieve container logs for containerd://...`. In that case `kubectl logs -c <container>` (the last container that exited) showed the same content.

### Log files on the node

```text
/var/log/pods/<namespace>_<pod>_<uid>/<container>/<restart number>.log   ← the actual file
/var/log/containers/<pod>_<namespace>_<container>-<container id>.log     ← symlink
```

```text
$ sudo sh -c 'ls /var/log/pods/app_logger_*/crash/'
2.log  3.log
$ sudo sh -c 'tail -n2 /var/log/pods/app_logger_*/out/0.log'
2026-10-14T02:35:21.78145528Z stdout F out-29
2026-10-14T02:35:21.781537313Z stderr F err-29
```

- line format: `timestamp stream tag content`. The stream field tells stdout from stderr. `kubectl logs` shows the two mixed together
- the number in the file name is the restart count. Only the recent ones are kept
- needs root, and globs only expand inside `sudo sh -c '...'`
- log rotation is set by the kubelet config `containerLogMaxSize` (default 10Mi) and `containerLogMaxFiles` (default 5). This cluster's `config.yaml` doesn't set them, so they're the defaults
- the kubelet's and containerd's own logs aren't files; they're in `journalctl -u kubelet` and `journalctl -u containerd`

## Service connectivity problems

With an nginx Deployment (`app=web`, replicas 2) and a busybox client, I broke one thing at a time and compared the `wget` results.

| Breakage                           | EndpointSlice               | Client result                             |
| ---------------------------------- | --------------------------- | ----------------------------------------- |
| healthy                            | 2 Pod IPs, port 80          | `Welcome to nginx!`                       |
| selector mismatch                  | `<unset>` (no endpoints)    | `Connection refused`                      |
| wrong targetPort (8080)            | 2 Pod IPs, port 8080        | `Connection refused`                      |
| Pod failing readiness              | only that Pod `ready=false` | normal responses from the other Pods      |
| CoreDNS replicas 0                 | no `kube-dns` endpoints     | names give `bad address`, ClusterIP works |
| NetworkPolicy default deny ingress | normal                      | `download timed out`                      |

### Selector mismatch

`kubectl create svc clusterip web-bad-sel --tcp=80:80` creates the selector `app: web-bad-sel`. The Pod label is `app=web`.

```bash
kubectl get svc web-bad-sel -o jsonpath='{.spec.selector}'    # {"app":"web-bad-sel"}
kubectl get pods -l app=web --show-labels                       # app=web,pod-template-hash=...
kubectl get endpointslice -l kubernetes.io/service-name=web-bad-sel
# web-bad-sel-rcjwq   IPv4   <unset>   <unset>
```

If the endpoints are empty, compare the selector against the Pod labels first.

### Wrong targetPort

There are endpoints, but the port is 8080, which the container doesn't listen on. You can see it right away in the EndpointSlice's PORTS column. `refused` means nobody is listening on that Pod IP:port.

### Readiness failure

A new Pod whose `readinessProbe` was changed to check a path that doesn't exist (`/nope`) is `0/1 Running` and stays in the EndpointSlice as `ready=false`. Since it's a rolling update, the 2 existing Pods stay Ready and requests go to them. The new Pod gets no traffic.

### DNS

Scaling CoreDNS to 0 makes only name resolution fail; connecting to the ClusterIP directly still works. For a "the Service doesn't work" problem, testing the name and the IP separately tells you right away whether it's DNS. Right after scaling replicas back to 2, it kept failing for a bit and then went back to normal.

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=kube-dns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### NetworkPolicy

With a default deny of `podSelector: {}` + `policyTypes: [Ingress]`, the connection isn't refused; it times out with no response. The difference between `refused` (fails fast) and a timeout (fails after waiting) is the clue.

## Checking order

```text
1. kubectl get svc <svc> -o wide            selector, port, targetPort
2. kubectl get endpointslice -l kubernetes.io/service-name=<svc>
   ├─ empty → selector vs Pod labels, are the Pods Ready
   └─ present → does the port match the container port
3. directly to Pod IP:port → works: Service/kube-proxy side; fails: Pod/NetworkPolicy side
4. to the ClusterIP → works: DNS problem
5. nslookup with the FQDN
6. kubectl get networkpolicy -A
7. kube-proxy, CNI Pod status (kubectl -n kube-system get pods, calico-system, etc.)
```

## Easily confused

| Comparison                                         | A                                                            | B                                       |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `kubectl top node` vs Allocated in `describe node` | actual usage                                                 | sum of requests/limits                  |
| `logs` vs `logs --previous`                        | the current (or last) container                              | the one before it                       |
| `-c <name>` vs `--all-containers`                  | one container                                                | all of them. Tell apart with `--prefix` |
| `/var/log/pods` vs `/var/log/containers`           | the actual files                                             | symlinks                                |
| `Connection refused` vs `timed out`                | nothing listening at that address (no endpoints, wrong port) | packets blocked (NetworkPolicy, etc.)   |
| `bad address`                                      | name resolution failed                                       | check DNS (CoreDNS, dnsPolicy)          |
| no endpoints vs `ready=false`                      | selector mismatch or no Pods                                 | Pods exist but fail readiness           |

## Exam tips

### Quick commands

```bash
kubectl top pods -A --sort-by=cpu --no-headers | head -1
kubectl logs <pod> -c <container> --previous
kubectl logs <pod> --all-containers --prefix
kubectl logs <pod> > /path/to/file          # tasks that ask you to save logs to a file
kubectl get endpointslice -l kubernetes.io/service-name=<svc>
kubectl get pods -l <selector> --show-labels
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
```

- for tasks that ask you to write results to a file, use exactly the path and format given (just the name? a single line?)
- give busybox `wget` and `nslookup` a timeout like `-T3` so you don't wait long

### kubectl explain

```bash
kubectl explain endpointslice.endpoints.conditions
kubectl explain pod.status.containerStatuses.lastState.terminated
```

## References

- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
