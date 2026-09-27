---
title: "CKAD concept notes: CRDs, Operators, and API deprecations"
description: "Notes on CRDs, custom resources, and Operators that extend the Kubernetes API, and on the rules for deprecating and removing API versions and migrating manifests, based on the official docs."
pubDatetime: 2026-09-26T12:10:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "crd", "operator", "api-deprecation"]
order: 11
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### Resources and custom resources

- resource: an API endpoint that stores a collection of API objects of a certain kind. For example, the `pods` resource holds Pod objects
- custom resource: an API extension that isn't in the default install. Can be registered and removed on a running cluster
- once installed, you create and read it with `kubectl` just like a built-in resource
- a custom resource on its own only stores and retrieves structured data. Actual behavior only appears once a controller is attached

### Two ways to add custom resources

|                       | CRD                             | API aggregation                              |
| --------------------- | ------------------------------- | -------------------------------------------- |
| Programming           | not needed (one YAML)           | needs a separate API server binary and image |
| Extra services to run | none. The API server handles it | yes. More points of failure                  |
| Flexibility           | lower                           | higher                                       |

For CKAD, CRDs alone are enough.

### When a ConfigMap is enough

Per the official docs, use a ConfigMap if:

- there's already a well-defined config file format, like `mysql.cnf` or `pom.xml`
- you want to put the whole config into one ConfigMap key
- the program in the Pod reads it as a file or environment variable (not through the Kubernetes API)
- you want file changes rolled out through a Deployment rolling update

If you want to treat it as a first-class resource in kubectl, like `kubectl get my-object`, or attach new automation (a controller), use a custom resource.

### Operator

- Kubernetes extension software that manages an application and its components through custom resources
- extends behavior by connecting a controller to one or more custom resources, without changing Kubernetes code
- Operator = a Kubernetes API client acting as the controller for a custom resource
- examples of what it automates: deploying the application on demand, backing up and restoring state, upgrades that involve DB schema changes, leader election
- the most common way to deploy one: add a CRD + controller to the cluster. The controller usually runs outside the control plane like any other container (for example, as a Deployment)
- how you use it: add, change, or delete the custom resources the Operator watches

```
user ── kubectl apply ──▶ SampleDB (custom resource)
                              │ watch
                              ▼
                       operator controller (Pod of a Deployment)
                              │ reconcile
                              ▼
                  StatefulSet, Service, backup Job ... (built-in resources)
```

## How it works

### Registering a CRD

1. apply a `CustomResourceDefinition` object
2. the API server creates a new RESTful endpoint: `/apis/<group>/<version>/namespaces/*/<plural>/...`
3. creating the endpoint can take a few seconds. It's usable once the CRD's `Established` condition is true
4. from then on, create and read objects of that kind with `kubectl`

Deleting a CRD removes the endpoint and deletes every custom object stored under it.

### API version tracks

Each API group is versioned independently. The version name tells you the track.

| Example    | Track                | Removal rule (Rule #4a)                                                                                                                                                |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v1`       | GA (stable)          | can be marked deprecated, but can't be removed within a major version                                                                                                  |
| `v1beta1`  | Beta (pre-release)   | deprecated within 9 months or 3 minor releases of introduction, and no longer served 9 months or 3 minor releases after deprecation (whichever is longer in each case) |
| `v1alpha1` | Alpha (experimental) | can be removed in any release without prior deprecation                                                                                                                |

Other rules (excerpt):

- Rule #1: API elements can only be removed by incrementing the version of the API group. Something that's in a version doesn't disappear from that version or change behavior significantly
- Rule #2: within a release, API objects must be able to round-trip between versions without losing information
- Rule #3: a more stable version can't be deprecated in favor of a less stable one (GA can replace beta and alpha, not the other way around)

"Deprecated" and "removed" aren't the same. A deprecated version is still served; a removed version is no longer accepted by the API server.

## Examples

### A CRD and a custom object

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com # <plural>.<group>
spec:
  group: stable.example.com
  versions:
    - name: v1
      served: true # serve this version through the API
      storage: true # exactly one storage version
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                cronSpec:
                  type: string
                image:
                  type: string
                replicas:
                  type: integer
  scope: Namespaced # or Cluster
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
      - ct
---
apiVersion: stable.example.com/v1
kind: CronTab
metadata:
  name: my-new-cron-object
spec:
  cronSpec: "* * * * */5"
  image: my-awesome-cron-image
```

```bash
kubectl apply -f resourcedefinition.yaml
kubectl apply -f my-crontab.yaml
kubectl get crontab          # plural, singular, and shortName (ct) all work
kubectl get ct -o yaml
```

### Finding out which extensions a cluster has

```bash
kubectl get crd                                  # registered CRDs
kubectl api-resources                            # every resource: name, shortName, APIVERSION, NAMESPACED, KIND
kubectl api-resources --api-group=stable.example.com
kubectl api-resources --namespaced=true
kubectl api-versions                             # served group/versions
kubectl explain crontab.spec                     # field descriptions from the CRD schema
kubectl explain deployments --api-version=apps/v1
kubectl explain pod.spec --recursive
```

- `kubectl explain` can show custom resource fields because the CRD has an OpenAPI v3 schema

### Migrating manifests off removed APIs

From the removal history in the v1.35 Deprecated API Migration Guide, the resources that come up often in CKAD:

| Resource                | Removed versions                                     | No longer served | Migrate to             | Notable changes                                                                                    |
| ----------------------- | ---------------------------------------------------- | ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| Deployment, DaemonSet   | `extensions/v1beta1`, `apps/v1beta1`, `apps/v1beta2` | v1.16            | `apps/v1`              | `spec.selector` required, immutable after creation                                                 |
| NetworkPolicy           | `extensions/v1beta1`                                 | v1.16            | `networking.k8s.io/v1` |                                                                                                    |
| Ingress                 | `extensions/v1beta1`, `networking.k8s.io/v1beta1`    | v1.22            | `networking.k8s.io/v1` | `serviceName` → `service.name`, `servicePort` → `service.port.number`/`.name`, `pathType` required |
| CronJob                 | `batch/v1beta1`                                      | v1.25            | `batch/v1`             | none                                                                                               |
| HorizontalPodAutoscaler | `autoscaling/v2beta1`                                | v1.25            | `autoscaling/v2`       |                                                                                                    |
| PodSecurityPolicy       | `policy/v1beta1`                                     | v1.25            | no replacement API     | move to Pod Security Admission or a third-party admission webhook                                  |

As of the v1.35 docs, the most recent removal was in v1.32 (`flowcontrol.apiserver.k8s.io/v1beta3`).

Ingress `v1beta1` → `v1`:

```yaml
# before (networking.k8s.io/v1beta1, no longer served since v1.22)
#   backend:
#     serviceName: web
#     servicePort: 80
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

The migration steps (the docs' "What to do"):

- test: start the API server with `--runtime-config=<group>/<version>=false` to reproduce a future removal ahead of time
- find: locate uses of deprecated APIs through client warnings, metrics, and audit information in 1.19+
- migrate: fix the `apiVersion` and changed fields in the YAML. For automatic conversion, `kubectl convert -f <file> --output-version <group>/<version>`
  - `kubectl convert` is a separate plugin that isn't in the default install. The defaults in the converted output may not be ideal. Converting the v1beta1 Ingress above with kubectl-convert v1.35 fills in `pathType` as `ImplementationSpecific`, so if you wanted `Prefix` you have to fix it yourself

Applying a removed `apiVersion` as-is gives you `no matches for kind "Ingress" in version "networking.k8s.io/v1beta1"` along with `ensure CRDs are installed first`. It isn't a CRD problem; it means that version isn't served anymore.

## Easily confused

| Item                                      | A                                                                                  | B                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| CRD vs custom resource                    | the kind definition (`kind: CustomResourceDefinition`, `apiextensions.k8s.io/v1`)  | an object of that kind (`kind: CronTab`, `stable.example.com/v1`)                                     |
| CRD vs Operator                           | only adds a new kind to the API. On its own it just stores data                    | CRD + controller. Brings real resources in line with the declared state                               |
| CRD vs ConfigMap                          | a first-class resource handled through kubectl and the API, with schema validation | settings injected into a Pod as files or environment variables                                        |
| deprecated vs removed                     | still served, warnings only                                                        | no longer served. Requests with that version fail                                                     |
| `served` vs `storage`                     | whether to serve this version through the API                                      | the version used when storing in etcd. Exactly one                                                    |
| `kubectl api-resources` vs `api-versions` | per resource (name, kind, group/version, namespaced)                               | just the list of group/versions                                                                       |
| alpha vs beta                             | can be removed at any time without prior deprecation                               | stops being served 9 months or 3 releases after deprecation (GA isn't removed within a major version) |

## Exam tips

### Quick commands

```bash
kubectl get crd
kubectl describe crd <plural>.<group>
kubectl api-resources | grep -i <keyword>
```

- when an unfamiliar custom resource shows up: check its name, group, and whether it's namespaced with `api-resources` → check fields with `explain` → write the YAML
- if you need to fix a removed `apiVersion`: check the currently served version in the APIVERSION column of `kubectl api-resources`. For changed fields, the Deprecated API Migration Guide

### kubectl explain

```bash
kubectl explain crd.spec.names                              # plural, singular, kind, shortNames
kubectl explain crd.spec.versions                           # served, storage, schema
kubectl explain crd.spec.scope                              # Namespaced / Cluster
kubectl explain <kind>.spec --recursive                     # custom resource fields (from the CRD schema)
kubectl explain ingress --api-version=networking.k8s.io/v1  # fields for a specific group/version
```

## References

- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [kubectl explain](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_explain/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
