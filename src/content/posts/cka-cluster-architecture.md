---
title: "CKA concept notes: cluster architecture and components"
description: "How the control plane components (kube-apiserver, etcd, scheduler, controller-manager) and node components (kubelet, kube-proxy, container runtime) connect, plus static Pods and the files under /etc/kubernetes, checked hands-on on a kubeadm cluster."
pubDatetime: 2026-10-14T01:02:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "control-plane", "kubelet", "static-pod"]
order: 2
---

> Based on: commands checked on a kubeadm cluster v1.35.9 (3 libvirt VMs: 1 control plane, 2 workers), containerd 2.4.1

## Contents

## Component map

```text
              kubectl / users
                    │ :6443
┌───────────────────▼──── control plane (cka-cp1) ───────────────┐
│  kube-apiserver ──── etcd (:2379)                              │
│     ▲      ▲                                                   │
│     │      └── kube-scheduler, kube-controller-manager         │
│     │          (watch the apiserver, write results back to it) │
└─────┼──────────────────────────────────────────────────────────┘
      │ :6443                       ▲ :10250 (logs, exec)
┌─────┴──────────── worker (cka-w1, cka-w2) ──┴──────────────────┐
│  kubelet ── CRI ── containerd ── runc                          │
│  kube-proxy (Service → iptables rules)                         │
│  CNI plugin (Pod network)                                      │
└────────────────────────────────────────────────────────────────┘
```

- only kube-apiserver talks to etcd directly. Everything else goes through the apiserver
- components don't command each other. Each one watches the apiserver and, when the desired state and actual state differ, reconciles them

## Control plane components

| Component                | What it does                                                                    | How kubeadm runs it            |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------ |
| kube-apiserver           | entry point for every request. Authn, authz, admission, validation, then etcd   | static Pod                     |
| etcd                     | key-value store holding cluster state                                           | static Pod                     |
| kube-scheduler           | picks a node for Pods with an empty `nodeName`                                  | static Pod                     |
| kube-controller-manager  | bundle of controllers (Deployment, ReplicaSet, Node, Job...). Drives to desired | static Pod                     |
| cloud-controller-manager | cloud API integration (LBs, nodes, etc.)                                        | not present in on-prem kubeadm |

Key flags in the manifests:

```bash
sudo grep -E "etcd-servers|service-cluster-ip-range|authorization-mode|enable-admission" \
  /etc/kubernetes/manifests/kube-apiserver.yaml
#    - --authorization-mode=Node,RBAC
#    - --enable-admission-plugins=NodeRestriction
#    - --etcd-servers=https://127.0.0.1:2379
#    - --service-cluster-ip-range=10.96.0.0/12

sudo grep -E "cluster-cidr|allocate-node-cidrs|leader-elect" \
  /etc/kubernetes/manifests/kube-controller-manager.yaml
#    - --allocate-node-cidrs=true
#    - --cluster-cidr=10.244.0.0/16
#    - --leader-elect=true
```

- `--service-cluster-ip-range`: Service ClusterIP range. `kubeadm init --service-cidr`
- `--cluster-cidr`: Pod range. `kubeadm init --pod-network-cidr`
- the scheduler and controller-manager run with `--leader-elect=true`. In HA, several can be up, but only the one holding the Lease does the work

```text
$ kubectl -n kube-system get lease
NAME                      HOLDER
kube-controller-manager   cka-cp1_570f3ff0-...
kube-scheduler            cka-cp1_af5d04d1-...
```

## Node components

| Component         | What it does                                                                     | How it runs                                      |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| kubelet           | runs the Pods assigned to its node through the container runtime, reports status | systemd service                                  |
| container runtime | pulls images, runs containers. Talks to the kubelet over CRI                     | systemd service (containerd)                     |
| kube-proxy        | watches Services and EndpointSlices, writes iptables/IPVS/nftables rules         | DaemonSet                                        |
| CNI plugin        | gives Pods an IP and a network interface                                         | usually a DaemonSet + binaries in `/opt/cni/bin` |

The kubelet isn't a Pod. You need the kubelet for Pods to start at all. Control plane nodes have a kubelet, container runtime, and kube-proxy too.

```text
$ kubectl -n kube-system get pods -o wide
coredns-7d764666f9-9w4dz          cka-cp1
coredns-7d764666f9-bwvwh          cka-w1
etcd-cka-cp1                      cka-cp1
kube-apiserver-cka-cp1            cka-cp1
kube-controller-manager-cka-cp1   cka-cp1
kube-proxy-44chc                  cka-w1
kube-proxy-ckfkj                  cka-w2
kube-proxy-mjtnj                  cka-cp1
kube-scheduler-cka-cp1            cka-cp1
```

- names ending in a node name (`etcd-cka-cp1`) are static Pods
- names with a random suffix come from a Deployment (CoreDNS) or a DaemonSet (kube-proxy)

## kubelet

### Where the config lives

```bash
systemctl cat kubelet
```

```text
# /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
EnvironmentFile=-/etc/default/kubelet
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
```

| File                                 | Contents                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `/etc/kubernetes/kubelet.conf`       | kubeconfig for reaching the apiserver                                     |
| `/var/lib/kubelet/config.yaml`       | KubeletConfiguration. `staticPodPath`, `cgroupDriver`, `clusterDNS`, etc. |
| `/var/lib/kubelet/kubeadm-flags.env` | extra flags kubeadm adds (`KUBELET_KUBEADM_ARGS`)                         |
| `/etc/default/kubelet`               | extra flags you add (`KUBELET_EXTRA_ARGS`)                                |

```bash
sudo grep -E "staticPodPath|cgroupDriver|containerRuntimeEndpoint|clusterDomain" /var/lib/kubelet/config.yaml
# cgroupDriver: systemd
# clusterDomain: cluster.local
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock
# staticPodPath: /etc/kubernetes/manifests
```

`clusterDNS: [10.96.0.10]` is in this file too. That's where the nameserver in a Pod's `/etc/resolv.conf` comes from.

## Static Pods

Pods the kubelet starts on its own from manifests in a local directory (`staticPodPath`), no apiserver needed. This is how the control plane can come up without an apiserver.

### Mirror Pods

For each static Pod, the kubelet creates a mirror Pod in the apiserver so it shows up in `kubectl get pods`. The name is `<metadata.name>-<node name>`.

I dropped a file into `/etc/kubernetes/manifests/` on a worker (cka-w1).

```yaml
# /etc/kubernetes/manifests/static-web.yaml (cka-w1)
apiVersion: v1
kind: Pod
metadata:
  name: static-web
  labels:
    role: static
spec:
  containers:
    - name: web
      image: nginx:1.27
```

```text
$ kubectl get pod -o wide
static-web-cka-w1   Running   cka-w1

$ kubectl get pod static-web-cka-w1 -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}'
Node/cka-w1
```

| Action                                 | Result                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `kubectl delete pod static-web-cka-w1` | says `deleted`, but it's back to `Running` a few seconds later. The kubelet recreates the mirror Pod |
| delete the manifest file               | the Pod actually goes away (`NotFound`)                                                              |
| edit the manifest file                 | the kubelet recreates the Pod                                                                        |

To delete or change a static Pod, you have to ssh into that node and work with the file. Which node it's on: check the name suffix or `-o wide`.

- `/etc/kubernetes/manifests/` on a worker starts out empty. The directory and the `staticPodPath` setting exist on workers just the same
- static Pods can't reference other API objects like ConfigMaps, Secrets, or ServiceAccounts

## Files under /etc/kubernetes

Control plane:

```text
/etc/kubernetes/
├── admin.conf               # kubeadm:cluster-admins group. For kubectl
├── super-admin.conf         # system:masters group. Break-glass
├── controller-manager.conf  # controller-manager → apiserver
├── scheduler.conf           # scheduler → apiserver
├── kubelet.conf             # kubelet → apiserver
├── manifests/               # static Pods: etcd, kube-apiserver, kube-controller-manager, kube-scheduler
└── pki/
    ├── ca.crt, ca.key                     # cluster CA
    ├── apiserver.crt/key                  # apiserver serving cert
    ├── apiserver-kubelet-client.crt/key   # apiserver → kubelet (logs, exec)
    ├── apiserver-etcd-client.crt/key      # apiserver → etcd
    ├── front-proxy-ca.*, front-proxy-client.*  # aggregation layer
    ├── sa.key, sa.pub                     # ServiceAccount token signing
    └── etcd/                              # etcd's own CA and server/peer certs
```

Workers only have `kubelet.conf`, `manifests/` (empty), and `pki/ca.crt`. A worker's `kubelet.conf` points to `server: https://192.168.122.11:6443`.

## Ports

What `ss -tlnp` showed on the control plane:

| Address                                 | Process                 | Purpose                                     |
| --------------------------------------- | ----------------------- | ------------------------------------------- |
| `*:6443`                                | kube-apiserver          | API                                         |
| `192.168.122.11:2379`, `127.0.0.1:2379` | etcd                    | client                                      |
| `192.168.122.11:2380`                   | etcd                    | peer (between members in HA)                |
| `127.0.0.1:2381`                        | etcd                    | metrics, health                             |
| `127.0.0.1:10257`                       | kube-controller-manager | health                                      |
| `127.0.0.1:10259`                       | kube-scheduler          | health                                      |
| `*:10250`                               | kubelet                 | API (the apiserver connects for logs, exec) |
| `127.0.0.1:10248`                       | kubelet                 | healthz                                     |
| `*:10256`, `127.0.0.1:10249`            | kube-proxy              | healthz, metrics                            |

## From one request to a running Pod

`kubectl create deploy web --image=nginx --replicas=2`:

1. kubectl → apiserver: authn, authz (RBAC), admission, then the Deployment is stored in etcd
2. the Deployment controller in controller-manager creates a ReplicaSet
3. the ReplicaSet controller creates 2 Pods (`nodeName` empty)
4. the scheduler picks a node for each Pod and writes `nodeName` (binding)
5. that node's kubelet sees its Pod and asks containerd over CRI to create the sandbox and containers; the CNI assigns the Pod IP
6. the kubelet reports Pod status back to the apiserver

Where to look depends on which step it stopped at:

| Symptom                                                 | Suspect                         |
| ------------------------------------------------------- | ------------------------------- |
| Deployment exists but no ReplicaSet/Pods appear         | kube-controller-manager         |
| Pod `Pending`, nothing in Events                        | kube-scheduler                  |
| Pod assigned to a node but stuck in `ContainerCreating` | kubelet, container runtime, CNI |
| `kubectl` doesn't respond at all                        | kube-apiserver, etcd            |

## Easily confused

| Comparison                                       | A                                                                      | B                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| static Pod vs DaemonSet                          | the kubelet starts it from a local file. No apiserver needed. One node | a controller manages it via the API. All (or selected) nodes |
| deleting the mirror Pod vs deleting the manifest | it comes back                                                          | it's actually gone                                           |
| kubelet vs the other components                  | systemd service. `systemctl`, `journalctl`                             | Pods. `kubectl logs`, `crictl logs`                          |
| `--service-cluster-ip-range` vs `--cluster-cidr` | Service IP range (apiserver)                                           | Pod IP range (controller-manager)                            |
| `admin.conf` vs `kubelet.conf`                   | admin kubeconfig for humans                                            | the kubelet's node identity (`system:node:<node>`)           |

## Exam tips

### Quick commands

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide        # static Pods end with the node name
ls /etc/kubernetes/manifests/                  # which static Pods exist
sudo grep staticPodPath /var/lib/kubelet/config.yaml
systemctl status kubelet
sudo crictl ps                                  # works even when the apiserver is down
kubectl get --raw='/readyz?verbose'             # apiserver health
```

- a "create a static Pod" task is done once the YAML is in that node's `staticPodPath`. Generating the skeleton with `kubectl run --dry-run=client -o yaml` is fast
- `staticPodPath` might not be the default. Check `config.yaml` first
- `kubectl get componentstatuses` prints a warning that it's been deprecated since v1.19. Check health with `/readyz`, `/livez`, or Pod status instead

### kubectl explain

```bash
kubectl explain pod.spec.nodeName
kubectl explain lease.spec            # holderIdentity, renewTime
```

## References

- [Cluster Architecture](https://kubernetes.io/docs/concepts/architecture/)
- [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/)
- [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [Communication between Nodes and the Control Plane](https://kubernetes.io/docs/concepts/architecture/control-plane-node-communication/)
- [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
