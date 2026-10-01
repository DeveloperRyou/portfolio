---
title: "CKAD 모의고사 연습장의 내부 구조"
description: "정적 사이트로 배포한 시험 화면이 각자의 PC에 있는 kind 클러스터와 터미널을 어떻게 다루는지 정리했습니다."
pubDatetime: 2026-09-27T12:00:00
topic: "project-cncf"
subtopic: "cncf-practice"
tags: ["kubernetes", "ckad", "kind", "killer-sh"]
order: 2
draft: false
---

[지난 글](/ko/posts/cncf-practice-intro)에서 CKAD 모의고사 연습장 [cncf-practice](https://github.com/DeveloperRyou/cncf-practice)를 왜 만들었고 어떻게 쓰는지 소개했습니다. 이번에는 안쪽을 봅니다. 요약하면 시험 화면은 Cloudflare Workers에 올린 정적 페이지이고 클러스터·터미널·채점은 전부 각자의 PC에서 도는 로컬 서버가 맡아요. 이 구조에서 제일 신경 쓴 건 "공개 웹페이지가 내 PC의 셸을 다룬다"는 점이라, 보안 이야기에 분량을 꽤 썼습니다.

## 환경

2026년 9월 27일 기준 버전입니다.

| 항목 | 버전 |
| --- | --- |
| WSL / 배포판 | 2.7.14 / Ubuntu 22.04 |
| Docker Desktop | 4.89.0 |
| kubectl | v1.37.1 |
| kind | v0.33.0 (`kindest/node:v1.37.0`) |
| ttyd | 1.7.7 |
| Python | 표준 라이브러리만 사용 |

## 전체 구조

```
 브라우저 (Windows)
 ┌────────────────────────────────────────────┐
 │ cncf-practice.developerryou.workers.dev    │  ← 정적 HTML 한 장 (Cloudflare Workers)
 │  ┌──────────────┐   ┌───────────────────┐  │
 │  │ 문제지·타이머 │   │ <iframe> 터미널   │  │
 │  └──────┬───────┘   └────────┬──────────┘  │
 └─────────┼────────────────────┼─────────────┘
           │ fetch               │ WebSocket
           ▼                     ▼
   localhost:8000          localhost:7681        ← WSL localhost 포워딩
   exam/server.py          ttyd (bash)
     │  down.sh / up.sh / setup.sh / grade.sh
     ▼                     │ kubectl
   kind 클러스터 (Docker 컨테이너 한 개) ◀──────┘
```

`./scripts/exam.sh`가 서버 두 개를 띄웁니다. 하나는 브라우저에서 bash를 쓰게 해 주는 [ttyd](https://github.com/tsl0922/ttyd), 다른 하나는 Python 표준 라이브러리로만 짠 작은 HTTP 서버(`exam/server.py`)예요. 배포된 페이지는 이 둘에 `localhost`로 붙습니다.

## 로컬 클러스터

클러스터는 kind로 만든 단일 노드입니다. 설정은 control-plane 노드 하나가 전부예요.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
```

`up.sh`는 클러스터를 만든 뒤 노드가 Ready가 되고 `default` ServiceAccount가 생길 때까지 기다립니다. 노드가 Ready가 돼도 몇 초 동안은 ServiceAccount가 없어서 그 사이에 Pod를 만들면 `serviceaccount default not found`로 실패하거든요.

```bash
kubectl wait --for=condition=Ready node --all --timeout=180s
until kubectl get serviceaccount default >/dev/null 2>&1; do sleep 2; done
```

한 가지 걸렸던 건 cgroup입니다. kubelet 1.35부터는 cgroup v1 호스트에서 아예 기동하지 않는데, WSL2 기본 설정에서는 v1이 켜져 있어요. 처음엔 kubelet 설정(`failCgroupV1: false`)으로 우회했다가, 결국 그 패치를 빼고 호스트 쪽을 고쳤습니다. Windows의 `.wslconfig`에 아래를 넣고 `wsl --shutdown` 후 다시 열면 됩니다.

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all
```

## 회차 구조

문제는 자격증별 디렉터리 아래 회차별로 둡니다.

```
ckad/
  README.md        # 회차 목록, 점수, 다룬 주제 누적
  round-01/
    README.md      # 문제지 (영어, 실제 시험처럼)
    setup.sh       # 문제 풀기 전 사전 리소스 생성 (멱등)
    grade.sh       # 자동 채점
    meta.json      # 문제별 CKAD 영역과 세부 주제
    answers/       # 파일로 제출하는 답 (killer.sh의 /opt/course/N/)
```

`setup.sh`는 문제에 필요한 namespace와 리소스를 미리 만들어 둡니다. 트러블슈팅 문제라면 일부러 망가뜨린 리소스도 여기서 만들어져요. 회차마다 트러블슈팅형을 최소 한 문제는 넣도록 출제 기준에 적어 뒀습니다.

`grade.sh`는 클러스터 상태와 `answers/` 파일을 읽기만 하고 채점 항목마다 한 줄씩 PASS/FAIL을 찍습니다. 핵심은 `check()` 함수 하나예요.

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

조건은 셸 한 줄이라 `kubectl get -o json | jq -e ...`로 spec 값을 보든, 임시 Pod에서 `wget`을 날려 NetworkPolicy가 실제로 막는지 보든 자유롭게 쓸 수 있어요. 부분 점수는 이 항목 단위로 줍니다.

### 출제와 검증

문제는 AI 에이전트가 냅니다. 저장소의 `docs/mock-exam.md`에 출제 기준을 적어 두고 에이전트가 매번 그걸 읽게 했어요. 형식은 killer.sh, 난이도는 중상, 5문제, CKAD 커리큘럼 5개 영역에 고르게, kind에서 안 되는 기능(`LoadBalancer` 외부 IP 같은)은 피할 것, 같은 내용입니다.

제일 중요하게 둔 규칙은 "정답을 저장소에 쓰지 않는다"예요. 에이전트는 문제를 낼 때 모범 풀이를 저장소 밖에 두고 scratch 클러스터에서 직접 검증합니다.

1. `setup.sh` → 모범 풀이 → `grade.sh`가 100점이 나와야 함
2. `setup.sh`만 돌린 상태에서 `grade.sh`가 0점 가까이 나와야 함

두 번째 검사는 채점 조건이 너무 느슨해서 아무것도 안 했는데 점수가 나오는 경우를 잡기 위한 거예요. 해설과 모범 풀이는 제가 다 풀고 채점을 요청한 뒤에야 `result.md`로 들어갑니다.

## 시험 화면

화면은 HTML 파일 한 장(`exam/web/index.html`)입니다. 프레임워크 없이 해시 라우팅으로 환경 확인 → 회차 선택 → 환경 준비 → 시험 → 결과를 오가요.

로컬 서버의 API는 이게 전부입니다.

| 메서드 | 경로 | 하는 일 |
| --- | --- | --- |
| GET | `/api/env` | 터미널·Docker·kind·kubectl 준비 여부, 클론이 upstream보다 뒤처졌는지 |
| GET | `/api/rounds` | `*/round-*/README.md`를 찾아 회차 목록과 점수 |
| GET | `/api/sheet` | 문제지 마크다운 |
| POST | `/api/prepare` | `down.sh` → `up.sh` → `<회차>/setup.sh` |
| GET | `/api/job` | 돌고 있는 prepare/grade 작업의 로그 |
| POST | `/api/grade` | 종료 기록 후 `grade.sh` 실행 |
| GET | `/api/result` | 채점 결과 |

문제지는 마크다운 그대로 받아서 브라우저에서 파싱합니다. `# 제목`, `40 minutes`, `## Question N (W%)` 같은 제목 형식에 기대고 있어서 출제 기준에 이 형식을 지키라고 적어 뒀어요.

prepare와 grade는 오래 걸려서 백그라운드 스레드로 돌리고 화면은 `/api/job`을 폴링하면서 로그를 보여 줍니다. 동시에 하나만 돌 수 있고 이미 돌고 있으면 409를 돌려줘요.

"End exam"을 누르면 시작·종료 시각과 플래그 단 문제를 `finished.json`에 남기고 `grade.sh`를 돌립니다. 끝나면 서버가 출력의 PASS/FAIL 줄을 정규식으로 파싱해서 `meta.json`의 영역 정보와 합친 뒤 `grade.json`에 저장해요. 결과 화면의 영역별 점수는 이렇게 만들어집니다.

재시험도 따로 신경 썼습니다. `down.sh`는 클러스터만 지우고 `answers/`는 남기기 때문에, 그냥 다시 준비하면 이전 답안이 섞여요. 그래서 환경 준비를 누르면 이전 답안과 결과를 `attempts/<시각>/`으로 먼저 옮기고 시작합니다.

## 배포

배포되는 건 `exam/web/` 폴더뿐입니다. `wrangler.jsonc`에서 이 폴더를 Workers 정적 자산으로 지정했어요.

```jsonc
{
  "name": "cncf-practice",
  "compatibility_date": "2026-09-27",
  "assets": {
    "directory": "./exam/web"
  }
}
```

`v*` 태그를 push하면 GitHub Actions가 `wrangler deploy`를 돌립니다. 문제지와 스크립트는 배포하지 않아요. 문제지는 각자 클론에서 로컬 서버가 내보내고 클러스터와 터미널도 각자 PC에 있습니다.

페이지는 자기가 어디서 열렸는지 보고 API 주소를 정합니다. `localhost`에서 열렸으면 같은 서버, 배포된 도메인에서 열렸으면 `http://localhost:8000`이에요.

```js
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = new URLSearchParams(location.search).get("api") || (LOCAL ? "" : "http://localhost:8000");
```

이 구조의 약점은 배포된 페이지와 각자의 클론 버전이 어긋날 수 있다는 점입니다. 그래서 페이지와 서버가 `API_VERSION`을 하나씩 들고 있고 다르면 환경 확인 화면에서 `git pull`하라고 안내해요. 서버는 1분에 한 번 백그라운드로 `git fetch`를 해서 upstream보다 뒤처졌는지도 알려 줍니다.

## 보안

공개 웹페이지가 내 PC의 bash와 클러스터를 다루는 구조라서 막고 싶었던 건 "브라우저에 같이 열려 있는 다른 사이트가 이 서버를 건드리는 것"이에요.

### 바인딩

서버 둘 다 `127.0.0.1`에만 바인딩합니다. WSL의 localhost 포워딩으로 같은 PC의 Windows 브라우저에서는 열리지만 같은 네트워크의 다른 기기에서는 안 열려요.

### 터미널

ttyd는 `-O` 옵션으로 띄웁니다. 웹소켓 연결의 Origin이 ttyd 자신과 다르면 거부하는 옵션이에요. 이게 없으면 아무 사이트나 `ws://localhost:7681`에 붙어서 셸에 명령을 칠 수 있습니다.

```bash
ttyd -i 127.0.0.1 -p "$TERM_PORT" -W -O -w "$ROOT" \
  -- bash --rcfile "$ROOT/exam/bashrc" -i
```

### DNS rebinding

`127.0.0.1`에만 바인딩해도, 공격자가 자기 도메인을 `127.0.0.1`로 풀리게 바꾸는 DNS rebinding을 쓰면 브라우저 입장에서는 "같은 origin"이 돼 버립니다. 그래서 모든 요청의 `Host` 헤더가 `localhost:<포트>` 또는 `127.0.0.1:<포트>`가 아니면 403을 돌려줘요.

### CORS preflight 강제

POST는 `Content-Type: text/plain` 같은 "단순 요청"이면 CORS preflight 없이 바로 서버에 도달합니다. 응답을 못 읽을 뿐 스크립트는 이미 실행돼 버리는 거죠. 그래서 POST에는 `X-Exam: 1` 커스텀 헤더를 필수로 걸었습니다. 커스텀 헤더가 붙으면 브라우저가 반드시 preflight를 먼저 보내고 서버는 허용 목록(`EXAM_ORIGINS`, 기본값은 배포 도메인)과 자기 자신의 origin에만 허락해요.

```python
if (not self.host_ok() or self.path not in ("/api/prepare", "/api/grade")
        or self.headers.get("X-Exam") != "1" or not self.allowed_origin()):
    return self.send_error(403)
```

### 정해진 스크립트만

서버는 임의의 명령을 받지 않습니다. 요청으로 받는 건 회차 이름 하나이고 `^[a-z0-9-]+/round-\d+$` 정규식과 파일 존재 여부를 확인한 뒤 `down.sh`, `up.sh`, `setup.sh`, `grade.sh`만 돌려요. 정적 파일도 `index.html`만 내보내고 `grade.sh` 같은 나머지는 404입니다. 채점 조건이 드러나면 안 되니까요.

### 브라우저 쪽 제약

Chrome과 Edge는 공개 사이트가 localhost에 요청할 때 "로컬 네트워크 접근" 권한을 한 번 묻습니다. 이건 허용해야 해요. Safari는 https 페이지에서 `http://localhost`로 가는 요청을 막아서 지원하지 않습니다.

## 정리

구조는 단순합니다. 정적 페이지 한 장, 표준 라이브러리 Python 서버, ttyd, kind, 그리고 회차마다 셸 스크립트 세 개예요. 대신 "공개 페이지 + 로컬 셸" 조합이라, localhost 바인딩만으로는 부족하고 Origin 검사, Host 검사, preflight 강제, 고정 스크립트까지 겹겹이 막아야 했습니다.

2026년 9월 27일 기준으로 문제는 CKAD round-01 하나뿐이고 CKAD 준비를 하면서 회차와 기능을 계속 늘려 갈 생각입니다.

코드는 [GitHub 저장소](https://github.com/DeveloperRyou/cncf-practice)에 있어요.
