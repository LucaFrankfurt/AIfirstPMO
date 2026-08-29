# Time tracking

Two ways in, one row out.

**Log it afterwards** — a duration, a day and a note — or **run a timer** and
stop it when you are done. Both live on the task, under **Time**.

## What a timer is

A row in the database with a `started_at` and no minutes yet.

That is the whole design, and it is what makes a timer behave the way people
expect it to: it survives a reload, it is still running when you open the app on
your phone, it keeps running through a tunnel, and if you forgot to stop it on
Friday you fix it by editing an entry rather than by losing the afternoon.

Stopping writes the minutes and clears the start. A timer that has run less than
a minute is stored as one — an entry of zero is a row that says nothing.

**One clock at a time, per person.** Starting a timer somewhere else stops the
one that was running, and says so before you press it. Two stopwatches on two
tasks is not a feature; it is something you find out about on Friday.

## What it takes as an amount

All of these are ninety minutes:

```
90     90m     1.5h     1,5h     1h30     1h 30m     1:30
```

A bare number is minutes, because the unit people leave off is the small one.
Anything with no number in it at all is refused rather than rounded to zero —
including over MCP, where a silent zero-minute entry would be worse.

## Where the totals are

| Where | What |
|---|---|
| A task | everything logged against it, by everyone, and the entries themselves |
| A project | the total and a line per person, under **Settings → Time** |
| MCP | `list_time`, narrowed by task, project, date range or `mine` |

A running clock counts towards the total while it runs. A number that jumps when
you press stop was wrong before you pressed it.

## Rates, and what an hour cost

A rate says what an hour is worth. Two kinds: **cost** — what the hour costs the
organisation — and **billable** — what it is charged at. Both rather than one,
because the interesting figure is the difference, and a single rate cannot
produce it.

### A rate is dated, and never edited

Changing a rate means adding one with a later `starts_on`. The old row stays.

This is the whole design and it is worth being blunt about why: a rate stored as
one current number means raising it in April silently rewrites what March cost.
Every report anybody exported stops matching the screen, and nothing announces
it. An hour is costed at whatever was in force **on the day the work happened**.

### Most specific wins

Four buckets, in one fixed order:

| | |
|---|---|
| 1 | this person, on this project |
| 2 | this person, anywhere |
| 3 | anybody, on this project |
| 4 | anybody, anywhere — the workspace's own |

So "Ada is more expensive on the client work" is one row, not a rate on every
project she is not on. Within a bucket, the latest one that has already started
is the one in force.

### Time no rate covers is unrated, not free

If nothing matches, the hour is **not** costed at zero. It is counted as
`unrated` and shown as its own figure, on every screen and in every tool.

An hour that costs nothing is not a saving; it is a rate nobody has set. This is
the same decision `unallocated` makes in budgets, and for the same reason: a
wrong number that looks like a real one is worse than an admitted gap.

### Revenue is billable time only

The `billable` flag on an entry is finally read, and this is what reads it. Cost
counts every hour; revenue counts only the billable ones. Margin is stated only
where both sides are known in the same currency — where one side is unknown
there is no margin to state, and stating one would mean treating an unknown cost
as nothing.

## The timesheet

`/timesheet` — a week at a time, a row per person or per project, a column per
day. All seven days, including the ones nobody logged against: a blank Thursday
is a fact about the week, and a sheet that hides its empty columns cannot be
scanned down.

The **Cost** tab is the same rows over months rather than days: cost, revenue,
margin and billable share, per project and per person.

## Utilisation, and the number this app will not invent

Two ratios go by that name and only one of them is answerable here.

**Billable share** — billable hours over hours logged — divides one recorded
figure by another and is always available.

**Billable over *available*** needs the hours somebody was contracted for, which
is an HR fact Kolibri does not hold. So the target is a number **whoever is
looking types in**, exactly as the team planner's comfortable load is. Leave it
empty and only the share is shown.

## Who can see money

Rates, and every figure derived from one, are **owners and admins only**.

A rate is close enough to somebody's pay to keep it to the people who set it —
and hiding a screen would not have been enough, because a project total is a
rate anybody can divide back out: one person on a project, and cost ÷ their
hours is exactly what they are paid.

So the line is drawn at the sync filter. A member's device never receives a rate
at all, which means their timesheet has no cost column rather than a cost column
reading zero. **Hours are not restricted** — a lead has to be able to add up a
project, which is why time was never private. Money is.

## What it is not

- **Not compared with the estimate.** `tasks.estimate` is in *points* — a guess
  at size, not at hours. Showing "3h of 5" against a 5-point task would be
  comparing two different things confidently. An estimate has to carry a unit
  before spent-versus-estimated can mean anything, and that is a decision about
  how a team plans rather than a formatting problem.
- **Not a submitted timesheet.** There *is* a week view — `/timesheet`, a row
  per person or per project and a column per day — and time is costed against
  hourly rates. What there is not is a submit button, an approval step or a
  lock: time is recorded, added up and costed, and who signs it off is a
  workflow Kolibri does not have.
- **Not billing.** Rates give what an hour cost and what it is charged at, so
  cost, revenue and margin are answerable. Turning that into an invoice —
  numbering, VAT, a document to send — is not here and is not planned.
- **Not compared with the estimate.** The one thing that genuinely is blocked,
  and by the paragraph above: `tasks.estimate` is in points.
- **Not private.** Anyone who can see the project can see the time logged
  against it — a lead has to be able to add up the project. Entries with no
  project are the writer's own loose time.

## Through MCP

```json
{ "name": "log_time", "arguments": { "task": "WEB-42", "amount": "1h30", "note": "review" } }
```

Defaults to today and to the token owner. Filing time under somebody else is a
timesheet-approval feature, so the server ignores a `user_id` a client sends and
uses the caller's.
