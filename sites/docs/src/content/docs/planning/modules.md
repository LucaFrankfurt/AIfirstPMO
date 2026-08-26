---
title: Modules
description: A milestone that outlives a sprint — what it is for, and the one rule that keeps it from becoming a second backlog.
sidebar:
  order: 2
---

*Project → Modules.* A module is a named outcome with tasks in it. Unlike a
[cycle](/planning/cycles/), it is not a window of time you fill — it is a thing that is either
finished or not, and it may take three cycles or half of one.

Milestone, epic, initiative, release. Same idea.

## When you want one

- The work has a **shape somebody outside the team asks about**: *is Payments v2 done?*
- The work **spans cycles**, so a cycle cannot answer for it.
- You want a **progress number for an outcome** rather than for a fortnight.

## When you do not

If every task in the project is in exactly one module and the modules are called *January*,
*February*, *March* — those are cycles. If the modules are called *Frontend*, *Backend*,
*Infra* — those are labels. A module that nobody would describe as *finished* is not a
milestone, and it will quietly turn into a second, worse backlog.

## What it gives you

| | |
|---|---|
| **Progress** | Done over total, in tasks and in points |
| **A filter** | `module = "Payments v2"` anywhere, including in a saved view |
| **A row on the timeline** | Its tasks drawn together, with its own bar |
| **A row on the portfolio roadmap** | Which is where a module earns its keep — see [across projects](/planning/portfolio/) |
| **Tools an assistant can call** | `list_modules`, `create_module`, `update_module`, `delete_module`, and `module` on `list_tasks` and `update_task` — see [connecting an assistant](/beyond/assistant/) |

## One module, several projects

A module normally belongs to one project. **Which projects work on it**, beside the name box, offers
two other answers:

- **Chosen projects** — tick the ones that are in it. A launch the API, the app and the website are
  all working towards is one milestone, not three with the same name.
- **Every project** — the whole workspace, including projects made later.

| | Just this project | Chosen projects | Every project |
|---|---|---|---|
| Appears in | Its project's Modules tab | The tab of each one, chipped **2 projects** | Every project's tab, marked **Shared** |
| Work in it | That project's | Any of theirs | Any project's |
| Progress | Its own | The whole milestone's, everywhere — one module showing different numbers depending on where you opened it would be worse | The whole milestone's |
| Deleting it | Affects one project | Takes it out of all of them | Takes it out of all of them |

A task that moves between two projects the module covers **stays in it**. That is the point of a
shared milestone: the work moved, the thing it is part of did not.

**The scope is fixed when you create it**, in the interface, because narrowing a running milestone
strands the dropped projects' work inside it. An assistant can re-scope one over MCP with
`update_module`, and it tells you what it stranded — by name, having moved nothing.

## A task in both

A task can be in a cycle and a module at once, and that is the normal case. *Sprint 14* says
when somebody is doing it; *Payments v2* says what it is part of. Filtering on one does not
disturb the other, and the two progress numbers answer two different questions that people
routinely confuse:

- The **cycle** number is *are we going to finish what we said we would this fortnight*.
- The **module** number is *are we going to finish this thing at all*.

A cycle at 90% and a module at 20% is a completely normal and completely healthy Tuesday.
