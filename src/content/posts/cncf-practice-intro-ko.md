---
title: "CKAD 모의고사 연습장 만들기"
description: "killer.sh처럼 실제 시험 형식으로 풀어 볼 수 있는 로컬 CKAD 모의고사"
pubDatetime: 2026-09-27T12:00:00
topic: "project-cncf"
subtopic: "cncf-practice"
tags: ["kubernetes", "ckad", "kind", "killer-sh"]
coverImage: "/assets/blog/cncf-practice-intro/05-exam.png"
order: 1
draft: false
---

CKAD를 준비하면서 killer.sh 시뮬레이터를 풀어 봤는데 점수가 생각만큼 안 나왔습니다. 그래서 실제 시험처럼 모의고사를 연습할 수 있는 환경을 만들어 보았습니다.

[cncf-practice](https://github.com/DeveloperRyou/cncf-practice)이고 시험 화면은 <https://cncf-practice.developerryou.workers.dev/>에 배포했습니다.

이번 글은 왜 만들었는지와 어떻게 쓰는지를, 다음 글은 안에서 어떻게 돌아가는지를 다룹니다.

## 계기

CKAD 시험을 결제하면 [killer.sh](https://killer.sh/) 시뮬레이터 세션이 딸려 옵니다. 실제 시험과 같은 형식으로, 브라우저 왼쪽에 문제가 있고 오른쪽 터미널에서 실제 k8s 클러스터를 만지면서 푸는 방식이에요. 난이도는 실제 시험보다 어렵게 잡혀 있다고는 하는데, 막상 풀어 보니 시간에도 쫓기고 점수가 잘 안 나왔습니다.

시험 범위를 따라 [개념 노트](/ko/topics/project-cncf/ckad)를 쓰긴 했지만 개념을 정리하는 것과 제한 시간 안에 터미널에서 직접 푸는 건 또 다른 느낌이었습니다.
그래서 이와 비슷한, 실제 시험처럼 풀어볼 수 있는 모의고사를 만들어보고자 했습니다.

## 만들고 싶었던 것

처음에 정한 사양입니다.

- killer.sh처럼 실제 클러스터에서 작업하는 실기형. 객관식은 없음
- 한 회차에 5문제, 난이도는 중상. 부분 문제가 존재. 한 문제가 개념 두세 개를 엮도록
- 끝나면 자동으로 채점돼서 어디서 틀렸는지 바로 보일 것
- 클러스터를 버튼 한 번으로 깨끗하게 다시 만들 수 있을 것

문제는 제가 직접 내지 않고 AI 에이전트에게 맡겼습니다.
에이전트가 출제 기준 문서와 공식 문서를 읽고 웹 검색도 해서 문제지와 사전 준비 스크립트, 채점 스크립트를 만듭니다.
이후 제가 문제를 풀고 다 풀면 채점이 진행되는 식입니다.

클러스터는 [kind](https://kind.sigs.k8s.io/)로 WSL2 위에 단일 노드로 띄웁니다.

## 사용 흐름

배포된 페이지를 열면 먼저 로컬 환경을 확인합니다. 페이지 자체는 정적 사이트라서 문제지와 클러스터·터미널은 각자 PC에서 돌아가는 로컬 서버에 붙어야 합니다. 로컬 서버가 없으면 클론하고 실행하는 방법을 그대로 보여 줍니다.

![로컬 서버가 없을 때 보이는 안내 화면](/assets/blog/cncf-practice-intro/01-no-server.png)

WSL에서 아래처럼 실행해 두면 됩니다.

```bash
git clone https://github.com/DeveloperRyou/cncf-practice.git
cd cncf-practice
./scripts/install.sh   # kubectl, kind, ttyd를 ~/.local/bin에 설치
./scripts/exam.sh      # 로컬 시험 서버 + 터미널
```

Chrome이나 Edge에서는 이때 "로컬 네트워크의 기기에 접근"하겠냐는 권한 요청이 한 번 뜨는데, 허용해야 페이지가 localhost에 붙을 수 있습니다. 서버가 뜨면 터미널, Docker, kind, kubectl이 준비됐는지 하나씩 확인하고 로컬 클론이 원격 저장소보다 뒤처져 있으면 `git pull`하라고 알려 줘요.

![환경 확인 화면](/assets/blog/cncf-practice-intro/02-environment.png)

다음은 회차 선택입니다. 자격증별로 회차 목록이 나오고 이미 푼 회차는 점수가 같이 표시돼요.

![회차 선택 화면](/assets/blog/cncf-practice-intro/03-rounds.png)

회차를 고르면 환경 준비 화면으로 넘어갑니다. "Prepare environment"를 누르면 클러스터를 지웠다가 새로 만들고 그 회차에 필요한 리소스를 미리 깔아 둡니다. 트러블슈팅 문제라면 일부러 망가뜨린 Deployment나 Pod도 이때 만들어져요. 로그가 화면에 그대로 흘러가서, 준비가 어디까지 됐는지 볼 수 있습니다.

![환경 준비 로그](/assets/blog/cncf-practice-intro/04-prepare.png)

준비가 끝나야 "Start exam" 버튼이 켜지고 누르면 바로 시험이 시작됩니다. 왼쪽에 문제지, 오른쪽에 WSL bash 터미널이 뜨고 위에서 타이머가 돌아가요. killer.sh 화면을 최대한 따라 했습니다. 문제마다 번호 탭이 있고 나중에 다시 볼 문제에는 플래그를 달 수 있고 문제지의 인라인 코드를 누르면 클립보드로 복사됩니다. 터미널에는 `k` alias와 자동완성이 미리 잡혀 있어요.

![시험 화면: 왼쪽 문제지, 오른쪽 터미널](/assets/blog/cncf-practice-intro/05-exam.png)

"End exam"을 누르면 타이머가 멈추고 바로 채점이 돌아갑니다. 총점과 합격 여부(합격선은 실제 시험과 같은 66%), CKAD 영역별 점수, 문제별 채점 항목이 나와요. 아래 화면은 아무것도 안 풀고 바로 끝냈을 때라서 점수가 이렇습니다.

![결과 화면](/assets/blog/cncf-practice-intro/06-result.png)

같은 회차를 다시 풀고 싶으면 목록에서 다시 누르면 되는데 이전 시도의 답안과 결과는 따로 보관되고 클러스터는 다시 깨끗한 상태로 만들어져요.

## 현재 상태와 다음 계획

2026년 9월 27일 기준으로 문제는 CKAD round-01, 5문제 하나뿐인데 아직 제 CKAD 준비도 진행 중이라서 준비하면서 이것저것 계속 넣어 볼 생각이에요.

- CKAD 회차 추가. 이전 회차에서 덜 다룬 영역부터
- 이후 CKA 등 다른 자격증 디렉터리
- 풀어 보면서 불편했던 화면 기능들

직접 써 보고 싶다면 위 명령 네 줄이면 됩니다. 다만 지금은 WSL2 + Docker Desktop 환경만 확인했고 Safari는 https 페이지에서 localhost 접근을 막아서 지원하지 않아요.

다음 글에서는 정적 페이지가 어떻게 로컬 클러스터와 터미널을 다루는지, 그러면서 다른 사이트가 이 서버를 건드리지 못하게 어떤 장치를 뒀는지 정리해 보겠습니다.
