---
title: "CKA concept notes: CNI, CSI, CRI, and Operators"
description: "Where CRI (between the kubelet and the container runtime), CNI (Pod networking), and CSI (storage) are configured on a node, installing cluster components with Helm and Kustomize, and how an Operator manages components through CRDs, checked on a kubeadm cluster."
pubDatetime: 2026-10-14T01:06:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "cni", "csi", "cri", "operator", "helm"]
order: 6
---

> Based on: commands checked on a kubeadm cluster v1.35.9 (3 libvirt VMs), containerd 2.4.1, Calico v3.33.0, Helm v4.3.0

Helm charts, releases, values, and Kustomize base/overlay basics are in [CKAD concept notes: Helm and Kustomize](/posts/ckad-helm-kustomize); CRD definitions and custom resource basics are in [CKAD concept notes: CRDs, Operators, API deprecations](/posts/ckad-crds-api-deprecations). This note only covers installing and managing cluster components.

## Contents

## The three interfaces

Kubernetes doesn't implement container execution, networking, or storage itself. It hands them to plugins behind standard interfaces.

| Interface                         | Called by                        | Calls               | What it does                                   | This cluster                          |
| --------------------------------- | -------------------------------- | ------------------- | ---------------------------------------------- | ------------------------------------- |
| CRI (Container Runtime Interface) | kubelet                          | container runtime   | creates sandboxes and containers, pulls images | containerd 2.4.1                      |
| CNI (Container Network Interface) | container runtime                | CNI plugin binaries | gives Pods a network interface and IP          | Calico                                |
| CSI (Container Storage Interface) | kubelet, CSI sidecar controllers | CSI driver          | creates, attaches, mounts volumes              | `csi.tigera.io` (bundled with Calico) |

```text
kubelet ──CRI(gRPC)──▶ containerd ──▶ runc (containers)
                          └──CNI──▶ /opt/cni/bin/calico (Pod network)
kubelet ──CSI(gRPC)──▶ CSI node plugin (DaemonSet)
```

## CRI

The kubelet sends CRI gRPC requests to the runtime over a Unix socket. The socket path is in the kubelet config.

```bash
sudo grep containerRuntimeEndpoint /var/lib/kubelet/config.yaml
# containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock

sudo crictl version
# RuntimeName:  containerd
# RuntimeVersion:  v2.4.1
# RuntimeApiVersion:  v1
```

- `crictl` is a CRI client. It shows Pods and containers on the node from the runtime's point of view (`crictl pods`, `crictl ps`, `crictl logs`, `crictl images`)
- dockershim was removed in Kubernetes v1.24. Using Docker Engine needs an adapter like cri-dockerd
- the low-level runtime that actually creates containers is runc. To use a different low-level runtime (gVisor, Kata, etc.), pick it with a RuntimeClass. This cluster has none (`kubectl get runtimeclass` → `No resources found`)

## CNI

CNI config lives in two places on the node.

| Path              | Contents                                              |
| ----------------- | ----------------------------------------------------- |
| `/etc/cni/net.d/` | CNI config files. The first one in name order is used |
| `/opt/cni/bin/`   | CNI plugin binaries                                   |

Checking that containerd uses these paths:

```bash
sudo crictl info | grep -A3 '"cni"'
# confDir: /etc/cni/net.d, binDirs: ["/opt/cni/bin"]
```

After installing Calico:

```text
$ sudo ls /etc/cni/net.d
10-calico.conflist
calico-kubeconfig
```

`10-calico.conflist` holds a plugin chain: `calico` (ipam `calico-ipam`) followed by `portmap` (handles hostPort).

What a CNI plugin does:

- creates an interface in the network namespace and assigns an IP when a Pod sandbox is created
- routes to Pods on other nodes (Calico uses VXLAN here)
- NetworkPolicy enforcement depends on the CNI. Calico supports it, flannel alone doesn't

With no CNI or an empty config, the node is `NotReady` with the reason `cni plugin not initialized`. (See the [kubeadm install note](/posts/cka-kubeadm-install-ha))

## CSI

A CSI driver is usually installed in two parts.

| Part              | Form                                                                              | What it does                               |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| controller plugin | Deployment/StatefulSet + sidecars (external-provisioner, external-attacher, etc.) | watches PVCs, creates and attaches volumes |
| node plugin       | DaemonSet + node-driver-registrar                                                 | mounts on each node                        |

Drivers registered in the cluster show up as CSIDriver objects.

```text
$ kubectl get csidriver
NAME            ATTACHREQUIRED   PODINFOONMOUNT   STORAGECAPACITY   MODES       AGE
csi.tigera.io   true             true             false             Ephemeral   61m
```

```text
$ kubectl -n calico-system get ds
NAME              DESIRED   CURRENT   READY
calico-node       3         3         3
csi-node-driver   3         3         3
```

- a StorageClass's `provisioner` is the CSI driver name. If dynamic provisioning doesn't work, start by matching the StorageClass provisioner against `kubectl get csidriver`
- `csi.tigera.io` is an ephemeral-only driver Calico uses, so it doesn't create PVs
- for PVs, PVCs, StorageClasses, reclaim policies, and access modes, see [CKAD concept notes: persistent and ephemeral volumes](/posts/ckad-volumes)

## Installing components with Helm

Installing metrics-server with Helm.

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo metrics-server
# metrics-server/metrics-server   3.14.0   0.9.0

helm show values metrics-server/metrics-server | grep -A1 '^args'
# args: []

helm install metrics-server metrics-server/metrics-server -n kube-system \
  --set 'args={--kubelet-insecure-tls}'
kubectl top nodes
```

If you upgrade without `--kubelet-insecure-tls`, the new Pod stays at `0/1 Running` and never becomes Ready.

```text
"Failed to scrape node" err="Get \"https://192.168.122.21:10250/metrics/resource\":
tls: failed to verify certificate: x509: cannot validate certificate for 192.168.122.21
because it doesn't contain any IP SANs" node="cka-w1"
```

This happens because kubeadm's default kubelet serving certificate is self-signed and has no node IP SAN. In a lab you turn off TLS verification; in production you set the kubelet's `serverTLSBootstrap: true` so it gets a serving certificate signed by the cluster CA.

```bash
helm list -n kube-system
helm history metrics-server -n kube-system
helm rollback metrics-server 1 -n kube-system
helm get values metrics-server -n kube-system
# USER-SUPPLIED VALUES:
# args:
# - --kubelet-insecure-tls
```

## Installing components with Kustomize

You can apply a directory with a kustomization, or a remote URL, directly with `kubectl apply -k`. I installed the Gateway API CRDs.

```bash
kubectl kustomize 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3' \
  | grep -c '^kind: CustomResourceDefinition'
# 10

kubectl apply -k 'https://github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.6.3'
kubectl get crd | grep gateway.networking
```

- look at the output YAML with `kubectl kustomize` (= `kustomize build`) first, then apply
- this kustomization creates 10 CRDs and a ValidatingAdmissionPolicy (`safe-upgrades.gateway.networking.k8s.io`)

## Operators

Operator = CRD + a controller that watches that CRD. The controller takes over operational procedures a person used to do (install, config changes, recovery).

I installed Calico the operator way.

| Part                | This cluster                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| operator Deployment | `tigera-operator/tigera-operator`                                           |
| CRDs                | the `operator.tigera.io` group, etc. (`kubectl get crd \| grep tigera` → 9) |
| custom resources    | `Installation default`, `APIServer default`, etc.                           |
| status              | `kubectl get tigerastatus`                                                  |

```bash
kubectl get installation default -o jsonpath='{.spec.calicoNetwork.ipPools}'
# [{"cidr":"10.244.0.0/16","encapsulation":"VXLANCrossSubnet",...}]
```

```text
$ kubectl get tigerastatus
NAME        AVAILABLE   PROGRESSING   DEGRADED
apiserver   True        False         False
calico      True        False         False
...
```

Delete a resource the operator manages, and it comes back.

```bash
kubectl -n calico-system delete ds calico-node
# 15 seconds later
kubectl -n calico-system get ds calico-node    # DESIRED 3, READY 3
```

So to change a DaemonSet or Deployment the operator manages, you edit the custom resource (`Installation`), not that resource. The operator reverts direct edits.

### Operator install order

1. install the CRDs (`operator-crds.yaml`)
2. install the operator (Deployment, RBAC)
3. create the custom resources (`custom-resources.yaml`)

Out of order, you get `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`.

## Easily confused

| Comparison                                                | A                                      | B                                                  |
| --------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| CRI vs CNI                                                | kubelet ↔ runtime. Runs containers     | runtime ↔ network plugin. Pod IPs                  |
| `/etc/cni/net.d` vs `/opt/cni/bin`                        | config                                 | binaries                                           |
| containerd vs runc                                        | high-level runtime implementing CRI    | low-level runtime that actually creates containers |
| CSI controller plugin vs node plugin                      | creates, attaches volumes (Deployment) | mounts on the node (DaemonSet)                     |
| `helm install --set` vs `-f values.yaml`                  | a few values                           | lots of values                                     |
| `kubectl apply -k` vs `kubectl kustomize`                 | builds and applies                     | only prints the build output                       |
| editing operator-managed resources vs the custom resource | the operator reverts it                | the operator applies it                            |

## Exam tips

### Quick commands

```bash
sudo crictl version; sudo crictl info | grep -A3 '"cni"'
ls /etc/cni/net.d /opt/cni/bin
kubectl get csidriver; kubectl get storageclass
kubectl get runtimeclass

helm repo add <name> <url>; helm repo update; helm search repo <keyword>
helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback / uninstall / list -A / get values

kubectl kustomize <dir|url>
kubectl apply -k <dir|url>

kubectl get crd; kubectl api-resources --api-group=<group>
```

- "which CNI is installed": the file names in `/etc/cni/net.d` and the DaemonSets in `kube-system` or a dedicated namespace
- for Helm tasks, get the namespace and release name exactly right. Leave out `-n` and it installs into the default namespace

### kubectl explain

```bash
kubectl explain csidriver.spec
kubectl explain runtimeclass.handler
kubectl explain storageclass.provisioner
```

## References

- [Extending Kubernetes](https://kubernetes.io/docs/concepts/extend-kubernetes/)
- [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [Volumes: CSI](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [Runtime Class](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [metrics-server Helm chart](https://github.com/kubernetes-sigs/metrics-server/tree/master/charts/metrics-server)
- [Gateway API: Getting started](https://gateway-api.sigs.k8s.io/guides/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
