---
title: "Pong Game"
description: "A web game project built for 42 Seoul's Transcendence assignment. Implemented 42 OAuth login and real-time chat/gameplay over WebSockets."
pubDatetime: 2023-12-01T12:00:00
tags: ["42seoul", "nestjs", "nextjs", "websocket"]
coverImage: "/assets/blog/ponggame/cover.png"
---

## About Pong Game

Pong Game was built as a 5-person team project for Transcendence, 42 Seoul's final assignment.

We ran the project from September 2023 through December 2023 — three months from start to finish.

For this assignment, we built a website for playing ping-pong games. We implemented login via the 42 OAuth API and real-time data communication over WebSockets, and built out chat and gameplay features on top of it.

## UI/UX Design

**[Pong Game Figma](https://www.figma.com/file/XLj9hhweYS8loExOuyHE3p/Transcendence?type=design&node-id=96%3A1101&mode=design&t=2iGru4oXqvZLQDfg-1m)**

Before building Pong Game, we started with UI/UX design. We used Figma to define the app's layout and color palette ahead of full-scale development.

To implement the assignment's spec, we designed the user profile page, friends page, chat page, and game page in Figma.

![main](/assets/blog/ponggame/main.png)

![play](/assets/blog/ponggame/play.png)

![user](/assets/blog/ponggame/user.png)

![dm](/assets/blog/ponggame/dm.png)

![game](/assets/blog/ponggame/game.png)

## Defining the API Endpoints and WebSocket Spec

**[Pong Game API endpoints](https://magnificent-front-23e.notion.site/e5948eb267e540c7b43dc99696232a80)**

**[Pong Game WebSocket spec](https://magnificent-front-23e.notion.site/504cbe61748b4a6290ace5cfafcd53a5?pvs=4)**

We then defined the API endpoints and WebSocket spec so the backend and frontend could communicate with each other.

## ER Diagram

![erdiagram](/assets/blog/ponggame/erdiagram.png)

We designed the DB schema for the backend to use.

Unlike direct messaging, channel-based chat doesn't create a separate table to persist chat messages.

## Tech Stack

From there, we split into frontend and backend work.

We used TypeScript throughout, with Next.js as the frontend framework and NestJS as the backend framework.
