---
title: "CKA concept notes: Pod network and CoreDNS"
description: "The Kubernetes network model, Pod-to-Pod traffic across nodes, how kube-proxy turns Services into iptables rules, NodePort and LoadBalancer, editing the CoreDNS Corefile, and Pod dnsPolicy, checked hands-on on a kubeadm + Calico cluster."
pubDatetime: 2026-10-14T01:09:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "networking", "kube-proxy", "coredns", "dns"]
order: 9
---

> Based on: commands checked on a kubeadm cluster v1.35.9 (3 libvirt VMs, node network 192.168.122.0/24), Calico v3.33.0, CoreDNS v1.13.1

Service types, selectors and EndpointSlices, Ingress, and NetworkPolicy basics are in [CKAD concept notes: Service, Ingress, NetworkPolicy](/posts/ckad-services-ingress-networkpolicy). This note only covers what you look at from the node and cluster side.

## Contents

## The network model

What Kubernetes requires of the CNI:

- every Pod gets an IP that's unique within the cluster
- every Pod can talk to every other Pod without NAT (same node or not)
- agents on a node (the kubelet, etc.) can talk to that node's Pods

Three IP ranges must not overlap.

| Range           | This cluster       | Set by                                        |
| --------------- | ------------------ | --------------------------------------------- |
| node network    | `192.168.122.0/24` | infrastructure (libvirt)                      |
| Pod network     | `10.244.0.0/16`    | `kubeadm init --pod-network-cidr`, CNI config |
| Service network | `10.96.0.0/12`     | `kubeadm init --service-cidr` (default)       |

## Where Pod IPs come from

```text
$ kubectl get nodes -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR
NAME      PODCIDR
cka-cp1   10.244.0.0/24
cka-w1    10.244.1.0/24
cka-w2    10.244.2.0/24
```

The controller-manager runs with `--allocate-node-cidrs=true`, so it hands each node a `/24`. But the actual Pod IPs were `10.244.95.x` and `10.244.62.x`. Calico doesn't use `node.spec.podCIDR`; it uses its own IPAM blocks.

```text
$ kubectl get blockaffinities -o custom-columns=NODE:.spec.node,CIDR:.spec.cidr
NODE      CIDR
cka-cp1   10.244.212.128/26
cka-w1    10.244.95.128/26
cka-w2    10.244.62.128/26
```

Some CNIs (flannel, etc.) do use `podCIDR`, so which range Pod IPs come from depends on the CNI.

## Pod traffic across nodes

Requesting the IP of an nginx Pod on cka-w2 directly from a busybox Pod on cka-w1:

```bash
kubectl exec c -- wget -qO- -T3 http://10.244.62.167
# <title>Welcome to nginx!</title>
```

It works straight to the Pod IP, no Service. Calico wraps traffic between nodes in VXLAN (the `vxlan.calico` interface).

## kube-proxy

A Service is a virtual IP with nothing behind it. kube-proxy on each node watches Services and EndpointSlices and turns them into packet rules.

| mode       | How                | Notes         |
| ---------- | ------------------ | ------------- |
| `iptables` | iptables NAT rules | Linux default |
| `ipvs`     | kernel IPVS        |               |
| `nftables` | nftables rules     |               |

```bash
kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep '^mode'
# mode: ""        ← empty = iptables on Linux
```

Rules created for Service `net/web` (ClusterIP `10.111.80.136`, 2 endpoints):

```text
-A KUBE-SERVICES -d 10.111.80.136/32 -p tcp -m comment --comment "net/web cluster IP" -m tcp --dport 80 -j KUBE-SVC-RTHZXQ2YZKSHM2PI
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.62.167:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-S3UT2MK4P7AJ67WG
-A KUBE-SVC-RTHZXQ2YZKSHM2PI -m comment --comment "net/web -> 10.244.95.170:80" -j KUBE-SEP-JIQR6UIXHEWKPI63
-A KUBE-NODEPORTS -p tcp -m comment --comment "net/web" -m tcp --dport 31777 -j KUBE-EXT-RTHZXQ2YZKSHM2PI
```

- `KUBE-SERVICES`: matches ClusterIP:port and jumps to the Service chain
- `KUBE-SVC-*`: picks one endpoint by probability (0.5 with 2)
- `KUBE-SEP-*`: DNAT to the actual Pod IP:port
- `KUBE-NODEPORTS`: traffic coming in through the NodePort

If a Service has no endpoints, `KUBE-SVC-*` has nowhere to go. If "the Service exists but connections fail," check the EndpointSlice first.

```bash
kubectl get endpointslice -l kubernetes.io/service-name=web
# NAME        ADDRESSTYPE   PORTS   ENDPOINTS
# web-4bnv6   IPv4          80      10.244.62.167,10.244.95.170
```

## NodePort and LoadBalancer

```bash
kubectl expose deploy web --port=80 --type=NodePort
# web   NodePort   10.111.80.136   <none>   80:31777/TCP
```

A NodePort opens on every node. Even a request to the control plane IP, which has no Pod, gets a response.

```text
192.168.122.11:31777  <title>Welcome to nginx!</title>   (cka-cp1, no Pod)
192.168.122.21:31777  <title>Welcome to nginx!</title>
192.168.122.22:31777  <title>Welcome to nginx!</title>
```

A LoadBalancer only gets an IP if there's an implementation that creates an external LB (a cloud controller, MetalLB, etc.). This cluster has none, so it's `<pending>`.

```text
$ kubectl create svc loadbalancer lb --tcp=80:80
lb   LoadBalancer   10.111.57.195   <pending>   80:30363/TCP
```

A LoadBalancer Service also gets a NodePort (`30363`), so it's reachable through the NodePort even while `<pending>`.

## CoreDNS

### Setup

```text
$ kubectl -n kube-system get deploy coredns
coredns   2/2

$ kubectl -n kube-system get svc kube-dns
kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP,9153/TCP
```

- the Deployment is named `coredns`; the Service is named `kube-dns` for compatibility
- `10.96.0.10` matches `clusterDNS` in the kubelet config. The kubelet writes this address into each Pod's `/etc/resolv.conf`

### Corefile

The config is the `Corefile` in the `kube-system/coredns` ConfigMap.

```text
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
```

| plugin                         | What it does                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `kubernetes cluster.local ...` | answers Service and Pod records. With `pods insecure`, Pod IP records too             |
| `forward . /etc/resolv.conf`   | names outside the cluster go to the servers in the node's (CoreDNS Pod's) resolv.conf |
| `cache 30`                     | 30-second cache                                                                       |
| `reload`                       | re-reads the Corefile when it changes, no restart                                     |
| `health`, `ready`              | liveness (8080), readiness (8181)                                                     |

### Editing the Corefile

I pinned one name outside the cluster with the `hosts` plugin.

```bash
kubectl -n kube-system edit cm coredns
```

```text
    ready
    hosts {
       192.168.122.200 legacy.example.internal
       fallthrough
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
```

- because of the `reload` plugin, it takes effect without restarting CoreDNS. `[INFO] Reloading` in the logs
- it took 82 seconds to take effect. That's the time for the ConfigMap volume to update the file inside the Pod + the reload interval. If you're in a hurry, `kubectl -n kube-system rollout restart deploy coredns`
- to send only a specific domain to a different DNS server, add a server block (`example.internal:53 { forward . 10.0.0.53 }`)

## DNS names

| Target                        | Name                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Service                       | `<service>.<namespace>.svc.cluster.local`                                                              |
| Pod                           | `<IP with . replaced by ->.<namespace>.pod.cluster.local` (e.g. `10-244-62-167.net.pod.cluster.local`) |
| Pod behind a headless Service | `<hostname>.<service>.<namespace>.svc.cluster.local`                                                   |

A Pod's `/etc/resolv.conf` (`dnsPolicy: ClusterFirst`, the default):

```text
search net.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

- `web` should resolve within the same namespace, and `web.other` from another one
- `nslookup web` in busybox:1.36 failed with `** server can't find web.svc.cluster.local: NXDOMAIN`. The FQDN (`web.net.svc.cluster.local`) worked. When checking with busybox, using the FQDN is the safe bet

## dnsPolicy

| dnsPolicy                 | resolv.conf                                 | Lab result                                              |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `ClusterFirst` (default)  | CoreDNS + search list                       | as above                                                |
| `Default`                 | the resolv.conf of the node the Pod runs on | `nameserver 192.168.122.1`. Cluster names don't resolve |
| `ClusterFirstWithHostNet` | CoreDNS even for hostNetwork Pods           | `nameserver 10.96.0.10` + search list                   |
| `None`                    | only `dnsConfig`                            | below                                                   |

- despite the name, `Default` isn't the default
- with `hostNetwork: true` and no `dnsPolicy` (`ClusterFirst`), you get the node's resolv.conf (`192.168.122.1`). To use CoreDNS, set `ClusterFirstWithHostNet`

```yaml
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers: [1.1.1.1]
    searches: [example.internal]
    options:
      - name: ndots
        value: "2"
```

```text
search example.internal
nameserver 1.1.1.1
options ndots:2
```

## Easily confused

| Comparison                                 | A                                          | B                                                                          |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| `--pod-network-cidr` vs `--service-cidr`   | Pod IPs                                    | Service ClusterIPs                                                         |
| `node.spec.podCIDR` vs actual Pod IPs      | range handed out by the controller-manager | decided by the CNI's IPAM. Calico uses its own blocks                      |
| kube-proxy vs CNI                          | Service → Pod (DNAT)                       | Pod ↔ Pod connectivity                                                     |
| ClusterIP vs NodePort                      | inside the cluster only                    | 30000-32767 on every node IP                                               |
| NodePort vs LoadBalancer                   | node IP:port                               | external LB IP. `<pending>` without an implementation. Gets a NodePort too |
| `kube-dns` Service vs `coredns` Deployment | only the name is kube-dns                  | the actual server                                                          |
| `dnsPolicy: Default` vs `ClusterFirst`     | node DNS                                   | CoreDNS (the actual default)                                               |

## Exam tips

### Quick commands

```bash
kubectl get nodes -o wide; kubectl get pods -o wide            # node IPs, Pod IPs
kubectl -n kube-system get cm kubeadm-config -o yaml | grep -E "podSubnet|serviceSubnet"
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode
kubectl get svc,endpointslice
kubectl -n kube-system get cm coredns -o yaml
kubectl -n kube-system edit cm coredns
kubectl -n kube-system rollout restart deploy coredns
kubectl run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup <svc>.<ns>.svc.cluster.local
sudo iptables -t nat -S | grep <namespace>/<service>
```

- for tasks asking for the Pod CIDR or Service CIDR, look in the `kubeadm-config` ConfigMap or the apiserver (`--service-cluster-ip-range`) and controller-manager (`--cluster-cidr`) manifests
- Pod record names use dashes instead of the dots in the IP

### kubectl explain

```bash
kubectl explain pod.spec.dnsPolicy
kubectl explain pod.spec.dnsConfig
kubectl explain service.spec.type
```

## References

- [Services, Load Balancing, and Networking](https://kubernetes.io/docs/concepts/services-networking/)
- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [CoreDNS plugins](https://coredns.io/plugins/)
- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
