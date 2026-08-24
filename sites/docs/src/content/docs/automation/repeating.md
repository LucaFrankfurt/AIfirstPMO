---
title: Repeating tasks
description: A task that files its successor when it is finished — not when the date passes, which is the difference that matters.
sidebar:
  order: 2
---

Set **Repeats** on a task, or type it into the quick-add line:

```text
Water the build server *ops every:weekly
```

| | |
|---|---|
| Once | The default — it does not repeat |
| Every day | |
| Every week | |
| Every two weeks | |
| Every month | |

## The next one is created when this one is finished

Not when the date passes. That is the single decision worth understanding about this feature,
and it is the opposite of how a calendar behaves.

A weekly task you have not done does **not** quietly accumulate five copies of itself while you
were away. There is one, still open, still overdue, still saying the true thing: this has not
been done. Closing it creates the next one, dated a week on.

The failure mode this avoids is the one everybody has met — a recurring task in some other tool
that has spawned eleven instances, ten of which are noise, and the eleventh of which nobody can
distinguish from the ten.

The trade-off is real and worth stating: **if you never close it, it never recurs.** A repeating
task is a rhythm, not a reminder. If what you want is *tell me on the first of the month
regardless*, that is a [rule](/automation/rules/) with a due-date trigger, not a repeat.

## What carries over

The new task gets the title, description, project, labels, priority, estimate, assignees and
custom-field answers of the one that closed. It gets a new identifier, a fresh due date one
interval on, and no comments, no sub-tasks and no attachments — those belonged to the instance,
not to the rhythm.

If a repeating task's sub-tasks are the point, make it a [template](/automation/templates/) filed
by a rule instead.
