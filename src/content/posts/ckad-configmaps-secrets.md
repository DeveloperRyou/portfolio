---
title: "CKAD concept notes: ConfigMaps and Secrets"
description: "How to create ConfigMaps and Secrets, the three ways to get them into a Pod (env, envFrom, volume), how changes propagate, and projected volumes and the Downward API, based on the official docs."
pubDatetime: 2026-09-26T12:07:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "configmap", "secret", "downward-api"]
order: 8
---

> Based on: Kubernetes v1.35 (commands and YAML checked on kind `kindest/node:v1.35.8`)

## Contents

## Concepts

### ConfigMap

Non-secret configuration data as key-value pairs. Used to keep environment-specific settings out of the container image.

- unlike most objects it has no `spec`; it has `data` and `binaryData` fields
  - `data`: UTF-8 strings
  - `binaryData`: base64-encoded binary
  - keys can't overlap between the two fields
- key names: only letters, digits, `-`, `_`, `.`
- size limit: 1 MiB. Anything bigger goes in a volume or a separate store
- no secrecy or encryption. Sensitive values go in a Secret
- must be in the same namespace as the Pod to be referenced. Static Pods can't reference ConfigMaps

The official docs list four ways to use one:

1. referenced inside a container's `command`/`args`
2. container environment variables
3. files in a read-only volume
4. read directly from the Kubernetes API inside the Pod

In the exam you mostly write 2 and 3 by hand.

### Secret

A small amount of sensitive data like passwords, tokens, or keys. Structurally similar to a ConfigMap, but it has a `type` field and `data` values must be base64-encoded.

- `data`: base64-encoded values
- `stringData`: write plain text and the API server encodes it and merges it into `data`. If the same key is in both, `stringData` wins
- size limit: 1MiB per Secret
- a Secret is only sent to nodes running a Pod that needs it. When mounted as a volume, the kubelet copies it into tmpfs so it never hits disk, and deletes the local copy when the Pod is deleted

### base64 != encryption

To quote the official docs' warning: by default, Secrets are stored **unencrypted** in the API server's data store (etcd). Anyone with API access, or with access to etcd, can read and modify Secrets. And anyone allowed to create a Pod in a namespace can use that Pod to indirectly read any Secret in the same namespace.

The minimum measures the docs suggest:

- enable Encryption at Rest for Secrets
- restrict Secret access with least-privilege RBAC
- limit Secret access to the containers that need it
- consider an external Secret store provider

A value in `data` goes back to plain text with a single `base64 -d`.

### Secret types

| type                                  | Use                                |
| ------------------------------------- | ---------------------------------- |
| `Opaque`                              | default. Arbitrary user data       |
| `kubernetes.io/service-account-token` | ServiceAccount token               |
| `kubernetes.io/dockercfg`             | serialized `~/.dockercfg`          |
| `kubernetes.io/dockerconfigjson`      | serialized `~/.docker/config.json` |
| `kubernetes.io/basic-auth`            | basic authentication credentials   |
| `kubernetes.io/ssh-auth`              | SSH authentication data            |
| `kubernetes.io/tls`                   | TLS certificate and key            |
| `bootstrap.kubernetes.io/token`       | bootstrap token                    |

How the `kubectl create secret` subcommands map: `generic` -> `Opaque`, `docker-registry` -> `kubernetes.io/dockerconfigjson`, `tls` -> `kubernetes.io/tls`.

### immutable

Both ConfigMaps and Secrets can set `immutable: true` (stable since v1.21). Once immutable, you can't undo it or change `data`; you have to delete and recreate. Immutable objects also close their watches, which reduces load on kube-apiserver.

## How it works

### Behavior by injection method

| Method                 | Fields                                             | Result                                                            |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| one key -> one env var | `env[].valueFrom.configMapKeyRef` / `secretKeyRef` | you pick the name                                                 |
| all keys -> env vars   | `envFrom[].configMapRef` / `secretRef`             | key names become variable names as-is                             |
| files                  | `volumes[].configMap` / `secret` + `volumeMounts`  | one file per key. Use `items` to pick specific keys and set paths |

- if a ConfigMap or key referenced by `env` doesn't exist, the Pod doesn't start. Mark it `optional: true` and it starts anyway
- `envFrom` uses keys directly as variable names. Since v1.34 the variable name rules are relaxed (any printable ASCII except `=`), so on a v1.35 cluster keys like `Y-Z`, `1abc`, and `.dot` aren't skipped; they become variables. The explanation "invalid keys are skipped and recorded in an `InvalidVariableNames` event" is from versions with the stricter rules
- file permissions on a Secret volume are set with `defaultMode` (the whole volume) or `items[].mode` (per file)
- keys starting with `.` become hidden files (check with `ls -la`)

### Update propagation

| How it's consumed             | When the source changes                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| volume mount                  | picked up automatically. The delay is at most the kubelet sync period + cache propagation delay |
| volume mounted with `subPath` | not picked up                                                                                   |
| `env` / `envFrom`             | not picked up. The Pod needs a restart                                                          |
| direct API reads              | up to the application to watch and handle it                                                    |

How the kubelet detects changes is set by `configMapAndSecretChangeDetectionStrategy`, default `Watch`. The other options are a TTL-based cache and querying the API server on every sync.

Even when a volume's value changes, it has no effect unless the application rereads the file. Whether it takes effect depends on how the app is written.

### projected volumes

Merges several volume sources into one directory. Supported sources:

- `secret`
- `configMap`
- `downwardAPI`
- `serviceAccountToken`
- `clusterTrustBundle`
- `podCertificate`

Things to watch:

- every source must be in the same namespace as the Pod
- mounting with `subPath` means no updates
- a regular `secret` volume uses `secretName`, but `secret` inside a projected volume uses `name`
- `defaultMode` applies to the whole projected volume; override per source with `items[].mode`
- `serviceAccountToken`: set `audience`, `expirationSeconds` (default 1 hour, minimum 10 minutes), `path`

### Downward API

A way to expose the Pod's and container's own fields to the container. The environment variable form and the `downwardAPI` volume together are called the Downward API.

Fields you can expose with `fieldRef`:

| Field                                                              | env | volume |
| ------------------------------------------------------------------ | --- | ------ |
| `metadata.name`, `metadata.namespace`, `metadata.uid`              | O   | O      |
| `metadata.labels['<KEY>']`, `metadata.annotations['<KEY>']`        | O   | O      |
| `metadata.labels`, `metadata.annotations` (all)                    | X   | O      |
| `spec.nodeName`, `spec.serviceAccountName`                         | O   | X      |
| `status.podIP`, `status.podIPs`, `status.hostIP`, `status.hostIPs` | O   | X      |

`resourceFieldRef` exposes the container's `requests`/`limits` values (`cpu`, `memory`, `ephemeral-storage`, `hugepages-*`). If no limit is set, you get the node's allocatable maximum. `divisor` defaults to `1`, so `limits.cpu: 500m` in the example below comes out rounded up to `1`. To see millicores, use `divisor: 1m`.

All labels or all annotations are only available through a volume. If resources are resized while running, the volume side gets updated, but env stays the same until the container restarts.

## Examples

### Creating them

```bash
# ConfigMap
kubectl create configmap app-config --from-literal=MODE=prod --from-literal=LOG_LEVEL=info
kubectl create configmap app-files --from-file=app.properties            # key = file name
kubectl create configmap app-files2 --from-file=config=app.properties    # custom key name
kubectl create configmap app-env --from-env-file=app.env                 # one VAR=VAL per line

# Secret
kubectl create secret generic db-cred --from-literal=username=admin --from-literal=password='s3cr3t'
kubectl create secret tls web-tls --cert=tls.crt --key=tls.key
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com --docker-username=user --docker-password=pass

# dump YAML
kubectl create configmap app-config --from-literal=MODE=prod --dry-run=client -o yaml > cm.yaml

# check a value
kubectl get secret db-cred -o jsonpath='{.data.password}' | base64 -d
```

`--from-file` vs `--from-env-file`:

- `--from-file=app.env`: the whole file is one value. The key is `app.env`
- `--from-env-file=app.env`: one key per `VAR=VAL` line. `#` comments and blank lines are ignored

### Secret manifest

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-cred
type: Opaque
data:
  username: YWRtaW4= # "admin"
stringData:
  password: s3cr3t # plain text, converted to base64 on create
```

### env / envFrom / volume

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "env; ls /etc/config /etc/secret; sleep 3600"]
      env:
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: db-cred
              key: username
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
              optional: true
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config-vol
          mountPath: /etc/config
          readOnly: true
        - name: secret-vol
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: config-vol
      configMap:
        name: app-files
    - name: secret-vol
      secret:
        secretName: db-cred
        defaultMode: 0400
        items:
          - key: password
            path: db-password
```

### projected volume + Downward API

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: projected-demo
  labels:
    app: demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      resources:
        limits:
          cpu: 500m
          memory: 128Mi
      env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
      volumeMounts:
        - name: all-in-one
          mountPath: /projected
          readOnly: true
  volumes:
    - name: all-in-one
      projected:
        sources:
          - configMap:
              name: app-config
          - secret:
              name: db-cred # inside projected it's name, not secretName
              items:
                - key: password
                  path: secret/password
          - downwardAPI:
              items:
                - path: labels
                  fieldRef:
                    fieldPath: metadata.labels
                - path: cpu_limit
                  resourceFieldRef:
                    containerName: app
                    resource: limits.cpu
```

## Easily confused

| Item               | ConfigMap                             | Secret                                                 |
| ------------------ | ------------------------------------- | ------------------------------------------------------ |
| Use                | non-secret settings                   | sensitive values                                       |
| Value fields       | `data` (UTF-8), `binaryData` (base64) | `data` (base64), `stringData` (plain text, write-only) |
| `type`             | none                                  | `Opaque`, etc.                                         |
| Size limit         | 1 MiB                                 | 1MiB                                                   |
| env reference      | `configMapKeyRef` / `configMapRef`    | `secretKeyRef` / `secretRef`                           |
| volume field       | `configMap.name`                      | `secret.secretName` (`name` inside projected)          |
| Stored on the node | -                                     | tmpfs when mounted as a volume                         |

| Comparison                         | Difference                                                       |
| ---------------------------------- | ---------------------------------------------------------------- |
| `env` vs `envFrom`                 | one key under a name you choose vs every key as-is               |
| volume vs `subPath` volume         | picks up updates vs doesn't                                      |
| `--from-file` vs `--from-env-file` | one file = one key vs one line = one key                         |
| `fieldRef` vs `resourceFieldRef`   | Pod metadata and status vs container requests/limits             |
| Downward API env vs volume         | fixed while running vs all labels/annotations, updates picked up |

## Exam tips

### Commands

- create ConfigMaps and Secrets directly with `kubectl create configmap` / `kubectl create secret generic`, and dump YAML with `--dry-run=client -o yaml`
- the Pod side (`env`/`envFrom`/`volumes`) has no imperative command, so write it in YAML. For an existing Deployment, `kubectl set env deployment/<name> --from=configmap/<cm>` also works
- check a Secret value: `kubectl get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`
- check environment variables: `kubectl exec <pod> -- env`

### kubectl explain

```bash
kubectl explain pod.spec.containers.env.valueFrom   # configMapKeyRef, secretKeyRef, fieldRef
kubectl explain pod.spec.containers.envFrom         # configMapRef, secretRef, prefix
kubectl explain pod.spec.volumes.configMap          # name, items, defaultMode
kubectl explain pod.spec.volumes.secret             # secretName (field name differs from configMap)
kubectl explain pod.spec.volumes.projected.sources  # sources you can put in a projected volume
kubectl explain pod.spec.volumes.downwardAPI.items  # Downward API volume
kubectl explain secret.stringData                   # the plain-text field
```

## References

- [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Projected Volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/)
- [Downward API](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [CKAD Curriculum v1.35](https://github.com/cncf/curriculum)
