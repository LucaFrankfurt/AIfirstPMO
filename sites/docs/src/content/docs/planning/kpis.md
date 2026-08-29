---
title: KPIs
description: Numbers you have undertaken to watch, what they have to reach, and by which milestone — with staleness as a state of its own.
sidebar:
  order: 10
---

A KPI here is a number somebody has undertaken to move: uptime, churn, lead time, NPS. You
define it, you record what it reads, and you say what it has to reach and by when.

It is **off until somebody switches it on**. An owner or admin turns it on under **Settings →
Workspace**; until then there is no **KPIs** in the sidebar.

## The three things

| | |
|---|---|
| **The KPI** | What is measured: a name, a unit, how precise, which way is better, and how often you have undertaken to measure it |
| **A reading** | One measurement — a day, a value, and where the number came from |
| **A target** | What it has to reach, and by when — or by which milestone |

## You type the numbers in

Kolibri does not scrape your monitoring or query your warehouse. The figures a team actually
reports on come from systems that are not this one, so readings are entered by hand or posted
by an assistant over MCP.

That is a real cost, and the cadence field is what pays it back. **You say how often you will
measure**, and a reading older than twice that is reported as *stale* rather than quoted as
current — because "we're at 94 %" from a number nobody has refreshed since March is not a
statement about today.

## What "on track" means here

Not "close to the target". A KPI is on track when it has come **further than the days have**:
past a straight line drawn from where it started to where it has to be by the deadline.

- **On track** — at or past that line
- **At risk** — behind the line, but still on the right side of where it started
- **Off track** — it has gone the wrong way

Both figures are on the screen — how far it has come, and where the line says it should be by
now — so you can show the reasoning instead of asserting the colour. There is no hidden
tolerance band.

### Three answers that are not judgements

| | |
|---|---|
| **Not measured** | Nobody has taken a reading. Nothing can be on track |
| **No target** | It is measured, but nobody has said what it should be |
| **Stale** | The last reading is more than twice the cadence old |

These are counted in their own right on the KPI list, and they sort into the middle rather than
at either end. A KPI nobody has measured is not a crisis and it is not fine, and a dashboard
that shows it as green by leaving it out is the thing this is built to refuse. **Stale outranks
on track**: a number nobody has refreshed is not evidence, however good it looks.

## A target due by a milestone

Give a target a milestone instead of a date and it takes **that milestone's date, live**.

This is the point of the link. The promise was "90 % by the time we ship", not "90 % by 30
June" — so when the release slips a month, the target slips with it instead of becoming a
miss. The milestone's own page reads the same link backwards and lists what has to be *true*
by the time it lands, beside what has to be *built*.

Deleting a milestone leaves its targets standing, undated: cancelling a release does not cancel
the promise. Deleting a KPI does take its readings and targets with it.

## Several targets are a ladder

"85 % by June, 90 % by December" is two targets, not one you edited. The one in force is the
next one still ahead; once they have all passed, the last one stands — you do not stop having a
target because the date went by, you have one you are late for.

## Reading the chart

Two things about it are deliberate and worth knowing:

- **The gaps are real.** Readings sit where they were taken, so three months without a
  measurement look like three months without a measurement.
- **The scale does not start at zero**, and both ends of it are printed beside the plot. A
  percentage moving between 90 and 100 drawn from zero is a flat line at the top and tells you
  nothing.

The measured line is a neutral colour on purpose. Half of all KPIs are better when the line
falls, so a green line climbing would be a picture arguing with itself.

## Where the figures are

| Where | What |
|---|---|
| **KPIs** in the sidebar | Every one, worst first, with the current value, the change, the target and the pace |
| A KPI | The chart, its readings, its targets, and its settings |
| A milestone | What has to be true by the time it lands |
| An assistant | `list_kpis`, `kpi_status`, `create_kpi`, `record_measurement`, `set_kpi_target` — see [the assistant](/beyond/assistant/) |

## What it is not

- **Not OKRs.** No objectives above these, no grouping into key results, no scoring.
- **Not alerting.** Nothing emails anybody when a KPI turns red.
- **Not a band.** A KPI is better going up or better going down. A target with a floor *and* a
  ceiling would need a second figure on every target and every screen, and is written down as a
  limit rather than half-built.
