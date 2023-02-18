---
title: 'OASIS Project'
excerpt: '
OASIS Project는 가상화폐 자동매매 프로그램을 기획, 개발하고 배포하는 프로젝트입니다. 
기획단계에서 비즈니스 모델을 수립해 개발, 배포이후 지속적인 수익을 창출할 수 있게 설계되었습니다. 
Electron을 이용하여 데스크탑 어플리케이션을 개발하였고 Nodejs와 Upbit api를 이용하여 가상화폐 자동매매를, React를 이용하여 Frontend를 구현하였습니다.
'
coverImage: '/assets/blog/oasis/cover.jpg'
date: '2022-09-01T00:00:00'
ogImage:
  url: '/assets/blog/oasis/cover.jpg'
---

## OASIS 소개

OASIS Project는 가상화폐 자동매매 프로그램을 기획, 개발하고 배포하는 프로젝트입니다.

**[OASIS 랜딩페이지 바로가지](http://oasisbot24.com)**

2022년 9월 부터 기획을 시작했으며 현재(2023.2.)까지 진행하고 있습니다. 고객들에게 필요한 가상화폐 자동매매 프로그램을 OASIS BOT 명명하고 필요한 기능을 정의 하는것 부터, UI / UX 디자인, OASIS BOT 개발, 랜딩페이지 개발을 담당했습니다. 프로젝트 내의 모든 서비스 개발과 기술 관리를 맡고 있습니다.

현재(2023.2)는 사업자등록을 마친 상태이며, 1억원 가량의 자금을 모아 beta 서비스를 런칭하였습니다. OASIS BOT을 검증하고 본 서비스까지 수정, 보완을 이어갈 예정입니다. 

**[OASIS BOT Beta 서비스 바로가기](https://github.com/DeveloperRyou/oasis/releases/)**


## UI / UX 디자인

OASIS Project를 통해 기존의 가상화폐 자동매매 프로그램에서 부족했던 부분인 UI / UX 를 발전시켜야겠다고 생각했습니다. 데스크탑 어플리케이션을 개발함에 있어 Dashboard 형태의 어플리케이션이 유저의 경험에 도움이 되리라 판단했습니다. figma를 이용해 본격적인 개발 전 어플리케이션의 레이아웃과 색 등을 미리 정의하였습니다.

![Dashboard](https://developerryou.github.io/portfolio/assets/blog/oasis/dashboard.png)

![Dashboard](https://developerryou.github.io/portfolio/assets/blog/oasis/oasisbot.png)

**[figma 확인하기](https://www.figma.com/file/XQozaVMLzNJ5LxA8byEkqO/Trade-Bot?node-id=1%3A1096&t=OPtk0MpLLQTDUT7e-1)** 

## OASIS BOT

OASIS BOT은 데스크탑 어플리케이션으로 개발하기로 결정했습니다. 이를 위해서 사용할 기술을 알아보던 중, 저에게 익숙한 웹기술을 이용하여 데스크탑 어플리케이션을 개발해야겠다고 생각하였습니다. Electron은 이를 가능하게 해주는 프레임워크였습니다. Discord, Slack, Skype 등의 소프트웨어가 Electron으로 개발되었습니다. Electron과 함께 typescript를 사용하여 방대한 구현과정 속 예상치 못한 에러가 일어나지 않도록 하였습니다.

Electron의 Main 프로세스에서는 Nodejs with typescript를 이용해 자동매매의 핵심 동작을 구현하였습니다. interface와 class를 사용해 객체 지향적 개발을 하여 유지 보수가 원할하게 개발을 진행했습니다.

Electron의 Renderer 프로세스에서는 React with typescript를 이용해 figma로 디자인한 화면을 어플리케이션에서 렌더링 할 수 있도록 구현하였습니다. OASIS BOT에서 필요한 정보는 Main 프로세스에서 제공하고, Renderer 프로세스에서는 React의 State를 활용하여 제공된 정보를 화면에 렌더링했습니다.


