---
title: Time tracking
description: Log a duration or run a timer that survives a reload — what the totals mean, and the four things this is deliberately not.
sidebar:
  order: 5
---

Two ways in, one row out. On any task, under **Time**: log a duration afterwards, or start a
timer and stop it when you are done.

## What it accepts as an amount

All of these are ninety minutes:

```text
90     90m     1.5h     1,5h     1h30     1h 30m     1:30
```

A bare number is **minutes**, because the unit people leave off is the small one. Anything with
no number in it at all is refused rather than rounded to zero.

An entry carries a duration, a day and an optional note.

## The timer

Start it and it is a row in the database with a start time and no minutes yet. That is the whole
design, and it is what makes it behave the way people expect:

- It survives a reload.
- It is still running when you open the app on your phone.
- It keeps running through a tunnel.
- If you forgot to stop it on Friday, you fix it by editing an entry rather than by losing the
  afternoon.

**One clock at a time, per person.** Starting a timer somewhere else stops the one that was
running, and says so before you press it. Two stopwatches on two tasks is not a feature; it is
something you find out about on Friday.

A timer that has run less than a minute is stored as one minute. An entry of zero is a row that
says nothing.

## Where the totals are

| | |
|---|---|
| **A task** | Everything logged against it, by everyone, and the entries themselves |
| **A project** | The total and a line per person, under *Settings → Time* |
| **Insights** | *Time logged* is one of the four numbers |

A running clock counts towards the total while it runs. A number that jumps when you press stop
was wrong before you pressed it.

## Four things it is not

**Not compared with the estimate.** `Estimate` is in points — a guess at size, not at hours.
Showing "3h of 5" against a five-point task would be comparing two different things
confidently.

**Not money.** Every entry carries a `billable` flag, stored and synced, and nothing reads it
yet. [Budgets](/planning/budgets/) do exist, but deliberately not through this: a budget line
carries its own money, so a cost never has to be inferred from an estimate in points. What is
missing is an hourly **rate** — the piece that would turn a logged hour into a figure — and
nothing here invents one.

**Not a timesheet.** No week view, no submit, no approval. Time is recorded and added up; who
signs it off is a workflow Kolibri does not have.

**Not private.** Anybody who can see the project can see the time logged against it — a lead has
to be able to add up a project. Entries with no project attached are the writer's own loose
time.

## Over MCP

```json
{ "name": "log_time", "arguments": { "task": "WEB-42", "amount": "1h30", "note": "review" } }
```

Defaults to today and to whoever owns the token. Filing time under somebody *else* is a
timesheet-approval feature, so the server ignores a user id a client sends and uses the
caller's. `list_time` reads it back, narrowed by task, project, date range or just yours.
