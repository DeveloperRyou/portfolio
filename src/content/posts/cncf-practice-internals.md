---
title: "Inside the CKAD mock exam"
description: "How an exam UI deployed as a static site drives the kind cluster and terminal on each person's own PC."
pubDatetime: 2026-09-27T12:00:00
topic: "project-cncf"
subtopic: "cncf-practice"
tags: ["kubernetes", "ckad", "kind", "killer-sh"]
order: 2
draft: false
---

In the [previous post](/posts/cncf-practice-intro), I introduced [cncf-practice](https://github.com/DeveloperRyou/cncf-practice), my CKAD mock exam environment: why I built it and how to use it. This time, let's look inside. In short, the exam UI is a static page on Cloudflare Workers, and the cluster, terminal, and grading are all handled by a local server running on each person's own PC. The thing I worried about most in this setup is that "a public web page drives a shell on my PC", so a good chunk of this post is about security.

## Environment

Versions as of September 27, 2026.

| Item | Version |
| --- | --- |
| WSL / distro | 2.7.14 / Ubuntu 22.04 |
| Docker Desktop | 4.89.0 |
| kubectl | v1.37.1 |
| kind | v0.33.0 (`kindest/node:v1.37.0`) |
| ttyd | 1.7.7 |
| Python | standard library only |

## Overall structure

```
 Browser (Windows)
 ┌────────────────────────────────────────────┐
 │ cncf-practice.developerryou.workers.dev    │  ← a single static HTML page (Cloudflare Workers)
 │  ┌──────────────┐   ┌───────────────────┐  │
 │  │ sheet, timer │   │ <iframe> terminal │  │
 │  └──────┬───────┘   └────────┬──────────┘  │
 └─────────┼────────────────────┼─────────────┘
           │ fetch               │ WebSocket
           ▼                     ▼
   localhost:8000          localhost:7681        ← WSL localhost forwarding
   exam/server.py          ttyd (bash)
     │  down.sh / up.sh / setup.sh / grade.sh
     ▼                     │ kubectl
   kind cluster (one Docker container) ◀────────┘
```

`./scripts/exam.sh` starts two servers. One is [ttyd](https://github.com/tsl0922/ttyd), which gives you bash in the browser; the other is a small HTTP server written with nothing but the Python standard library (`exam/server.py`). The deployed page connects to both over `localhost`.

## Local cluster

The cluster is a single node created with kind. The whole config is one control-plane node.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
```

After creating the cluster, `up.sh` waits until the node is Ready and the `default` ServiceAccount exists. Even after the node goes Ready, the ServiceAccount is missing for a few seconds, and creating a Pod in that window fails with `serviceaccount default not found`.

```bash
kubectl wait --for=condition=Ready node --all --timeout=180s
until kubectl get serviceaccount default >/dev/null 2>&1; do sleep 2; done
```

One thing that tripped me up was cgroups. Starting with 1.35, the kubelet refuses to start at all on a cgroup v1 host, and WSL2's default setup has v1 enabled. At first I worked around it with a kubelet setting (`failCgroupV1: false`), but in the end I dropped that patch and fixed the host instead. Add the following to `.wslconfig` on Windows, run `wsl --shutdown`, and reopen WSL.

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all
```

## Round structure

Questions live under a directory per certification, one subdirectory per round.

```
ckad/
  README.md        # round list, scores, cumulative topics covered
  round-01/
    README.md      # question sheet (in English, like the real exam)
    setup.sh       # creates prerequisite resources before solving (idempotent)
    grade.sh       # automatic grading
    meta.json      # CKAD domain and subtopic per question
    answers/       # answers submitted as files (killer.sh's /opt/course/N/)
```

`setup.sh` creates the namespaces and resources the questions need ahead of time. For troubleshooting questions, the deliberately broken resources are created here too. The question-writing guidelines require at least one troubleshooting-style question per round.

`grade.sh` only reads the cluster state and the `answers/` files, and prints one PASS/FAIL line per check. The core of it is a single `check()` function.

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

Since the condition is a single shell line, it can be anything: inspecting spec values with `kubectl get -o json | jq -e ...`, or firing `wget` from a temporary Pod to see whether a NetworkPolicy actually blocks traffic. Partial credit is awarded per check.

### Writing and verifying questions

An AI agent writes the questions. I put the question-writing guidelines in the repo's `docs/mock-exam.md` and have the agent read it every time. It says things like: killer.sh format, medium-to-hard difficulty, 5 questions, spread evenly across the 5 CKAD curriculum domains, and avoid features that don't work on kind (like external IPs for `LoadBalancer`).

The rule I care about most is "never write the answers into the repo". When writing questions, the agent keeps the model solutions outside the repo and verifies them on a scratch cluster itself.

1. `setup.sh` → model solution → `grade.sh` must score 100
2. With only `setup.sh` run, `grade.sh` must score close to 0

The second check catches grading conditions that are so loose you get points without doing anything. Explanations and model solutions only go into `result.md` after I've finished solving and asked for grading.

## Exam UI

The UI is a single HTML file (`exam/web/index.html`). No framework; hash routing moves between environment check → round selection → environment setup → exam → results.

This is the local server's entire API.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/env` | Whether terminal, Docker, kind, kubectl are ready; whether the clone is behind upstream |
| GET | `/api/rounds` | Finds `*/round-*/README.md` and returns the round list with scores |
| GET | `/api/sheet` | Question sheet markdown |
| POST | `/api/prepare` | `down.sh` → `up.sh` → `<round>/setup.sh` |
| GET | `/api/job` | Logs of the running prepare/grade job |
| POST | `/api/grade` | Records the end, then runs `grade.sh` |
| GET | `/api/result` | Grading results |

The question sheet comes over as raw markdown and gets parsed in the browser. The parser relies on heading formats like `# Title`, `40 minutes`, and `## Question N (W%)`, so the guidelines tell the agent to stick to them.

Prepare and grade take a while, so they run in a background thread, and the UI polls `/api/job` to show the logs. Only one job can run at a time; if one is already running, the server returns 409.

Clicking "End exam" saves the start/end times and flagged questions to `finished.json` and runs `grade.sh`. When it finishes, the server parses the PASS/FAIL lines of the output with a regex, merges them with the domain info from `meta.json`, and saves the result to `grade.json`. That's where the per-domain scores on the results screen come from.

Retakes needed some extra care too. `down.sh` only deletes the cluster and leaves `answers/` alone, so preparing again as-is would mix in the previous answers. So when you click prepare, the previous answers and results are moved to `attempts/<timestamp>/` first.

## Deployment

Only the `exam/web/` folder is deployed. `wrangler.jsonc` points Workers static assets at that folder.

```jsonc
{
  "name": "cncf-practice",
  "compatibility_date": "2026-09-27",
  "assets": {
    "directory": "./exam/web"
  }
}
```

Pushing a `v*` tag makes GitHub Actions run `wrangler deploy`. The question sheets and scripts aren't deployed. Each person's local server serves the question sheet from their own clone, and the cluster and terminal live on their own PC too.

The page decides the API address based on where it was opened. If it was opened from `localhost`, it uses the same server; if from the deployed domain, `http://localhost:8000`.

```js
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = new URLSearchParams(location.search).get("api") || (LOCAL ? "" : "http://localhost:8000");
```

The weak spot of this setup is that the deployed page and each person's clone can drift out of sync. So the page and the server each carry an `API_VERSION`, and if they differ, the environment check screen tells you to `git pull`. The server also runs `git fetch` in the background once a minute and reports whether you're behind upstream.

## Security

Since a public web page drives the bash shell and cluster on my PC, what I wanted to block was "another site open in the same browser poking at this server".

### Binding

Both servers bind only to `127.0.0.1`. Thanks to WSL's localhost forwarding, they're reachable from the Windows browser on the same PC, but not from other devices on the same network.

### Terminal

ttyd runs with the `-O` option, which rejects WebSocket connections whose Origin differs from ttyd itself. Without it, any site could connect to `ws://localhost:7681` and type commands into the shell.

```bash
ttyd -i 127.0.0.1 -p "$TERM_PORT" -W -O -w "$ROOT" \
  -- bash --rcfile "$ROOT/exam/bashrc" -i
```

### DNS rebinding

Even when bound to `127.0.0.1`, an attacker can use DNS rebinding, pointing their own domain at `127.0.0.1`, and from the browser's point of view it becomes "the same origin". So the server returns 403 for any request whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>`.

### Forcing a CORS preflight

A POST that's a "simple request", like one with `Content-Type: text/plain`, reaches the server directly without a CORS preflight. The page just can't read the response, but the script has already run by then. So every POST must carry a custom `X-Exam: 1` header. A custom header forces the browser to send a preflight first, and the server allows only its allowlist (`EXAM_ORIGINS`, which defaults to the deployed domain) and its own origin.

```python
if (not self.host_ok() or self.path not in ("/api/prepare", "/api/grade")
        or self.headers.get("X-Exam") != "1" or not self.allowed_origin()):
    return self.send_error(403)
```

### Fixed scripts only

The server never accepts arbitrary commands. The only thing a request carries is a round name, and after checking it against the `^[a-z0-9-]+/round-\d+$` regex and confirming the files exist, the server runs only `down.sh`, `up.sh`, `setup.sh`, and `grade.sh`. For static files it serves only `index.html`; everything else, like `grade.sh`, is a 404. The grading conditions shouldn't leak, after all.

### Browser-side limits

When a public site makes a request to localhost, Chrome and Edge ask once for "local network access" permission. You have to allow it. Safari blocks requests from https pages to `http://localhost`, so it isn't supported.

## Wrapping up

The structure is simple: one static page, a standard-library Python server, ttyd, kind, and three shell scripts per round. But because it combines "a public page + a local shell", binding to localhost alone wasn't enough. I had to layer Origin checks, Host checks, forced preflights, and fixed scripts on top.

As of September 27, 2026, there's only one set of questions, CKAD round-01, and I plan to keep adding rounds and features as I prepare for the CKAD.

The code is in the [GitHub repository](https://github.com/DeveloperRyou/cncf-practice).
