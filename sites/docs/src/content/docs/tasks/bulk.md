---
title: Changing many at once
description: Select several tasks and edit, move, archive or delete them together — and what to do when the change is bigger than a selection.
sidebar:
  order: 5
---

Click the checkbox in front of a task, or hold <kbd>Shift</kbd> and click a second one to take
the range. A bar appears at the foot of the screen with what you can do to the lot.

## What you can change together

| | |
|---|---|
| State | Moves them all to one workflow state |
| Priority | |
| Assignee | Adds, replaces or clears |
| Labels | Adds or removes, rather than replacing — so a bulk *add* does not wipe what each already had |
| Cycle | Including out of one, which is how you clean up at the end of a sprint |
| Module | |
| Project | Re-keys every one of them; see [the task itself](/tasks/detail/#moving-a-task-to-another-project) |
| Archive | |
| Delete | To the trash, which means it is undoable |

Selection survives scrolling and re-grouping, so you can select four things on a board, regroup
by assignee and still have them.

## Dragging instead of selecting

On a board, dragging a card between columns sets its state. If the board is grouped by something
else, dragging writes *that* instead — group by assignee and a drag reassigns; group by a
*Select* custom field and a drag writes the answer to that field. The column you drop into is
always the value being written, whatever the grouping happens to be.

That is worth remembering the first time you regroup a board and drag out of habit.

## When the change is bigger than a selection

**A whole backlog arriving** — [import it](/beyond/import/). The preview is a real run with the
writing switched off, so what it promises and what lands cannot differ.

**Undoing an import** — there is no undo button, but an import is ordinary tasks: filter to
them, select them all and delete them together. And if you delete one too many,
*Settings → Data* has it.

**Moving a project to another instance** — *Project → Settings → Export as JSON* writes a round
trip that another Kolibri reads, including comments, which the CSV path cannot carry. It is not a
backup: `kolibri backup` copies the database, which has to be exact.

**Asking an assistant** — an MCP client can do this too, and `create_tasks_batch` is one
transaction: the whole batch lands or none of it does. "Move everything labelled `legacy` that
is still open into the icebox cycle" is a sentence, and something that speaks
[MCP](/beyond/assistant/) can carry it out against the same permissions you have.
