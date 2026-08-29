---
title: Timesheet and cost
description: A week of logged time laid out day by day, hourly rates that are dated rather than current, and what work cost against what it is charged at.
sidebar:
  order: 6
---

**Timesheet** in the sidebar shows a week of logged time: a row per person or
per project, a column per day.

All seven days are there, including the ones nobody logged against. A blank
Thursday is a fact about the week, and a sheet that hides its empty columns
cannot be read down. Use the arrows for another week, or **This week** to come
back.

It appears once [time tracking](/planning/time/) is switched on, and not before.

## Rates

A rate says what an hour is worth. There are two kinds and you will usually want
both:

| | |
|---|---|
| **What it costs** | What the hour costs you |
| **What it is charged at** | What you invoice for it |

Two rather than one, because the interesting number is the difference. A team
that bills nobody sets only the first and still gets a cost report.

Rates live under **Settings → Rates**.

### Changing a rate never changes the past

You do not edit a rate. You add one that starts on a day, and the old one stays
in the list, greyed, with the new one marked **In force**.

That is deliberate, and it is the single most important thing on this page. If a
rate were one current number, raising it in April would silently restate what
March cost — every report anybody had exported would stop matching the screen,
and nothing would say so. An hour is costed at whatever was in force **the day
the work happened**.

The old rows are also the answer to "why is March eighty and April ninety",
which is a question somebody will ask.

### The most specific rate wins

You can set a rate for everybody, for one person, for one project, or for one
person on one project. When several could apply, the most specific one does:

1. this person, on this project
2. this person, anywhere
3. anybody, on this project
4. anybody, anywhere

So "Ada is more expensive on the client work" is one row. You do not have to set
a rate on every project she is *not* on.

### Hours no rate covers are not free

If nothing matches an hour, it is not costed at zero. It is counted as
**unrated** and shown as its own figure beside the cost.

An hour that costs nothing is not a saving — it is a rate nobody has set, and
the number that would hide that is worse than the gap.

## The cost tab

The same time over months rather than days: cost, revenue and margin, per
project and per person, with the billable share beside it.

Revenue counts **billable hours only** — a flag on each time entry, which is
what that flag has always been for. Margin appears only where both the cost and
the charge are known in the same currency; where one side is missing there is no
margin to state.

## Utilisation

Two things go by that name, and only one of them can be answered honestly here.

**Billable share** — billable hours divided by hours logged — is two recorded
numbers and is always shown.

**Billable over hours available** needs to know what somebody was contracted
for, and Kolibri does not know that. So **Available hours** is a box you fill
in, and the ratio appears once you do. Leave it empty and you get the share
alone. It works the way the [team planner](/planning/portfolio/)'s comfortable
load does: a judgement the reader supplies rather than a fact invented from the
data.

## Who can see the money

Rates, and every figure worked out from one, are visible to **owners and
administrators only**.

A rate sits close enough to somebody's pay that it stays with the people who set
it. Hiding the screen would not have been enough: a project total is a rate
anybody can divide back out, and with one person on a project the division is
exact. So members simply never receive rates at all, and their timesheet has no
cost column rather than a cost column full of zeroes.

**Hours are not restricted.** Anybody who can see a project can see the time
logged against it — a lead has to be able to add up a project, which is why time
was never private in the first place. Money is the part that is.

## What this is not

**Not a submitted timesheet.** There is no submit button, no approval step and
no lock on a past week. Time is recorded, added up and costed; signing it off is
a workflow Kolibri does not have.

**Not invoicing.** No numbering, no VAT, no document to send.

**Not compared with estimates.** Estimates are in points — a guess at size, not
at hours — so "3h of 5" would be comparing two different things confidently.
