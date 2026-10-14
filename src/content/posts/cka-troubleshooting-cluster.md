---
title: "CKA concept notes: troubleshooting nodes and cluster components"
description: "A record of stopping the kubelet and containerd, deliberately breaking the kubelet config and static Pod manifests, then tracking down the cause with kubectl, systemctl, journalctl, crictl, and /var/log/pods on a kubeadm cluster."
pubDatetime: 2026-10-14T01:11:00
topic: "project-cncf"
subtopic: "cka"
tags:
  ["kubernetes", "cka", "troubleshooting", "kubelet", "crictl", "static-pod"]
order: 11
---

> Based on: broken on purpose and checked on a kubeadm cluster v1.35.9 (3 libvirt VMs), containerd 2.4.1, crictl v1.35.0

Component layout, static Pods, and file locations under `/etc/kubernetes` are in the [cluster architecture note](/posts/cka-cluster-architecture); checking certificate expiration is in the [lifecycle note](/posts/cka-cluster-lifecycle).

## Contents

## Where to start

```text
Does kubectl respond?
├─ no  → ssh to the control plane node
│        crictl ps -a (apiserver, etcd state)
│        crictl logs / /var/log/pods
│        journalctl -u kubelet (can it read the manifests?)
└─ yes → kubectl get nodes
         ├─ NotReady node → ssh to that node
         │                  systemctl status kubelet containerd
         │                  journalctl -u kubelet
         └─ nodes are fine → kubectl -n kube-system get pods
                             (scheduler, controller-manager, CoreDNS, CNI, kube-proxy)
```

| Component                                      | How it runs            | Status                                                                        | Logs                                            |
| ---------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| kubelet, containerd                            | systemd                | `systemctl status`                                                            | `journalctl -u kubelet`                         |
| apiserver, etcd, scheduler, controller-manager | static Pod             | `kubectl -n kube-system get pods`, or `crictl ps -a` if the apiserver is down | `kubectl logs`, `crictl logs`, `/var/log/pods/` |
| kube-proxy, CoreDNS, CNI                       | DaemonSet / Deployment | `kubectl get pods`                                                            | `kubectl logs`                                  |

## Node is NotReady

### The kubelet stopped

`sudo systemctl stop kubelet` on a worker.

- `NotReady` 48 seconds later. The node lease stopped being renewed, so the node lifecycle controller changed the status
- the condition is `Unknown`, not `False`

```text
$ kubectl describe node cka-w1
  MemoryPressure  Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
  Ready           Unknown  ...  NodeStatusUnknown  Kubelet stopped posting node status.
Taints:  node.kubernetes.io/unreachable:NoExecute
         node.kubernetes.io/unreachable:NoSchedule
```

On the node:

```bash
systemctl status kubelet
#  ○ kubelet.service - kubelet: The Kubernetes Node Agent
#     Loaded: loaded (/usr/lib/systemd/system/kubelet.service; enabled; ...)
#     Drop-In: /usr/lib/systemd/system/kubelet.service.d
#              └─10-kubeadm.conf
sudo systemctl start kubelet
sudo systemctl enable kubelet     # so it comes up after a reboot too
```

`○` (inactive) means stopped. If it's not `enabled`, it'll be stopped again after a reboot.

### containerd isn't there

Starting the kubelet with containerd stopped makes the kubelet itself fail.

```text
"command failed" err="failed to run Kubelet: validate service connection:
validate CRI v1 runtime API for endpoint \"unix:///var/run/containerd/containerd.sock\": rpc error ..."
```

After `sudo systemctl start containerd`, the node was back to `Ready` within 30 seconds.

### kubelet config error

I changed `clientCAFile` in `/var/lib/kubelet/config.yaml` to a file that doesn't exist and restarted.

```text
$ systemctl status kubelet
     Active: activating (auto-restart) (Result: exit-code) since ...; 9s ago

$ sudo journalctl -u kubelet --since "-1min"
"command failed" err="failed to construct kubelet dependencies: unable to load client CA file
/etc/kubernetes/pki/ca-wrong.crt: open /etc/kubernetes/pki/ca-wrong.crt: no such file or directory"
```

- if you keep seeing `activating (auto-restart)`, it's dying right after starting. The reason is on the `command failed` line in journalctl
- where kubelet config lives: `/var/lib/kubelet/config.yaml`, `/var/lib/kubelet/kubeadm-flags.env`, `/etc/default/kubelet`, `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf`, `/etc/kubernetes/kubelet.conf`
- if you edited a systemd unit file, `systemctl daemon-reload` and then restart

```bash
sudo journalctl -u kubelet -f                  # follow along
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -i -E "error|failed"
```

## Control plane components

### The apiserver can't reach etcd

I changed `--etcd-servers` in `kube-apiserver.yaml` to `https://127.0.0.1:2399`.

```text
$ kubectl get nodes
Unable to connect to the server: net/http: TLS handshake timeout
```

With kubectl unusable, look at the containers directly on the node.

```bash
sudo crictl ps -a --name kube-apiserver
# ea5139c8c6d5a   ...   19 seconds ago   Running   kube-apiserver   0
sudo crictl logs --tail 3 <container-id>
# grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ...
```

- the container is `Running`, but it can't reach etcd so it can't handle requests. Looking only at the status, you'd miss it. You have to read the logs
- the same logs are also on the node in `/var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log`. `/var/log/containers/*.log` are symlinks pointing there. Both need root
- after reverting the manifest, the kubelet brought it back up and kubectl responded within a minute

What you can guess from kubectl's error message:

| Message                           | Suspect                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `connect: connection refused`     | no apiserver on that port (didn't start, or the kubeconfig address/port is wrong) |
| `net/http: TLS handshake timeout` | the apiserver process is there but can't respond (etcd connection, etc.)          |
| `x509: certificate ...`           | a problem with the kubeconfig's certificate or CA                                 |
| `Unauthorized`                    | a credentials problem                                                             |

Changing the port in `~/.kube/config` to `6444` gives `dial tcp 192.168.122.11:6444: connect: connection refused`.

### Typo in a static Pod manifest's command

I changed `- kube-scheduler` in `kube-scheduler.yaml` to `- kube-schedulerr`.

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
kube-scheduler-cka-cp1   0/1   CrashLoopBackOff   2 (14s ago)   26s

$ kubectl -n kube-system describe pod kube-scheduler-cka-cp1
      Reason:   StartError
      Message:  failed to create containerd task: failed to create shim task: OCI runtime create failed:
                runc create failed: unable to start container process: error during container init: exec: "kube-schedulerr": ...
```

Creating a Pod in this state:

```text
$ kubectl get pod sched-test
sched-test   0/1   Pending   0   10s

$ kubectl describe pod sched-test
Events:  <none>
```

`Pending` with empty Events. That means the scheduler never looked at it. If there's a `FailedScheduling`, the scheduler is alive and the constraints just don't fit. After reverting the manifest, the Pod got placed with a `Scheduled` event.

### controller-manager broken

I broke the command in `kube-controller-manager.yaml` the same way.

```text
$ kubectl create deploy cm-test --image=nginx:1.27
$ kubectl get deploy cm-test
cm-test   0/1   0     0     10s
$ kubectl get rs -l app=cm-test
No resources found in default namespace.
```

The Deployment object got stored, but no ReplicaSet appeared, because there's no Deployment controller. After fixing it, `1/1` in 50 seconds.

### YAML syntax error in a manifest

Dropping in a `kube-scheduler.yaml` with broken indentation creates neither a container nor a mirror Pod.

```text
$ kubectl -n kube-system get pod kube-scheduler-cka-cp1
Error from server (NotFound): pods "kube-scheduler-cka-cp1" not found
$ sudo crictl ps --name kube-scheduler -q | wc -l
0
$ sudo journalctl -u kubelet --since "-1min" | grep kube-scheduler.yaml
"Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml:
couldn't parse as pod(yaml: line 11: did not find expected key), please check config file"
```

If the Pod has vanished from the list entirely, the manifest failed to parse. The kubelet log gives the line number.

## By symptom

| Symptom                                 | Check                                          | Cause in this lab                             |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| node `NotReady`, condition `Unknown`    | `systemctl status kubelet` on the node         | kubelet stopped                               |
| kubelet `activating (auto-restart)`     | `command failed` in `journalctl -u kubelet`    | wrong path in config.yaml, containerd missing |
| kubectl `TLS handshake timeout`         | `crictl ps -a`, `crictl logs`                  | wrong etcd address in the apiserver           |
| kubectl `connection refused`            | kubeconfig server address, apiserver container | wrong port in the kubeconfig                  |
| control plane Pod `CrashLoopBackOff`    | Last State in `describe pod`, `crictl logs`    | typo in the manifest command                  |
| control plane Pod missing from the list | `journalctl -u kubelet`                        | manifest YAML syntax                          |
| Pod `Pending` with no Events            | scheduler Pod                                  | scheduler broken                              |
| Deployment `0/1`, no ReplicaSet         | controller-manager Pod                         | controller-manager broken                     |

## Easily confused

| Comparison                                                   | A                                                       | B                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------- |
| node condition `False` vs `Unknown`                          | the kubelet reported a bad state                        | the kubelet isn't reporting (dead, or network)            |
| `systemctl status` `inactive` vs `activating (auto-restart)` | stopped. Start it and you're done                       | dying right after starting. Check the logs                |
| `kubectl logs` vs `crictl logs`                              | needs the apiserver                                     | directly on the node. Works even if the apiserver is down |
| `/var/log/pods` vs `/var/log/containers`                     | the actual files (`<ns>_<pod>_<uid>/<container>/N.log`) | symlinks                                                  |
| `Pending` + `FailedScheduling` vs `Pending` + no Events      | constraints don't fit                                   | the scheduler isn't running                               |

## Exam tips

### Quick commands

```bash
kubectl get nodes; kubectl describe node <node> | grep -A8 Conditions
ssh <node>
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | tail -30
sudo crictl ps -a
sudo crictl logs <container-id>
ls /etc/kubernetes/manifests/
sudo cat /var/lib/kubelet/config.yaml
```

- after fixing, confirm it yourself all the way to node `Ready` and Pods `Running`
- before editing a manifest, copy the original first (`cp kube-apiserver.yaml /tmp/`). Keep backups outside `/etc/kubernetes/manifests/`. The kubelet reads every file in that directory regardless of extension; when I left a `kube-scheduler.yaml.bak` there, the scheduler Pod got recreated
- kubelet problems are mostly path typos, certificate paths, or a stopped service. They show up as is in `journalctl`

### kubectl explain

```bash
kubectl explain node.status.conditions
kubectl explain pod.status.containerStatuses.lastState
```

## References

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Node status](https://kubernetes.io/docs/reference/node/node-status/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
