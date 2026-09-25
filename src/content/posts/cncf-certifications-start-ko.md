---
title: "CNCF 자격증 도전기"
description: "CNCF 관련 기술들을 매일같이 사용하면서, 내가 실제로 이 기술들을 얼마나 알고 있다고 할 수 있는지 확인해 보고 싶었습니다."
pubDatetime: 2026-09-25T12:00:00
topic: "project-cncf"
tags: ["kubernetes", "cncf", "certification"]
---

## AI 사용과 실제로 알고 있는 것의 경계

CNCF의 기술들은 참 많으면서도 회사에서도 주로 사용하는 기술들입니다. Kubernetes부터 시작해서 Helm, Prometheus, containerd, CoreDNS, Envoy까지, 클러스터 하나만 띄워도 CNCF 프로젝트를 여러 개 쓰게 되니까요.

평소 업무할 때는 사실 필요한 부분만 찾아서 쓰거나, 요즘에는 AI에게 아예 조사를 맡겨 버리죠. "이 namespace에서 Pod가 왜 계속 재시작되는지 원인 좀 찾아 줘" 같은 지시를 해 버리면, AI가 `kubectl describe`와 로그를 뒤져 보고 결론까지 자연어로 잘 설명해 주고 시간도 빠르니까요.

이 블로그 글도 AI로 최종 검수를 하고 있는 마당에, AI를 사용하는 게 정말 아는 게 맞냐와 같은 다소? 구시대적인 이야기를 하려는 건 아닙니다.

다만 일도 어느 정도 익숙해지다 보니, 이론을 좀 더 알고 싶다는 생각이 들었습니다.

저는 새 언어나 기술을 배울 때도 이론부터가 아니라 튜토리얼부터 하는 타입이라서요.

실무에서도 자주 쓰는 명령어나 Helm chart, YAML 수정부터 해 왔으니까요.

예를 들면, init container라는 개념을 모르는 상태에서 AI에게 "애플리케이션이 시작되기 전에 DB 접속이 정상적으로 되는지 먼저 확인하고 싶다"고 요청했다고 해 볼게요. AI가 init container를 추천해 주면, 그게 뭔지 이해하는 데 한 번 더 시간이 듭니다. 반대로 AI가 애플리케이션 코드에 접속 재시도 로직을 넣자고 하면, Kubernetes 쪽에서 푸는 방법이 따로 있다는 걸 떠올리기 어렵겠죠.

비슷해 보이는 probe와 헷갈리기도 쉽습니다. startup probe는 애플리케이션이 다 떴는지를, readiness probe는 트래픽을 받아도 되는지를 확인하고 init container는 애플리케이션 컨테이너가 뜨기 전에 먼저 실행돼서 끝나야 하는 작업이에요. 이 차이를 모르면 AI가 내놓은 답이 맞는지 판단하는 데 시간이 걸리겠죠.

내가 정말 "알고" 있다면, 사용 방법은 바로 기억나지 않더라도 "이런 개념이 있었지" 정도는 머릿속에 떠올라야 하는 게 아닐까, 그런 생각이 들었습니다.

## CNCF 자격증

AI 시대에 이제는 이런 자격증이 의미가 있을까? 하는 솔직한 의문도 있습니다. 그리고 CNCF 자격증이 한두 푼 하는 것도 아니잖아요?

유효기간이 2년인 데다, Kubernetes 이외의 자격증까지 하면 10개가 넘어가는 양은 사실 다소 버겁습니다.

다만 자격증 준비를 해 보자고 생각한 건 앞서 말한 이론 공부를 해 보기 위해서이기도 하고 회사에서 자격증 2개를 지원해 준다고 해서도 큽니다.

일단 목표는 아래 언급할 Kubestronaut으로 잡았습니다.

### CNCF 자격증은 어떻게 나뉘어 있나

CNCF 자격증, 실제로는 CNCF(Cloud Native Computing Foundation)와 Linux Foundation이 함께 운영하는 Kubernetes 자격증은 다섯 개라고 합니다.

| 자격증                                                | 성격                                | 형식                |
| ----------------------------------------------------- | ----------------------------------- | ------------------- |
| KCNA (Kubernetes and Cloud Native Associate)          | 입문. 클라우드 네이티브 전반의 개념 | 객관식              |
| KCSA (Kubernetes and Cloud Native Security Associate) | 입문. 보안 개념                     | 객관식              |
| CKA (Certified Kubernetes Administrator)              | 클러스터 운영·관리                  | 실기                |
| CKAD (Certified Kubernetes Application Developer)     | 애플리케이션 배포·설계              | 실기                |
| CKS (Certified Kubernetes Security Specialist)        | 클러스터 보안                       | 실기, CKA 보유 필요 |

다섯 개를 모두 유효한 상태로 갖고 있으면 **Kubestronaut**이라는 칭호를 줍니다. 2년 안에 전부 보유가 필요하다는 이야기네요.

### 순서

CKS는 CKA가 있어야 볼 수 있고 나머지는 자유입니다. 저는 **CKAD, CKA**를 회사 지원으로 봐 보려고 합니다.

CKAD라면 평소 하는 업무와도 비슷해서 먼저 CKAD부터 시작해 보고 싶었어요.

이후 CKA를 준비하고 2026년 11월에 정기 할인이 있다는데 그즈음 CKS와 KCNA와 KCSA를 자비로 봐 보려고 해요.

## 시작

AI에게 물어보기 전에 "이런 개념이 있었지"가 먼저 떠오르게 하는 게 이번 목표입니다.

앞으로 CKAD 시험 범위를 따라가며 공부한 내용을 주제별로 올려 보려고 합니다.

## 레퍼런스

- **연습 문제**: [CKAD-exercises](https://github.com/dgkanatsios/CKAD-exercises)
- **공식 문서**: [Kubernetes Documentation](https://kubernetes.io/docs/)
  - 공식 문서는 시험장에서도 볼 수 있어서, 자료를 빠르게 찾는 준비도 해야 합니다.
- **강의**: Kubernetes for Developers (LFD259)
