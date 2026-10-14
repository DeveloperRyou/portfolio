---
title: "CKA concept notes: kubeadm install and HA control plane"
description: "From node prep (swap, sysctl, containerd cgroup driver) to kubeadm init/join, installing a CNI, and a stacked-etcd HA control plane behind kube-vip, all run hands-on on 3 VMs."
pubDatetime: 2026-10-14T01:03:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "containerd", "high-availability"]
order: 3
---

> Based on: commands checked with Kubernetes v1.34.12 / v1.35.9, kubeadm, on 3 libvirt VMs (Ubuntu 24.04, 2 vCPU, 2.5-3GB), containerd 2.4.1, Calico v3.33.0

## Contents

## The overall flow

kubeadm is a tool that "turns one node into a control plane and joins the rest." It doesn't prepare the OS, install a container runtime, or install a CNI for you.

| Step             | Where               | What happens                                                         |
| ---------------- | ------------------- | -------------------------------------------------------------------- |
| Node prep        | every node          | swap, sysctl, container runtime, cgroup driver                       |
| Install packages | every node          | kubeadm, kubelet, kubectl (+ cri-tools)                              |
| `kubeadm init`   | first control plane | certificates, kubeconfigs, static Pods, addons (CoreDNS, kube-proxy) |
| Install a CNI    | kubectl             | Pod network. Without it, nodes stay `NotReady`                       |
| `kubeadm join`   | other nodes         | join as a worker or an extra control plane                           |

## Node prep

### Requirements

- 2GB+ RAM per node, 2+ CPUs for the control plane
- every node needs a unique hostname, MAC address, and `product_uuid` (watch out when cloning VMs)

```bash
ip link
sudo cat /sys/class/dmi/id/product_uuid
```

### Required ports

| Node          | Port        | Purpose                 |
| ------------- | ----------- | ----------------------- |
| control plane | 6443        | kube-apiserver          |
| control plane | 2379-2380   | etcd client / peer      |
| control plane | 10250       | kubelet API             |
| control plane | 10257       | kube-controller-manager |
| control plane | 10259       | kube-scheduler          |
| worker        | 10250       | kubelet API             |
| worker        | 10256       | kube-proxy              |
| worker        | 30000-32767 | NodePort Services       |

### swap

By default, the kubelet won't start if swap is on. Turn it off (`swapoff -a` + clean up `/etc/fstab`), or allow it with `failSwapOn: false` in the kubelet config.

When I turned on a swap file on one worker and restarted the kubelet, it kept restarting in `activating`.

```text
"command failed" err="failed to run Kubelet: running with swap on is not supported,
please disable swap or set --fail-swap-on flag to false"
```

The Ubuntu cloud image has no swap to begin with, so `swapon --show` printed nothing.

### sysctl

The only one the official docs currently list as required is IPv4 forwarding.

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # net.ipv4.ip_forward = 1
```

### Container runtime and cgroup driver

The kubelet and the container runtime have to use the same cgroup driver. On distros with systemd as init, and on cgroup v2, the `systemd` driver is recommended. kubeadm puts `cgroupDriver: systemd` in the kubelet config by default, so the side you usually need to fix is containerd.

Installing containerd 2.4.1 from the `containerd.io` package in Docker's repo and generating the default config gives you `SystemdCgroup = false`.

```bash
sudo apt-get install -y containerd.io
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
grep -n SystemdCgroup /etc/containerd/config.toml
# 89:            SystemdCgroup = false
```

In the containerd 2.x config file (`version = 4`), the setting lives at the path below. It's different from the `[plugins."io.containerd.grpc.v1.cri"...]` path in 1.x docs.

```toml
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
  SystemdCgroup = true
```

```bash
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

The sandbox (pause) image is set in the same file: `sandbox = 'registry.k8s.io/pause:3.10.2'`.

## Installing the packages

`pkgs.k8s.io` has a separate repo per minor version. The `v1.34` part of the URL is the minor you're installing.

```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

- `apt-mark hold`: pins the version so `apt upgrade` doesn't bump it on its own. `unhold` only when upgrading
- at this point the kubelet has no config file, so it restarts every few seconds. That's fine once `kubeadm init`/`join` writes the config
- `crictl` didn't come with those three packages. Install it separately with `sudo apt-get install -y cri-tools`
- without `/etc/crictl.yaml`, `crictl` prints a warning every time that the default endpoints are deprecated

```yaml
# /etc/crictl.yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
```

## kubeadm init

```bash
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=192.168.122.11
```

| Flag                            | Meaning                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `--pod-network-cidr`            | Pod IP range. Must match the CNI config and must not overlap the node network     |
| `--apiserver-advertise-address` | the IP the apiserver advertises. Defaults to the interface with the default route |
| `--control-plane-endpoint`      | shared endpoint for HA (an LB address or DNS name). See the HA section below      |
| `--service-cidr`                | Service IP range. Default `10.96.0.0/12`                                          |
| `--kubernetes-version`          | control plane version                                                             |

You can also pull the images ahead of time: `sudo kubeadm config images pull`.

### What init does

The `[phase]` order in the output is exactly what kubeadm creates.

| phase                   | Output                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`             | checks swap, ports, runtime, etc. Pulls images                                                                                            |
| `certs`                 | CA and certificates under `/etc/kubernetes/pki/`. The apiserver cert SANs include `10.96.0.1` (the kubernetes Service IP) and the node IP |
| `kubeconfig`            | `admin.conf`, `super-admin.conf`, `kubelet.conf`, `controller-manager.conf`, `scheduler.conf` in `/etc/kubernetes/`                       |
| `etcd`, `control-plane` | static Pod manifests for etcd, kube-apiserver, kube-controller-manager, kube-scheduler in `/etc/kubernetes/manifests/`                    |
| `kubelet-start`         | writes `/var/lib/kubelet/config.yaml`, `/var/lib/kubelet/kubeadm-flags.env`, then starts the kubelet                                      |
| `upload-config`         | stores the config used in the `kube-system/kubeadm-config` ConfigMap                                                                      |
| `mark-control-plane`    | label `node-role.kubernetes.io/control-plane`, taint `node-role.kubernetes.io/control-plane:NoSchedule`                                   |
| `bootstrap-token`       | a join token with its RBAC, and the `kube-public/cluster-info` ConfigMap                                                                  |
| `addons`                | CoreDNS Deployment, kube-proxy DaemonSet                                                                                                  |

### Right after it finishes

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

As root, `export KUBECONFIG=/etc/kubernetes/admin.conf` works too.

Until a CNI is installed, the node is `NotReady` and CoreDNS is `Pending`.

```text
$ kubectl get nodes
NAME      STATUS     ROLES           AGE   VERSION
cka-cp1   NotReady   control-plane   7s    v1.34.12

$ kubectl describe node cka-cp1
Taints:  node.kubernetes.io/not-ready:NoExecute
         node.kubernetes.io/not-ready:NoSchedule
  Ready  False ... KubeletNotReady  container runtime network not ready: NetworkReady=false
         reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
```

`/opt/cni/bin` already has the basic plugin binaries (bridge, host-device, etc.), but `/etc/cni/net.d` is empty, hence this state.

## Installing a CNI

One Pod network per cluster. I installed Calico v3.33.0 the operator way.

```bash
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/operator-crds.yaml
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/tigera-operator.yaml
curl -fsSLO https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/custom-resources.yaml
sed -i 's#cidr: 192.168.0.0/16#cidr: 10.244.0.0/16#' custom-resources.yaml
kubectl create -f custom-resources.yaml
```

- the default `192.168.0.0/16` in `custom-resources.yaml` overlaps libvirt's default network (`192.168.122.0/24`), so I changed it to `10.244.0.0/16`, same as `--pod-network-cidr`
- creating the custom resources before the CRDs are registered gives `no matches for kind "Installation" in version "operator.tigera.io/v1"` / `ensure CRDs are installed first`
- after installing, `/etc/cni/net.d/10-calico.conflist` appears and the node goes `Ready` in about a minute

## kubeadm join

Run the join command at the end of the init output on each worker, as root. If you lost the output, you can regenerate it on the control plane.

```bash
# on the control plane
sudo kubeadm token create --print-join-command
# kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>

# on the worker
sudo kubeadm join 192.168.122.11:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

| Value                            | Meaning                                                                                | Check                 |
| -------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| `--token`                        | bootstrap token the worker uses when it first reaches the apiserver. Default TTL 24h   | `kubeadm token list`  |
| `--discovery-token-ca-cert-hash` | hash of the CA public key, so the worker can verify it's talking to the real apiserver | openssl command below |

```bash
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
  | openssl rsa -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -hex | sed 's/^.* //'
```

I checked that this matches the hash in the join command.

The flow visible in the join output: read the `kube-system/kubeadm-config` ConfigMap → write the kubelet config and start it → TLS Bootstrap (send a CSR with the token and get a kubelet client certificate) → `This node has joined the cluster`.

```text
$ kubectl get nodes -o wide
NAME      STATUS   ROLES           VERSION    INTERNAL-IP      CONTAINER-RUNTIME
cka-cp1   Ready    control-plane   v1.34.12   192.168.122.11   containerd://2.4.1
cka-w1    Ready    <none>          v1.34.12   192.168.122.21   containerd://2.4.1
cka-w2    Ready    <none>          v1.34.12   192.168.122.22   containerd://2.4.1
```

ROLES showing `<none>` for workers is normal. It shows up if you add the label yourself (`kubectl label node cka-w1 node-role.kubernetes.io/worker=`).

To run Pods on the control plane too, remove the taint.

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

## HA control plane

### Topology

|               | stacked etcd                                                        | external etcd                                              |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Where etcd is | an etcd member runs on each control plane node                      | separate etcd nodes                                        |
| Minimum nodes | 3 control planes                                                    | 3 control planes + 3 etcd                                  |
| Pros          | fewer nodes, simpler setup. kubeadm's default                       | losing a control plane doesn't take an etcd member with it |
| Cons          | losing a node takes out an etcd member and a control plane together | twice the nodes, more complex setup                        |

etcd needs a majority (quorum) alive to accept writes. With 3, it tolerates 1 failure. That's why stacked needs at least 3 too.

### Load balancer

With several control planes, the kubelets and kubectl need a shared address. That's `--control-plane-endpoint`, and you have to decide it at the first init.

- use an external LB (HAProxy, etc.), or run keepalived + HAProxy on the nodes, or a static Pod like kube-vip
- LB health check: TCP check on the apiserver port (6443)
- here I ran kube-vip v1.2.4 as a static Pod, attaching the VIP `192.168.122.100` to the leader node via ARP

```bash
export KVVERSION=v1.2.4 VIP=192.168.122.100 INTERFACE=enp1s0
sudo ctr image pull ghcr.io/kube-vip/kube-vip:$KVVERSION
sudo ctr run --rm --net-host ghcr.io/kube-vip/kube-vip:$KVVERSION vip /kube-vip \
  manifest pod --interface $INTERFACE --address $VIP --controlplane --arp --leaderElection \
  | sudo tee /etc/kubernetes/manifests/kube-vip.yaml
```

- on the first control plane, the kubeconfig hostPath in the manifest has to point to `super-admin.conf` instead of `admin.conf`. Since v1.29, `admin.conf` doesn't have its permissions yet during init, so kube-vip can't win leader election and the VIP never comes up
- switch it back to `admin.conf` after init. When I did, the VIP disappeared briefly while the kube-vip Pod restarted, and kubectl failed in the meantime with `dial tcp 192.168.122.100:6443: connect: no route to host`
- `nc -zv -w 2 192.168.122.100 6443` before init times out. kube-vip is also a static Pod started by the kubelet, so there's no VIP before init

### init and control plane join

```bash
# first control plane
sudo kubeadm init --control-plane-endpoint "192.168.122.100:6443" --upload-certs \
  --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=192.168.122.11

# other control planes (the command from the init output)
sudo kubeadm join 192.168.122.100:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane --certificate-key <key>
```

| Flag                | Meaning                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--upload-certs`    | encrypts the certificates control planes share (CA, etc.) and uploads them to the `kube-system/kubeadm-certs` Secret |
| `--control-plane`   | join as a control plane, not a worker                                                                                |
| `--certificate-key` | key that decrypts that Secret. Used to download the certificates                                                     |

- the uploaded certs and key are deleted after 2 hours. To add a control plane after that, re-upload with `sudo kubeadm init phase upload-certs --upload-certs` and get a new key
- worker join uses the same endpoint without `--control-plane` and `--certificate-key`

Result: 3 control planes, 3 etcd members. For the HA lab I rebuilt all 3 VMs as control planes, so cka-w1 and cka-w2 are control planes despite their names.

```text
$ etcdctl member list -w table
|  NAME   |         PEER ADDRS          | IS LEARNER |
|  cka-w2 | https://192.168.122.22:2380 |      false |
| cka-cp1 | https://192.168.122.11:2380 |      false |
|  cka-w1 | https://192.168.122.21:2380 |      false |
```

### Failure test

I force-stopped the cka-cp1 VM, which held the VIP.

- about 19 seconds later the VIP moved to cka-w1, and kubectl through the VIP responded again
- cka-cp1 turned `NotReady` after roughly 40-50 seconds
- `etcdctl endpoint health`: two members healthy, cka-cp1 `context deadline exceeded`, overall `unhealthy cluster`. Still, 2 of 3 were alive, so the API kept working

## Easily confused

| Comparison                                                    | A                                                                | B                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `--apiserver-advertise-address` vs `--control-plane-endpoint` | this node's own IP that its apiserver advertises                 | shared address (LB) every node connects to. Needed for HA |
| bootstrap token vs certificate key                            | authenticates a node joining the cluster for the first time. 24h | decryption key for fetching control plane certs. 2h       |
| worker join vs control plane join                             | `kubeadm join <ep> --token --discovery-token-ca-cert-hash`       | the same plus `--control-plane --certificate-key`         |
| `/opt/cni/bin` vs `/etc/cni/net.d`                            | CNI plugin binaries                                              | CNI config. The node needs this to be `Ready`             |
| stacked vs external etcd                                      | etcd on the control plane nodes. 3 minimum                       | etcd separate. 3+3 minimum                                |
| `admin.conf` vs `super-admin.conf`                            | `kubeadm:cluster-admins` group. The everyday kubeconfig          | `system:masters` group. Break-glass, bypasses RBAC        |

## Exam tips

### Quick commands

```bash
sudo kubeadm token create --print-join-command     # regenerate the join command
sudo kubeadm token list
sudo kubeadm init phase upload-certs --upload-certs # new key for adding control planes
kubectl -n kube-system get cm kubeadm-config -o yaml # check podSubnet, serviceSubnet, etcd dataDir
sudo kubeadm reset                                  # revert a node to before init/join (best-effort)
```

- what to check during node prep: `swapon --show`, `sysctl net.ipv4.ip_forward`, `grep SystemdCgroup /etc/containerd/config.toml`, `systemctl status containerd kubelet`
- `NotReady` right after init: check whether a CNI is installed first

### kubectl explain

kubeadm config isn't a Kubernetes resource, so there's no `kubectl explain` for it. Use these instead.

```bash
kubeadm config print init-defaults   # InitConfiguration, ClusterConfiguration defaults
kubeadm config print join-defaults
kubeadm init --help
```

## References

- [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)
- [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/)
- [Options for Highly Available Topology](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/ha-topology/)
- [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [kubeadm HA considerations (kube-vip)](https://github.com/kubernetes/kubeadm/blob/main/docs/ha-considerations.md)
- [Calico: Install on on-premises deployments](https://docs.tigera.io/calico/latest/getting-started/kubernetes/self-managed-onprem/onpremises)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
