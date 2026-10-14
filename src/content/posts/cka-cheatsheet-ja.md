---
title: "CKA チートシート"
description: "CKA v1.35 カリキュラムのドメインごとの kubeadm・etcdctl・systemctl・crictl・kubectl コマンドと最小 YAML、試験中に開く kubernetes.io ドキュメントの場所をまとめました。"
pubDatetime: 2026-10-14T01:01:00
topic: "project-cncf"
subtopic: "cka"
tags: ["kubernetes", "cka", "kubectl", "kubeadm", "cheatsheet"]
order: 1
---

> 基準: Kubernetes v1.35。コマンドは kubeadm クラスタ (v1.34.12 → v1.35.9、libvirt VM 3 台) で確認

## 要約

CKA のコマンド・YAML 集。CKAD と重なる kubectl の基本 (Pod、Deployment、ConfigMap、Service、probe など) は [CKAD チートシート](/ja/posts/ckad-cheatsheet) を参照。

CKAD との違い: カリキュラムにノードの準備、kubeadm、etcd、コンポーネントのトラブルシューティングが入っているので、ノードに ssh して kubelet、containerd、static Pod manifest を直接触ることが多い。apiserver が落ちて kubectl が使えない状況にも備える。

| ドメイン                                             | 比重 |
| ---------------------------------------------------- | ---- |
| Troubleshooting                                      | 30%  |
| Cluster Architecture, Installation and Configuration | 25%  |
| Services and Networking                              | 20%  |
| Workloads and Scheduling                             | 15%  |
| Storage                                              | 10%  |

閲覧できるサイトは試験前に Linux Foundation の許可リソース一覧で確認。

## 試験環境

- 問題ごとに指定されたホストへ `ssh`、終わったら `exit`。ノード作業は `sudo -i` か `sudo`
- context 切り替えの指示があれば `kubectl config use-context` から
- namespace はコマンドごとに `-n <ns>`

```bash
k run tmp --image=nginx --dry-run=client -o yaml > pod.yaml
k explain pod.spec.affinity.nodeAffinity
k explain pod.spec --recursive | less
```

### ノードでよく見る場所

| パス                                                        | 内容                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/etc/kubernetes/manifests/`                                | static Pod (etcd、kube-apiserver、kube-controller-manager、kube-scheduler) |
| `/etc/kubernetes/pki/`                                      | CA と証明書。etcd 専用は `etcd/` の下                                      |
| `/etc/kubernetes/admin.conf`                                | 管理者 kubeconfig                                                          |
| `/etc/kubernetes/kubelet.conf`                              | kubelet kubeconfig                                                         |
| `/var/lib/kubelet/config.yaml`                              | kubelet 設定 (`staticPodPath`、`clusterDNS`、`cgroupDriver`)               |
| `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf` | kubelet systemd drop-in                                                    |
| `/etc/containerd/config.toml`                               | containerd 設定 (`SystemdCgroup`)                                          |
| `/etc/cni/net.d/`、`/opt/cni/bin/`                          | CNI 設定、バイナリ                                                         |
| `/var/log/pods/`、`/var/log/containers/`                    | container ログファイル                                                     |

## Cluster Architecture, Installation and Configuration

カリキュラム: RBAC、インストール用インフラの準備、kubeadm によるインストールと管理、クラスタ lifecycle、HA control plane、Helm・Kustomize でのコンポーネントインストール、CNI・CSI・CRI、CRD・Operator。

ノート: [クラスタ構成](/ja/posts/cka-cluster-architecture)、[kubeadm インストールと HA](/ja/posts/cka-kubeadm-install-ha)、[upgrade・etcd・証明書](/ja/posts/cka-cluster-lifecycle)、[RBAC・ユーザー](/ja/posts/cka-rbac-users)、[CNI・CSI・CRI・Operator](/ja/posts/cka-extension-interfaces)

### ノードの準備

```bash
swapon --show                                   # 空であること (または kubelet failSwapOn: false)
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

### パッケージ (pkgs.k8s.io、minor ごとにリポジトリ)

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
sudo kubeadm init phase upload-certs --upload-certs        # certificate-key の再発行 (2 時間で期限切れ)
kubectl -n kube-system get cm kubeadm-config -o yaml        # podSubnet、serviceSubnet、etcd dataDir
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
sudo kubeadm reset
```

- init 直後にノードが `NotReady` + `cni plugin not initialized` → CNI をインストール

### upgrade (control plane → worker を 1 台ずつ)

```bash
# リポジトリ行の v1.34 → v1.35 に変えてから
sudo apt-mark unhold kubeadm && sudo apt-get update && sudo apt-get install -y kubeadm='1.35.9-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.9           # 最初の control plane だけ
sudo kubeadm upgrade node                    # 残りの control plane、worker

kubectl drain <node> --ignore-daemonsets [--delete-emptydir-data] [--force]
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.9-*' kubectl='1.35.9-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <node>
```

- minor は 1 つずつ。kubelet は apiserver より新しくてはいけない
- `kubectl get nodes` の VERSION は kubelet のバージョン

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
# etcd.yaml の etcd-data hostPath を /var/lib/etcd-from-backup に
# その後 kube-apiserver、controller-manager、scheduler を再起動 (manifest を出し入れ)、kubelet 再起動
```

- etcd 3.6 の `etcdctl snapshot` は `save` だけ。status・restore は `etcdutl`

### 証明書

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all          # 後で control plane static Pod を再起動、~/.kube/config をコピーし直す
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
```

### RBAC とユーザー

```bash
openssl genrsa -out u.key 2048
openssl req -new -key u.key -out u.csr -subj "/CN=u/O=g"
cat u.csr | base64 | tr -d "\n"                          # CSR オブジェクトの spec.request
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

### Helm、Kustomize、CRD

```bash
helm repo add <name> <url> && helm repo update
helm search repo <keyword>; helm show values <chart>
helm install <release> <chart> -n <ns> --create-namespace --set key=value
helm upgrade / rollback <release> <rev> / uninstall / list -A / history / get values
kubectl kustomize <dir|url>; kubectl apply -k <dir|url>
kubectl get crd; kubectl api-resources --api-group=<group>
```

CRD・Helm・Kustomize の基本: [CKAD: Helm と Kustomize](/ja/posts/ckad-helm-kustomize)、[CKAD: CRD、Operator、API deprecation](/ja/posts/ckad-crds-api-deprecations)

### ドキュメント

- [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)、[Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/)、[Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
- [Operating etcd clusters](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)、[RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)

## Workloads and Scheduling

カリキュラム: rolling update・rollback、ConfigMap・Secret、autoscaling、self-healing primitive、Pod の admission・scheduling。

ノート: [Pod scheduling](/ja/posts/cka-scheduling)、[autoscaling](/ja/posts/cka-autoscaling)。rolling update は [CKAD: Rolling update とデプロイ戦略](/ja/posts/ckad-deployment-strategies)、ConfigMap・Secret は [CKAD: ConfigMap と Secret](/ja/posts/ckad-configmaps-secrets)、requests・limits・LimitRange・ResourceQuota は [CKAD: requests、limits、quota](/ja/posts/ckad-resources-quotas)

```bash
k label node <node> disk=ssd
k taint node <node> key=value:NoSchedule
k taint node <node> key=value:NoSchedule-
k create priorityclass high --value=1000
k autoscale deploy <name> --cpu=50% --min=1 --max=5     # 対象に cpu request が必要
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
      nodeTaintsPolicy: Honor # control plane がドメインとして数えられて Pending になるのを防ぐ
      labelSelector: { matchLabels: { app: web } }
  priorityClassName: high
```

- static Pod: そのノードの `staticPodPath` (`/var/lib/kubelet/config.yaml`) に YAML を置く

### ドキュメント

- [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)、[Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)、[Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)

## Services and Networking

カリキュラム: Pod 間の接続、NetworkPolicy、Service type と endpoint、Gateway API、Ingress controller・Ingress、CoreDNS。

ノート: [Pod ネットワークと CoreDNS](/ja/posts/cka-pod-network-coredns)、[Gateway API と Ingress](/ja/posts/cka-gateway-api)。Service・Ingress・NetworkPolicy の基本は [CKAD: Service、Ingress、NetworkPolicy](/ja/posts/ckad-services-ingress-networkpolicy)

```bash
k expose deploy web --port=80 --target-port=8080 --type=NodePort
k get svc,endpointslice
k create ingress web --class=nginx --rule="web.example.com/*=web:80"
k get ingressclass; k get gatewayclass; k get gateway,httproute -A
k -n kube-system get cm coredns -o yaml          # Corefile
k -n kube-system edit cm coredns                 # reload plugin が読み直す (1 分ちょっと)
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

- Route が付かないときは `status.parents[].conditions` (`NotAllowedByListeners`、`BackendNotFound`、`RefNotPermitted`)
- 別の namespace: Route → Gateway は `allowedRoutes`、Route → Service は ReferenceGrant
- DNS: `<svc>.<ns>.svc.cluster.local`、Pod は `<ip-ダッシュ区切り>.<ns>.pod.cluster.local`。hostNetwork Pod は `dnsPolicy: ClusterFirstWithHostNet`

### ドキュメント

- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)、[Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)、[Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)、[Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)

## Storage

カリキュラム: StorageClass と dynamic provisioning、volume type・access mode・reclaim policy、PV・PVC。

ノート: [CKAD: persistent volume と ephemeral volume](/ja/posts/ckad-volumes)

```bash
k get sc,pv,pvc
k get csidriver
k describe pvc <pvc>             # Pending の理由 (StorageClass、provisioner)
k patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

## Troubleshooting

カリキュラム: クラスタとノード、クラスタコンポーネント、リソース使用量、container の出力、Service・ネットワーク。

ノート: [ノードとクラスタコンポーネント](/ja/posts/cka-troubleshooting-cluster)、[ワークロード・リソース・ネットワーク](/ja/posts/cka-troubleshooting-apps)

### ノード、コンポーネント

```bash
k get nodes; k describe node <node> | grep -A8 Conditions
sudo systemctl status kubelet containerd
sudo systemctl restart kubelet; sudo systemctl enable kubelet
sudo journalctl -u kubelet --since "-5min" --no-pager | grep -iE "error|failed"
sudo crictl ps -a; sudo crictl logs <id>
sudo sh -c 'ls /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/'
```

| 症状                                   | 原因の候補                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| ノード `NotReady`、condition `Unknown` | kubelet 停止                                                            |
| kubelet `activating (auto-restart)`    | 設定ファイルのパス誤り、containerd がない → journalctl `command failed` |
| kubectl `TLS handshake timeout`        | apiserver が etcd につながらない                                        |
| kubectl `connection refused`           | apiserver が起動していない、kubeconfig のアドレス・ポート               |
| control plane Pod `CrashLoopBackOff`   | manifest の command・flag の誤り                                        |
| control plane Pod が一覧にない         | manifest の YAML 文法 → journalctl `Could not process manifest file`    |
| Pod `Pending` + Events なし            | scheduler の故障                                                        |
| Deployment `0/N`、ReplicaSet なし      | controller-manager の故障                                               |

### リソース、ログ

```bash
k top nodes --sort-by=cpu
k top pods -A --sort-by=memory --no-headers | head -1
k top pod <pod> --containers
k logs <pod> -c <container> [--previous] [--tail=N] [--since=5m] [--timestamps]
k logs <pod> --all-containers --prefix
k logs -l app=web
```

### Service、ネットワーク

| 症状                                   | 確認                         |
| -------------------------------------- | ---------------------------- |
| `Connection refused` + endpoint なし   | selector と Pod label        |
| `Connection refused` + endpoint あり   | targetPort と container port |
| endpoint `ready=false`                 | readinessProbe               |
| 名前は `bad address`、ClusterIP は通る | CoreDNS                      |
| `timed out`                            | NetworkPolicy                |

```bash
k get endpointslice -l kubernetes.io/service-name=<svc>
k run t --image=busybox:1.36 --rm -it --restart=Never -- wget -qO- -T3 http://<svc>.<ns>.svc.cluster.local
k run t --image=busybox:1.36 --rm -it --restart=Never -- nslookup kubernetes.default.svc.cluster.local
```

### ドキュメント

- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)、[crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)、[Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)

## 参考ドキュメント

- [CKA Curriculum v1.35](https://github.com/cncf/curriculum)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [CKAD チートシート](/ja/posts/ckad-cheatsheet)
