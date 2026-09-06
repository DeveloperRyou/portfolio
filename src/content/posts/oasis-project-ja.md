---
title: "OASIS Project"
description: "仮想通貨自動売買プログラムを企画・開発・リリースするプロジェクト。Electronでデスクトップアプリを、Node.jsとUpbit APIで自動売買を、Reactでフロントエンドを実装した。"
pubDatetime: 2022-09-01T01:00:00
tags: ["oasis", "electron", "react", "typescript"]
coverImage: "/assets/blog/oasis/cover.jpg"
---

## OASISについて

OASIS Projectは、仮想通貨自動売買プログラムを企画・開発し、リリースするプロジェクトです。

**[OASISランディングページへ](http://oasisbot24.com)**

2022年9月から企画を開始し、現在(2023年2月時点)まで進行しています。顧客に必要な仮想通貨自動売買プログラムを「OASIS BOT」と名付け、必要な機能の定義から、UI/UXデザイン、OASIS BOTの開発、ランディングページの開発まで担当しました。プロジェクト内のすべてのサービス開発と技術管理を担っています。

現在(2023年2月時点)は事業者登録を終えており、約1億ウォンの資金を集めてベータサービスをローンチしました。OASIS BOTを検証しながら、本サービスに向けて修正・改善を続けていく予定です。

**[OASIS BOTベータサービスへ](https://github.com/DeveloperRyou/oasis/releases/)**

## UI/UXデザイン

OASIS Projectを通じて、既存の仮想通貨自動売買プログラムに不足していたUI/UXを改善すべきだと考えました。デスクトップアプリケーションを開発するにあたり、ダッシュボード形式のアプリケーションがユーザー体験に役立つと判断しました。本格的な開発の前に、Figmaを使ってアプリケーションのレイアウトや配色などをあらかじめ定義しました。

![Dashboard](/assets/blog/oasis/dashboard.png)

![oasisbot](/assets/blog/oasis/oasisbot.png)

**[Figmaを確認する](https://www.figma.com/file/XQozaVMLzNJ5LxA8byEkqO/Trade-Bot?node-id=1%3A1096&t=OPtk0MpLLQTDUT7e-1)**

## OASIS BOT

OASIS BOTはデスクトップアプリケーションとして開発することに決めました。そのために使用する技術を調べる中で、自分がよく知っているWeb技術を使ってデスクトップアプリケーションを開発しようと考えました。Electronはそれを可能にするフレームワークでした。Discord、Slack、Skypeなどのソフトウェアもelectronで開発されています。Electronとともにtypescriptを使用し、膨大な実装過程の中で予期せぬエラーが起きないようにしました。

ElectronのMainプロセスでは、typescriptを用いたNode.jsで自動売買の中核となる処理を実装しました。interfaceとclassを使ったオブジェクト指向開発により、保守がスムーズに行えるよう開発を進めました。

Electronのrendererプロセスでは、typescriptを用いたReactを使い、Figmaでデザインした画面をアプリケーション上にレンダリングできるよう実装しました。OASIS BOTに必要な情報はMainプロセスから提供し、rendererプロセスではReactのstateを活用して、提供された情報を画面にレンダリングしました。
