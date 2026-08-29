---
title: What Kolibri is
description: A project and work management tool that keeps working offline, runs on one small server, and treats an assistant as a member of the team.
sidebar:
  order: 1
---

Kolibri tracks work: tasks on boards, sprints, milestones, a wiki, and the conversation around
all of it. If you have used Jira, Linear, Plane or OpenProject, nothing on the surface will
surprise you.

Three things underneath are different, and they are the reason the surface behaves the way it
does.

## It reads from your device, not from a server

Every screen is drawn from a full copy of the workspace held in your browser. Filtering a board
of two thousand tasks is not a request; grouping them by assignee is not a request; opening a
task is not a request. There is no spinner because there is nothing to wait for.

The same mechanism is what makes the app work with no connection at all. Changes you make go
into a queue and are sent when there is something to send them to — from a train, from a plane,
from a hotel that wants your email address before it will route a packet.

When two people changed the same task while apart, Kolibri merges **field by field**: one person
changing the title and another changing the priority both keep their change, rather than the
later save flattening the earlier one. A page body is merged differently again — character by
character, so two people typing in the same paragraph both keep their sentences.

:::note
The details, including the cases where merging *does* have to pick a winner, are in
[working offline](/beyond/offline/).
:::

## It is one process and one file

The whole server is a single Node process with a SQLite database beside it. No Postgres, no
Redis, no queue worker, no search cluster. That is not a limitation you are working around — it
is why an instance can live on the smallest virtual machine a host sells, why a backup is a file
you can copy, and why upgrading is pulling an image.

For you as a user this shows up in one place: things are fast, and the instance is unlikely to be
down.

## An assistant is a first-class user

Kolibri speaks the Model Context Protocol natively. An AI client — Claude, or anything else that
speaks MCP — can be pointed at your instance and given a token, and from then on it can list
projects, read the backlog, file tasks, move them through the workflow, write pages and log
time. Not by driving a browser, and not through a scraped API: through tools the server exposes
on purpose.

What it may do is exactly what the token says. A token issued with read-only scope is refused by
every tool that writes, so handing an assistant a view of the backlog does not hand it a pen.

## What is in it

| | |
|---|---|
| [Tasks](/tasks/) | Sub-tasks, blocking relations, priorities, estimates, labels, due dates, assignees, custom fields, attachments, comments |
| [Views](/views/) | List, board, table and calendar over the same work, grouped and filtered however you like, saved under a name and shared |
| [Planning](/planning/cycles/) | Cycles, modules, a timeline where dragging a task moves what it blocks, baselines, work-in-progress limits, four charts per project |
| [Budgets](/planning/budgets/) | What things cost, planned against what has gone, split across the projects that pay for it, with a forecast and what-if scenarios |
| [Pages](/pages/) | A nested markdown wiki two people can edit at once, with version history, comments and read-only share links |
| [Automation](/automation/templates/) | Templates, repeating tasks, and rules that file work when something happens |
| [People](/people/chat/) | Chat, an in-app inbox with optional email, push and Telegram, intake forms for people with no account |
| [Elsewhere](/beyond/calendar/) | A calendar subscription, CSV and JSON import, an assistant over MCP, a REST API and webhooks |

Three languages throughout — English, German and French — including the emails, each written in
the recipient's own.

## What it is not

Being clear about this is cheaper for everybody than finding out in month two.

- **It is not a timesheet system.** Time is recorded and added up; there is no week view, no
  submit and no approval step. See [time tracking](/planning/time/).
- **There is no billing.** [Budgets](/planning/budgets/) exist — what was planned against what
  has actually gone, split across the projects that pay for it — but nothing turns hours into
  money: entries carry a `billable` flag that nothing reads, there are no hourly rates, and
  there are no invoices to send.
- **There is no forecasting.** The burn-up chart stops at today rather than drawing a line into
  the future, because a line into the future looks like a promise.
- **Estimates are in points, not hours,** and are deliberately never compared with logged time.
- **Documents are markdown pages, not a document editor.** No page layout, no tables of contents
  generated across a space, no PDF authoring — though any page prints.
- **There is no email-in.** You cannot file a task by writing to an address. A commit message
  can reach a task; an email cannot.
