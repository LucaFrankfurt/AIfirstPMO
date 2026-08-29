---
title: Budgets
description: What things cost, planned against what has actually gone — split across the projects that pay for it, with a forecast and what-if scenarios.
sidebar:
  order: 8
---

A budget is an envelope of money over a period: what you expect to spend, what has actually
gone, and what that means for the end of the year.

It is **off until somebody switches it on**. An owner or admin turns it on under **Settings →
Workspace**; until then there is no **Budgets** in the sidebar and no **Budget** tab on a
project. Switching it off again hides the screens and keeps every figure where it was.

## The four things

| | |
|---|---|
| **Budget** | The envelope. A name, a currency, a period, optionally an approved total. |
| **Cost** | One thing you plan to spend money on. The plan is the sum of these. |
| **Spend** | Money that has moved, or is committed and will. |
| **Scenario** | A what-if. It never changes the plan. |

## Plan a cost once, not twelve times

A cost carries an amount **per occurrence** and how often it repeats — one-off, monthly,
quarterly or yearly. Twelve months of hosting is one line, not twelve rows you have to keep
aligned when the price changes.

A quarter is counted from the cost's own start rather than from the calendar. A contract that
renews in February renews in February, not in January because that is when the calendar quarter
does.

Each cost also carries:

- a **category** — infrastructure, investment, people, licences, services, travel, training,
  contingency, other. A fixed list, because the whole point of a category is that two people
  writing down the same cost pick the same word, and a free-text box guarantees they will not:
  "AWS", "aws" and "Cloud" become three rows in every chart.
- a **kind** — a running cost, or money spent to build. Its own choice rather than guessed from
  the category, because a server is infrastructure whether you rent it monthly or buy it, and
  only you know which you did.
- a **confidence** — committed, likely or possible. Nothing is weighted automatically; how much
  of a maybe to carry is a judgement, and scenarios are where you make it.

## Who pays for it

This is the part that makes budgets worth having rather than a spreadsheet with a project
column.

A Kubernetes cluster is not *for* one project. It is 60% the platform rebuild and 40% everything
else — and both of those figures have to show up in both projects without the money being
counted twice.

So every cost can be **split across projects**, in percent. The split adds up to 100%; if it
does not, the screen says so and it is scaled when you save, because a cost that is 90%
allocated is 10% that has quietly left every per-project report while still counting in the
total.

The parts always add up to exactly the whole, down to the cent. Three projects splitting €10.00
comes to €10.00, not €9.99.

**Not splitting is allowed.** A cost with no split is *unallocated*, and it appears as its own
row in every breakdown rather than being charged to somebody. Inventing an owner for the office
coffee machine on the day you enter it is how a split stops meaning anything.

A recorded spend with no split of its own follows the cost it is filed against. That is almost
always what you want — an invoice for the cluster splits the way the cluster does — and it keeps
being right when you change the percentages later.

:::note
Who **pays** for a budget and who can **see** it are different questions. A budget is visible to
the workspace, or to one project, or to a chosen few — the same way a cycle is. A central
infrastructure budget is visible to everybody *and* charges 40% of itself to one team. Making
them one setting would mean either hiding a shared budget from the people paying for it, or
showing every project's figures to everybody.
:::

## Recording what has gone

Every spend carries a stage:

| | |
|---|---|
| **Committed** | Ordered. Nobody has invoiced it yet |
| **Invoiced** | Billed, not yet paid |
| **Paid** | Gone |

**Committed is the one that catches people out.** A purchase order raised against this quarter
is money you no longer have, and a report that counts only paid invoices says a budget is
healthy right up until the invoices land. So the headline "actual" here counts all three, and
"spent" — the narrower invoiced-plus-paid — is on the screen beside it.

You can record a spend against a planned cost, or against nothing at all. **Spend nobody planned
for is the most interesting row on the screen**, so it gets its own figure rather than being
filed under whichever line was closest.

## Closing a month in two presses

Twelve identical hosting bills a year is why the actuals in a budget stop being filled in around
April, and a budget nobody records against has a plan and nothing to compare it to. So the
actuals screen opens with **this month's plan and a button beside each line** — confirm one, or
confirm all of them at the figure the plan says.

What lands is an ordinary spend: same table, editable, deletable, nothing marking it as
machine-written. It takes the line's own day of the month (clamped, so a line that falls on the
31st lands on 28 February) and the amount of **one occurrence**, not the whole period.

A line that already has anything recorded against it that month is not offered again. The test
is "is there anything at all", not "does it add up" — a part invoice is a real thing, and a line
matched on totals would offer the rest as a fresh full-price row and book the cost one and a half
times. Under-recording shows up in the figures; a quiet double-book does not.

## The forecast

One rule, and it is worth knowing because every figure on the dashboard follows it:

> A month that has **finished** counts what actually happened. **This month and every month after
> it** count whichever is larger — what has happened, or what was planned.

That is the only version that neither charges this month twice when its invoice has already
arrived, nor loses it when it has not. It also means an overrun shows up in the month it
happens, rather than at the end of the year.

One consequence, stated plainly: a finished month in which nothing was recorded lowers the
forecast. That is on purpose — an underspend no report can show is worse than one you have to
explain — and it is what **committed** is for. Record the order when you place it and the
forecast knows about it before the bill does.

Beside the forecast is a **run rate**: what the period ends at if spending simply carries on as
it has. A second opinion, and worth reading when the two disagree.

## Scenarios

A scenario is a list of changes applied on the way to a total. It never edits the plan, which is
the whole point: *"what if the migration slips a quarter and we drop the training"* is something
to put on a screen on Tuesday and throw away on Wednesday, and the plan the team is working to
should survive both.

A change can apply to one cost, a whole category, or everything — which is what makes "cut all
travel by a third" one change rather than eleven. It can scale a figure, add to it, slip it by a
number of months, or drop it entirely. Changes apply in the order you write them: scaling and
then adding is not the same as adding and then scaling.

A scenario can also say **how much of each confidence level to carry** — all of the committed
money, half the likely, none of the maybes. That is the honest version of what every finance
spreadsheet does by hand, with the assumption written down instead of living in somebody's head.

Pressing **Show this scenario** redraws the dashboard under it, with a bar across the top so
nobody quotes a hypothetical figure by accident.

## Money, and the one thing it will not do

Amounts are typed however you write them — `4500`, `4.500,00`, `4,500.00`, `€4 500` are all the
same amount — and shown in your own language.

**One currency per budget, and nothing here converts.** An exchange rate is a fact about a day,
and a report that quietly picks today's to add up last year's is worse than one that declines to
add them. A portfolio spanning two currencies shows two totals, side by side.

## Where the figures are

| Where | What |
|---|---|
| **Budgets** in the sidebar | Every budget, totalled per currency, and what each project is charged across all of them |
| A budget | Dashboard, the plan, what has gone, scenarios, settings |
| A project → **Budget** | That project's share of every budget that charges it |
| An assistant | `list_budgets`, `budget_status`, `create_budget`, `add_budget_line`, `record_spend`, `confirm_planned`, `project_costs` — see [the assistant](/beyond/assistant/) |

Everything is worked out from rows as the screen draws, so the whole thing — charts included —
works offline, and an assistant answering a question cannot quote a different number from the
one in front of you.

## What it is not

**Not built on time tracking.** Estimates are in points and a logged hour has no rate, so a cost
derived from either would be invented. A planned cost carries its own money. See
[time tracking](/planning/time/).

**Not billing.** No invoices to send, no hourly rates, no VAT.

**Not accounting.** No ledger, no double entry, no period close. This is a view of money for
people running projects, not a finance system.

**Not an approval workflow.** A budget's status records that something was signed off; who may
sign it off, and a queue of things waiting, is a workflow Kolibri does not have.

**Not private.** Anybody who can see a project the budget covers can see the budget, its plan
and its invoices — the same rule the tasks and the logged time already follow.
