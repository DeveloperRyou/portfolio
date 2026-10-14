---
title: "CKA concept notes: workload autoscaling"
description: "How metrics-server feeds CPU usage to the HPA, kubectl autoscale and the autoscaling/v2 HPA, watching it scale up under load and back down 5 minutes after the load stops, and how it differs from VPA, on a kubeadm cluster."
pubDatetime: 2026-10-14T01:08:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "hpa", "autoscaling", "metrics-server"]
order: 8
---

> Based on: commands checked on a kubeadm cluster v1.35.9, kubectl v1.35.9, metrics-server 0.9.0 (Helm chart 3.14.0)

## Contents

## Kinds of autoscaling

| Target            | How                                        | Who                                                     |
| ----------------- | ------------------------------------------ | ------------------------------------------------------- |
| number of Pods    | HorizontalPodAutoscaler (HPA)              | the HPA controller in kube-controller-manager. Built in |
| Pod resource size | VerticalPodAutoscaler (VPA)                | an add-on you install separately (CRD + controller)     |
| number of nodes   | Cluster Autoscaler, Karpenter, etc.        | cloud-integrated add-ons                                |
| manual            | `kubectl scale deploy <name> --replicas=N` | a person                                                |

Within the exam scope, the HPA is the one you work with directly. VPA and node autoscalers are concept-only.

## metrics-server

The HPA gets CPU and memory usage from the Metrics API (`metrics.k8s.io`). metrics-server provides that API, and kubeadm doesn't install it.

```text
kubelet (/metrics/resource) ──▶ metrics-server ──▶ metrics.k8s.io API ──▶ HPA controller, kubectl top
```

- installed with Helm in the [extension interfaces note](/posts/cka-extension-interfaces). On a kubeadm cluster, installing without `--kubelet-insecure-tls` means it never becomes Ready because kubelet certificate verification fails
- without it: `kubectl top nodes` → `error: Metrics API not available`
- right after rebooting the VMs I got the same error until metrics-server came back up

## Creating an HPA

### Prep

The HPA's CPU utilization (%) is usage "relative to the request." The target container needs a CPU request.

```bash
kubectl create deploy php --image=registry.k8s.io/hpa-example --port=80
kubectl set resources deploy php --requests=cpu=200m --limits=cpu=500m
kubectl expose deploy php --port=80
```

### kubectl autoscale

```bash
kubectl autoscale deploy php --cpu=50% --min=1 --max=5
```

- in kubectl v1.35, `--cpu` takes `50%` (utilization) or `500m` (average usage). There's a `--memory` too
- the old `--cpu-percent=50` still works but prints a `Flag --cpu-percent has been deprecated` warning

The created object is `autoscaling/v2`.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
```

| `target.type`                        | Meaning                                        |
| ------------------------------------ | ---------------------------------------------- |
| `Utilization` + `averageUtilization` | average % of request                           |
| `AverageValue` + `averageValue`      | average absolute amount (e.g. `500m`, `200Mi`) |

## Watching it work

Load Pod:

```bash
kubectl run load --image=busybox:1.36 --restart=Never -- \
  /bin/sh -c "while sleep 0.01; do wget -q -O- http://php; done"
```

```text
NAME   REFERENCE        TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
php    Deployment/php   cpu: 0%/50%     1         5         1          31s
php    Deployment/php   cpu: 250%/50%   1         5         1          61s
php    Deployment/php   cpu: 186%/50%   1         5         5          91s
php    Deployment/php   cpu: 79%/50%    1         5         5          2m1s
php    Deployment/php   cpu: 65%/50%    1         5         5          2m31s
```

```text
Normal  SuccessfulRescale  New size: 4; reason: cpu resource utilization (percentage of request) above target
Normal  SuccessfulRescale  New size: 5; reason: cpu resource utilization (percentage of request) above target
```

- formula: `desired replicas = ceil(current replicas × current value / target value)`. 1 × 250 / 50 = 5, but it went to 4 first and then straight to 5
- for the first few tens of seconds there's a `FailedGetResourceMetric` warning. The new Pods' metrics haven't been collected yet
- once it hits maxReplicas (5), it won't scale further even if utilization is above target

After deleting the load Pod:

| Time          | TARGETS  | REPLICAS |
| ------------- | -------- | -------- |
| 0 min         | `0%/50%` | 5        |
| 3 min         | `0%/50%` | 5        |
| about 4-5 min | `0%/50%` | 1        |

Scaling down doesn't happen right away because the default stabilization window is 300 seconds. For scaling up it's 0 seconds by default.

## behavior

Tune scaling speed and stabilization time with `spec.behavior`.

```yaml
spec:
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 50
          periodSeconds: 30
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Pods
          value: 2
          periodSeconds: 15
```

- `stabilizationWindowSeconds`: uses the most conservative recommendation within this window (for scale down, the largest)
- `policies`: how much can change per period. With several, the default is whichever changes the most (`selectPolicy: Max`)
- `selectPolicy: Disabled` turns off scaling in that direction

## When it doesn't work

| Symptom                                                 | Cause                                                   |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `TARGETS` shows `cpu: <unknown>/50%`                    | no metrics-server, not collected yet, or no request     |
| `missing request for cpu in container nginx of Pod ...` | the target container has no CPU request                 |
| replicas stuck at min                                   | load isn't actually arriving, or the target is too high |
| replicas don't drop right away                          | scaleDown stabilization (300 seconds by default)        |

I put an HPA on a Deployment with no requests:

```text
$ kubectl get hpa noreq
NAME    REFERENCE          TARGETS              MINPODS   MAXPODS   REPLICAS
noreq   Deployment/noreq   cpu: <unknown>/50%   1         3         1

$ kubectl describe hpa noreq
... missing request for cpu in container nginx of Pod noreq-75667f6bd8-h2q66
```

## VPA

- recommends or changes a Pod's requests/limits to match actual usage. It's an add-on from the `kubernetes/autoscaler` repo, not part of Kubernetes itself
- `updateMode`: `Off` (recommend only), `Initial` (only at creation), `Recreate` (recreates Pods to apply), `InPlaceOrRecreate` (without a restart when possible)
- using HPA and VPA together on the same CPU/memory metrics isn't recommended, since they can work against each other

I didn't install VPA on this cluster, so its commands aren't verified.

## Easily confused

| Comparison                        | A                                           | B                          |
| --------------------------------- | ------------------------------------------- | -------------------------- |
| HPA vs VPA                        | number of Pods                              | Pod size (requests/limits) |
| `Utilization` vs `AverageValue`   | % of request                                | absolute amount            |
| `kubectl scale` vs HPA            | changes it once. An HPA overwrites it again | keeps adjusting            |
| scale up vs scale down defaults   | stabilization 0 seconds                     | stabilization 300 seconds  |
| `--cpu=50%` vs `--cpu-percent=50` | the v1.35 kubectl way                       | deprecation warning        |

## Exam tips

### Quick commands

```bash
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5
kubectl autoscale deploy <name> --cpu=50% --min=1 --max=5 --dry-run=client -o yaml   # when adding behavior
kubectl get hpa -w
kubectl describe hpa <name>        # Events: SuccessfulRescale, FailedGetResourceMetric
kubectl top pods
```

- before creating an HPA, first check that the target has a CPU request (`kubectl set resources`)
- behavior has no imperative flag, so dump the YAML and add it

### kubectl explain

```bash
kubectl explain hpa.spec.metrics.resource.target
kubectl explain hpa.spec.behavior.scaleDown
```

## References

- [Autoscaling Workloads](https://kubernetes.io/docs/concepts/workloads/autoscaling/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
