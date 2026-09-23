---
title: "Can I manage all my AI docs from a single repository?"
description: "CLAUDE.md, skills, and agent docs have to be maintained separately in every repository. Both personally and on my team at work, I'd come to feel that the upkeep cost of these AI docs was too high. Could they all be managed from one shared repository?"
pubDatetime: 2026-09-23T12:00:00
topic: "ai"
subtopic: "ai-documents"
tags: ["claude-code", "ai-documents", "documents"]
---

## AI docs scattered across repositories

When you use Claude or Codex, you end up running AI agents per directory, per repository. When you first adopt AI, or whenever you create a new repository, you set up a bunch of docs so the agents work smoothly — and once your repositories are split up, keeping those docs in shape gets pretty painful.

The main pain points were these:

1. If you have a good skill or agent and want to use it in another repository, you have to copy it over by hand.
   - So every time something changes, you have to fix it separately in each repository.
2. AI docs start getting mixed into the repository's work history (its Git history).
   - AI docs need regular updates too, but once they live in the working repository, you run into questions like whether an AI doc change belongs in the feature PR or in a separate PR.
   - Doc changes also fall under PR review, so AI doc updates gradually fall behind and the experience gets worse.
3. Keeping docs in order is hard when you need to look back and forth between repository A and repository B.
   - Think of separate FE and BE repositories, or a BE that's split into one repository per API. Every time, I had to read the other repository with `gh` and then go through several steps to check that repository's AI docs, which hurt both speed and token usage.

You might say, "Can't people just pay attention and fix it?"... but I basically don't think relying on people's goodwill or conscious effort is a very good approach.

Whether it's because it's tedious, because you forget, or because the actual development work keeps you busy, low-priority tasks are bound to get pushed back, right?

So how should the docs be structured to reduce that mental overhead?

## How to manage them

These were the conditions I wanted:

- The source of truth for the setup is managed in exactly one place.
- Shared settings and per-repository settings can be separated.
- It works no matter where each person cloned their repositories.
- No extra dependencies to install.

With those conditions in mind, I looked at a few options.

### Git submodules

The first thing that came to mind was a git submodule. Managing the docs as a submodule does meet the conditions above. But two drawbacks felt pretty significant, so in the end I didn't go with it.

First, to pick up AI doc updates, you have to update the submodule regularly. A submodule points at a specific commit, so whenever the AI docs change you have to bump the submodule to the latest commit and then commit that change in the working repository as well.

Second, it doesn't play well with the git worktrees AI agents use. I already knew from using agents that worktrees and submodules don't get along. If I pulled the AI docs in as a submodule, I figured every new worktree would need extra setup.

> See also: [Worktrees with submodules (r/ClaudeCode)](https://www.reddit.com/r/ClaudeCode/comments/1scpsaj/worktrees_with_submodules/)

### Symbolic links

Someone at work suggested managing them with symbolic links, and it looked like a good idea. The downside was that it could be awkward on Windows, but everyone at work is on a Mac, so we adopted this approach.

## How it's built

[DeveloperRyou/ai-documents](https://github.com/DeveloperRyou/ai-documents)

### Directory layout

```
ai-documents/
  repo.yaml              # list of managed repositories (by remote URL)
  install.sh             # find repos → mirror _common → create symbolic links
  update.sh              # git pull, then re-run install.sh
  uninstall.sh           # remove the symbolic links it created
  projects/              # shared and per-repository docs (explained below)
```

### Finding repositories by remote URL, not by path

`repo.yaml` registers the repositories this shared set of AI docs gets installed into. Each one is listed by its Git remote URL instead of a local path.

```yaml
anchor: /opt/ai-documents

search_paths:
  - ~/Develop

repos:
  - name: portfolio
    remote: https://github.com/DeveloperRyou/portfolio.git
```

When you run `install.sh` in ai-documents, it walks everything under `search_paths` to find a clone whose remote URL matches, and caches the path it found per machine. The point is that even if repository locations differ between my laptop and desktop, or each teammate has the repository at a different location or under a different name, it still works as long as it's somewhere inside `search_paths`.

### Why `install.sh` goes through two symbolic links

At first, each repository's `CLAUDE.md` pointed straight at the ai-documents clone — but then every link breaks the moment you re-clone ai-documents somewhere else.

On top of that, this link is a path that gets committed into the actual working repository. You can't commit a local path that differs per developer, so I put a fixed anchor directory in the middle.

```
<portfolio>/CLAUDE.md
  → /opt/ai-documents/checkout/projects/portfolio/CLAUDE.md
  → (checkout is a link to the actual ai-documents clone)
```

Every repository's link always goes through `/opt/ai-documents/checkout`, so if ai-documents moves, you only need to repoint that one `checkout` link, and nothing changes on the managed repositories' side.

The links created this way are committed into the managed repositories. Even a fresh clone of portfolio brings `CLAUDE.md` and `.claude` along as links, and it works right away as long as the anchor is in place.

### `_common` and per-repository folders

```
projects/
  _common/.claude/      # shared by every repo: RULES.md, hooks, shared skills
  portfolio/            # portfolio only: CLAUDE.md, its own skills
  ai-documents/         # ai-documents' own CLAUDE.md
```

`install.sh` first mirrors each file under `_common` into every repository's folder, then links each repository folder as a whole into the actual repository. The mirrored links go into the ai-documents repository's `.git/info/exclude` so they never get committed.

Files with overlapping names needed special handling. `CLAUDE.md` differs per repository, so `_common` must not overwrite it. Instead, the shared rules live in `_common/.claude/RULES.md`, and each repository's `CLAUDE.md` pulls them in with a single line at the top.

```
@.claude/RULES.md
```

`settings.json` has the same problem. There are plugins and hooks that should be on everywhere, but also plugins used only in a particular repository (Playwright, frontend-design). So if a repository folder has a `settings.override.json`, it gets deep-merged on top of the shared `settings.json` to produce the final file.

### Rule: commit straight to main

ai-documents itself gets committed and pushed straight to main, with no branches or PRs. Opening a PR just to edit docs rather than code is overkill, and with a review burden in the way, doc updates slip down the priority list and don't get refreshed quickly.

Especially if you had to check whether the docs are up to date every single time before running an AI agent — I thought that would be an absurd workflow.

This rule is also written in ai-documents' own `CLAUDE.md`, so when Claude Code edits the setup, it commits to main on its own.

At work, we set it up to open PRs depending on the situation. Some PRs sit in draft, and some features take a long time to build, so we allowed doc changes to wait in a PR too. I think this part can flex depending on how you work.

### Updating automatically when an AI agent session starts

I put a SessionStart hook in the shared `settings.json` so `update.sh` runs every time a Claude Code session opens. `update.sh` does a `git pull` on ai-documents and re-runs the install, so rules fixed from another repository, or by another developer, apply from the very next session.

The whole point of this way of managing docs is that I never have to run anything myself.

### Skills

These are the skills that have piled up in `_common`:

- `backlog-issue`: writes a GitHub issue in Why / What / Acceptance format
- `resolve-issue`: takes one issue through branching, implementation, and a local-model review, all the way to a PR
- `issue-status`: scans open PRs and issues and sorts out what to do next
- `handoff`: writes a 10-line handoff note before ending a session

I keep adding more, and I'll go into them in more detail when I write about skills separately.

## What I liked about it

The biggest benefit of managing the shared docs separately is, unsurprisingly, that updating docs and settings is much less of a burden. You fix a rule in one place, commit it, and you're done, so whenever something feels annoying you can turn it into a rule or a skill right away.

Another benefit I personally value is that the actual working repositories' Git history no longer gets polluted. These days, AI agents read the Git history and trace how the code changed while they work, after all.

## Are there other solutions?

Honestly, if you work in a monorepo instead of multiple repos, you probably wouldn't need things like symbolic links just to keep your AI docs in order... it might be solved more cleanly.

But converting a project that's already built on multiple repos into a monorepo means dealing with CI/CD and a lot of effort all around. In that sense, I think ai-documents is a way to keep your current repository layout while still managing docs in one place, easily.
