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

## What it is not

- **Not compared with the estimate.** `tasks.estimate` is in *points* — a guess
  at size, not at hours. Showing "3h of 5" against a 5-point task would be
  comparing two different things confidently. An estimate has to carry a unit
  before spent-versus-estimated can mean anything, and that is a decision about
  how a team plans rather than a formatting problem.
- **Not money.** There is a `billable` flag on every entry, stored and synced,
  and nothing reads it yet. Budgets *do* exist — see [`budgets.md`](budgets.md) —
  but they are deliberately not derived from this: a budget line carries its own
  money, precisely so that a cost never has to be inferred from an estimate in
  points. What is still missing is a **rate**, which is the piece that would turn
  an hour into a figure. Nothing here invents one.
- **Not a timesheet.** There is no week view, no submit, no approval. Time is
  recorded and added up; who signs it off is a workflow Kolibri does not have.
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
