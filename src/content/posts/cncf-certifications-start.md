---
title: "Taking on the CNCF certifications"
description: "I use CNCF technologies practically every day, and I wanted to check how much I can honestly say I actually know them."
pubDatetime: 2026-09-25T12:00:00
topic: "project-cncf"
tags: ["kubernetes", "cncf", "certification"]
---

## Using AI vs. actually knowing it

There are a lot of CNCF technologies, and they're also the ones I mostly use at work. Starting with Kubernetes, then Helm, Prometheus, containerd, CoreDNS, Envoy -- spin up a single cluster and you're already using a handful of CNCF projects.

Day to day, I honestly just look up the part I need, or these days I hand the whole investigation off to AI. Tell it "find out why the Pods in this namespace keep restarting" and it digs through `kubectl describe` and the logs, then explains its conclusion nicely in plain language, and fast.

I'm even using AI for the final review of this very blog post, so I'm not here to make the kind of? old-fashioned argument that using AI means you don't really know things.

It's just that as I've gotten more comfortable with the work, I started wanting to know more of the theory.

When I pick up a new language or technology, I'm the type who starts with the tutorial, not the theory.

At work, too, I started out with commonly used commands, Helm charts, and editing YAML.

Say I don't know what an init container is, and I ask AI, "I want to check that the DB connection works before the application starts." If it recommends an init container, I lose time figuring out what that even is. And if it suggests adding retry logic to the application code instead, it's hard for me to realize there's a separate way to solve it on the Kubernetes side.

It's also easy to mix up with probes, which look similar. A startup probe checks whether the application has finished starting, a readiness probe checks whether it's ready to take traffic, and an init container is work that runs and has to finish before the application containers start. Without knowing that difference, it takes me a while to judge whether AI's answer is right.

If I really "know" something, then even when I can't recall exactly how to use it, shouldn't at least "oh right, there was a concept like that" come to mind? That's what I started thinking.

## The CNCF certifications

I'll be honest, I do wonder whether certifications like these still mean anything in the age of AI. And CNCF certifications aren't exactly cheap, right?

On top of that they're valid for two years, and if you count the non-Kubernetes ones too there are more than ten of them, which is honestly a bit much.

Still, I decided to go for it partly to get that theory study done, and a big part is that my company covers two certifications.

For now I've set my goal at Kubestronaut, which I'll explain below.

### How the CNCF certifications break down

CNCF certifications -- or more precisely the Kubernetes certifications run jointly by the CNCF (Cloud Native Computing Foundation) and the Linux Foundation -- come to five.

| Certification                                         | Focus                                      | Format                          |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------- |
| KCNA (Kubernetes and Cloud Native Associate)          | Entry level. Cloud native concepts overall | Multiple choice                 |
| KCSA (Kubernetes and Cloud Native Security Associate) | Entry level. Security concepts             | Multiple choice                 |
| CKA (Certified Kubernetes Administrator)              | Cluster operations and administration      | Performance-based               |
| CKAD (Certified Kubernetes Application Developer)     | Application deployment and design          | Performance-based               |
| CKS (Certified Kubernetes Security Specialist)        | Cluster security                           | Performance-based, requires CKA |

Hold all five at the same time, all still valid, and you get the title **Kubestronaut**. In other words, you need to have them all within two years.

### Order

CKS requires CKA; beyond that the order is up to you. I'm planning to take **CKAD and CKA** with my company's support.

CKAD is close to what I do at work every day, so I wanted to start there.

After that I'll prepare for CKA, and I hear there's a regular sale in November 2026, so around then I'm planning to take CKS, KCNA, and KCSA on my own dime.

## Getting started

My goal this time is for "oh right, there was a concept like that" to come to mind before I ask AI.

From here on, I'm going to follow the CKAD exam curriculum and post what I study, one topic at a time.

## References

- **Practice exercises**: [CKAD-exercises](https://github.com/dgkanatsios/CKAD-exercises)
- **Official docs**: [Kubernetes Documentation](https://kubernetes.io/docs/)
  - You can use the official docs during the exam too, so it's worth practicing finding things in them quickly.
- **Course**: Kubernetes for Developers (LFD259)
