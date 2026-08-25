---
title: How it is put together
description: Workspaces, teams, projects, tasks, cycles, modules and pages — what nests inside what, and which of them you can safely ignore.
sidebar:
  order: 3
---

Seven words do most of the work in this app. Here is what each one holds.

```
workspace
├── teams                  who owns what
├── projects               ── may nest inside another project
│   ├── tasks              ── may have sub-tasks, and relations to any other task
│   ├── cycles             a fixed window of time
│   ├── modules            a milestone, which may span several cycles
│   ├── states + labels    the project's own workflow and vocabulary
│   ├── custom fields      questions asked of every task in the project
│   └── pages              
├── pages                  a nested wiki, workspace-wide or attached to a project
└── chat                   channels, and direct messages that belong to nobody
```

## Workspace

The outer container. Everything except a direct message belongs to exactly one, and nothing can
reference across the boundary — a task in one workspace cannot be labelled with a label from
another, and the server enforces that rather than trusting the interface.

You can be a member of several and switch between them from the bottom of the sidebar. Most
people only ever have one.

## Team

A group of people who own some projects. Teams are how you say "the design team's work" without
listing four names, and rules can address a whole team as a recipient.

Optional. A small workspace can put everybody in nothing and lose nothing.

## Project

Where the work is. A project has:

- **A key** — two to five letters. Every task in it is `KEY-1`, `KEY-2`, forever, and the number
  is never reused.
- **Its own workflow states**, grouped into backlog, todo, in progress, done and cancelled. The
  *names* are yours; the five groups are what the rest of the app reasons about, which is how
  "show me everything open" works across projects that call their columns different things.
- **Its own labels**, its own custom fields, its own pages, its own cycles and modules.

**Projects nest.** Drag one onto another in the sidebar and it lives inside it; fold a branch to
get it out of the way. A project marked as a **container** holds only other projects and has no
board of its own — that is how you model a programme without inventing a fake backlog for it.

## Task

The unit. Full detail is in [the task itself](/tasks/detail/); the shape is:

- One **project**, one **state**, zero or more **assignees** and **labels**.
- Optionally a **parent** task, which is what makes it a sub-task.
- Optionally **relations** to any other task, in any project: *blocks*, *is blocked by*,
  *relates to*, *duplicates*.
- Optionally a **cycle** and a **module**.

A sub-task is a real task with its own identifier and its own place on the board. It is not a
checklist item.

## Cycle

A fixed window — a sprint, if that is the word your team uses. It has a start, an end, and a set
of tasks that were in it. Progress, the burn-up chart and the "what did we actually finish"
question all read from that.

One cycle is active at a time per project. [Cycles](/planning/cycles/).

## Module

A milestone. Unlike a cycle it is not a window of time you fill — it is an outcome that may take
three cycles or half of one. A task can be in a cycle and a module at once, and they answer
different questions: *when are we doing it* and *what is it part of*.
[Modules](/planning/modules/).

## Page

Markdown, nested to any depth, either at workspace level or attached to a project. Two people can
type in one at the same time and both keep their words. Every save is a version you can read,
compare and put back. [Pages](/pages/).

## Chat

Channels belong to the workspace or to a project. A **direct** conversation belongs to nowhere —
its identity is the two people in it, which is what lets both of them open it while offline and
end up in the same room rather than two half-rooms. Three or more people is a private channel
with a name, not a bigger direct message. [Chat](/people/chat/).

## What you can ignore

Most workspaces never create a team, never create a module, and never use a custom field. None
of those are load-bearing — a project with tasks, states and a cycle is a complete way to use
this app, and every other noun above is there for the moment you actually feel its absence.
