---
title: "CKA concept notes: Pod scheduling"
description: "nodeName, nodeSelector, node affinity, taints and tolerations, Pod anti-affinity, topology spread constraints, and PriorityClass with preemption, placed hands-on on a kubeadm cluster with 2 workers."
pubDatetime: 2026-10-14T01:07:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "scheduling", "affinity", "taint", "priorityclass"]
order: 7
---

> Based on: commands checked on a kubeadm cluster v1.35.9 (1 control plane + 2 workers, 2 CPUs per worker)

The admission and resource side, like requests and limits, LimitRange, and ResourceQuota, is in [CKAD concept notes: requests, limits, quotas](/posts/ckad-resources-quotas).

## Contents

## What the scheduler does

For each Pod with an empty `spec.nodeName`, it picks one node and binds the Pod to it.

1. filter: drop nodes that can't satisfy the constraints (resource requests, nodeSelector, affinity, taints, spread, etc.)
2. score: score the remaining nodes (preferred affinity, resource balance, etc.)
3. bind to the highest-scoring node

If every node gets filtered out, the Pod stays `Pending`, and the reasons show up in a `FailedScheduling` event with node counts.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s),
2 node(s) didn't match Pod's node affinity/selector.
```

On this cluster, "1 node(s) had untolerated taint(s)" is almost always there. That's the control plane's `node-role.kubernetes.io/control-plane:NoSchedule` taint.

## Methods at a glance

| Method                       | Where                                           | Nature                                                    |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `nodeName`                   | `spec.nodeName`                                 | skips the scheduler. That node's kubelet runs it directly |
| `nodeSelector`               | `spec.nodeSelector`                             | only nodes where all labels match                         |
| node affinity                | `spec.affinity.nodeAffinity`                    | operators (In, NotIn, Exists, etc.), required/preferred   |
| Pod affinity / anti-affinity | `spec.affinity.podAffinity` / `podAntiAffinity` | toward (away from) where other Pods are                   |
| taint / toleration           | node `spec.taints` / Pod `spec.tolerations`     | the node repels Pods. A toleration is needed to get in    |
| topology spread              | `spec.topologySpreadConstraints`                | evenly across domains (nodes, zones)                      |
| PriorityClass                | `spec.priorityClassName`                        | if there's no room, pushes out lower-priority Pods        |

## nodeName

```bash
kubectl run nn --image=nginx:1.27 --overrides='{"spec":{"nodeName":"cka-cp1"}}'
```

- it lands on cka-cp1 despite the control plane's NoSchedule taint. The scheduler is what checks taints, and this skips the scheduler
- there's no `Scheduled` event from `default-scheduler`
- a wrong node name or a node without resources just fails. You use it less in practice than in "manually place a Pod because the scheduler is dead" tasks

## nodeSelector

```bash
kubectl label node cka-w1 disk=ssd
```

```yaml
spec:
  nodeSelector:
    disk: ssd
```

With no matching node, like `disk=hdd`, it stays `Pending`.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector.
```

## node affinity

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: disk
                operator: In
                values: [ssd, nvme]
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 50
          preference:
            matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values: [cka-w2]
```

- required: filter. If it can't be met, `Pending`
- preferred: score. The example above prefers cka-w2, but only cka-w1 satisfies required (disk=ssd), so it lands on cka-w1
- operators: `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`. Use `NotIn` or `DoesNotExist` to "avoid this node"
- multiple `nodeSelectorTerms` are OR'd, multiple `matchExpressions` within one term are AND'd
- `IgnoredDuringExecution`: removing the node label after placement leaves the Pod alone. Removing the `disk` label from cka-w1 kept the running Pod `Running`

## Taints and tolerations

```bash
kubectl taint node cka-w2 dedicated=gpu:NoSchedule
kubectl taint node cka-w2 dedicated-          # remove (- after the key)
kubectl describe node cka-w2 | grep Taints
```

| effect             | New Pods                        | Existing Pods                                                                               |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `NoSchedule`       | not placed without a toleration | untouched                                                                                   |
| `PreferNoSchedule` | avoided if possible             | untouched                                                                                   |
| `NoExecute`        | not placed without a toleration | evicted immediately without a toleration. With `tolerationSeconds`, evicted after that long |

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: gpu
      effect: NoSchedule
    - key: maint
      operator: Exists # matches on the key alone, no value
      effect: NoExecute
      tolerationSeconds: 30
```

Lab results:

- after putting `NoSchedule` on cka-w2, the Pods already there stayed `Running`. After `rollout restart` on the Deployment, all the new Pods went to cka-w1
- after putting `maint=true:NoExecute` on cka-w2, Pods without a NoExecute toleration were gone within 10 seconds, while the Pod with `tolerationSeconds: 30` was still `Running` at 10 seconds and evicted by 40 seconds

A toleration only means "allowed in," not "go there." To dedicate a node to certain Pods, you need both a taint (keeps other Pods out) and a nodeSelector or affinity (sends these Pods there).

## Pod anti-affinity

One replica per node:

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: aa
          topologyKey: kubernetes.io/hostname
```

- `topologyKey`: nodes with the same value form one domain. With `kubernetes.io/hostname` each node is a domain; with `topology.kubernetes.io/zone` it's a zone
- with replicas 3, I got one on each of the 2 workers, and the third stayed `Pending`

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod anti-affinity rules.
```

- `podAffinity` does the opposite and groups Pods in the same domain (e.g., a cache next to the app)

## Topology spread constraints

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: ts
```

| Field               | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `maxSkew`           | max difference in Pod count between domains                           |
| `whenUnsatisfiable` | `DoNotSchedule` (Pending) or `ScheduleAnyway` (only affects score)    |
| `labelSelector`     | which Pods to count                                                   |
| `nodeTaintsPolicy`  | whether tainted nodes count as domains. Default `Ignore` (they count) |

With replicas 5, only one came up on cka-w1 and one on cka-w2, and 3 stayed `Pending`.

```text
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match pod topology spread constraints.
```

The control plane also has a `kubernetes.io/hostname` label, so it counts as a domain. It has 0 Pods because of its taint, so putting one more on either worker would make the skew 2, and that's blocked. Adding `nodeTaintsPolicy: Honor` dropped tainted nodes without a matching toleration from the calculation, and the Pods got placed 2/3.

## PriorityClass and preemption

```bash
kubectl get priorityclass
# system-cluster-critical   2000000000
# system-node-critical      2000001000

kubectl create priorityclass high --value=1000 --description="high"
kubectl create priorityclass low --value=10
```

Lab: I ran one `low` Pod requesting `cpu: 1200m` on each worker (node allocatable CPU 2). Then I created a `high` Pod with `cpu: 1200m`.

```text
low-w1   Running   cka-w1
high     Running   cka-w2
Preempted   pod/low-w2   Preempted by pod 92ff4701-... on node cka-w2
```

- if no node fits, the scheduler picks a node where it can evict lower-priority Pods, writes it to `status.nominatedNodeName`, and places the Pod once the eviction is done
- a PriorityClass with `preemptionPolicy: Never` only moves ahead in the queue and doesn't push anyone out
- only one PriorityClass can have `globalDefault: true`. It applies to Pods without a `priorityClassName`

## Easily confused

| Comparison                       | A                                                    | B                                                    |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| nodeName vs nodeSelector         | skips the scheduler. Ignores taints                  | the scheduler filters by label                       |
| nodeSelector vs node affinity    | label match (AND) only                               | operators, OR, preferred                             |
| required vs preferred            | filter. Pending if unmet                             | score. Placed even if unmet                          |
| taint vs affinity                | the node repels Pods                                 | the Pod picks nodes                                  |
| NoSchedule vs NoExecute          | blocks new Pods only                                 | evicts existing Pods too                             |
| anti-affinity vs topology spread | never together in the same domain (max 1 per domain) | keeps the count difference between domains ≤ maxSkew |
| `Equal` vs `Exists`              | key and value match                                  | key present is enough                                |

## Exam tips

### Quick commands

```bash
kubectl label node <node> key=value
kubectl label node <node> key-
kubectl taint node <node> key=value:NoSchedule
kubectl taint node <node> key=value:NoSchedule-
kubectl get nodes --show-labels
kubectl describe node <node> | grep -A3 Taints
kubectl create priorityclass <name> --value=1000
kubectl describe pod <pod> | grep -A5 Events      # FailedScheduling reason
```

- don't memorize affinity YAML, copy it from the "Assigning Pods to Nodes" doc
- leaving out a toleration's `effect` tolerates every effect for that key
- for the cause of a Pending Pod, read the "N node(s) ..." items in the FailedScheduling message one by one

### kubectl explain

```bash
kubectl explain pod.spec.affinity.nodeAffinity
kubectl explain pod.spec.tolerations
kubectl explain pod.spec.topologySpreadConstraints
kubectl explain priorityclass
```

## References

- [Kubernetes Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
