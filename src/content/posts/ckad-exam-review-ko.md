---
title: "CKAD 합격 후기"
description: "2026년 10월 12일 CKAD 시험을 80%로 합격했습니다. 준비 과정, 시험을 보며 느낀 점, 못 푼 NetworkPolicy 문제를 다시 정리한 오답 노트를 남깁니다."
pubDatetime: 2026-10-13T23:00:00
topic: "project-cncf"
subtopic: "ckad"
tags: ["kubernetes", "ckad", "certification", "killer-sh"]
coverImage: "/assets/blog/ckad-exam-review/certificate.png"
order: 15
draft: true
---

2026년 10월 12일에 CKAD 시험을 봤고, 다음 날인 13일에 80%로 합격했다는 결과와 자격증을 받았습니다.
준비는 개념 복습 두 번, killer.sh 두 번(30%, 66%), 직접 만든 [cncf-practice](https://github.com/DeveloperRyou/cncf-practice)에서 30분짜리 모의 세션 다섯 번 정도였습니다.

![CKAD 시험 결과: 80%, 합격선 66%](/assets/blog/ckad-exam-review/result.png)

## 준비 과정

Kubernetes는 업무에서 쓰고 있어서 시험 범위를 한 번 훑는 것부터 시작했습니다.
Linux Foundation의 트레이닝 포털에 있는 CKAD 내용을 쭉 훑어보고, AI와 함께 [개념 노트](/ko/topics/project-cncf/ckad)를 정리하면서 개념을 두 번 정도 반복해서 복습했어요.

실습은 바로 killer.sh를 풀었습니다. 첫 점수가 30%였어요.
점수가 낮아서 연습 세션이 더 필요하겠다고 생각했고, 그래서 연습용으로 cncf-practice를 만들었어요. 만든 이유와 구조는 [cncf-practice 소개 글](/ko/posts/cncf-practice-intro)에 따로 정리해 두었습니다.
두 번째 killer.sh는 66%였고, cncf-practice에서는 30분짜리 세션을 다섯 번 정도 풀었습니다. 실전 연습이 중요했던 것 같아요.

## 시험

시험은 2시간에 17문제였습니다. 저는 1시간 30분쯤에 끝냈어요.

체감상 절반 정도는 Deployment와 Pod를 만들고, 고치고, 안 뜨는 원인을 찾아 해결하는 문제였습니다.
나머지는 지엽적인 내용들로 채워졌습니다. Ingress, resource limit, CronJob, 컨테이너 이미지를 빌드해서 tar로 저장하기, Service, canary 배포, ServiceAccount, rollback 같은 주제들이요.
Helm과 Kustomize는 공부했는데 나오지 않았습니다.

이런 지엽적인 주제는 명령어가 바로바로 떠오르지는 않았어요. 그래도 개념과 대략의 명령어는 알고 있어서, `--help`와 공식 문서를 확인해 가면서 풀었습니다.

못 푼 문제는 두 개였고, 둘 다 네트워크 쪽이었습니다. 나머지는 다 풀었으니 70~90% 사이를 예상했는데 결과는 80%였어요.

## 오답 노트: NetworkPolicy와 Pod label

못 푼 문제 하나가 NetworkPolicy였습니다. 시험 내용은 공개할 수 없으니 문제 대신, 시험이 끝나고 다시 찾아본 개념을 정리해 둡니다.
NetworkPolicy와 Pod는 label로 연결됩니다.

NetworkPolicy는 `spec.podSelector`로 자기가 적용될 Pod를 고르고, `ingress.from`과 `egress.to` 안의 `podSelector`(필요하면 `namespaceSelector`)로 통신 상대 Pod를 고릅니다. 둘 다 label selector예요.
Pod 쪽에는 "이 정책을 적용해 줘" 같은 필드가 없습니다. 그래서 정책이 기대하는 label을 붙이면 그 순간부터 정책이 적용됩니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
spec:
  podSelector:
    matchLabels:
      role: api          # 이 label이 붙은 Pod에 적용
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: frontend   # 이 label이 붙은 Pod에서 오는 것만 허용
  egress:
    - to:
        - podSelector:
            matchLabels:
              role: db         # 이 label이 붙은 Pod로 가는 것만 허용
```

이 정책이 있다면, 어떤 Pod를 "frontend에서만 받고 db로만 보내게" 만드는 방법은 그 Pod에 `role=api`를 붙이는 거예요. 상대 Pod에도 각각 `role=frontend`, `role=db`가 붙어 있어야 허용 규칙이 맞아떨어집니다.

```bash
# 정책이 어떤 label을 기대하는지 확인
kubectl describe networkpolicy api-policy

# 지금 Pod에 붙어 있는 label과 비교
kubectl get pods --show-labels

# label 추가 (실행 중인 Pod에도 바로 붙일 수 있음)
kubectl label pod <pod> role=api
```

Deployment가 관리하는 Pod라면 Pod에 직접 붙이는 대신 `spec.template.metadata.labels`를 고쳐야 합니다. Pod에만 붙이면 다음에 Pod가 다시 만들어질 때 사라지거든요.

같이 기억해 둘 동작이 두 가지 있습니다. 어떤 정책에도 선택되지 않은 Pod는 격리되지 않아서 모든 트래픽이 열려 있어요. 그리고 정책끼리는 허용 규칙의 합집합이라, 정책이 여러 개면 하나라도 허용하는 트래픽은 통과합니다.
더 자세한 동작과 `from` 항목의 AND/OR 차이는 [CKAD 개념 노트: Service, Ingress, NetworkPolicy](/ko/posts/ckad-services-ingress-networkpolicy)에 정리해 두었어요.

## 회고

난이도는 업무에서도 쓰는 내용들이어서 전반적으로 중하 정도였어요.
개념은 쉬운데, 실제로 명령어를 넣어 가면서 수정하는 게 생각보다 머리를 썼어요.

오랜만에 AI 없이 직접 만져서 기초 체력을 테스트해 본 느낌이라 좋았습니다.
다음은 CKA 도전입니다.
