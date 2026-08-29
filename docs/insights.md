# Insights

**Project → Insights.** Four numbers and four pictures, all worked out from the
tasks already on your device.

There is no endpoint behind this, no aggregation table and no nightly job. The
data was always there; nothing read it. That also means the charts work on a
train.

## What each one answers

| | |
|---|---|
| **Open / Finished / Typical time / Time logged** | The four numbers worth knowing before looking at anything else |
| **How much gets finished** | Tasks reaching a done state, per week, for twelve weeks. Steady beats spiky — a tall column after three empty ones usually means the work was finished long before it was marked |
| **Burn-up** | Two lines over the active cycle: everything in it, and everything finished. They meet when it is done. Scope climbing mid-cycle is work being added, which is worth seeing rather than hiding |
| **By label** | Where the tasks are, across the project's own words. A task may wear several, so the bars add up to more than the project has tasks |
| **Open work per person** | Unfinished tasks only. A task with two people on it counts for both, which is why the numbers can exceed the total |

**Typical time to finish is a median, not an average.** One task that sat in the
backlog for a year would drag a mean somewhere nobody recognises.

## How the charts are built

Hand-drawn SVG and CSS, no charting library — a chart you can read is worth more
than one you have to trust, and four pictures do not justify the kilobytes.

The rules they follow are not a matter of taste:

- **The colours were validated, not chosen.** `--chart-1` and `--chart-2` pass a
  categorical check for lightness band, chroma floor, colour-blind separation
  (protanopia and deuteranopia at full severity), a normal-vision separation
  floor, and contrast against the surface. Dark mode gets its own steps, checked
  against the dark surface — not an automatic flip of the light ones.
- **Colour is never the only channel.** Every chart has a legend where it has two
  series, direct labels on the ends, and **the same numbers as a table** one click
  below it.
- **A zero draws nothing.** A two-pixel stub for "nothing finished that week" is
  ink claiming there was some.
- **Labels are sparing.** The tallest column and the line ends carry values; a
  number on every point is chaos that goes unread. The rest is in the tooltip —
  which keyboard focus reaches too — and in the table.
- **One axis, always.** Two measures of different scale get two charts, never a
  second y-axis.

## What is not here

- **Nothing across projects.** A portfolio view is a different screen and a
  different question.
- **No forecasting.** The burn-up stops at today rather than drawing a flat line
  into the future, because a flat line into the future looks like a prediction and
  this is a record of what happened. The one screen that *does* draw a forecast is
  the budget burn chart, and it is allowed to because a plan is a number somebody
  wrote down in advance — there is no equivalent for "tasks that will be finished".
- **No money.** These charts count work, not spend. Money has its own screens —
  see [`budgets.md`](budgets.md) — and the two are deliberately not merged: one
  chart carrying tasks finished and euros spent would share an axis between two
  quantities that have no ratio. A **rate** is what would connect them, and there
  is not one.
- **No export.** The table view is copyable, and every underlying row is available
  over the REST API.
