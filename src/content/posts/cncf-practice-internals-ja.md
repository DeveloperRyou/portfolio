---
title: "CKAD 模擬試験の練習環境の内部構造"
description: "静的サイトとしてデプロイした試験画面が、各自の PC にある kind クラスターとターミナルをどう扱っているのかをまとめました。"
pubDatetime: 2026-09-27T12:00:00
topic: "project-cncf"
subtopic: "cncf-practice"
tags: ["kubernetes", "ckad", "kind", "killer-sh"]
order: 2
draft: false
---

[前回の記事](/ja/posts/cncf-practice-intro)では、CKAD 模擬試験の練習環境 [cncf-practice](https://github.com/DeveloperRyou/cncf-practice) をなぜ作ったのか、どう使うのかを紹介しました。今回は中身を見ていきます。要約すると、試験画面は Cloudflare Workers に置いた静的ページで、クラスター・ターミナル・採点はすべて各自の PC で動くローカルサーバーが担当しています。この構成で一番気を使ったのは「公開 Web ページが自分の PC のシェルを扱う」という点なので、セキュリティの話にかなり分量を割きました。

## 環境

2026年9月27日時点のバージョンです。

| 項目 | バージョン |
| --- | --- |
| WSL / ディストリビューション | 2.7.14 / Ubuntu 22.04 |
| Docker Desktop | 4.89.0 |
| kubectl | v1.37.1 |
| kind | v0.33.0 (`kindest/node:v1.37.0`) |
| ttyd | 1.7.7 |
| Python | 標準ライブラリのみ使用 |

## 全体構成

```
 ブラウザ (Windows)
 ┌────────────────────────────────────────────┐
 │ cncf-practice.developerryou.workers.dev    │  ← 静的 HTML 1枚 (Cloudflare Workers)
 │  ┌──────────────┐   ┌───────────────────┐  │
 │  │問題・タイマー│   │<iframe> ターミナル│  │
 │  └──────┬───────┘   └────────┬──────────┘  │
 └─────────┼────────────────────┼─────────────┘
           │ fetch               │ WebSocket
           ▼                     ▼
   localhost:8000          localhost:7681        ← WSL の localhost フォワーディング
   exam/server.py          ttyd (bash)
     │  down.sh / up.sh / setup.sh / grade.sh
     ▼                     │ kubectl
   kind クラスター (Docker コンテナ1つ) ◀───────┘
```

`./scripts/exam.sh` が2つのサーバーを立ち上げます。1つはブラウザで bash を使えるようにする [ttyd](https://github.com/tsl0922/ttyd)、もう1つは Python の標準ライブラリだけで書いた小さな HTTP サーバー(`exam/server.py`)です。デプロイされたページはこの2つに `localhost` でつながります。

## ローカルクラスター

クラスターは kind で作ったシングルノードです。設定は control-plane ノード1つだけです。

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
```

`up.sh` はクラスターを作ったあと、ノードが Ready になり `default` ServiceAccount ができるまで待ちます。ノードが Ready になっても数秒間は ServiceAccount がなく、その間に Pod を作ると `serviceaccount default not found` で失敗するからです。

```bash
kubectl wait --for=condition=Ready node --all --timeout=180s
until kubectl get serviceaccount default >/dev/null 2>&1; do sleep 2; done
```

一つ引っかかったのが cgroup です。kubelet は 1.35 から cgroup v1 のホストではそもそも起動しなくなりましたが、WSL2 のデフォルト設定では v1 が有効になっています。最初は kubelet の設定(`failCgroupV1: false`)で回避していましたが、結局そのパッチは外してホスト側を直しました。Windows の `.wslconfig` に次を追加し、`wsl --shutdown` してから開き直せば OK です。

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all
```

## 回の構成

問題は資格ごとのディレクトリの下に、回ごとに置いています。

```
ckad/
  README.md        # 回の一覧、点数、扱ったトピックの累積
  round-01/
    README.md      # 問題用紙 (本番と同じく英語)
    setup.sh       # 問題を解く前の事前リソース作成 (冪等)
    grade.sh       # 自動採点
    meta.json      # 問題ごとの CKAD ドメインと細かいトピック
    answers/       # ファイルで提出する解答 (killer.sh の /opt/course/N/)
```

`setup.sh` は問題に必要な namespace とリソースをあらかじめ作っておきます。トラブルシューティングの問題なら、わざと壊したリソースもここで作られます。各回にトラブルシューティング形式の問題を最低1問は入れるよう、出題基準に書いてあります。

`grade.sh` はクラスターの状態と `answers/` のファイルを読むだけで、採点項目ごとに PASS/FAIL を1行ずつ出力します。肝心なのは `check()` 関数1つです。

```bash
check() {  # check <q> <points> <description> <shell condition>
  local q=$1 pts=$2 desc=$3 cond=$4
  [[ -v MAX[$q] ]] || { MAX[$q]=0; GOT[$q]=0; ORDER+=("$q"); }
  MAX[$q]=$(( MAX[$q] + pts ))
  if ( eval "$cond" ) >/dev/null 2>&1; then
    GOT[$q]=$(( GOT[$q] + pts )); printf '  PASS  [%s] %-2s %s\n' "$q" "$pts" "$desc"
  else
    printf '  FAIL  [%s] %-2s %s\n' "$q" "$pts" "$desc"
  fi
}
```

条件はシェル1行なので、`kubectl get -o json | jq -e ...` で spec の値を見るのも、一時的な Pod から `wget` を投げて NetworkPolicy が実際にブロックするかを見るのも自由です。部分点はこの項目単位で付けます。

### 出題と検証

問題は AI エージェントが作ります。リポジトリの `docs/mock-exam.md` に出題基準を書いておき、エージェントに毎回それを読ませるようにしました。形式は killer.sh、難易度はやや難しめ、5問、CKAD カリキュラムの5ドメインに均等に、kind で動かない機能(`LoadBalancer` の外部 IP など)は避ける、といった内容です。

一番大事にしたルールは「正解をリポジトリに書かない」です。エージェントは問題を作るとき、模範解答をリポジトリの外に置いて、scratch クラスターで自分で検証します。

1. `setup.sh` → 模範解答 → `grade.sh` で100点になること
2. `setup.sh` だけ実行した状態で `grade.sh` が0点近くになること

2つ目のチェックは、採点条件がゆるすぎて何もしなくても点数が出てしまうケースを捕まえるためのものです。解説と模範解答は、私が全部解いて採点を依頼したあとで初めて `result.md` に入ります。

## 試験画面

画面は HTML ファイル1枚(`exam/web/index.html`)です。フレームワークなしで、ハッシュルーティングで環境確認 → 回の選択 → 環境準備 → 試験 → 結果を行き来します。

ローカルサーバーの API はこれで全部です。

| メソッド | パス | 役割 |
| --- | --- | --- |
| GET | `/api/env` | ターミナル・Docker・kind・kubectl の準備状況、クローンが upstream より遅れているか |
| GET | `/api/rounds` | `*/round-*/README.md` を探して回の一覧と点数 |
| GET | `/api/sheet` | 問題用紙の Markdown |
| POST | `/api/prepare` | `down.sh` → `up.sh` → `<回>/setup.sh` |
| GET | `/api/job` | 実行中の prepare/grade ジョブのログ |
| POST | `/api/grade` | 終了を記録してから `grade.sh` を実行 |
| GET | `/api/result` | 採点結果 |

問題用紙は Markdown のまま受け取ってブラウザでパースします。`# タイトル`、`40 minutes`、`## Question N (W%)` のような見出し形式に頼っているので、出題基準にこの形式を守るよう書いてあります。

prepare と grade は時間がかかるのでバックグラウンドスレッドで動かし、画面は `/api/job` をポーリングしながらログを表示します。同時に動けるのは1つだけで、すでに動いていれば 409 を返します。

「End exam」を押すと、開始・終了時刻とフラグを付けた問題を `finished.json` に残して `grade.sh` を実行します。終わるとサーバーが出力の PASS/FAIL 行を正規表現でパースし、`meta.json` のドメイン情報と合わせて `grade.json` に保存します。結果画面のドメイン別の点数はこうして作られています。

再受験にも気を配りました。`down.sh` はクラスターだけを削除して `answers/` は残すので、そのまま準備し直すと前回の解答が混ざってしまいます。そこで環境準備を押すと、前回の解答と結果をまず `attempts/<時刻>/` に移してから始めます。

## デプロイ

デプロイされるのは `exam/web/` フォルダだけです。`wrangler.jsonc` でこのフォルダを Workers の静的アセットに指定しました。

```jsonc
{
  "name": "cncf-practice",
  "compatibility_date": "2026-09-27",
  "assets": {
    "directory": "./exam/web"
  }
}
```

`v*` タグを push すると GitHub Actions が `wrangler deploy` を実行します。問題用紙とスクリプトはデプロイしません。問題用紙は各自のクローンからローカルサーバーが返し、クラスターとターミナルも各自の PC にあります。

ページは自分がどこで開かれたかを見て API のアドレスを決めます。`localhost` で開かれたら同じサーバー、デプロイ先のドメインで開かれたら `http://localhost:8000` です。

```js
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = new URLSearchParams(location.search).get("api") || (LOCAL ? "" : "http://localhost:8000");
```

この構成の弱点は、デプロイされたページと各自のクローンのバージョンがずれる可能性があることです。そこでページとサーバーがそれぞれ `API_VERSION` を持ち、違っていれば環境確認画面で `git pull` するよう案内します。サーバーは1分に1回バックグラウンドで `git fetch` して、upstream より遅れているかも知らせてくれます。

## セキュリティ

公開 Web ページが自分の PC の bash とクラスターを扱う構成なので、防ぎたかったのは「同じブラウザで開いている別のサイトがこのサーバーに触ること」です。

### バインド

サーバーはどちらも `127.0.0.1` にだけバインドします。WSL の localhost フォワーディングで同じ PC の Windows ブラウザからは開けますが、同じネットワークの別の端末からは開けません。

### ターミナル

ttyd は `-O` オプション付きで起動します。WebSocket 接続の Origin が ttyd 自身と違えば拒否するオプションです。これがないと、どのサイトでも `ws://localhost:7681` につないでシェルにコマンドを打ち込めてしまいます。

```bash
ttyd -i 127.0.0.1 -p "$TERM_PORT" -W -O -w "$ROOT" \
  -- bash --rcfile "$ROOT/exam/bashrc" -i
```

### DNS rebinding

`127.0.0.1` にだけバインドしても、攻撃者が自分のドメインを `127.0.0.1` に解決させる DNS rebinding を使うと、ブラウザから見ると「同じ origin」になってしまいます。そこで、すべてのリクエストの `Host` ヘッダーが `localhost:<ポート>` か `127.0.0.1:<ポート>` でなければ 403 を返します。

### CORS preflight の強制

POST は `Content-Type: text/plain` のような「シンプルリクエスト」なら、CORS preflight なしでそのままサーバーに届きます。レスポンスが読めないだけで、スクリプトはもう実行されてしまうわけです。そこで POST には `X-Exam: 1` というカスタムヘッダーを必須にしました。カスタムヘッダーが付くとブラウザは必ず先に preflight を送り、サーバーは許可リスト(`EXAM_ORIGINS`、デフォルトはデプロイ先のドメイン)と自分自身の origin にだけ許可します。

```python
if (not self.host_ok() or self.path not in ("/api/prepare", "/api/grade")
        or self.headers.get("X-Exam") != "1" or not self.allowed_origin()):
    return self.send_error(403)
```

### 決まったスクリプトだけ

サーバーは任意のコマンドを受け付けません。リクエストで受け取るのは回の名前1つだけで、`^[a-z0-9-]+/round-\d+$` の正規表現とファイルの存在を確認したうえで、`down.sh`、`up.sh`、`setup.sh`、`grade.sh` だけを実行します。静的ファイルも `index.html` しか返さず、`grade.sh` などそれ以外は 404 です。採点条件が見えてしまってはいけませんからね。

### ブラウザ側の制約

Chrome と Edge は、公開サイトが localhost にリクエストするときに「ローカルネットワークへのアクセス」の権限を一度確認します。これは許可する必要があります。Safari は https ページから `http://localhost` へのリクエストをブロックするので対応していません。

## まとめ

構成はシンプルです。静的ページ1枚、標準ライブラリの Python サーバー、ttyd、kind、そして回ごとのシェルスクリプト3つです。その代わり「公開ページ + ローカルシェル」という組み合わせなので、localhost へのバインドだけでは足りず、Origin チェック、Host チェック、preflight の強制、固定スクリプトまで何重にも防ぐ必要がありました。

2026年9月27日時点で、問題は CKAD round-01 だけです。CKAD の準備をしながら、回と機能を増やしていくつもりです。

コードは [GitHub リポジトリ](https://github.com/DeveloperRyou/cncf-practice)にあります。
