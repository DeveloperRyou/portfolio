---
title: "CKA concept notes: cluster upgrades, etcd backup, certificates"
description: "Version skew rules, the order for upgrading from 1.34 to 1.35 with kubeadm plus drain/uncordon, etcd backup and restore with etcdctl and etcdutl, and checking and renewing kubeadm certificates, all run hands-on on a VM cluster."
pubDatetime: 2026-10-14T01:04:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubeadm", "upgrade", "etcd", "certificates"]
order: 4
---

> Based on: commands checked on a kubeadm cluster v1.34.12 → v1.35.9 (3 libvirt VMs: 1 control plane, 2 workers), etcd 3.6.5 / 3.6.6, etcdctl and etcdutl 3.6.5

## Contents

## Version skew

The upgrade order follows from "how far ahead of or behind the apiserver each component is allowed to be."

| Component                               | Allowed range relative to kube-apiserver  |
| --------------------------------------- | ----------------------------------------- |
| kube-apiserver (HA)                     | up to 1 minor apart from each other       |
| kube-controller-manager, kube-scheduler | same or 1 minor older. Never newer        |
| kubelet                                 | same or up to 3 minors older. Never newer |
| kube-proxy                              | same or up to 3 minors older. Never newer |
| kubectl                                 | ±1 minor                                  |

Rules that come out of this:

- upgrade the control plane first, the kubelets after
- you can't skip minor versions. 1.33 → 1.35 has to go through 1.34. Skipping patches is fine

## Upgrade order

| Step | Node                   | Commands                                                                                                 |
| ---- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | first control plane    | change repo → install kubeadm → `kubeadm upgrade plan` → `kubeadm upgrade apply v1.35.9`                 |
| 2    | other control planes   | install kubeadm → `kubeadm upgrade node`                                                                 |
| 3    | each control plane     | drain → install kubelet, kubectl → restart kubelet → uncordon                                            |
| 4    | workers, one at a time | install kubeadm → `kubeadm upgrade node` → drain → install kubelet, kubectl → restart kubelet → uncordon |

`kubeadm upgrade apply` runs only once for the whole cluster. Every other node uses `kubeadm upgrade node`.

## Control plane upgrade

### Repo and kubeadm

`pkgs.k8s.io` has a different repo per minor version, so you have to change the version in the repo line before the new version shows up.

```bash
sudo sed -i 's#v1.34#v1.35#g' /etc/apt/sources.list.d/kubernetes.list
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
sudo apt-get update
sudo apt-cache madison kubeadm
#    kubeadm | 1.35.9-1.1 | https://pkgs.k8s.io/core:/stable:/v1.35/deb  Packages
#    kubeadm | 1.35.8-1.1 | ...

sudo apt-mark unhold kubeadm && \
sudo apt-get install -y kubeadm='1.35.9-*' && \
sudo apt-mark hold kubeadm
kubeadm version -o short   # v1.35.9
```

### upgrade plan

```bash
sudo kubeadm upgrade plan
```

```text
[upgrade/versions] Cluster version: 1.34.12
[upgrade/versions] kubeadm version: v1.35.9
remote version is much newer: v1.37.1; falling back to: stable-1.35
Components that must be upgraded manually after you have upgraded the control plane with 'kubeadm upgrade apply':
COMPONENT   NODE      CURRENT    TARGET
kubelet     cka-cp1   v1.34.12   v1.35.9
kubelet     cka-w1    v1.34.12   v1.35.9
kubelet     cka-w2    v1.34.12   v1.35.9

COMPONENT                 NODE      CURRENT    TARGET
kube-apiserver            cka-cp1   v1.34.12   v1.35.9
kube-controller-manager   cka-cp1   v1.34.12   v1.35.9
kube-scheduler            cka-cp1   v1.34.12   v1.35.9
kube-proxy                          1.34.12    v1.35.9
CoreDNS                             v1.12.1    v1.13.1
etcd                      cka-cp1   3.6.5-0    3.6.6-0
```

- kubeadm doesn't upgrade the kubelet. The top table is "what you have to do yourself"
- running plan right after restarting the control plane static Pods failed with `[ERROR CreateJob]: Job "upgrade-health-check-..." ... did not complete in 15s`. Running it again 30 seconds later passed. plan and apply start a health check Job to look at cluster state

### upgrade apply

```bash
sudo kubeadm upgrade apply v1.35.9
```

What apply does:

- rewrites the manifests in order (etcd, kube-apiserver, kube-controller-manager, kube-scheduler) and waits for the kubelet to restart each static Pod
- backs up the previous manifests to `/etc/kubernetes/tmp/kubeadm-backup-manifests-<date>/` and the etcd data to `kubeadm-backup-etcd-<date>/`
- renews certificates per component (`Renewing apiserver certificate`, etc.)
- updates the `kube-system/kubelet-config` ConfigMap, upgrades the CoreDNS and kube-proxy addons
- last line: `[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.35.9".`

Even after apply finishes, VERSION in `kubectl get nodes` stays `v1.34.12`. That column is the kubelet version, so it won't change until you upgrade the kubelet.

### kubelet, kubectl

```bash
kubectl drain cka-cp1 --ignore-daemonsets

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && \
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon cka-cp1
```

`Ready,SchedulingDisabled` while drained, `Ready` and `v1.35.9` after uncordon.

## Worker upgrade

```bash
# on the worker: after changing the repo
sudo apt-mark unhold kubeadm && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade node
# [upgrade/addon] Skipping the addon/kube-proxy phase. Not a control plane node.

# on the control plane (where kubectl is)
kubectl drain cka-w1 --ignore-daemonsets

# on the worker
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet

# on the control plane
kubectl uncordon cka-w1
```

On a worker, `kubeadm upgrade node` only fetches the new kubelet config (`/var/lib/kubelet/config.yaml`). Run drain where the kubeconfig is, not on the worker.

## drain, cordon, uncordon

| Command                   | Blocks scheduling   | Existing Pods |
| ------------------------- | ------------------- | ------------- |
| `kubectl cordon <node>`   | yes                 | untouched     |
| `kubectl drain <node>`    | yes (cordons first) | evicted       |
| `kubectl uncordon <node>` | lifted              | no change     |

Cases where drain without options is refused:

```text
cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore):
  calico-system/calico-node-..., calico-system/csi-node-driver-..., kube-system/kube-proxy-...
cannot delete Pods that declare no controller (use --force to override): default/plain
```

| Situation                     | Option                   | Result                         |
| ----------------------------- | ------------------------ | ------------------------------ |
| DaemonSet Pods                | `--ignore-daemonsets`    | skipped. They stay on the node |
| Pods with no controller       | `--force`                | deleted. Not recreated         |
| Pods using emptyDir           | `--delete-emptydir-data` | deleted. emptyDir data is lost |
| PodDisruptionBudget violation | (none)                   | keeps retrying                 |

- even if drain fails, the cordon is already in place. Draining again prints `node/cka-w2 already cordoned`
- draining the node of a replicas-2 Deployment with a `minAvailable: 2` PDB repeats `Cannot evict pod as it would violate the pod's disruption budget.` every 5 seconds. With `--timeout=10s` it ends with `global timeout reached: 10s`
- uncordon doesn't move Pods back to the original node. In my lab, after draining the two workers in turn, all 4 replicas ended up on cka-w1

## etcd backup and restore

### Tools

| Tool      | Purpose                                     | Notes                                 |
| --------- | ------------------------------------------- | ------------------------------------- |
| `etcdctl` | connects to a running etcd over the network | `snapshot save`                       |
| `etcdutl` | works on etcd data files directly           | `snapshot status`, `snapshot restore` |

In etcd 3.6.5, `etcdctl snapshot` only has `save` left. status and restore are done with `etcdutl`.

```text
$ etcdctl snapshot --help
COMMANDS:
  save	Stores an etcd node backend snapshot to a given file
```

Neither is installed on kubeadm nodes by default, so I downloaded them from the GitHub release matching the etcd image version (`registry.k8s.io/etcd:3.6.5-0`).

### Finding the connection details

Everything you need is in the etcd static Pod manifest.

```bash
sudo grep -E "listen-client-urls|cert-file|key-file|trusted-ca-file|data-dir" /etc/kubernetes/manifests/etcd.yaml
#    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
#    - --data-dir=/var/lib/etcd
#    - --key-file=/etc/kubernetes/pki/etcd/server.key
#    - --listen-client-urls=https://127.0.0.1:2379,https://192.168.122.11:2379
#    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
```

### Backup

```bash
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db
# Snapshot saved at /opt/etcd-backup.db

sudo etcdutl --write-out=table snapshot status /opt/etcd-backup.db
```

```text
+----------+----------+------------+------------+---------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE | VERSION |
+----------+----------+------------+------------+---------+
| 2e711e8a |     2202 |        767 |      11 MB |   3.6.0 |
+----------+----------+------------+------------+---------+
```

### Restore

How I checked it: create a ConfigMap `before-backup` before the backup and `after-backup` after it, then restore. After the restore only `before-backup` should exist.

```bash
# 1. restore into a new data dir
sudo etcdutl --data-dir /var/lib/etcd-from-backup snapshot restore /opt/etcd-backup.db

# 2. point the etcd manifest's hostPath at the new path
sudo vi /etc/kubernetes/manifests/etcd.yaml
```

```yaml
volumes:
  - hostPath:
      path: /var/lib/etcd-from-backup # was /var/lib/etcd
      type: DirectoryOrCreate
    name: etcd-data
```

- leave `--data-dir=/var/lib/etcd` and the `mountPath` inside the container as they are. Only the host-side path changes
- after editing the manifest, it took the kubelet over a minute to bring the etcd Pod back up

This is where I got confused once. Even after etcd came up with the restored data, `kubectl get cm` kept showing `after-backup`. Looking at etcd directly with `etcdctl get /registry/configmaps/backup-test --prefix --keys-only`, `after-backup` was already gone. The apiserver's watch cache was holding the pre-restore state.

```bash
# 3. restart the control plane components (static Pods restart when you move the manifest out and back)
cd /etc/kubernetes/manifests
sudo mv kube-apiserver.yaml kube-controller-manager.yaml kube-scheduler.yaml /tmp/
# wait until the containers are gone, then
sudo mv /tmp/kube-apiserver.yaml /tmp/kube-controller-manager.yaml /tmp/kube-scheduler.yaml .
sudo systemctl restart kubelet
```

After the restart only `before-backup` remains. The official docs also recommend restarting all apiservers, plus the scheduler, controller-manager, and kubelet, after a restore.

### Watch out when upgrading after a restore

With only the hostPath changed, I ran `kubeadm upgrade apply`, and kubeadm rewrote the etcd manifest based on `etcd.local.dataDir` (`/var/lib/etcd`) in `kubeadm-config`, so the hostPath went back to `/var/lib/etcd`. etcd came back up with the pre-restore data, and the upgrade then failed at the apiserver step with `context deadline exceeded`.

On a real cluster, either put the restored data in the original path or change the dataDir in `kubeadm-config` too. For this lab, I rolled back to a VM snapshot and redid the upgrade from a clean state.

## Certificates

### Checking expiration

```bash
sudo kubeadm certs check-expiration
```

```text
CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY
admin.conf                 Oct 13, 2027 16:21 UTC   364d            ca
apiserver                  Oct 13, 2027 16:21 UTC   364d            ca
apiserver-etcd-client      Oct 13, 2027 16:21 UTC   364d            etcd-ca
apiserver-kubelet-client   Oct 13, 2027 16:21 UTC   364d            ca
controller-manager.conf    Oct 13, 2027 16:21 UTC   364d            ca
etcd-healthcheck-client    Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-peer                  Oct 13, 2027 16:21 UTC   364d            etcd-ca
etcd-server                Oct 13, 2027 16:21 UTC   364d            etcd-ca
front-proxy-client         Oct 13, 2027 16:21 UTC   364d            front-proxy-ca
scheduler.conf             Oct 13, 2027 16:21 UTC   364d            ca
super-admin.conf           Oct 13, 2027 16:21 UTC   364d            ca

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME
ca                      Oct 10, 2036 16:21 UTC   9y
etcd-ca                 Oct 10, 2036 16:21 UTC   9y
front-proxy-ca          Oct 10, 2036 16:21 UTC   9y
```

- leaf certificates 1 year, CAs 10 years
- `kubelet.conf` isn't in the list. The kubelet renews its own client certificate, and the `/var/lib/kubelet/pki/kubelet-client-current.pem` symlink points to the latest file
- checking one: `sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate`

### Renewal

| Method                                   | When                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kubeadm upgrade apply` / `upgrade node` | renewed automatically on upgrade. If you upgrade at least once a year, nothing else to do |
| `kubeadm certs renew all`                | manual renewal. Give a name for just one (`kubeadm certs renew apiserver`)                |

```bash
sudo kubeadm certs renew all
# Done renewing certificates. You must restart the kube-apiserver, kube-controller-manager,
# kube-scheduler and etcd, so that they can use the new certificates.
```

- restart the control plane static Pods after renewing
- `~/.kube/config` is a copy of `admin.conf`, so it doesn't change on its own. Copy it again

## Easily confused

| Comparison                                | A                                                           | B                                                                               |
| ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `kubeadm upgrade apply` vs `upgrade node` | once, on the first control plane. Bumps the cluster version | other control planes and workers. Only that node's manifests and kubelet config |
| `kubectl get nodes` VERSION               | the kubelet version                                         | control plane version: `kubectl version` or the static Pod images               |
| cordon vs drain                           | blocks scheduling only                                      | blocks scheduling and evicts Pods                                               |
| `--ignore-daemonsets` vs `--force`        | skips DaemonSet Pods                                        | deletes Pods with no controller                                                 |
| `etcdctl` vs `etcdutl`                    | connects to a running etcd. save                            | works on files directly. status, restore                                        |
| `--data-dir` vs hostPath                  | path inside the container. Leave it                         | host path. Change it to the restored directory                                  |
| leaf vs CA certificates                   | 1 year. Renewed with renew                                  | 10 years. Not covered by renew                                                  |

## Exam tips

### Quick commands

```bash
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9
sudo kubeadm upgrade node
kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
kubectl uncordon <node>

sudo cat /etc/kubernetes/manifests/etcd.yaml | grep -E "file|urls|data-dir"
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=... --cert=... --key=... snapshot save <file>
sudo etcdutl --data-dir <new-dir> snapshot restore <file>

sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
```

- in upgrade tasks it's easy to mix up where each command runs (the node you ssh into vs the node with kubectl)
- don't memorize the etcd certificate paths, copy them from `etcd.yaml`
- if `kubectl` output hasn't changed after a restore, suspect the apiserver first and restart it

### kubectl explain

```bash
kubectl explain poddisruptionbudget.spec   # minAvailable, maxUnavailable, selector
kubectl explain node.spec.unschedulable    # the field cordon changes
kubectl drain --help
```

## References

- [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [etcd: etcdutl](https://github.com/etcd-io/etcd/blob/main/etcdutl/README.md)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
