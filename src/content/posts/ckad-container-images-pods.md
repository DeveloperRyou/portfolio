---
title: "CKAD concept notes: container images and Pods"
description: "Image names, tags, and digests, the imagePullPolicy default rules, private registries and imagePullSecrets, building and pushing images, and Pod spec basics, based on the official docs."
pubDatetime: 2026-09-26T12:01:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "container-image", "pod"]
order: 2
---

> Based on: Kubernetes v1.35

## Contents

## Image names

The format is `[REGISTRY_HOST[:PORT]/]NAME[:TAG][@DIGEST]`.

| Written as                                 | What it actually means                               |
| ------------------------------------------ | ---------------------------------------------------- |
| `busybox`                                  | `docker.io/library/busybox:latest`                   |
| `busybox:1.32.0`                           | `docker.io/library/busybox:1.32.0`                   |
| `registry.k8s.io/pause:3.5`                | the given registry, tag `3.5`                        |
| `registry.k8s.io/pause@sha256:1ff6...`     | pinned by digest                                     |
| `registry.k8s.io/pause:3.5@sha256:1ff6...` | both tag and digest; only the digest is used to pull |

- The default registry (Docker Hub) can be changed in the container runtime config
- Tag rules: upper/lowercase letters, digits, `_`, `.`, `-`, up to 128 characters, regex `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`
- A tag can be moved to point at a different image, but a digest (`sha256:<hash>`) is a hash of the image content, so it never changes

### Why use a digest instead of a tag

If the same tag gets repointed to a different image in the registry, a Pod that started earlier and one that started later can end up running different code. With a digest you always get the same image. The official docs also recommend avoiding `:latest` in production and using a meaningful tag like `v1.42.0` or a digest instead. With `:latest` it's hard to tell which version is actually running, and rollbacks get awkward.

## imagePullPolicy

A per-container field that decides when the kubelet pulls the image.

| Value          | Behavior                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `IfNotPresent` | pull only if the image isn't on the node                                                                                           |
| `Always`       | ask the runtime to pull every time the container starts; it checks the digest against the registry and skips already-cached layers |
| `Never`        | never pull; run if the image is on the node, otherwise fail to start                                                               |

Thanks to the layer cache, `Always` isn't as expensive as it sounds, as long as the registry is reliably reachable.

### Default when omitted

Filled in when the Pod is submitted to the API server:

| Image reference            | Default `imagePullPolicy` |
| -------------------------- | ------------------------- |
| digest given               | `IfNotPresent`            |
| tag is `:latest`           | `Always`                  |
| no tag (ends up `latest`)  | `Always`                  |
| a tag other than `:latest` | `IfNotPresent`            |

This value is set only once, when the object is first **created**. For example, if you create a Deployment with `nginx:1.27` and later change its image to `nginx:latest`, `imagePullPolicy` stays `IfNotPresent`. Change it yourself if you need to.

Ways to force a pull every time:

- set `imagePullPolicy: Always` explicitly
- omit the policy + use `:latest` or no tag
- enable the `AlwaysPullImages` admission controller on the cluster (an admin task)

### ImagePullBackOff

The container is stuck in Waiting because the pull failed. The usual causes are a wrong image name, or a private registry with no `imagePullSecrets`. The kubelet keeps retrying with an increasing delay, capped at 300 seconds (5 minutes).

## Private registries

There are several ways to authenticate (node config, kubelet credential provider, pre-pulled images), but the one the official docs recommend is setting `imagePullSecrets` on the Pod. A developer can do it entirely within a namespace, which also fits the CKAD scope.

- Secret type: `kubernetes.io/dockerconfigjson` (or the older `kubernetes.io/dockercfg`)
- The Secret must be in the **same namespace** as the Pod; create one per namespace
- Each entry in `imagePullSecrets` points to one Secret
- A Secret made with `kubectl create secret docker-registry` only works for a single registry. For multiple registries, importing an existing `~/.docker/config.json` with `--from-file` is the better route
- Put `imagePullSecrets` on a ServiceAccount and they're attached automatically to every Pod that uses it

## Building and modifying images

The Kubernetes docs only cover consuming images; building them is Docker/Podman territory.

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

```bash
# build: -t sets the name, the last argument is the build context
docker build -t registry.example.com/team/web:v2 .
podman build -t registry.example.com/team/web:v2 .

# use a different Dockerfile
docker build -t web:v2 -f Dockerfile.prod .

# give an existing image a new name, push to the registry
docker tag web:v2 registry.example.com/team/web:v2
docker push registry.example.com/team/web:v2

# export to a tar file
docker save -o web-v2.tar web:v2
podman save -o web-v2.tar web:v2
```

- `docker build` is an alias for `docker buildx build`. Without `-f` it uses `Dockerfile` at the root of the context
- `podman build` treats `Containerfile` and `Dockerfile` the same
- If you build with podman using `-t web:v2` and no registry, the name gets a `localhost/` prefix. That's easy to trip over when you reference the image in a Pod spec

"Modifying an image" really means editing the Dockerfile and rebuilding under a new tag. You don't patch a running container.

## Pod

A Pod is the smallest deployable unit you can create and manage in Kubernetes: one or more containers, shared storage and network, and a spec for how to run them.

- Containers in the same Pod are always scheduled together on the same node
- Shared network namespace: one Pod IP (per address family), a shared port space, and they talk to each other over `localhost`
- Multiple containers can mount a volume defined in `volumes` to share files
- The hostname inside a container is the Pod name
- The most common shape is a single-container Pod. Multiple containers only when they're tightly coupled (next post's topic)
- Pods are designed to be disposable. Usually a workload resource like a Deployment, Job, or StatefulSet creates and manages Pods from a pod template
- For replicas, you add more Pods, not more containers inside a Pod
- A container restart isn't a Pod restart. A Pod isn't a process; it's the environment containers run in, and it stays until it's deleted

### Minimal Pod spec

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: web
      image: nginx:1.27
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 80
  imagePullSecrets:
    - name: regcred
  restartPolicy: Always
```

- Required: `apiVersion: v1`, `kind: Pod`, `metadata.name`, `spec.containers[].name` and `image`
- Pod names must follow the DNS subdomain rules; the stricter DNS label rules are safer for hostname compatibility
- `restartPolicy`: `Always` (default) / `OnFailure` / `Never`. A Pod-level field
- You can set `.spec.os.name` to `linux`/`windows`; if it doesn't match the node OS, the kubelet refuses to run it

### What you can change on a running Pod

These are the only spec fields you can change with `patch`/`replace`:

- `spec.containers[*].image`
- `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds` (unset -> positive, or only to a smaller value)
- `spec.terminationGracePeriodSeconds` (only to 1, when the previous value was negative)
- `spec.tolerations` (additions only)
- `spec.schedulingGates` (removals only)

Metadata like `namespace`, `name`, and `uid` can't change either. To change env, ports, command, etc., delete and recreate the Pod. If you change a workload resource's pod template, the controller doesn't modify the existing Pods; it replaces them with new ones.

## Easily confused

### Tag vs. digest

|                              | tag                                              | digest                           |
| ---------------------------- | ------------------------------------------------ | -------------------------------- |
| Form                         | `:v1.2.3`                                        | `@sha256:<hash>`                 |
| What it points to            | can be moved                                     | hash of the image content, fixed |
| When both are given          | ignored                                          | used for the pull                |
| `imagePullPolicy` if omitted | `Always` for `:latest`, otherwise `IfNotPresent` | `IfNotPresent`                   |

### Where to put imagePullSecrets

| Location                                         | Scope                                |
| ------------------------------------------------ | ------------------------------------ |
| Pod `spec.imagePullSecrets`                      | that Pod only                        |
| ServiceAccount `imagePullSecrets`                | every Pod using that ServiceAccount  |
| Node config (`config.json`, credential provider) | every Pod on the node; an admin task |

### Editing a Pod directly vs. editing the pod template

|                            | Running Pod            | Workload resource's pod template                      |
| -------------------------- | ---------------------- | ----------------------------------------------------- |
| Fields you can change      | only a few, like image | almost all                                            |
| Effect on existing Pods    | applied in place       | existing Pods untouched; the controller replaces them |
| To change the other fields | delete and recreate    | editing the template is enough                        |

## Exam tips

### Commands

```bash
# generate a Pod YAML skeleton
kubectl run web --image=nginx:1.27 --port=80 \
  --image-pull-policy=IfNotPresent --dry-run=client -o yaml > pod.yaml

# a Pod that runs once and exits
kubectl run tmp --image=busybox:1.36 --restart=Never -- sh -c 'echo hi'

# private registry Secret
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=<user> --docker-password=<password> \
  --docker-email=<email>

# add imagePullSecrets to a ServiceAccount
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "regcred"}]}'

# swap the image (works on Pods and Deployments; format is containerName=image)
kubectl set image pod/web web=nginx:1.28
kubectl set image deployment/web web=nginx:1.28

# check the imagePullPolicy that was actually applied
kubectl get pod web -o jsonpath='{.spec.containers[0].imagePullPolicy}'
```

### kubectl explain

```bash
kubectl explain pod.spec.containers.image
kubectl explain pod.spec.containers.imagePullPolicy  # allowed values and default rules
kubectl explain pod.spec.imagePullSecrets
kubectl explain serviceaccount.imagePullSecrets      # when attaching to a ServiceAccount
kubectl explain pod.spec --recursive | less          # the whole Pod spec field tree
```

## References

- [Images | Kubernetes](https://kubernetes.io/docs/concepts/containers/images/)
- [Pods | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/)
- [Pod Lifecycle: Restart policy | Kubernetes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
- [Pull an Image from a Private Registry | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
- [Add ImagePullSecrets to a service account | Kubernetes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)
- [kubectl run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_run/), [kubectl set image](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_image/), [kubectl create secret docker-registry](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_secret_docker-registry/)
- [docker buildx build | Docker Docs](https://docs.docker.com/reference/cli/docker/buildx/build/), [docker image push](https://docs.docker.com/reference/cli/docker/image/push/), [docker image save](https://docs.docker.com/reference/cli/docker/image/save/)
- [podman-build | Podman](https://docs.podman.io/en/latest/markdown/podman-build.1.html)
- [CNCF CKAD curriculum](https://github.com/cncf/curriculum)
