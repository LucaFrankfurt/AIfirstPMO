---
title: Rules
description: When something happens to a task, file work for the people who need to know — addressed by role rather than by name, and unable to run away.
sidebar:
  order: 3
---

*Settings → Templates & rules.* A rule watches for one thing happening and files a
[template](/automation/templates/) for you.

The one everybody wants: **when a task enters review, ask somebody for feedback.** Every new
project starts with exactly that, switched on.

## What a rule is made of

| | |
|---|---|
| **Scope** | One project, or the whole workspace so every project behaves the same |
| **When** | A task enters a named state · a task enters a state *group* · a task is created · a task is due in *n* days · a page is edited · somebody comments |
| **What it does** | File a task from a template, or change the priority of the task it watched |
| **File this** | Which template |
| **Give it to** | A list of selectors — see below |
| **How many** | One task with everybody on it, or one task each |
| **Link back** | *relates to*, *blocks*, … or nothing |
| **At most once** | Off by default, so a second review round asks again |
| **Also apply to generated tasks** | Off by default, so a rule cannot feed itself |

## Who gets it

Recipients are **selectors, not names**. A rule that says *whoever leads the project* keeps
meaning that after the lead changes; a stored name does not.

| Selector | Resolves to |
|---|---|
| A named person | Exactly them |
| Whoever is on the task | The source task's assignees |
| Whoever created the task | Its author |
| Whoever triggered it | The person whose change fired the rule |
| The project lead | The target project's lead |
| Everyone in a team | That team's members |
| Everyone with a role | Everybody who is owner, admin or member |

Several combine and the result is de-duplicated, so *the lead and the design team* is one rule,
not two. Two things then narrow it:

- **Skip whoever triggered it** — on by default, because you rarely review your own work. Asking
  for the actor *explicitly* wins over this, so the two settings cannot contradict each other.
- **Anyone who cannot see the project the task lands in is dropped.** A rule is not a way around
  a private project.

If nobody is left, the rule files nothing and **says so in its log**, rather than creating a
ticket nobody is on. On a one-person workspace the seeded review rule therefore does nothing at
all, correctly, and the log explains it.

## Placeholders

A template's title and description may refer to the task that triggered the rule:

| | |
|---|---|
| `{identifier}` | `WEB-42` |
| `{title}` | The source task's title |
| `{project}` | Its project's name |
| `{actor}` | Who caused the trigger |
| `{state}` | The state it entered |
| `{url}` | A link straight to it |

Anything else is left as written rather than turned into a hole.

## The log

Every decision a rule makes is written down, **including the decisions to do nothing**, under
**Log** beside the rule:

| It says | It means |
|---|---|
| *filed WEB-43* | It worked |
| *nobody to give it to* | Every selector resolved to nobody, or to people who cannot see the project |
| *already done for this task* | *At most once* is on and it has run before |
| *that task came from a rule* | The trigger was a generated task |
| *the template is gone* | Somebody deleted it |

This is the first place to look when a rule seems quiet. It is almost always the second row.

## Why it cannot run away

Three guards, because a rule engine that files tasks about its own tasks is worse than no rule
engine:

1. Tasks a rule created are **recognisable**, and rules skip them unless you deliberately turn
   *also apply to generated tasks* on.
2. A **depth counter stops any chain at three**, even if you do turn that on.
3. *Entering in progress* fires only when the **group** actually changes, so moving a task
   between two different in-progress states is not entering it a second time.

## Two limits worth knowing

**Rules run on the server.** A change you make offline fires its rule when your device syncs, not
before — so a feedback task appears a moment after the board move reaches the server, not on the
device that made it.

**A rule can change the task it watched, but only its priority.** Setting the state is
deliberately not offered: a rule that moves a task can trigger a rule that moves it back, and two
rules editing one row is a merge problem rather than a feature.

:::tip[The due-date trigger is a clock]
*Due in n days* is swept once a day and records the day it ran, so restarting the server does not
re-fire it. *Skip whoever triggered it* does not apply — nobody did — because excluding the actor
there would exclude the task's creator, usually the only recipient such a rule has.
:::
