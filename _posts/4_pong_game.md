---
title: 'PONG GAME'
excerpt: '
42Seoul Transcendence 과제를 통해 진행한 웹 게임 프로젝트입니다. 42 OAuth api를 통해서 42 계정을 통한 로그인을 구현하였습니다. 또한 웹 소켓을 통해 실시간 채팅과 실시간 게임을 구현하였습니다.
'
coverImage: '/assets/blog/ponggame/cover.png'
date: '2023-12-01T12:00:00'
ogImage:
  url: '/assets/blog/ponggame/cover.png'
---

## Pong Game 소개

Pong game 은 42Seoul 의 마지막 과제인 Transcendence 를 5인 팀 프로젝트로 진행하였습니다.

2023년 9월부터 시작하여 2023년 12월까지 3개월 동안 프로젝트를 진행, 완성하였습니다.

과제를 통해 ping pong 게임을 하기위한 웹 사이트를 개발하였습니다. 42 OAuth api를 통해서 42 계정을 통한 로그인을, 웹 소켓을 이용한 실시간 데이터 통신을 구현하고 채팅과 게임 기능을 개발했습니다.

## UI / UX 디자인

**[PONG GAME Figma 바로가기](https://www.figma.com/file/XLj9hhweYS8loExOuyHE3p/Transcendence?type=design&node-id=96%3A1101&mode=design&t=2iGru4oXqvZLQDfg-1m)**

Pong game을 개발하기 전 먼저 UI / UX 디자인을 진행했습니다. figma를 이용해 본격적인 개발 전 어플리케이션의 레이아웃과 색 등을 미리 정의하였습니다.

과제의 명세를 구현하기 위해서 Figma 를 통해 유저 정보 확인페이지, 친구페이지, 채팅페이지, 게임페이지 등을 디자인하였습니다.

![main](https://developerryou.github.io/portfolio/assets/blog/ponggame/main.png)

![play](https://developerryou.github.io/portfolio/assets/blog/ponggame/play.png)

![user](https://developerryou.github.io/portfolio/assets/blog/ponggame/user.png)

![dm](https://developerryou.github.io/portfolio/assets/blog/ponggame/dm.png)

![game](https://developerryou.github.io/portfolio/assets/blog/ponggame/game.png)

## api 엔드포인트, 웹소켓 명세 정의

**[PONG GAME 엔드포인트 확인하기](https://magnificent-front-23e.notion.site/e5948eb267e540c7b43dc99696232a80)**

**[PONG GAME 웹소켓 확인하기](https://magnificent-front-23e.notion.site/504cbe61748b4a6290ace5cfafcd53a5?pvs=4)**

이후 백엔드와 프런트엔드가 서로 소통하기 위한 api 엔드포인트와 웹소켓 명세를 정의했습니다.

## ER diagram

![erdiagram](https://developerryou.github.io/portfolio/assets/blog/ponggame/erdiagram.png)

백엔드에서 사용할 DB 설계를 진행했습니다.

직접 채팅을 하는 경우와 달리 채널을 통해 채팅을 하는 기능과 같은 경우, 따로 테이블을 생성하여 채팅 메세지를 저장하지 않기로 하였습니다.

## 개발 기술스택

이후 프런트엔드와 백엔드를 나누어 개발을 진행하였습니다.

언어는 typescript를 사용하였으며, 프레임워크로는 프런트엔드는 Next.js를, 백엔드는 Nest.js를 이용하였습니다.
