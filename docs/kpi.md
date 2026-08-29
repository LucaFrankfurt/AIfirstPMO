# KPIs

Numbers somebody has undertaken to watch, what they have to reach, and by which
milestone. Off by default; switched on per workspace under **Settings →
Workspace**.

The shape is the budget's, deliberately: a definition, a list of things that
actually happened, and one pure function that compares them. If you have read
[`budgets.md`](budgets.md), you already know how this works.

## The shape of it

| | |
|---|---|
| **KPI** | What is measured. A name, a unit, a scale, which way is better, how often it is measured, and optionally where it started. Scoped like a budget: one project, several, or the workspace |
| **Reading** | One measurement: a day, a value, and where the number came from |
| **Target** | What it has to reach, and by when — or by which milestone |

## It is not a query over your tasks

The obvious design is to compute KPIs from the rows already in here: tasks
closed, cycles completed, time logged. It was rejected, and the reason is worth
stating because it looks like a missing feature.

The numbers a PMO actually reports on are **uptime, churn, NPS, revenue per
seat, headcount, lead time out of a system that is not this one**. A KPI feature
that could only measure what happened to be in this database would cover almost
none of them, and the half it did cover would quietly become the half that gets
reported — which is how a team ends up steering by whatever was easy to count.

So a KPI is a definition, and readings are typed in or posted over MCP. What
this costs is honesty about staleness, which is why `cadence` exists.

## Values are integers, like money

A value is stored as a whole number scaled by the KPI's own `decimals`: 99.95
with `decimals: 2` is `9995`. The reason is the one money has — `0.1 + 0.2` is
not `0.3`, and these figures are averaged over readings and compared against a
target somebody will argue about. `parseMeasure` and `formatMeasure` are the
only two places a decimal point exists.

`decimals` is therefore the one field that cannot be changed lightly. It is not
a display preference: it is the exponent every value on the KPI is scaled by, so
changing it moves the decimal point on every reading and target at once. The
form says so where it is chosen, and the server clamps it to 0–4.

`unit` is about **shape**, not meaning: `percent` puts a sign after the figure,
`duration` reads minutes as hours and minutes with the timesheet's own function,
`number` takes whatever word you put in `unit_label`. There is no `currency`
member — money already has a system here, with an amount, a code and one
currency per container, and a second half-built one whose totals cannot be added
to the first is worse than a link to a budget.

## Which way is better, and only two answers

`direction` is `up` or `down`. A KPI that has to land inside a **band** — a
stock level, a response time with a floor as well as a ceiling — needs a second
bound on every target, and every screen would then carry a second figure for the
sake of a case that is rare here. It is written down as a limit rather than
half-built.

Direction never appears in the progress arithmetic. Progress is *distance
travelled toward the target*, which is the same sum whether the number should
rise or fall: churn at 5% aiming for 2%, now at 3%, is two thirds of the way
there. Only the trend arrow needs to know, and it is the one place that does.

## The six states, and the three that are not judgements

`health` is one rule, applied in this order:

1. **`no_data`** — nothing has been measured. Nothing can be on track.
2. **`stale`** — the last reading is older than **twice** the cadence. This
   outranks being on track on purpose: a KPI is the one figure that looks
   equally confident whether it was taken this morning or in March, and "we are
   at 94%" from a number nobody has refreshed in two quarters is not a claim
   about today. A stale reading that happens to be past its target is not
   evidence of anything.
3. **`no_target`** — measured, but nobody has said what it should be.
4. Otherwise, compare where it is against **where a straight line from the
   baseline to the target says it should be today**:
   - at or past that line → **`on_track`**
   - behind the line, but on the right side of the baseline → **`at_risk`**
   - on the wrong side of the baseline → **`off_track`**

The line is the whole of the judgement. There is no "within 10%" fudge factor,
because a threshold nobody can derive is a threshold every reader has to be told.
Both figures — how far it has come and where the line says it should be — are on
the screen and in the MCP answer, so the reasoning can be quoted rather than
asserted.

**The first three are the point.** They are the states a dashboard usually
paints green by omission, and each of them is the more useful answer than a
colour. They are counted in the summary row alongside the judgements, and they
sort into the middle of the list rather than either end: not measured is not a
crisis, and it is not fine either.

## A target due by a milestone

A target can name a `module_id` instead of a date, and then it takes **the
milestone's date, live** — not a copy made when somebody linked them.

That is the whole reason the link is a link. The sentence was never "90% by 30
June"; it was "90% by the time we ship". A milestone that slips a month drags
its targets with it, and a copied date would have turned every slip into a
missed target.

The milestone page reads the same link from the other end: *what has to be true
by the time this lands*. A milestone is usually described by what gets built,
and this is the list of what has to be so.

**Deleting a milestone does not delete the targets due by it.** They stay,
undated, because cancelling a release does not cancel the promise. Deleting a
*KPI* does take its readings and targets with it — unlike an invoice, a
measurement of a metric nobody keeps is not independent evidence of anything.
The two cascades go opposite ways on purpose and both are tested.

## Several targets are a ladder

"85% by June, 90% by December" is two targets, not one that was edited. The one
in force is **the earliest still ahead**; once they have all passed, the last one
stands — a KPI does not stop having a target because the date went by, it has one
it is now late for. A target with no date at all is a destination without a
deadline, which is a real thing and sorts last.

## The chart, and two decisions in it

- **The x axis is time**, not an index. Readings arrive when somebody takes
  them, and spacing them evenly would draw a steady climb across a three-month
  gap where nothing was known. A gap should look like a gap.
- **The y axis does not start at zero, and says so.** A percentage moving
  between 90 and 100 charted from zero is a flat line at the top. The scale is
  fitted to what is on the chart and both ends of it are printed beside the
  plot, because a truncated axis that does not announce itself is the oldest way
  to make a small change look enormous.
- **The measured line is neutral, not green.** Half the KPIs in a workspace are
  better when the line falls, so a green line climbing would say "good" in
  colour while saying "worse" in shape. The verdict is carried by the chip, the
  pace bar and the sentence above the chart.

## Through MCP

```json
{ "name": "set_kpi_target", "arguments": {
    "kpi": "Uptime", "value": "99.9", "milestone": "Public launch" } }
```

Every figure comes back twice — the integer to compute with and the text to
quote — because a model asked for a number picks whichever it sees first, and
here the two differ by a factor of ten to the `decimals`. `kpi_status` returns
`achieved_pct` and `expected_pct` separately so the judgement can be shown, and
`age_days` beside the value so a quote can be dated.

Every KPI tool is refused with `KPIs is switched off in this workspace` until an
admin turns the feature on.

## Who sees a number

The same three-state scope as a budget: one project's own follows that project,
one with no owner and no list is the workspace's, one with a list follows any
project on it. Unlike a rate, this is **not** restricted by role — a number the
team has undertaken to move is a number the team should be able to see, and a
target everybody is working toward and nobody may read is a target in name only.

## What it is not

- **Not a metrics pipeline.** Nothing here scrapes Prometheus or queries a
  warehouse. Readings are entered by a person or posted by an assistant over
  MCP. Automating that is an integration per source, and it is not started.
- **Not OKRs.** There are no objectives above these, no key-result grouping and
  no scoring. A KPI here is one number with one direction.
- **Not a band.** See `direction` above.
- **Not alerting.** Nothing emails anybody when a KPI goes red. The states are
  computed on read; wiring them to notifications would need a schedule and a
  rule language, and neither exists yet.
