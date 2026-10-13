---
title: "CKAD 合格体験記"
description: "2026年10月12日に受けた CKAD 試験に 80% で合格しました。準備の過程、試験を受けて感じたこと、解けなかった NetworkPolicy の問題を整理し直した復習ノートを残します。"
pubDatetime: 2026-10-13T12:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "certification", "killer-sh"]
coverImage: "/assets/blog/ckad-exam-review/certificate.png"
order: 15
---

2026年10月12日に CKAD 試験を受け、翌日の13日に 80% で合格したという結果と認定証を受け取りました。
準備は概念の復習 2 回、killer.sh 2 回 (30%、66%)、自作の [cncf-practice](https://github.com/DeveloperRyou/cncf-practice) での 30 分の模擬セッション 5 回ほどでした。

![CKAD 試験結果: 80%、合格ライン 66%](/assets/blog/ckad-exam-review/result.png)

## 準備

Kubernetes は業務で毎日使っているので、概念を一から勉強するというよりは、試験範囲を一度ざっと見るところから始めました。
Linux Foundation のトレーニングポータルにある CKAD の内容をひと通り読み、AI と一緒にカリキュラムの項目ごとに[概念ノート](/ja/topics/project-cncf/ckad)をまとめました。ノートを書きながら 1 回、書き終えてから最初から読み直して 1 回、そうやって 2 周ほど復習しました。

実習はほかの問題集を使わず、すぐに killer.sh を解いてみました。
最初の点数は 30% くらいだったと思います。
業務で使う内容なのである程度は取れると思っていたのですが、時間内にコマンドを打って YAML を直すのはかなり難しかったです。

killer.sh のセッションは試験 1 回につき 2 回しかないので、本番のように解けるローカルの模擬試験環境 cncf-practice を作って、そこで練習しました。
作った理由と仕組みは[cncf-practice の紹介記事](/ja/posts/cncf-practice-intro)に別にまとめてあります。
cncf-practice では 30 分のセッションを 5 回ほど解きました。
その後、2 回目の killer.sh が 66% ほど取れた状態で本番の試験を受けました。

## 試験

試験は 2 時間で 17 問でした。私は 1 時間 30 分ほどで終えました。

体感では半分ほどが Deployment や Pod を作る、直す、起動しない原因を見つけて解決する問題でした。
残りはカリキュラムのあちこちから出ました。Ingress、resource limit、CronJob、コンテナイメージをビルドして tar で保存する、Service、canary デプロイ、ServiceAccount、rollback といったテーマです。
逆に Helm と Kustomize は私の試験には出ませんでした。

こうした細かいテーマはコマンドがすぐには浮かびませんでした。それでも何をすればいいかと、だいたいどのコマンドを使うかは分かっていたので、`--help` を叩いたり公式ドキュメントを探したりしながら解きました。

解けなかった問題は 2 問で、どちらもネットワーク系でした。残りは全部解いたので 70〜90% のあいだを予想していましたが、結果は 80% でした。

## 復習ノート: NetworkPolicy と Pod の label

解けなかった問題のひとつが NetworkPolicy でした。試験が終わってから調べ直した概念をまとめておきます。
見落としていたのは、**NetworkPolicy と Pod は label だけでつながっている**という点でした。

NetworkPolicy は `spec.podSelector` で自分が適用される Pod を選び、`ingress.from` と `egress.to` の中の `podSelector` (必要なら `namespaceSelector`) で通信相手の Pod を選びます。どちらも label selector です。
Pod 側には「このポリシーを適用して」というようなフィールドはありません。なので、ポリシーがすでに作られている状況なら、手を入れるべきはポリシーではなく Pod の label かもしれません。ポリシーが期待する label を Pod に付ければ、その瞬間からポリシーが適用されます。

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
spec:
  podSelector:
    matchLabels:
      role: api # この label が付いた Pod に適用
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: frontend # この label が付いた Pod からの通信だけ許可
  egress:
    - to:
        - podSelector:
            matchLabels:
              role: db # この label が付いた Pod への通信だけ許可
```

このポリシーがあるなら、ある Pod を「frontend からだけ受け、db にだけ送る」ようにする方法は、その Pod に `role=api` を付けることです。相手の Pod にもそれぞれ `role=frontend`、`role=db` が付いていないと許可ルールが噛み合いません。

```bash
# ポリシーがどの label を期待しているか確認
kubectl describe networkpolicy api-policy

# 今 Pod に付いている label と比較
kubectl get pods --show-labels

# label を追加 (実行中の Pod にもすぐ付けられる)
kubectl label pod <pod> role=api
```

Deployment が管理する Pod なら、Pod に直接付ける代わりに `spec.template.metadata.labels` を直す必要があります。

あわせて覚えておきたい動作が 2 つあります。どのポリシーにも選ばれていない Pod は隔離されないので、すべてのトラフィックが通ります。そしてポリシー同士は許可ルールの和集合なので、ポリシーが複数あれば、どれかひとつでも許可しているトラフィックは通ります。

## 振り返り

難易度は全体的に中の下くらいに感じました。業務でコマンドに慣れていたのもあり、実習の準備も役に立ったと思います。
ただ、頭では分かっていることを制限時間内に正確なコマンドに落とし込み、結果を確認し、間違ったところを直し直す過程は少しハードルでした。

久しぶりに AI なしで自分の手で触って、基礎体力を試してみた感じがして良かったです。
次の目標は CKA です。
