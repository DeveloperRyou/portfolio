---
title: "CKA cheat sheet"
description: "kubeadm, etcdctl, systemctl, crictl, and kubectl commands plus minimal YAML for each CKA v1.35 curriculum domain, and where to look in the kubernetes.io docs during the exam."
pubDatetime: 2026-10-14T01:01:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubectl", "kubeadm", "cheatsheet"]
order: 1
---

> Based on: Kubernetes v1.35. Commands checked on a kubeadm cluster (v1.34.12 → v1.35.9, 3 libvirt VMs)

## Summary

CKA commands and YAML in one place. For the kubectl basics shared with CKAD (Pod, Deployment, ConfigMap, Service, probes, etc.), see the [CKAD cheat sheet](/posts/ckad-cheatsheet).

What's different from CKAD: the curriculum includes node preparation, kubeadm, etcd, and component troubleshooting, so you'll often ssh into a node and deal with the kubelet, containerd, and static Pod manifests directly. Be ready for a dead apiserver where kubectl doesn't work.

| Domain                                               | Weight |
| ---------------------------------------------------- | ------ |
| Troubleshooting                                      | 30%    |
| Cluster Architecture, Installation and Configuration | 25%    |
| Services and Networking                              | 20%    |
| Workloads and Scheduling                             | 15%    |
| Storage                                              | 10%    |

Check which sites you can open in the Linux Foundation's allowed resources list before the exam.

## Exam environment

- `ssh` to the host given for each task, `exit` when done. Node work with `sudo -i` or `sudo`
- if the task says to switch context, `kubectl config use-context` first
- namespace with `-n <ns>` on every command

```bash
k run tmp --image=nginx --dry-run=client -o yaml > pod.yaml
k explain pod.spec.affinity.nodeAffinity
k explain pod.spec --recursive | less
```

### Paths you'll check often on a node

| Path                                                        | Contents                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/etc/kubernetes/manifests/`                                | static Pods (etcd, kube-apiserver, kube-controller-manager, kube-scheduler) |
| `/etc/kubernetes/pki/`                                      | CA and certificates. etcd-only ones under `etcd/`                           |
| `/etc/kubernetes/admin.conf`                                | admin kubeconfig                                                            |
| `/etc/kubernetes/kubelet.conf`                              | kubelet kubeconfig                                                          |
| `/var/lib/kubelet/config.yaml`                              | kubelet config (`staticPodPath`, `clusterDNS`, `cgroupDriver`)              |
| `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf` | kubelet systemd drop-in                                                     |
| `/etc/containerd/config.toml`                               | containerd config (`SystemdCgroup`)                                         |
| `/etc/cni/net.d/`, `/opt/cni/bin/`                          | CNI config, binaries                                                        |
| `/var/log/pods/`, `/var/log/containers/`                    | container log files                                                         |

## Cluster Architecture, Installation and Configuration

Curriculum: RBAC, preparing infrastructure for installation, installing and managing with kubeadm, cluster lifecycle, HA control plane, installing components with Helm and Kustomize, CNI/CSI/CRI, CRDs and Operators.

Notes: [cluster architecture](/posts/cka-cluster-architecture), [kubeadm install and HA](/posts/cka-kubeadm-install-ha), [upgrade, etcd, certificates](/posts/cka-cluster-lifecycle), [RBAC and users](/posts/cka-rbac-users), [CNI, CSI, CRI, Operators](/posts/cka-extension-interfaces)

### Node preparation

```bash
swapon --show                                   # should be empty (or kubelet failSwapOn: false)
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

### Packages (pkgs.k8s.io, one repo per minor)

```bash
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -y kubelet kubeadm kubectl cri-tools
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

### kubeadm

```bash
sudo kubeadm init --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=<ip>
sudo kubeadm init --control-plane-endpoint "<lb>:6443" --upload-certs --pod-network-cidr=...   # HA
mkdir -p $HOME/.kube && sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config && sudo chown $(id -u):$(id -g) $HOME/.kube/config

sudo kubeadm token create --print-join-command
sudo kubeadm join <ep>:6443 --token <t> --discovery-token-ca-cert-hash sha256:<h>
sudo kubeadm join <ep>:6443 --token <t> --discovery-token-ca-cert-hash sha256:<h> --control-plane --certificate-key <k>
sudo kubeadm init phase upload-certs --upload-certs        # reissue certificate-key (expires in 2h)
kubectl -n kube-system get cm kubeadm-config -o yaml        # podSubnet, serviceSubnet, etcd dataDir
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
sudo kubeadm reset
```

- node `NotReady` + `cni plugin not initialized` right after init → install a CNI

### upgrade (control plane → workers, one at a time)

```bash
# after changing v1.34 → v1.35 in the repo line
sudo apt-mark unhold kubeadm && sudo apt-get update && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9           # first control plane only
sudo kubeadm upgrade node                    # other control planes, workers

kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <node>
```

- one minor at a time. The kubelet must not be newer than the apiserver
- VERSION in `kubectl get nodes` is the kubelet version

### etcd

```bash
sudo grep -E "file|urls|data-dir" /etc/kubernetes/manifests/etcd.yaml

sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db
sudo etcdutl --write-out=table snapshot status /opt/etcd-backup.db
sudo etcdutl --data-dir /var/lib/etcd-from-backup snapshot restore /opt/etcd-backup.db
# point the etcd-data hostPath in etcd.yaml to /var/lib/etcd-from-backup
# then restart kube-apiserver, controller-manager, scheduler (move manifests out and back), restart kubelet
```

- in etcd 3.6, `etcdctl snapshot` only has `save`. status and restore are in `etcdutl`

### Certificates

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all          # then restart control plane static Pods, copy ~/.kube/config again
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
```

### RBAC and users

```bash
openssl genrsa -out u.key 2048
openssl req -new -key u.key -out u.csr -subj "/CN=u/O=g"
cat u.csr | base64 | tr -d "\n"                          # spec.request of the CSR object
kubectl certificate approve u
kubectl get csr u -o jsonpath='{.status.certificate}' | base64 -d > u.crt
kubectl config set-credentials u --client-key=u.key --client-certificate=u.crt --embed-certs=true
kubectl config set-context u --cluster=kubernetes --user=u --namespace=<ns>

kubectl create role r --verb=get,list --resource=pods -n <ns>
kubectl create clusterrole cr --verb=get,list --resource=nodes
kubectl create rolebinding rb --role=r --user=u -n <ns>
kubectl create clusterrolebinding crb --clusterrole=cr --group=g
kubectl create rolebinding rb2 --clusterrole=edit --serviceaccount=<ns>:<sa> -n <ns>
kubectl auth can-i list pods -n <ns> --as u
kubectl auth can-i --list -n <ns> --as=system:serviceaccount:<ns>:<sa>
```

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: u
spec:
  request: <base64>
  signerName: kubernetes.io/kube-apiserver-client
  usages: [client auth]
```

### Helm, Kustomize, CRDs

```bash
helm repo add <name> <url> && helm repo update
helm search repo <keyword>; helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback <release> <rev> / uninstall / list -A / history / get values
kubectl kustomize <dir|url>; kubectl apply -k <dir|url>
kubectl get crd; kubectl api-resources --api-group=<group>
```

CRD, Helm, and Kustomize basics: [CKAD: Helm and Kustomize](/posts/ckad-helm-kustomize), [CKAD: CRDs, Operators, API deprecations](/posts/ckad-crds-api-deprecations)

### Docs

- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Operating etcd clusters](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/), [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)

## Workloads and Scheduling

Curriculum: rolling updates and rollbacks, ConfigMaps and Secrets, autoscaling, self-healing primitives, Pod admission and scheduling.

Notes: [Pod scheduling](/posts/cka-scheduling), [autoscaling](/posts/cka-autoscaling). Rolling updates in [CKAD: rolling updates and deployment strategies](/posts/ckad-deployment-strategies), ConfigMaps and Secrets in [CKAD: ConfigMaps and Secrets](/posts/ckad-configmaps-secrets), requests, limits, LimitRange, and ResourceQuota in [CKAD: requests, limits, quotas](/posts/ckad-resources-quotas)

```bash
k label node <node> disk=ssd
k taint node <node> key=value:NoSchedule
k taint node <node> key=value:NoSchedule-
k create priorityclass high --value=1000
k autoscale deploy <name> --cpu=50% --min=1 --max=5     # target needs a cpu request
k scale deploy <name> --replicas=3
k rollout status|history|undo deploy <name>
```

```yaml
spec:
  nodeSelector: { disk: ssd }
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - { key: disk, operator: In, values: [ssd] }
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector: { matchLabels: { app: web } }
          topologyKey: kubernetes.io/hostname
  tolerations:
    - { key: key, operator: Equal, value: value, effect: NoSchedule }
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      nodeTaintsPolicy: Honor # keeps the control plane from counting as a domain and leaving Pods Pending
      labelSelector: { matchLabels: { app: web } }
  priorityClassName: high
```

- static Pod: put the YAML in that node's `staticPodPath` (`/var/lib/kubelet/config.yaml`)

### Docs

- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/), [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)

## Services and Networking

Curriculum: Pod-to-Pod connectivity, NetworkPolicy, Service types and endpoints, Gateway API, Ingress controllers and Ingress, CoreDNS.

Notes: [Pod network and CoreDNS](/posts/cka-pod-network-coredns), [Gateway API and Ingress](/posts/cka-gateway-api). Service, Ingress, and NetworkPolicy basics in [CKAD: Service, Ingress, NetworkPolicy](/posts/ckad-services-ingress-networkpolicy)

```bash
k expose deploy web --port=80 --target-port=8080 --type=NodePort
k get svc,endpointslice
k create ingress web --class=nginx --rule="web.example.com/*=web:80"
k get ingressclass; k get gatewayclass; k get gateway,httproute -A
k -n kube-system get cm coredns -o yaml          # Corefile
k -n kube-system edit cm coredns                 # the reload plugin picks it up (a bit over a minute)
k -n kube-system rollout restart deploy coredns
k -n kube-system get cm kube-proxy -o yaml | grep mode
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: app }
spec:
  parentRefs: [{ name: web-gw }]
  hostnames: [app.example.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /v2 } }]
      backendRefs: [{ name: app-v2, port: 80 }]
    - backendRefs:
        - { name: app-v1, port: 80, weight: 80 }
        - { name: app-v2, port: 80, weight: 20 }
```

- if a Route won't attach, check `status.parents[].conditions` (`NotAllowedByListeners`, `BackendNotFound`, `RefNotPermitted`)
- across namespaces: Route → Gateway needs `allowedRoutes`, Route → Service needs a ReferenceGrant
- DNS: `<svc>.<ns>.svc.cluster.local`, Pods `<ip-with-dashes>.<ns>.pod.cluster.local`. hostNetwork Pods use `dnsPolicy: ClusterFirstWithHostNet`

### Docs

- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/), [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/), [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)

## Storage

Curriculum: StorageClasses and dynamic provisioning, volume types, access modes, reclaim policies, PVs and PVCs.

Notes: [CKAD: persistent and ephemeral volumes](/posts/ckad-volumes)

```bash
k get sc,pv,pvc
k get csidriver
k describe pvc <pvc>             # why it's Pending (StorageClass, provisioner)
k patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## Troubleshooting

Curriculum: clusters and nodes, cluster components, resource usage, container output, Services and networking.

Notes: [nodes and cluster components](/posts/cka-troubleshooting-cluster), [workloads, resources, networking](/posts/cka-troubleshooting-apps)

### Nodes, components

```bash
k get nodes; k describe node <node> | grep -A8 Conditions
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -iE "error|failed"
sudo crictl ps -a; sudo crictl logs <id>
sudo sh -c 'ls /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/'
```

| Symptom                                 | Likely cause                                                             |
| --------------------------------------- | ------------------------------------------------------------------------ |
| node `NotReady`, condition `Unknown`    | kubelet stopped                                                          |
| kubelet `activating (auto-restart)`     | wrong config file path, containerd missing → journalctl `command failed` |
| kubectl `TLS handshake timeout`         | apiserver can't reach etcd                                               |
| kubectl `connection refused`            | apiserver not up, kubeconfig address/port                                |
| control plane Pod `CrashLoopBackOff`    | wrong command/flag in the manifest                                       |
| control plane Pod missing from the list | manifest YAML syntax → journalctl `Could not process manifest file`      |
| Pod `Pending` with no Events            | scheduler broken                                                         |
| Deployment `0/N`, no ReplicaSet         | controller-manager broken                                                |

### Resources, logs

```bash
k top nodes --sort-by=cpu
k top pods -A --sort-by=memory --no-headers | head -1
k top pod <pod> --containers
k logs <pod> -c <container> [--previous] [--tail=N] [--since=5m] [--timestamps]
k logs <pod> --all-containers --prefix
k logs -l app=web
```

### Services, networking

| Symptom                                   | Check                        |
| ----------------------------------------- | ---------------------------- |
| `Connection refused` + no endpoints       | selector vs Pod labels       |
| `Connection refused` + endpoints exist    | targetPort vs container port |
| endpoint `ready=false`                    | readinessProbe               |
| name gives `bad address`, ClusterIP works | CoreDNS                      |
| `timed out`                               | NetworkPolicy                |

```bash
k get endpointslice -l kubernetes.io/service-name=<svc>
k run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
k run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### Docs

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/), [crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/), [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)

## References

- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [CKAD cheat sheet](/posts/ckad-cheatsheet)
