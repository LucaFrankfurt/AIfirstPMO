---
title: Making a task
description: Seven ways a task gets into Kolibri, and the one-line syntax that does most of the work.
sidebar:
  order: 1
---

Press <kbd>C</kbd> anywhere, or the **+** button. That is the answer nine times in ten.

## One line is the whole task

The quick-add box reads the line as you type it. Everything except the words is optional, and the
order does not matter:

```text
Redraw the empty state !high @ada #WEB *design due:friday
```

| You type | It means |
|---|---|
| `!urgent` `!high` `!medium` `!low` — or `!1` … `!4` | Priority. `!1` is the urgent end |
| `@ada` `@"Ada Lovelace"` `@me` | Assignee. Repeatable |
| `#WEB` `#"Public API"` | Project, by key or by name |
| `*design` `*"needs research"` | Label. Repeatable |
| `due:friday` `due:tomorrow` `due:2026-09-04` `due:+3d` | Due date |
| `every:weekly` `every:2w` `repeat:monthly` | Repeat |

Underneath the box, what it understood shows up as chips. Nothing is ever applied invisibly, and
the tokens stay in the line so you can delete one and watch the chip go.

Two behaviours are worth knowing before they surprise you:

**A weekday always means the next one.** `due:friday` typed on a Friday is *next* Friday.
Somebody typing the name of today's day means the one coming — otherwise they would have typed
`due:today`.

**A token nothing answers to stays in the title.** `!important` is a word; `!urgent` is a
priority. The difference is whether your workspace has something by that name, not whether the
token starts with a sigil. `@nobody`, `#hashtag` and `*asterisk` all stay in the title as
written. And an ambiguous `@alex`, where two people are called Alex, matches **neither** —
quietly assigning work to the wrong Alex is worse than not assigning it.

The words in `due:` and `every:` work in all three languages: `due:freitag`, `every:wöchentlich`,
`due:demain`.

:::tip
The full table, including the relative offsets and what happens over MCP, is in
[the quick-add reference](/reference/quick-add/).
:::

## The other six ways

**From the board.** Every column on a Kanban board has an add button at its foot, which creates
the task already in that state. On the list and table layouts the same thing sits at the end of
each group — so adding to a group grouped by assignee assigns it.

**From a template.** *Settings → Templates & rules*, or the template picker in the quick-add
sheet. A template is a task written in advance: title, description, priority and a checklist that
becomes real sub-tasks. See [task templates](/automation/templates/).

**By a rule.** Something happens — a task enters review, a due date is three days out — and a
task is filed automatically, addressed to whoever the rule names. See [rules](/automation/rules/).

**By importing.** *Project → Settings → Import from a file* reads a CSV, and also reads exports from
Jira, Linear, Plane, OpenProject, Trello and Todoist by shape. Nothing is written until you have
seen the preview. See [bringing a backlog in](/beyond/import/).

**From outside, with no account.** An intake link is a form. What arrives waits in a queue and
becomes a task only when somebody accepts it, so nothing from outside lands on the board on its
own. See [intake forms](/people/intake/).

**By an assistant.** An MCP client with a write-scoped token can file tasks, including in
batches — where the whole batch is one transaction, so it either all lands or none of it does.
See [connecting an assistant](/beyond/assistant/).

## What a new task gets by default

| | |
|---|---|
| Identifier | The project key and the next number. Never reused, even if the task is deleted |
| State | The project's default state — usually the first in the backlog or todo group |
| Priority | None. Not "medium": an unset priority and a deliberate medium are different claims |
| Assignee | Nobody, unless you said otherwise or you added it into a group that implies one |
| Cycle | The active cycle, if you created it from inside one; otherwise none |

## Sub-tasks

Open a task and use **Add sub-task**, or drag an existing task onto another in the list layout.

A sub-task is a *whole task* — its own identifier, its own state, its own place on the board, its
own assignee. That is a deliberate difference from tools where a sub-task is a checkbox: it means
sub-tasks show up in searches and reports, and it means a sub-task can outlive its parent's
sprint.

If what you want really is a checklist, put it in the description as markdown checkboxes, or use
a [template](/automation/templates/) — a template's checklist becomes sub-tasks precisely when
you want the heavier thing.
