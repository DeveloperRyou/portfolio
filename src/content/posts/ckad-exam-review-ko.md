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
돌아보면 점수를 올린 건 개념 공부보다 손으로 직접 푸는 연습이었어요.

![CKAD 시험 결과: 80%, 합격선 66%](/assets/blog/ckad-exam-review/result.png)

## 준비 과정

Kubernetes는 업무에서 매일 쓰고 있어서, 개념을 처음부터 공부한다기보다는 시험 범위를 한 번 훑는 것부터 시작했습니다.
Linux Foundation의 트레이닝 포털에 있는 CKAD 내용을 쭉 읽고, AI와 함께 커리큘럼 항목별로 [개념 노트](/ko/topics/project-cncf/ckad)를 정리했어요. 노트를 쓰면서 한 번, 다 쓰고 처음부터 다시 읽으면서 한 번, 그렇게 두 바퀴 정도 복습했습니다.

실습은 따로 문제집 없이 바로 killer.sh로 들어갔습니다. 첫 점수가 30%였어요.
업무에서 쓰는 내용이라 어느 정도는 나올 줄 알았는데, 시간 안에 명령어를 치고 YAML을 고치는 건 완전히 다른 일이었습니다. 이 점수를 보고 연습을 훨씬 많이 해야겠다고 판단했어요.

그런데 killer.sh 세션은 시험 한 번에 두 번만 주어집니다. 그래서 실제 시험처럼 풀어 볼 수 있는 로컬 모의고사 환경인 cncf-practice를 만들었어요. 만든 이유와 구조는 [cncf-practice 소개 글](/ko/posts/cncf-practice-intro)에 따로 정리해 두었습니다.
두 번째 killer.sh는 66%였고, cncf-practice에서는 30분짜리 세션을 다섯 번 정도 풀었습니다. 실전처럼 풀어 보는 연습이 제일 중요했던 것 같아요.

## 시험

시험은 2시간에 17문제였습니다. 저는 1시간 30분쯤에 끝냈어요.

체감상 절반 정도는 Deployment와 Pod를 만들고, 고치고, 안 뜨는 원인을 찾아 해결하는 문제였습니다. 업무에서 제일 많이 하는 일이라 여기서는 크게 막히지 않았어요.
나머지는 커리큘럼 여기저기서 하나씩 나왔습니다. Ingress, resource limit, CronJob, 컨테이너 이미지를 빌드해서 tar로 저장하기, Service, canary 배포, ServiceAccount, rollback 같은 주제들이요.
반대로 Helm과 Kustomize는 따로 노트까지 써 가며 준비했는데 제 시험에는 나오지 않았습니다.

이런 지엽적인 주제는 명령어가 바로바로 떠오르지는 않았어요. 그래도 무엇을 해야 하는지와 대략 어떤 명령어를 쓰는지는 알고 있어서, `--help`를 찍어 보고 공식 문서를 찾아 가면서 풀었습니다.

못 푼 문제는 두 개였고, 둘 다 네트워크 쪽이었습니다. 나머지는 다 풀었으니 70~90% 사이를 예상했는데 결과는 80%였어요.

## 오답 노트: NetworkPolicy와 Pod label

못 푼 문제 하나가 NetworkPolicy였습니다. 시험 내용은 공개할 수 없으니 문제 대신, 시험이 끝나고 다시 찾아본 개념을 정리해 둡니다.
제가 놓친 건 **NetworkPolicy와 Pod는 label로만 연결된다**는 점이었어요.

NetworkPolicy는 `spec.podSelector`로 자기가 적용될 Pod를 고르고, `ingress.from`과 `egress.to` 안의 `podSelector`(필요하면 `namespaceSelector`)로 통신 상대 Pod를 고릅니다. 둘 다 label selector예요.
Pod 쪽에는 "이 정책을 적용해 줘" 같은 필드가 없습니다. 그러니 정책이 이미 만들어져 있는 상황이라면, 손댈 곳은 정책이 아니라 Pod의 label일 수 있어요. Pod에 정책이 기대하는 label을 붙이면 그 순간부터 정책이 적용됩니다.

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

난이도는 전반적으로 중하 정도로 느꼈어요. 대부분 업무에서 쓰는 내용이었으니까요.
다만 개념이 쉽다고 해서 문제가 쉬운 건 아니었습니다. 머릿속으로는 아는 걸 제한 시간 안에 정확한 명령어로 옮기고, 결과를 확인하고, 틀린 데를 다시 고치는 과정이 생각보다 머리를 많이 썼어요. killer.sh 첫 점수가 30%였던 것도 결국 이 차이였습니다.

오랜만에 AI 없이 직접 클러스터를 만지면서 기초 체력을 확인해 본 느낌이라 좋았습니다.
다음 목표는 CKA입니다.
