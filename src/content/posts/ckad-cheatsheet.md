---
title: "CKAD cheat sheet"
description: "kubectl commands, minimal YAML, and the kubernetes.io pages to open during the exam, organized by CKAD v1.35 curriculum domain."
pubDatetime: 2026-09-26T12:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "kubectl", "cheatsheet"]
order: 1
---

> Based on: Kubernetes v1.35

## Summary

CKAD commands and YAML in one place.

Rule of thumb: generate the skeleton with an imperative command,
then edit YAML only for fields the command can't set (or you don't remember).
Look them up with `kubectl explain` or copy an example from the official docs.

Example:

```bash
k run web --image=nginx --port=80 --dry-run=client -o yaml > web.yaml  # 1. generate the Pod YAML skeleton with a command
vi web.yaml                                                            # 2. add fields the command can't set (probe, volume, etc.)
k apply -f web.yaml                                                    # 3. apply
k get pod web                                                          # 4. check the result
```

| Domain                                              | Weight |
| --------------------------------------------------- | ------ |
| Application Design and Build                        | 20%    |
| Application Deployment                              | 20%    |
| Application Observability and Maintenance           | 15%    |
| Application Environment, Configuration and Security | 25%    |
| Services and Networking                             | 20%    |

Sites you can open during the exam: `kubernetes.io/docs`, `kubernetes.io/blog`, `helm.sh/docs` (per the Linux Foundation's allowed resources).

## Exam environment

- For each task, `ssh <host>` into the given host, solve it there, then `exit`
- Every ssh host comes with the `k` alias and Bash completion preconfigured
- Your own aliases, `export`s, and vim settings are gone once you switch hosts -- type options out every time
- Pass `-n <ns>` explicitly on every command

### Generating and editing YAML

```bash
k run web --image=nginx --dry-run=client -o yaml > pod.yaml  # write YAML to a file instead of creating
k apply -f pod.yaml                                          # apply after editing
```

- Most of a Pod spec can't be changed after creation; `apply` fails with `Forbidden: pod updates may not change fields ...`
  - Mutable: container `image`, `activeDeadlineSeconds`, adding `tolerations`
  - Immutable, e.g.: probes, `resources`, `env`, `command`/`args`, `volumeMounts`, `securityContext`, `serviceAccountName`
  - Fix: `k replace --force -f pod.yaml` -- deletes the existing Pod and recreates it under the same name
  - For a Deployment, editing the Pod template and running `apply` is enough (the Deployment replaces the Pods)

### kubectl explain

```bash
k explain pod.spec.containers.livenessProbe  # field description
k explain pod.spec --recursive | less        # full field tree
```

## Application Design and Build

Curriculum: define, build, and modify container images; choose a workload resource; multi-container Pod patterns (sidecar, init, etc.); persistent and ephemeral volumes.

### container image

```bash
docker build -t myapp:v1 .                         # or podman build
docker tag myapp:v1 registry.example.com/myapp:v1  # add a tag with the remote registry path
docker push registry.example.com/myapp:v1          # upload to the registry
```

```dockerfile
FROM nginx:1.27
COPY index.html /usr/share/nginx/html/index.html
```

### Choosing a workload

| Resource    | Use                        | Create with                                                            |
| ----------- | -------------------------- | ---------------------------------------------------------------------- |
| Pod         | one-off, testing           | `k run`                                                                |
| Deployment  | stateless, rolling updates | `k create deploy`                                                      |
| StatefulSet | stable names and storage   | YAML                                                                   |
| DaemonSet   | one per node               | Deployment YAML with `kind` changed, `replicas` and `strategy` removed |
| Job         | runs to completion         | `k create job`                                                         |
| CronJob     | runs on a schedule         | `k create cronjob`                                                     |

```bash
k run web --image=nginx --port=80 --labels=app=web,tier=fe                # create a Pod with port and labels
k run tmp --image=busybox --restart=Never --rm -it -- sh                  # shell into a temporary Pod, deleted on exit
k run box --image=busybox --dry-run=client -o yaml --command -- sh -c 'sleep 3600' > pod.yaml  # Pod YAML with a command set

k create deploy web --image=nginx --replicas=3 --port=80                  # Deployment with 3 replicas
k create job hello --image=busybox -- echo "Hello World"                  # one-shot Job
k create cronjob hello --image=busybox --schedule="*/1 * * * *" -- echo "Hello World"  # CronJob running every minute
k create job manual-run --from=cronjob/hello                              # run a CronJob once right now
```

Where the arguments after `--` end up:

| Image (Dockerfile) | Pod spec  | Role                                     |
| ------------------ | --------- | ---------------------------------------- |
| `ENTRYPOINT`       | `command` | the program to run                       |
| `CMD`              | `args`    | default arguments passed to that program |

```bash
k run box --image=busybox -- sleep 3600            # args: ["sleep", "3600"] -- keeps ENTRYPOINT, replaces only CMD
k run box --image=busybox --command -- sleep 3600  # command: ["sleep", "3600"] -- replaces ENTRYPOINT
```

- busybox has no `ENTRYPOINT`, so both run `sleep 3600`
- On an image with `ENTRYPOINT ["python"]`, leaving out `--command` runs `python sleep 3600` -> error
- If the task says "run this command", use `--command`

Extra Job/CronJob fields (no command-line flags for these):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      completions: 3
      parallelism: 2
      backoffLimit: 4
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: hello
              image: busybox
              command: ["sh", "-c", "date"]
```

- A Job Pod's `restartPolicy` must be `Never` or `OnFailure`
- Docs: [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

### multi-container Pod

| Pattern               | Defined in                                 | Behavior                                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| init container        | `initContainers`                           | run in order; all must succeed before app containers start |
| sidecar (native)      | `initContainers` + `restartPolicy: Always` | keeps running for the Pod's lifetime, stable since v1.33   |
| plain multi-container | multiple entries in `containers`           | start together, no ordering guarantee                      |

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  initContainers:
    - name: wait-db
      image: busybox
      command:
        [
          "sh",
          "-c",
          "until nslookup db.default.svc.cluster.local; do sleep 2; done",
        ]
    - name: logshipper
      image: alpine
      restartPolicy: Always # sidecar
      command: ["sh", "-c", "tail -F /opt/logs.txt"]
      volumeMounts:
        - name: data
          mountPath: /opt
  containers:
    - name: app
      image: alpine
      command:
        [
          "sh",
          "-c",
          "while true; do echo logging >> /opt/logs.txt; sleep 1; done",
        ]
      volumeMounts:
        - name: data
          mountPath: /opt
  volumes:
    - name: data
      emptyDir: {}
```

- Share files between containers by mounting the same `emptyDir`
- Logs/exec for a specific container: `k logs app -c logshipper`, `k exec -it app -c app -- sh`
- Docs: [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)

### volume

| Type                            | Lifetime        | Notes                                   |
| ------------------------------- | --------------- | --------------------------------------- |
| `emptyDir`                      | Pod             | tmpfs with `medium: Memory`             |
| `hostPath`                      | node            | for testing                             |
| `configMap` / `secret`          | source resource | mounted as files                        |
| `persistentVolumeClaim`         | PVC             | bound to a PV                           |
| generic ephemeral (`ephemeral`) | Pod             | per-Pod PVC created and deleted for you |

PV, PVC, and mount (no imperative command for these):

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  resources:
    requests:
      storage: 500Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
spec:
  containers:
    - name: app
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: pvc-data
```

- PVC stuck in `Pending`: check for a `storageClassName`/`accessModes`/capacity mismatch (`k describe pvc`)
- Docs: [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/) (PV, PVC, and Pod example all in one), [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/), [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)

## Application Deployment

Curriculum: deployment strategies (blue/green, canary), Deployment rolling updates, deploying existing packages with Helm, Kustomize.

### rolling update, rollout

```bash
k set image deploy/web nginx=nginx:1.27    # container name=image
k rollout status deploy/web                # wait for / check rollout completion
k rollout history deploy/web               # list revisions
k rollout undo deploy/web                  # roll back to the previous revision
k rollout undo deploy/web --to-revision=1  # roll back to a specific revision
k rollout restart deploy/web               # recreate Pods without changing config
k scale deploy/web --replicas=5            # change the replica count
```

```yaml
spec:
  strategy:
    type: RollingUpdate # or Recreate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
```

- When switching to `Recreate`, you must delete the `rollingUpdate` block
- Docs: [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)

### blue/green, canary

No dedicated resource. Two Deployments plus a Service selector.

| Strategy   | How                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| blue/green | `web-blue` and `web-green` Deployments side by side, switch the Service selector to `version=green`                  |
| canary     | both Deployments share a common label (`app=web`), the Service selects only that label, replica ratio splits traffic |

```bash
# blue/green switch
k set selector svc web 'app=web,version=green'                            # replace the Service selector
# or
k patch svc web -p '{"spec":{"selector":{"app":"web","version":"green"}}}'  # same change via patch

# canary: stable 9, canary 1 -> about 10%
k scale deploy/web-stable --replicas=9                                    # 9 stable
k scale deploy/web-canary --replicas=1                                    # 1 canary
```

- Check: `k get endpointslices -l kubernetes.io/service-name=web`, `k get pod -l app=web --show-labels`
- Docs: [Managing Workloads](https://kubernetes.io/docs/concepts/workloads/management/) (canary deployments section)

### Helm

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami                  # register a chart repo
helm repo update                                                          # refresh the repo index
helm show values bitnami/nginx > values.yaml                              # view and save the chart's default values

helm install web bitnami/nginx -n web --create-namespace --set replicaCount=2  # install, creating the namespace, with a value override
helm install web bitnami/nginx -n web -f values.yaml                       # install with a values file
helm upgrade web bitnami/nginx -n web --set replicaCount=3                 # upgrade with a changed value
helm list -A                                                              # releases across all namespaces
helm history web -n web                                                   # list release revisions
helm rollback web 1 -n web                                                # roll back to revision 1
helm uninstall web -n web                                                 # delete the release
```

- Releases are namespaced; without `-n` they won't show up in `helm list`
- Docs: [Using Helm](https://helm.sh/docs/intro/using_helm/), [helm install](https://helm.sh/docs/helm/helm_install/)

### Kustomize

Leaves the source YAML untouched and deploys the result of applying the transformations in `kustomization.yaml`. No template syntax, built into `kubectl`.

```
app/
├── base/                       # shared source
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml      # resources: [deployment.yaml, service.yaml]
└── overlay/
    └── prod/
        └── kustomization.yaml  # pulls in base and transforms it for prod
```

```bash
k kustomize ./app/overlay/prod  # only print the transformed YAML (check before applying)
k apply -k ./app/overlay/prod   # apply the transformed result (-k = directory containing kustomization.yaml)
k delete -k ./app/overlay/prod  # delete the resources created from that result
```

```yaml
# app/overlay/prod/kustomization.yaml
resources: # sources to transform (files or directories)
  - ../../base
namespace: prod # set every resource's namespace to prod
labels: # add a label to every resource
  - pairs:
      env: prod
images: # replace the tag of the nginx image
  - name: nginx
    newTag: "1.27"
patches: # change only specific fields of a specific resource
  - target: # target: Deployment web
      kind: Deployment
      name: web
    patch: |- # JSON patch: set replicas to 3
      - op: replace
        path: /spec/replicas
        value: 3
```

- `commonLabels` is deprecated, use `labels`
- Docs: [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)

## Application Observability and Maintenance

Curriculum: API deprecations, probes and health checks, monitoring with built-in CLI tools, container logs, debugging.

### API deprecation

```bash
k api-resources -o wide                         # group, version, and verbs per resource
k explain cronjob | head -5                     # check GROUP / VERSION
k convert -f old.yaml --output-version apps/v1  # requires the kubectl-convert plugin
```

- Watch for deprecated-API warnings on apply
- Docs: [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/), [Kubernetes Deprecation Policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/), installing kubectl-convert: [Install and Set Up kubectl on Linux](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)

### probe

| probe     | On failure                                                      |
| --------- | --------------------------------------------------------------- |
| liveness  | restart the container                                           |
| readiness | removed from Service endpoints (no restart)                     |
| startup   | liveness/readiness paused until it succeeds; restart on failure |

| handler | Field                    |
| ------- | ------------------------ |
| HTTP    | `httpGet: {path, port}`  |
| TCP     | `tcpSocket: {port}`      |
| command | `exec: {command: [...]}` |
| gRPC    | `grpc: {port}`           |

```yaml
spec:
  containers:
    - name: web
      image: nginx
      ports:
        - containerPort: 80
      startupProbe:
        httpGet:
          path: /
          port: 80
        failureThreshold: 30
        periodSeconds: 10
      livenessProbe:
        httpGet:
          path: /
          port: 80
        initialDelaySeconds: 5
        periodSeconds: 10
      readinessProbe:
        exec:
          command: ["cat", "/tmp/ready"]
        periodSeconds: 5
```

- Probes are per-container fields (`spec.containers[].livenessProbe`)
- Docs: [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)

### Monitoring CLI

```bash
k get pod -o wide                                   # include Pod IP and node
k get pod --show-labels -l app=web                  # filter by label + show labels
k get events --sort-by=.metadata.creationTimestamp  # events in time order
k top pod --sort-by=cpu                             # requires metrics-server
k top node                                          # node CPU/memory usage
k describe pod web                                  # detailed status and Events
```

- Docs: [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/), [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)

### container log

```bash
k logs web                   # default logs
k logs web -c sidecar        # multi-container
k logs web --all-containers  # logs from all containers
k logs web --previous        # the container before the restart
k logs web -f --tail=50      # follow, starting from the last 50 lines
```

### Debugging

| Status                       | Check                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `Pending`                    | `describe` Events: insufficient resources, nodeSelector, PVC |
| `ImagePullBackOff`           | image name/tag, `imagePullSecrets`                           |
| `CrashLoopBackOff`           | `logs --previous`, command/args, liveness probe              |
| `Running` but unreachable    | readiness, Service selector, `targetPort`                    |
| `CreateContainerConfigError` | missing referenced ConfigMap/Secret/key                      |

```bash
k exec -it web -- sh                                                      # shell into a running container
k debug web -it --image=busybox --target=web                              # ephemeral container
k debug web -it --image=busybox --copy-to=web-debug --share-processes                # debug a copy of the Pod with a shared process namespace
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web:80  # test calling a Service from a temporary Pod
```

- Docs: [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/), [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)

## Application Environment, Configuration and Security

Curriculum: CRDs and Operators, authentication/authorization/admission control, requests/limits/quotas, ConfigMaps, Secrets, ServiceAccounts, SecurityContext and capabilities.

### CRD, Operator

```bash
k get crd                            # list CRDs
k api-resources --api-group=<group>  # resources in a specific API group
k explain <kind>.spec                # fields from the CRD schema
k get <plural> -A                    # list all CRs
```

- CRs are `apply`/`get`/`delete`d like any other resource
- Docs: [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/), [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/), [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)

### authentication, authorization, admission control

```bash
k create role pod-reader --verb=get,list,watch --resource=pods            # define namespaced permissions
k create rolebinding pod-reader-rb --role=pod-reader --serviceaccount=default:app-sa  # bind the Role to a ServiceAccount
k create clusterrole node-reader --verb=get,list --resource=nodes         # define cluster-wide permissions
k create clusterrolebinding node-reader-rb --clusterrole=node-reader --user=jane  # bind the ClusterRole to a user

k auth can-i list pods                                                    # check my own permissions
k auth can-i list pods --as=system:serviceaccount:default:app-sa -n default  # check as the ServiceAccount
```

| Stage             | Role                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| authentication    | who you are (certificates, tokens, ServiceAccounts)                                     |
| authorization     | whether you're allowed (RBAC Role/ClusterRole)                                          |
| admission control | mutates/validates the request (LimitRange, ResourceQuota, Pod Security Admission, etc.) |

- `--serviceaccount` takes `<namespace>:<name>`
- Docs: [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/), [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)

### requests, limits, quota

```bash
k set resources deploy/web --requests=cpu=100m,memory=128Mi --limits=cpu=200m,memory=256Mi  # set requests and limits
k create quota ns-quota --hard=pods=10,requests.cpu=1,requests.memory=1Gi,limits.cpu=2,limits.memory=2Gi  # create a namespace ResourceQuota
k describe quota -n <ns>                                                  # check quota usage
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 200m
          memory: 256Mi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
```

- In a namespace whose ResourceQuota covers cpu/memory, Pods without requests/limits are rejected (a LimitRange can fill in defaults)
- Exceeding the memory limit -> OOMKilled; exceeding the cpu limit -> throttling
- Docs: [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)

### ConfigMap

```bash
k create cm app-config --from-literal=LOG_LEVEL=info --from-literal=PORT=8080  # create from key=value pairs
k create cm app-file --from-file=app.properties                           # create from a file's contents (key = file name)
k set env deploy/web --from=configmap/app-config                          # inject the whole ConfigMap as env
```

```yaml
spec:
  containers:
    - name: web
      image: nginx
      env:
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
      envFrom:
        - configMapRef:
            name: app-config
      volumeMounts:
        - name: config
          mountPath: /etc/app
  volumes:
    - name: config
      configMap:
        name: app-file
```

- Values injected as env don't pick up ConfigMap changes until the Pod restarts; volume mounts update automatically (except `subPath` mounts)
- Docs: [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)

### Secret

```bash
k create secret generic db-secret --from-literal=user=admin --from-literal=password=pass123  # create from key=value pairs
k create secret docker-registry regcred --docker-server=<registry> --docker-username=<u> --docker-password=<p>  # for private registry auth
k get secret db-secret -o jsonpath='{.data.password}' | base64 -d         # decode a value to check it
k set env deploy/web --from=secret/db-secret                              # inject the whole Secret as env
```

```yaml
spec:
  imagePullSecrets:
    - name: regcred
  containers:
    - name: app
      image: nginx
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
      volumeMounts:
        - name: secret
          mountPath: /etc/secret
          readOnly: true
  volumes:
    - name: secret
      secret:
        secretName: db-secret
```

- In YAML, `data` is base64 and `stringData` is plain text
- Volume field names differ: ConfigMap uses `configMap.name`, Secret uses `secret.secretName`
- Docs: [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/), [Distribute Credentials Securely Using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)

### ServiceAccount

```bash
k create sa app-sa                      # create a ServiceAccount
k set serviceaccount deploy/web app-sa  # set the ServiceAccount on a Deployment
```

```yaml
spec:
  serviceAccountName: app-sa
  automountServiceAccountToken: false
```

- A Pod's `serviceAccountName` can't change after creation; edit the Deployment so it recreates the Pods
- Docs: [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)

### SecurityContext, capabilities

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure
spec:
  securityContext: # Pod level
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
    - name: app
      image: busybox
      command: ["sh", "-c", "sleep 3600"]
      securityContext: # container level, overrides the Pod level
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          add: ["NET_ADMIN"]
          drop: ["ALL"]
```

| Field                                                                              | Where                  |
| ---------------------------------------------------------------------------------- | ---------------------- |
| `runAsUser`, `runAsGroup`, `runAsNonRoot`                                          | both Pod and container |
| `fsGroup`                                                                          | Pod only               |
| `capabilities`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem`, `privileged` | container only         |

- Check: `k exec secure -- id`
- Docs: [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)

## Services and Networking

Curriculum: basic understanding of NetworkPolicies, providing and troubleshooting access via Services, Ingress rules.

### Service

```bash
k expose deploy/web --port=80 --target-port=8080 --name=web-svc  # ClusterIP Service, 80 -> container 8080
k expose deploy/web --port=80 --type=NodePort                    # NodePort Service
k create svc nodeport web --tcp=80:8080 --node-port=30080        # pin a specific nodePort
k run web --image=nginx --port=80 --expose                       # Pod + ClusterIP Service
```

| type         | Reachable from                                    |
| ------------ | ------------------------------------------------- |
| ClusterIP    | inside the cluster                                |
| NodePort     | `<NodeIP>:<nodePort>` (default range 30000-32767) |
| LoadBalancer | external LB (cloud, etc.)                         |
| ExternalName | DNS CNAME                                         |

- `k create svc` hardcodes the selector to `app=<name>`; edit the YAML for any other label
- `expose` reuses the source resource's selector

Troubleshooting order:

```bash
k get svc web-svc -o wide                                                 # selector, port
k get endpointslices -l kubernetes.io/service-name=web-svc                # are the endpoints empty?
k get pod -l app=web --show-labels                                        # do labels match the selector?
k run tmp --image=busybox --restart=Never --rm -it -- wget -qO- http://web-svc.<ns>.svc.cluster.local  # test calling the Service by FQDN
```

- No endpoints: selector mismatch or failing readiness
- Connection refused: `targetPort` doesn't match `containerPort`
- Docs: [Service](https://kubernetes.io/docs/concepts/services-networking/service/), [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/), DNS naming rules in [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)

### Ingress

```bash
k create ingress web --class=nginx --rule="foo.com/=web-svc:80"  # host foo.com, exact path / only (pathType Exact)
k create ingress web --rule="foo.com/api*=api-svc:8080"          # trailing * -> pathType Prefix (everything under /api)
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  rules:
    - host: foo.com
      http:
        paths:
          - path: /api
            pathType: Prefix # Exact / Prefix / ImplementationSpecific
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
```

- Check: `k describe ingress web` (backend endpoints), `curl -H 'Host: foo.com' http://<ingress-ip>/api`
- Without an Ingress controller, the rules exist but do nothing
- Docs: [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/), [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)

### NetworkPolicy

No imperative command. Copy a docs example and edit it.

```yaml
# block all ingress in the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# app=db only accepts 5432 from app=api; egress only DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-policy
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - protocol: TCP
          port: 5432
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

Combining selectors inside `from`:

```yaml
# AND: must match both the namespace label and the Pod label
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
      podSelector:
        matchLabels:
          role: frontend
# OR: the whole namespace, or role=frontend Pods (in the policy's own namespace)
- from:
    - namespaceSelector:
        matchLabels:
          project: myproject
    - podSelector:
        matchLabels:
          role: frontend
```

- A single `-` decides AND vs. OR
- Policies add up as allow lists (OR); selected Pods block everything not explicitly allowed
- With `Egress` in `policyTypes` but no DNS rule, Service name resolution fails
- If the CNI doesn't support NetworkPolicy, nothing is enforced
- Check namespace labels: `k get ns --show-labels` (`kubernetes.io/metadata.name` is added automatically)
- Docs: [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

## References

- [CNCF curriculum: CKAD_Curriculum_v1.35.pdf](https://github.com/cncf/curriculum)
- [Linux Foundation: CKA/CKAD Exam Environment Tips](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- [Linux Foundation: Resources Allowed During the Exam](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- [Define a Command and Arguments for a Container](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/)
- [Pods: Pod update and replacement](https://kubernetes.io/docs/concepts/workloads/pods/#pod-update-and-replacement)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/), [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/), [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Managing Workloads](https://kubernetes.io/docs/concepts/workloads/management/)
- [Helm Docs](https://helm.sh/docs/)
- [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/), [Install kubectl on Linux (kubectl convert)](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/), [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Custom Resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/), [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/), [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/), [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/), [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/), [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
