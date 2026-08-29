---
title: Infrastructure and vendors
description: What runs where, who you buy it from, what the estate looks like in six months, and the documented steps that get you there.
sidebar:
  order: 7
---

**Infrastructure** in the sidebar is a register of the estate: servers, the
instances running on them, SaaS subscriptions, and the suppliers behind all of
it.

It appears once an owner or admin switches it on under **Settings → Workspace**,
and not before. It works with or without [budgets](/planning/budgets/) — the two
meet only when both are on.

## The register

One row per thing. A machine, an instance on it, a subscription beside it.

Components **nest**: a server holds its instances, an account holds its seats.
Put a component "on" another and the register indents it underneath.

Each row carries what you would expect — a kind, an environment, who supplies
it, where it lives, what it is called on the network — and two dates that matter
more than any of that.

## The two dates, and why there is no "target architecture" document

This is the part worth reading properly, because it is not how these tools
usually work.

There is no *current landscape* page and no *future landscape* page. Instead
every component says **when it joined the estate** and **when it leaves**. The
landscape on any day falls out of those two dates.

So "what runs today" and "what runs next March" are the same screen asked twice.

The alternative — keeping a current list and a target list side by side — breaks
in ways everybody who has tried it recognises. The two drift apart. The target
goes stale the first time somebody decommissions a machine for real and updates
only one of them. And there is nowhere at all to put *"in June we will briefly
have both"*, which is what a migration actually looks like.

With dates, none of that happens. Nobody has to remember to move anything from
one list to the other. The day arrives and the picture is already right.

:::note
**Status is a label; the dates decide.** Marking something *planned* does not
put it in a future landscape — a date does. Status only answers where a date is
missing: something marked *retired* with no end date is treated as gone, and
something marked *live* with no start date as having always been here.
:::

### Something planned with no date is in no landscape

If you mark a component planned and give it no start date, it appears in
**neither** the present nor any future — there is nowhere honest to put it.

It is not quietly dropped. The form says so while you are filling it in, and the
landscape screen lists it above the comparison. A register that silently left
things out of both answers would stop describing the plan.

Give it a date and it takes its place.

## Comparing two days

The **Landscape** tab takes two dates and answers three things:

| | |
|---|---|
| **Gone by then** | running on the first day, not on the second |
| **Arrived by then** | not running on the first, running on the second |
| **In both** | untouched |

Beside them: what the estate costs a year on each day, and the difference. That
is usually the number the meeting turns on.

Costs are shown **per year**, and one-off purchases — a rack you bought rather
than rent — are counted separately rather than folded in. A year in which
somebody bought hardware is not a year in which the estate got permanently more
expensive.

Anything without a price is counted as **unpriced** rather than treated as free.
An unpriced component is a price nobody has filled in, not a saving.

## Moves

A **move** is a documented step from one landscape to the next: what it retires,
what it brings in, by when, and which project is doing the work.

Naming the components rather than describing the step in prose is what lets the
register check it. A move is finished when everything it retires has actually
gone and everything it brings in is actually live — so the progress bar is read
from the estate, not from the status somebody set.

Where the two disagree, the card says so:

> **The register disagrees with this status — check what is still running.**

A plan nobody executed reads exactly like one that was executed, right up until
something compares them. That comparison is the point of the tab.

## Vendors, and the date people miss

Each vendor carries a contract window and a **notice period in days**.

Those two together give the day you stop being able to leave — the contract's
end date minus the notice. That is the date renewals actually surprise people
on, and it is not one anybody can work out from a note. The vendors tab leads
with the contracts whose notice date falls in the next ninety days.

Each vendor also shows what their components cost you a year, added up from the
register.

## Costs and the budget

Charge a component to a budget line and the budget's **Plan** tab gains a
column: *the register says*.

Neither figure wins. One is a plan somebody wrote and the other is an inventory
of what exists, and the useful thing is being told when they have drifted apart
— "we budgeted €4,500 a month for hosting, and the machines charged to that line
add up to €5,200" is a sentence somebody does something about.

## What this is not

**Not discovery.** Nothing scans your network or reads your cloud account. Every
row is one somebody wrote down, which is why the register can be wrong — and why
comparing it against reality occasionally is worth doing.

**Not monitoring.** No health, no uptime, no alerts. A component being in the
landscape means somebody said it is there, not that anything checked.

**Not a full CMDB.** The only relationship is "runs on". There is no change
approval workflow and no configuration detail beyond what you type.
