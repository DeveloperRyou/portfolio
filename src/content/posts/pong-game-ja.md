---
title: "Pong Game"
description: "42Seoul Transcendence課題として進めたWebゲームプロジェクト。42 OAuthログインとWebSocketベースのリアルタイムチャット・ゲームを実装した。"
pubDatetime: 2023-12-01T12:00:00
topic: "career"
subtopic: "42seoul"
tags: ["42seoul", "nestjs", "nextjs", "websocket"]
coverImage: "/assets/blog/ponggame/cover.png"
---

## Pong Gameについて

Pong Gameは、42Seoulの最終課題であるTranscendenceを5人チームのプロジェクトとして進めました。

2023年9月から開始し、2023年12月までの3ヶ月間でプロジェクトを進行、完成させました。

課題を通じてピンポンゲームをプレイするためのWebサイトを開発しました。42 OAuth APIを通じて42アカウントでのログインを、WebSocketを利用したリアルタイムデータ通信を実装し、チャットとゲーム機能を開発しました。

## UI/UXデザイン

**[PONG GAME Figmaへ](https://www.figma.com/file/XLj9hhweYS8loExOuyHE3p/Transcendence?type=design&node-id=96%3A1101&mode=design&t=2iGru4oXqvZLQDfg-1m)**

Pong Gameを開発する前に、まずUI/UXデザインを行いました。本格的な開発の前にFigmaを使ってアプリケーションのレイアウトや配色などをあらかじめ定義しました。

課題の仕様を実装するため、Figmaを通じてユーザー情報確認ページ、フレンドページ、チャットページ、ゲームページなどをデザインしました。

![main](/assets/blog/ponggame/main.png)

![play](/assets/blog/ponggame/play.png)

![user](/assets/blog/ponggame/user.png)

![dm](/assets/blog/ponggame/dm.png)

![game](/assets/blog/ponggame/game.png)

## APIエンドポイント・WebSocket仕様の定義

**[PONG GAMEエンドポイントを確認する](https://magnificent-front-23e.notion.site/e5948eb267e540c7b43dc99696232a80)**

**[PONG GAME WebSocketを確認する](https://magnificent-front-23e.notion.site/504cbe61748b4a6290ace5cfafcd53a5?pvs=4)**

その後、バックエンドとフロントエンドが互いに連携するためのAPIエンドポイントとWebSocket仕様を定義しました。

## ER図

![erdiagram](/assets/blog/ponggame/erdiagram.png)

バックエンドで使用するDB設計を行いました。

直接チャットする場合とは異なり、チャンネルを通じたチャット機能については、別途テーブルを作成してチャットメッセージを保存しないことにしました。

## 開発技術スタック

その後、フロントエンドとバックエンドに分かれて開発を進めました。

言語はtypescriptを使用し、フレームワークとしてフロントエンドはNext.jsを、バックエンドはNest.jsを利用しました。
