---
title: "CKAD concept notes: rolling updates and deployment strategies"
description: "How a Deployment's RollingUpdate and Recreate behave, how maxSurge and maxUnavailable are calculated, the rollout commands, and blue/green and canary deployments built from Service selectors and replica ratios, based on the official docs."
pubDatetime: 2026-09-26T12:05:00
topic: "project-cncf"
subtopic: "ckad"
tags:
  ["kubernetes", "ckad", "deployment", "rolling-update", "canary", "blue-green"]
order: 6
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### Deployment, ReplicaSet, revision

A Deployment doesn't manage Pods directly. When `.spec.template` changes, it creates a new ReplicaSet, scales the new one up and the old one down, and that's how Pods get replaced.

- the hash in the ReplicaSet name and the `pod-template-hash` label on Pods are the same value. It's a hash of the Pod template, and the Deployment controller adds it to the ReplicaSet selector, the Pod template labels, and existing Pods so ReplicaSets don't overlap on Pods
- revision history is stored in the old ReplicaSets. Once a ReplicaSet is deleted, you can't roll back to that revision
- `.spec.revisionHistoryLimit` defaults to 10. At 0, every old ReplicaSet with 0 replicas is cleaned up, so undo isn't possible

### When a rollout starts

In the docs' own words: "if and only if the Deployment's Pod template (`.spec.template`) is changed".

| Change                                       | rollout / new revision |
| -------------------------------------------- | ---------------------- |
| container image change (`kubectl set image`) | yes                    |
| template labels, env, resources, etc.        | yes                    |
| changing replicas with `kubectl scale`       | no                     |
| annotations on the Deployment itself         | no                     |

So a rollback only reverts the Pod template part. Replicas aren't something undo touches.

### The two strategies

|                              | `RollingUpdate` (default)                                  | `Recreate`                                |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| Behavior                     | gradually shrinks the old ReplicaSet and grows the new one | kills all old Pods, then creates new ones |
| Downtime                     | availability kept within `maxUnavailable`                  | there's a window with no old Pods left    |
| Two versions running at once | yes                                                        | not during the upgrade                    |
| Settings                     | `maxSurge`, `maxUnavailable`                               | none                                      |

The "kill first, create after" guarantee of `Recreate` only applies to upgrades. If you delete a Pod by hand, the ReplicaSet creates a replacement right away (even while the old Pod is still Terminating). If you really need "at most N at a time", the docs recommend a StatefulSet.

## How it works

### maxSurge / maxUnavailable

Both are optional fields under `.spec.strategy.rollingUpdate`. An integer (`5`) or a percentage of the desired Pod count (`10%`).

| Field            | Meaning                                            | Percentage rounding | Default |
| ---------------- | -------------------------------------------------- | ------------------- | ------- |
| `maxSurge`       | how many Pods can be created above `replicas`      | up                  | 25%     |
| `maxUnavailable` | how many Pods may be unavailable during the update | down                | 25%     |

- both can't be 0 (if one is 0, the other must not be)
- with the defaults: "at least 75% available, at most 125% existing"

With `replicas: 10` and the defaults:

```text
maxSurge       = ceil(10 * 0.25)  = 3  -> at most 13 Pods total
maxUnavailable = floor(10 * 0.25) = 2  -> at least 8 available Pods
```

Common combinations:

| Settings                           | Effect                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `maxSurge: 1`, `maxUnavailable: 0` | old Pods are only removed after a new Pod is ready. No capacity loss, needs extra resources      |
| `maxSurge: 0`, `maxUnavailable: 1` | removes one old Pod first, then creates a new one. No extra resources, capacity dips for a while |

### Availability and the progress deadline

- `.spec.minReadySeconds` (default 0): a new Pod has to stay ready this long without any container crashing before it counts as available. Directly affects rollout speed
- `.spec.progressDeadlineSeconds` (default 600): if there's no progress for this long, the condition becomes `Progressing=False` with `reason: ProgressDeadlineExceeded`. The controller doesn't roll back for you; it only reports the state. Must be larger than `minReadySeconds`
- `kubectl rollout status` exits 0 on completion and non-zero when the deadline is exceeded → scripts can check it

### Updating in the middle of an update

That's a rollover. If you change the template again mid-rollout, it creates yet another ReplicaSet and starts scaling down the one it had been scaling up, treating it as old. It doesn't wait for the previous rollout to finish.

Scaling during a rollout (in progress or paused) triggers proportional scaling: the extra replicas are spread across the active ReplicaSets in proportion.

### pause / resume

- while `.spec.paused: true`, template changes don't trigger a rollout. Use it to batch several changes into one rollout
- scaling still works while paused
- **you can't roll back while paused**. Resume first

## Examples (YAML and kubectl)

### RollingUpdate settings

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  minReadySeconds: 5
  revisionHistoryLimit: 5
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
```

To switch to `Recreate`, delete the `rollingUpdate` block and leave just `type: Recreate`.

### Rollout command flow

```shell
# change the image → rollout starts
kubectl set image deployment/web web=nginx:1.28

# watch progress (waits until done)
kubectl rollout status deployment/web

# history. CHANGE-CAUSE is copied from the kubernetes.io/change-cause annotation
kubectl annotate deployment/web kubernetes.io/change-cause="image updated to 1.28"
kubectl rollout history deployment/web
kubectl rollout history deployment/web --revision=2

# rollback
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=1

# batch several changes into one
kubectl rollout pause deployment/web
kubectl set image deployment/web web=nginx:1.29
kubectl set resources deployment/web -c=web --limits=memory=256Mi
kubectl rollout resume deployment/web

# check the ReplicaSet swap
kubectl get rs -l app=web
```

The `--record` flag is deprecated. If you need a change-cause, add the annotation yourself.

A revision you roll back to gets a new number in the history. If you type the commands above in order, the first `undo` moves revision 1 to 3, so the `--to-revision=1` on the next line fails with `unable to find specified revision 1 in history`. Check the numbers with `rollout history` before you undo.

### blue/green: switching the Service selector

A Service keeps looking for Pods that match its selector and updates the EndpointSlices. So changing one selector value moves all the traffic over at once.

Run two Deployments side by side, told apart by a `version` label:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
      version: blue
  template:
    metadata:
      labels:
        app: web
        version: blue
    spec:
      containers:
        - name: web
          image: nginx:1.27
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
      version: green
  template:
    metadata:
      labels:
        app: web
        version: green
    spec:
      containers:
        - name: web
          image: nginx:1.28
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
    version: blue
  ports:
    - port: 80
      targetPort: 80
```

Switching and switching back only change the selector value.

```shell
kubectl patch service web -p '{"spec":{"selector":{"version":"green"}}}'
kubectl get endpointslices -l kubernetes.io/service-name=web

# if something's wrong, back to blue
kubectl patch service web -p '{"spec":{"selector":{"version":"blue"}}}'
```

- before switching, make sure every green Pod is ready
- once the switch has settled, scale the blue Deployment to 0 or delete it

### canary: replica ratio

The same structure as the canary example in `docs/concepts/workloads/management`. Keep the common labels the same, vary only the `track` label, and have the Service select without `track`.

```yaml
# stable: track=stable, replicas 3, image v1
# canary: track=canary, replicas 1, image v2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-canary
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
      track: canary
  template:
    metadata:
      labels:
        app: web
        track: canary
    spec:
      containers:
        - name: web
          image: nginx:1.28
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web # no track → selects both stable and canary
  ports:
    - port: 80
```

- stable 3 : canary 1 → roughly 3:1 traffic (the ratio from the docs example)
- adjust the ratio with something like `kubectl scale deployment/web-canary --replicas=2`
- once you're confident, bump the stable image to the new version and delete the canary Deployment
- the `selector.matchLabels` of stable and canary must not overlap. The different `track` values keep the two sets of ReplicaSets apart

## Easily confused

|                       | RollingUpdate                  | Recreate                       | blue/green                                     | canary                                               |
| --------------------- | ------------------------------ | ------------------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| Implementation        | 1 Deployment, strategy setting | 1 Deployment, strategy setting | 2 Deployments + switching the Service selector | 2 Deployments + a Service selecting the common label |
| Versions coexisting   | only during the swap           | never                          | both running, traffic on one side              | both take traffic                                    |
| Traffic ratio control | no (only rollout speed)        | no                             | 0 or 100                                       | replica ratio                                        |
| Rolling back          | `kubectl rollout undo`         | `kubectl rollout undo`         | restore the selector                           | scale canary to 0 / delete                           |
| Extra resources       | up to `maxSurge`               | none                           | a full second copy                             | the canary replicas                                  |

| Easily confused pair                | Difference                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `maxSurge` vs `maxUnavailable`      | cap on extra Pods (rounded up) vs cap on missing Pods (rounded down)                 |
| revision vs replicas                | revisions only record template changes. Scaling creates no revision and isn't undone |
| `rollout pause` vs scale to 0       | pause only stops template changes from rolling out; Pods keep running                |
| exceeding `progressDeadlineSeconds` | just a status report, not an automatic rollback                                      |
| changing a Deployment `selector`    | immutable in `apps/v1`. Delete and recreate to change it                             |

## Exam tips

**Quick commands**

```shell
kubectl create deployment web --image=nginx:1.27 --replicas=3 --dry-run=client -o yaml > web.yaml
kubectl set image deployment/web web=nginx:1.28     # containerName=image
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web --to-revision=N
kubectl scale deployment/web --replicas=5
```

- `kubectl create deployment` doesn't take a `strategy`, so dump it with `--dry-run=client -o yaml` and add the `strategy` block by hand
- the left side of `kubectl set image` is the container name, not the Deployment name (`kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[*].name}'`)

**kubectl explain**

```bash
kubectl explain deployment.spec.strategy                # type: RollingUpdate / Recreate
kubectl explain deployment.spec.strategy.rollingUpdate  # maxSurge, maxUnavailable defaults
kubectl explain deployment.spec.revisionHistoryLimit    # how many revisions rollout history keeps
kubectl explain deployment.spec.minReadySeconds
kubectl explain service.spec.selector                   # what blue/green switches
```

## References

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Managing Workloads -- Canary deployments](https://kubernetes.io/docs/concepts/workloads/management/#canary-deployments)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
