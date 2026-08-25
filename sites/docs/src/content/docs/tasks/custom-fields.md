---
title: Custom fields
description: Nine kinds of question a project can ask of every task in it, and which of them a board can group by.
sidebar:
  order: 3
---

*Project → Settings → Fields.* A field you add there is asked of **every** task in that project,
from then on and retroactively — existing tasks show it empty rather than not showing it.

That default is the design. A field that some tasks have and others do not is a field you cannot
group a board by, cannot filter reliably, and cannot read a report off. If only some of the work
needs the question, that is usually a sign the answer wants to be a label.

The one narrowing offered is by **work item type**: limit a field to one type and only that kind
of task is asked for it. Use it for a question that genuinely only applies to bugs, or only to
research — not as a way to avoid deciding whether the question is worth asking.

## The nine kinds

| Kind | Holds | Group a board by it? |
|---|---|---|
| **Text** | One line | no |
| **Long text** | A paragraph | no |
| **Number** | A number | no |
| **Select** | One of a list you define | **yes** |
| **Multi-select** | Any number from a list you define | **yes** |
| **Date** | A day | no |
| **Checkbox** | Yes or no | **yes** |
| **URL** | A link | no |
| **Person** | A member of the workspace | **yes** |

Each is one input somebody already knows how to use, and each has an obvious empty value. There
is deliberately no formula field and no rollup — those are a different feature wearing the same
word, and the honest answer is that they are not built.

## Grouping by one

The four marked above can be a board's columns. That is where custom fields stop being metadata
and start being a workflow: group by a *Select* field called **Environment**, and the board is
staging / production / both, with **dropping a card into a column writing the answer**.

The rest can be filtered and sorted on, and shown as a column in the table layout.

## Filtering on them

The filter menus handle custom fields like any other field. The text
[filter language](/reference/filters/) deliberately does **not** — a custom field is named by an
id, and `field.7f3a1c… = staging` is text nobody can read or retype. A filter that contains
custom-field clauses keeps them untouched when you edit the text, and the box says so rather
than pretending the query you can see is the whole picture.

## When to use one, and when not

Reach for a custom field when the answer is:

- **the same question for every task** — *Which customer? Which environment? Needs legal review?*
- **something you will group, filter or count by**, rather than something you will read.

Reach for a **label** when it is a topic rather than an answer, when only some tasks have it,
and when you want people to add new values without an admin. Reach for the **description** when
it is prose and nobody is going to filter on it.

The failure mode worth naming: a project with fourteen custom fields where four are filled in.
Every one of them is asked of every task, on every screen, forever.
