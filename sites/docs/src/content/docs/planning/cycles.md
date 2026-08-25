---
title: Cycles
description: A fixed window with a set of tasks in it — what that buys you, and what it costs when the window closes with work still in it.
sidebar:
  order: 1
---

*Project → Cycles.* A cycle is a start date, an end date and the tasks that are in it. Sprint,
iteration, week — the word does not matter; the line around a promise does.

## Making one

**New cycle**, a name, two dates. Then put work in it: drag tasks in from the backlog, or filter
the task list to `cycle = none` and bulk-assign a selection.

One cycle per project is **active** at a time — the one whose dates contain today. That is what
the project header shows, what the burn-up chart draws, and what a new task created from inside
the project joins by default.

## What it gives you

| | |
|---|---|
| **Progress** | How many of the tasks in it are done, and how many points |
| **Burn-up** | Two lines over the cycle: everything in it, and everything finished. They meet when it is done |
| **A filter everything understands** | `cycle = "Sprint 14"`, on any layout, in any saved view |
| **A line in the past** | What was in the cycle, and what actually got finished in it |

The burn-up is a burn-*up*, not a burn-down, and the difference is the point: the top line is
scope. Scope climbing mid-cycle is work being added, which is worth seeing rather than hiding
under a falling line.

## What happens when a cycle ends

Nothing automatic. Kolibri does not roll unfinished work forward, close the cycle or nag you,
because every team's answer to *what happens to the three things we did not finish* is different
and a tool that picks one is a tool people fight.

What most teams do:

1. Filter the closing cycle to `is: open`.
2. Look at each one and decide: next cycle, back to the backlog, or it was never real.
3. Select the ones going forward and bulk-set the new cycle.

Three minutes, and the record of what the old cycle actually contained stays true.

:::caution
Moving unfinished work into the next cycle **changes the old cycle's history**: those tasks are
no longer in it. If keeping the record matters more than keeping the board tidy — and for a team
trying to work out why it keeps under-delivering, it does — leave them where they are and open
new tasks instead.
:::

## One cycle, several projects

A cycle normally belongs to one project. **Which projects run it** in the new-cycle form offers
two other answers:

- **Chosen projects** — tick the ones that are in it. Web and Mobile share a fortnight; Platform,
  on its own schedule, never sees it.
- **Every project** — the whole workspace, including projects made later.

Either way it is *one* cycle. That is the point: for a fortnight three teams genuinely share — one
planning meeting, one end date — three separate cycles with the same name drift apart within a
month, and each project then draws a burn-up of a thing nobody planned per project.

| | Just this project | Chosen projects | Every project |
|---|---|---|---|
| Appears in | Its project's Cycles tab | The Cycles tab of each one, chipped **2 projects** | Every project's Cycles tab, marked **Shared** |
| Work in it | That project's | Any of theirs | Any project's |
| Progress shown | Its own | The whole cycle's, on every tab — the same cycle showing different numbers depending on where you opened it would be worse | The whole cycle's |
| Deleting it | Affects one project | Takes it out of all of them | Takes it out of all of them |

**The scope is fixed when you create it**, in the interface. There is no dropdown to re-scope a
running cycle, because narrowing one silently strands the dropped projects' tasks — a change to
your data wearing the clothes of a setting. Make the new one and move the work.

An assistant *can* re-scope one over MCP, and it will tell you what it did: `update_cycle` returns
the tasks left in a cycle that no longer covers their project, by name, having moved none of them.

:::note
Exporting a project takes a shared cycle with it, and it arrives at the far end as an ordinary
cycle of the imported project. That is the truth there: the other projects that shared it are not
in the file.
:::

## Cycles and modules are different questions

A cycle answers *when*. A [module](/planning/modules/) answers *what is this part of*. A task
can be in both, and usually is: `Sprint 14` and `Payments v2`.

If you find yourself making a cycle called *Payments v2* and stretching its dates whenever the
work slips, that is a module trying to get out.

## Over MCP

`list_cycles`, `create_cycle`, `update_cycle` and `delete_cycle` are tools an assistant can use.
Combined with `project_status` and the `sprint_planning` prompt, "what did not get finished last
cycle and what is blocking it" is a question you can ask rather than a report you assemble. See
[connecting an assistant](/beyond/assistant/).
