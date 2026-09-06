---
title: "OASIS Project"
description: "A project to plan, build, and ship a cryptocurrency auto-trading program. Built a desktop app with Electron, an auto-trading engine with Node.js and the Upbit API, and a frontend in React."
pubDatetime: 2022-09-01T01:00:00
tags: ["oasis", "electron", "react", "typescript"]
coverImage: "/assets/blog/oasis/cover.jpg"
---

## About OASIS

The OASIS Project plans, builds, and ships a cryptocurrency auto-trading program.

**[Visit the OASIS landing page](http://oasisbot24.com)**

Planning began in September 2022, and as of writing (Feb. 2023) it's still ongoing. I named the customer-facing crypto auto-trading program "OASIS BOT" and owned everything from defining its required features, to UI/UX design, to building OASIS BOT itself and its landing page. I'm responsible for all service development and technical management within the project.

As of writing (Feb. 2023), the business has been formally registered, and we've raised roughly 100 million KRW to launch a beta service. We plan to validate OASIS BOT through the beta and keep iterating on it toward a full release.

**[Visit the OASIS BOT beta service](https://github.com/DeveloperRyou/oasis/releases/)**

## UI/UX Design

Working on the OASIS Project, I felt that UI/UX was an area existing crypto auto-trading programs handled poorly, and set out to improve it. For a desktop application, I decided a dashboard-style layout would serve the user experience well. Before diving into development, I used Figma to define the app's layout and color palette.

![Dashboard](/assets/blog/oasis/dashboard.png)

![oasisbot](/assets/blog/oasis/oasisbot.png)

**[Check out the Figma file](https://www.figma.com/file/XQozaVMLzNJ5LxA8byEkqO/Trade-Bot?node-id=1%3A1096&t=OPtk0MpLLQTDUT7e-1)**

## OASIS BOT

I decided to build OASIS BOT as a desktop application. While researching what to build it with, I realized I could build a desktop app using web technologies I already knew well. Electron made that possible — it's the same framework behind software like Discord, Slack, and Skype. I paired Electron with TypeScript to catch unexpected errors early across such a large implementation.

In Electron's main process, I used Node.js with TypeScript to implement the core auto-trading logic. Using interfaces and classes for an object-oriented approach kept the codebase maintainable as it grew.

In Electron's renderer process, I used React with TypeScript to render the screens designed in Figma inside the app. The main process supplies the data OASIS BOT needs, and the renderer process uses React state to render that data to the screen.
