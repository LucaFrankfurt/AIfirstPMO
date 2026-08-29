# Budgets

What things cost, planned against what has actually gone — and, because a
platform team's costs are never one project's, **split across the projects that
pay for them**.

Off by default. A workspace admin switches budgets on under **Settings →
Workspace**; until then there is no sidebar entry, no project tab, and MCP
refuses to write. Turning them off again hides the screens and keeps the rows.

## The shape of it

| | |
|---|---|
| **Budget** | An envelope of money over a period. A name, a currency, a period, optionally an approved total, and a scope. |
| **Line** | One planned cost inside it — the plan is the sum of these, and no total is stored anywhere. |
| **Actual** | Money that has moved, or is committed and will. |
| **Scenario** | A what-if applied on the way to a total. It never edits the plan. |

## Money is an integer

Every amount is stored as a whole number of **minor units**: `1250` in a budget
whose currency is `EUR` is €12.50.

Not a style preference. `0.1 + 0.2` is not `0.3` in any language with IEEE
doubles, and a budget is a column of numbers that gets added up thousands of
times and then compared to another column that was added up differently. A cent
of drift is a reconciliation somebody does by hand. Integers cannot drift.

The conversion happens at the two edges only — reading what somebody typed, and
writing what they read. In between, nothing sees a decimal point.

What the box accepts, all as €1,234.56:

```
1234.56    1.234,56    1,234.56    1234,56    €1 234.56
```

Whichever of `.` or `,` comes last is the decimal one, because that is true in
every convention that uses both. A lone separator with exactly three digits
after it is a thousands group — `1,234` is one thousand two hundred and
thirty-four, not one and a bit — which is the one case position cannot settle,
and the one people would otherwise be out by a factor of a thousand on.

**One currency per budget, and nothing converts.** A rate is a fact about a day;
a report that silently picks today's to add up last year's is worse than one
that declines to add them. Two currencies in a portfolio are two totals.

## A cost is planned once

`amount` is **per occurrence**, and `recurrence` says how often. Twelve months
of hosting is one line, not twelve rows somebody has to keep aligned:

| `recurrence` | What it means |
|---|---|
| `once` | The amount, in the month the line's window opens |
| `monthly` | The amount every month of the window |
| `quarterly` | Every third month, counted **from the line's own start** |
| `yearly` | Every twelfth month, likewise |

A quarter is counted from the line rather than from the calendar: a contract
that renews in February renews in February, not in January because that is when
the calendar quarter does.

Months outside the budget's period are dropped. A line running past the end of
the budget is planning next year's money, and adding it to this year's total is
how a budget looks overspent from the day it is written.

**So the period decides how much of a recurring line is planned**, and a budget
that has not been given one still has one:

| Dates given | Period |
|---|---|
| Start and end | Exactly those, swapped if they were typed backwards |
| Start only | **Twelve months from the start** |
| End only | The twelve months up to it |
| Neither | Twelve months from this one |

An open end means a year rather than the month it starts in, and that is worth
stating because the other answer shipped first. A budget with a start and no
end — which is what the form produces unless the second date is filled in —
covered one single month, so twelve monthly hosting lines were planned one
month's worth each and every month but one fell outside the period. Nothing
said so: no error, no warning, just a plan total an order of magnitude under
the real one. It was reported as *"I cannot take the plan across for other
months"*, which is exactly what it looks like from the outside.

A year, rather than "up to today", because a budget is an annual instrument
almost everywhere and because the total should not change merely because a
month went by — these figures get quoted. Costs that run longer are said with
an end date, and the form now says that is what the empty field means.

## Categories, and the two words that are not the same

`category` is a fixed list — infrastructure, investment, people, licences,
services, travel, training, contingency, other — because the whole point of a
category is that two people writing down the same cost pick the same word, and a
text box guarantees they will not: "AWS", "aws", "Cloud" and "Infrastruktur"
are four rows in every chart that groups by it.

`kind` is `opex` or `capex` — money spent to run, or money spent to build. It is
its own field rather than inferred from the category, because a server is
infrastructure whether it is rented by the month or bought outright, and only
the team knows which they did.

`contingency` is in the list because a budget without one will be wrong, and a
PMO that hides its buffer inside the other lines cannot answer how much of it is
left.

## Who pays for it

This is the part that makes a budget tracker different from a spreadsheet with a
project column.

A Kubernetes cluster is not "for" one project. It is 60% the platform rebuild
and 40% everything else, and both of those numbers have to appear in both
projects' figures **without the money being counted twice**.

So a line carries `allocations`: a list of `{project_id, share}` where the shares
are basis points summing to 10000. On screen they are percentages, because
nobody types 6000 meaning 60%. Underneath they are integers, for the reason the
amount is: three projects splitting a cost equally is 3333 + 3333 + 3334, which
is exact, whereas a third three times is not.

Splitting an amount uses largest-remainder, which is the only method that both
keeps each project's share as close as possible to its proportion **and**
guarantees the parts add up to the whole. Naive rounding does neither: three
projects splitting €10.00 comes to €9.99 or €10.02 depending on which way the
third rounds, and a portfolio report two cents out is one somebody stops
trusting.

**An empty split is not "nobody".** It is *unallocated* — a real and common
state, shown as its own row in every breakdown rather than quietly charged to
somebody. Forcing an owner for the office coffee machine on the day it is
entered is how allocations become fiction.

An **actual** with no split of its own follows its line's. That is the useful
default by a wide margin — an invoice for the cluster splits the way the cluster
does — and it keeps meaning the right thing when the percentages change, which a
copy taken at entry time would not.

**Who pays is not who can see.** Visibility is the budget's `project_id` /
`projects` scope, exactly as a cycle's is: one project's own, the whole
workspace, or exactly some projects. A central infrastructure budget is
workspace-wide, so everybody sees it, and still charges 40% of itself to one
team's project. Making them one field would mean either hiding a shared budget
from the people paying for it, or showing every project's figures to everybody.

## Plan against actual

An actual carries a `stage`:

| | |
|---|---|
| `committed` | A purchase order nobody has invoiced yet |
| `invoiced` | Billed, not yet paid |
| `paid` | Gone |

**Committed is the one that ruins a month.** A purchase order raised against
this quarter's budget is money you no longer have, and a report counting only
paid invoices says a budget is healthy right up until the invoices arrive. So
`actual` here means committed + invoiced + paid; `spent` is the narrower
invoiced + paid, and both are on the screen.

`line_id` is nullable on purpose. An invoice nobody planned for is the most
interesting row in the system, and a model that forced every actual to name a
plan line would have people filing it under whichever line was closest — which
is how a budget report stops describing reality. Unplanned spend has its own
figure.

## Taking the plan across

The recurring half of a budget is almost all of it — twelve identical hosting
bills a year, four quarterly ones, a licence renewal — and typing the same four
fields twelve times is why the actuals in a budget stop being filled in around
April. A budget nobody records against has a plan and nothing to compare it
to, which is a worse failure than any the forecast rules guard against.

So the actuals screen opens with the month's plan and a button per line. A
confirmed row is an ordinary actual in every respect: same shape, same table,
editable and deletable like any other. Nothing marks it as machine-written,
because nothing about it is less true — somebody looked at the plan and said
yes.

Three decisions worth naming:

- **The amount is one occurrence, not the period.** A monthly line confirmed
  in August records August's figure, not the year's.
- **The date is the line's own day of month**, carried across and clamped to
  the month's length — a line starting 31 January lands on 28 February.
- **A line with anything already recorded that month is not offered again.**
  The test is "is there anything at all", not "does the total match": a part
  invoice is a real thing, and a line matched on totals would offer the
  remainder as a fresh full-price row and book the cost one and a half times.
  Under-recording shows up in the figures; a silent double-book does not.

The allocations are left empty on purpose, which means *follow the line* — so
a plan line resplit between projects in November also resplits everything
confirmed against it, instead of leaving each month frozen at the split that
was current when somebody pressed the button.

`confirm_planned` does the same thing over MCP, and takes `dry_run` so a model
can show the list before writing it.

## The forecast

One rule, applied everywhere:

> A month that has **closed** contributes what actually happened. **This month
> and every month after it** contribute whichever is larger — what has happened,
> or what was planned.

The rule exists because the two obvious definitions disagree. "Actuals to date
plus the remaining plan" counts this month twice when its invoice has already
landed; "actuals plus the plan for months after this one" loses this month's
bill entirely when it has not. Taking the larger of the two for an open month
does neither: it shows an overrun the month it happens and never charges for it
twice.

The tile and the burn chart read the same loop, so the number at the end of the
curve is the number on the tile, by construction.

It follows that a closed month where nothing was recorded lowers the forecast.
That is deliberate — an underspend no report can show is worse than one somebody
has to explain — and `committed` is how a bill that has not arrived yet gets
counted before it does.

Beside it is a **run rate**: what has gone, scaled by how much of the period is
left. A second opinion, and worth attention when the two disagree.

## Scenarios

A scenario is a list of adjustments applied on the way to a total. It never
touches a line, which is the whole point: "what if the migration slips a quarter
and we drop the training" is something to show a steering committee on Tuesday
and throw away on Wednesday, and the plan the team is working to should survive
both.

An adjustment names one line, or a whole category, or everything — which is what
makes "cut all travel by a third" one adjustment rather than eleven. It can
scale, add, slip by whole months, or drop the line entirely. They apply **in the
order they are written**: a factor then a delta is not the same as a delta then
a factor, and a scenario has to mean what it reads like.

Then there are weights. Every line carries a `confidence` — `committed`,
`likely` or `possible` — and a scenario can say how much of each to carry. That
is the honest version of the thing every finance spreadsheet does by hand: all
of the signed money, half of the likely, none of the maybes, with the numbers
written down instead of in somebody's head.

Nothing weights automatically. How much of a maybe to carry is a judgement, not
a fact about the data.

## Where the figures are

| Where | What |
|---|---|
| `/budgets` | Every budget, totalled per currency, with what each project is charged across all of them |
| A budget | Dashboard, plan, actuals, scenarios, settings |
| A project → **Budget** | That project's share of every budget that charges it |
| MCP | `list_budgets`, `budget_status`, `create_budget`, `add_budget_line`, `record_spend`, `project_costs` |

Every one of those reads the same `rollUp` in `@kolibri/shared`, computed from
rows on demand. No endpoint, no aggregation table, no nightly job — so the
dashboard works on a train, and an assistant answering over MCP and a person
looking at the screen cannot be told two different numbers. Two implementations
of "how much of a quarterly line falls inside this period" would have differed
by one occurrence about a quarter of the time.

## Through MCP

```json
{ "name": "add_budget_line", "arguments": {
    "budget": "Platform 2026", "name": "Kubernetes cluster",
    "amount": "4.500,00", "category": "infrastructure",
    "recurrence": "monthly", "allocations": { "WEB": 60, "OPS": 40 } } }
```

Amounts go in as text in any of the shapes above, and come back **twice** —
`variance` in minor units to compute with and `variance_text` already formatted
to quote — because a model asked for a figure will otherwise pick whichever it
sees first, and one of the two readings is out by a factor of a hundred.

A split naming a project that does not exist is refused rather than dropped: a
split that quietly loses one of its halves charges the whole cost to the other,
which is a wrong number nobody would think to question.

## What it is not

- **Not the same as the infrastructure register.** A budget line is what you
  *plan* to spend; a component in [the register](infrastructure.md) is a thing
  that exists and costs money. A component can name the line it is charged to,
  and the Plan tab then shows the two figures beside each other — but neither
  overwrites the other, because a plan and an inventory disagreeing is
  information rather than an error.
- **Not derived from time tracking.** `tasks.estimate` is in points and a time
  entry has no rate, so a cost computed from either would be invented. A budget
  line carries its own money. Rates and cost-per-hour are still the open
  question they were.
- **Not multi-currency.** One currency per budget and no conversion anywhere.
  A portfolio spanning two shows two totals.
- **Not an approval workflow.** `status` records that something was signed off;
  who may sign it off, and the queue of things waiting to be, is a workflow
  Kolibri does not have.
- **Not private.** Anyone who can see a project a budget covers can see the
  budget, its plan and its invoices — the same rule the tasks and the time
  already follow. A budget scoped to a private project stays out of the list,
  the row, the pull, the search index and MCP.
- **Not accounting.** There is no ledger, no double entry, no VAT and no period
  close. This is a PMO's view of money, not a finance system's.
