---
title: "CKAD concept notes: Helm and Kustomize"
description: "Helm's chart, repository, and release concepts, install/upgrade/rollback/uninstall and values overrides, plus Kustomize's base/overlay, patches, generators, and kubectl apply -k, based on the official docs."
pubDatetime: 2026-09-26T12:06:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "helm", "kustomize"]
order: 7
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)
> Helm commands and flags follow the helm.sh docs for 4.3.0. Ran them with both Helm 4.3.0 and 3.19.0

## Contents

## Helm concepts

The three pieces the official docs use to describe Helm:

| Piece      | Definition (per the helm.sh Introduction)                                                          |
| ---------- | -------------------------------------------------------------------------------------------------- |
| chart      | a Helm package. The bundle of resource definitions needed to run an application                    |
| repository | a place where charts are collected and shared                                                      |
| release    | an instance of a chart running in a cluster. Install the same chart twice and you get two releases |

When creating a release, Helm combines the chart with configuration (values, usually `values.yaml`).

### Release revisions

- every install, upgrade, and rollback bumps the revision by 1. The first revision is always 1
- a rollback doesn't rewind revisions; it **adds a new revision**
- list revisions with `helm history <release>`
- `helm uninstall` also deletes the release record, so you can't roll back after uninstalling. To keep the record, use `--keep-history`

## How Helm works

### repo → search → install

```shell
helm repo add bitnami <repo-url>
helm repo update
helm search repo wordpress        # search the repos you added (local data)
helm search hub wordpress         # search Artifact Hub
helm show values bitnami/wordpress
helm install my-wp bitnami/wordpress
```

- `helm search repo` searches repo data cached locally. Refresh it with `helm repo update`
- since Helm 3 there's no default repository. `helm repo add` the ones you need
- install takes a release name and a chart. To let Helm pick the name, use `--generate-name`
- chart sources: a repo reference (`bitnami/wordpress`), a local `.tgz`, an unpacked directory, a URL, an OCI registry (`oci://...`)
- by default Helm exits without waiting for resources to come up. In Helm 4, `--wait` takes a strategy: without the flag it's `hookOnly`, with bare `--wait` it's `watcher`. In Helm 3, `--wait` is just an on/off flag. In both, the wait limit is `--timeout` (default `5m0s`)

### Overriding values

```shell
helm install my-wp bitnami/wordpress -f values.yaml
helm install my-wp bitnami/wordpress -f base.yaml -f override.yaml   # rightmost file wins
helm install my-wp bitnami/wordpress --set service.type=NodePort
helm get values my-wp              # see the values given to this release
```

| Method                    | Precedence                                         |
| ------------------------- | -------------------------------------------------- |
| the chart's `values.yaml` | lowest (defaults)                                  |
| `-f` / `--values`         | with several, the rightmost file wins              |
| `--set`                   | higher than `-f`. With several, the rightmost wins |

`--set` syntax:

| `--set`               | YAML                              |
| --------------------- | --------------------------------- |
| `a=b,c=d`             | `a: b` / `c: d`                   |
| `outer.inner=value`   | `inner: value` under `outer:`     |
| `name={a,b,c}`        | a list                            |
| `servers[0].port=80`  | a field on a list element         |
| `name=value1\,value2` | escaped comma → `"value1,value2"` |

### upgrade / rollback / uninstall

```shell
helm upgrade my-wp bitnami/wordpress -f new-values.yaml
helm upgrade --install my-wp bitnami/wordpress     # install if it doesn't exist
helm upgrade my-wp bitnami/wordpress --reuse-values --set image.tag=6.6
helm history my-wp
helm rollback my-wp 1       # to revision 1
helm rollback my-wp         # revision omitted (or 0) → the previous release
helm uninstall my-wp
helm list                   # releases in the current context's namespace
helm list -A                # all namespaces
```

- upgrade only updates what changed ("least invasive upgrade")
- when upgrading from a chart reference without `--version`, it uses the latest chart version
- how values are handled on upgrade:

| Flag                        | Behavior                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `--reuse-values`            | the previous release's values + this time's `--set`/`-f`, merged                            |
| `--reset-values`            | reset to the chart defaults                                                                 |
| `--reset-then-reuse-values` | reset to chart defaults → apply the previous release's values → merge this time's overrides |

- `-n <ns>`: the target namespace. `--create-namespace` creates it if missing (for upgrade, only together with `--install`)

### Previewing before install

```shell
helm template my-wp bitnami/wordpress -f values.yaml     # local render, no cluster lookups
helm install my-wp bitnami/wordpress --dry-run=server     # simulate against the cluster
```

`--dry-run` output includes Secrets as-is. Hide them with `--hide-secret`.

## Kustomize concepts

What Kustomize does, per the Kubernetes docs:

- generate resources from other sources (`configMapGenerator`, `secretGenerator`)
- set cross-cutting fields on every resource (namespace, name prefix/suffix, labels, annotations)
- compose and customize collections of resources (`resources`, `patches`)

kubectl has supported kustomization files since 1.14. The entry point is the `kustomization.yaml` inside a directory.

```shell
kubectl kustomize <dir>      # just print the rendered result
kubectl apply -k <dir>       # apply
kubectl get -k <dir>
kubectl describe -k <dir>
kubectl diff -k <dir>        # diff against what applying would do
kubectl delete -k <dir>
```

`-k` has to point at a kustomization **directory**, not a file.

### base and overlay

- base: a directory with a `kustomization.yaml`. A set of resources and customizations. Local or in a remote repo
- overlay: a directory with a `kustomization.yaml` that references another kustomization directory
- the base knows nothing about overlays. One base can be reused by many overlays

```text
.
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
├── dev/
│   └── kustomization.yaml    # resources: [../base], namePrefix: dev-
└── prod/
    └── kustomization.yaml    # resources: [../base], namePrefix: prod-
```

## Kustomize examples

### base

```yaml
# base/kustomization.yaml
resources:
  - deployment.yaml
  - service.yaml
```

```yaml
# base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      run: my-nginx
  template:
    metadata:
      labels:
        run: my-nginx
    spec:
      containers:
        - name: my-nginx
          image: nginx
```

### overlay: common fields + image + patches

```yaml
# prod/kustomization.yaml
resources:
  - ../base
namespace: prod
namePrefix: prod-
labels:
  - pairs:
      env: prod
images:
  - name: nginx
    newTag: "1.27"
patches:
  - path: increase_replicas.yaml
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: my-nginx
    path: set_memory.json.yaml
```

```yaml
# prod/increase_replicas.yaml  (strategic merge patch)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
spec:
  replicas: 3
```

```yaml
# prod/set_memory.json.yaml  (JSON 6902 patch)
- op: add
  path: /spec/template/spec/containers/0/resources
  value:
    limits:
      memory: 512Mi
```

- both kinds of patch go in the single `patches` field
  - strategic merge: finds its target from the `group`/`version`/`kind`/`name` inside the patch file
  - JSON 6902: the file has no target information, so `target` is **required**
- `patches` are applied in the order listed. The docs recommend "small patches that each do one thing"
- `images`: change image name, tag, or digest without a patch
- `labels` doesn't add the label to selectors. To include selectors, set `includeSelectors: true`. The old `commonLabels` also changes selectors, but the Kustomize bundled with kubectl 1.35 warns `'commonLabels' is deprecated. Please use 'labels' instead`

### generators

```yaml
# kustomization.yaml
configMapGenerator:
  - name: app-config
    files:
      - application.properties
    literals:
      - FOO=Bar
secretGenerator:
  - name: app-secret
    files:
      - password.txt
```

- the generated ConfigMap/Secret names get a content hash suffix (like `app-config-8mbdf7882g`). Change the content and the name changes
- a Deployment in the same kustomization that references `name: app-config` gets rewritten to the hashed name too. The net effect is that the Pod template changes and a rollout happens
- to turn off the suffix: `generatorOptions.disableNameSuffixHash: true`

## Helm vs Kustomize

|                                        | Helm                                | Kustomize                               |
| -------------------------------------- | ----------------------------------- | --------------------------------------- |
| Input                                  | a chart (templates + `values.yaml`) | plain YAML + `kustomization.yaml`       |
| Expressing per-environment differences | different values                    | overlay directories + patches           |
| Tool                                   | a separate `helm` CLI               | built into `kubectl` (`-k`)             |
| Install history                        | Helm stores releases and revisions  | none. Only the applied objects remain   |
| Rollback                               | `helm rollback`                     | `apply -k` the previous manifests again |
| Sharing                                | repositories, OCI registries        | base directories (local or remote repo) |
| Render only                            | `helm template`                     | `kubectl kustomize`                     |

When to use which:

- installing someone else's software (a DB, an ingress controller, etc.) with just the settings changed → a Helm chart
- manifests you own that need to differ a little between dev and prod → Kustomize overlays
- if a CKAD task talks about "chart", "release", or "repository", it's Helm; if it says "kustomization", "overlay", or `-k`, it's Kustomize

## Exam tips

**Quick commands**

```shell
helm repo list
helm search repo <keyword>
helm show values <repo>/<chart> | less
helm install <release> <repo>/<chart> -n <ns> --create-namespace --set key=value
helm upgrade <release> <repo>/<chart> --reuse-values --set key=value
helm list -A
helm history <release> -n <ns>
helm rollback <release> <revision> -n <ns>
helm uninstall <release> -n <ns>

kubectl kustomize <dir>
kubectl apply -k <dir>
```

**kubectl explain**

```bash
# Helm and Kustomize config aren't API resources, so explain doesn't cover them. Only explain the resulting resources' fields
kubectl explain deployment.spec.replicas                                      # a field Kustomize patches and Helm values change
kubectl explain deployment.spec.template.spec.containers.image
# for options, use the CLI help
helm install --help | grep -E -- '--(set|values|namespace|create-namespace)'
helm upgrade --help | grep -E -- '--(install|reuse-values|reset-values)'
kubectl kustomize --help
```

## References

- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Helm Docs](https://helm.sh/docs/)
- [Introduction to Helm](https://helm.sh/docs/intro/introduction/)
- [Using Helm](https://helm.sh/docs/intro/using_helm/)
- [helm install](https://helm.sh/docs/helm/helm_install/), [helm upgrade](https://helm.sh/docs/helm/helm_upgrade/), [helm rollback](https://helm.sh/docs/helm/helm_rollback/), [helm uninstall](https://helm.sh/docs/helm/helm_uninstall/), [helm template](https://helm.sh/docs/helm/helm_template/)
- [CNCF curriculum (CKAD v1.35)](https://github.com/cncf/curriculum)
