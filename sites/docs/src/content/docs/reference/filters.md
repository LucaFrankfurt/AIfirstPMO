---
title: Filter language
description: The complete grammar for writing a view's filter as text — fields, operators, and the four things it deliberately cannot express.
sidebar:
  order: 3
---

The **Query** button beside the filter menu. It opens with the current filter already written
out, because a query language you have to learn before it shows you anything is one nobody
learns.

```text
assignee = me AND state != Done
priority in (urgent, high) AND due = overdue
project = WEB AND label in (design, ops)
is: open AND cycle = none
```

## Fields

| Field | Also spelled | Values |
|---|---|---|
| `state` | `status` | A state's name |
| `type` | `kind` | A work-item type |
| `is` | `group` | `backlog` `unstarted` `started` `completed` `cancelled`, or `done` / `open` |
| `priority` | `p` | `urgent` `high` `medium` `low` `none` |
| `assignee` | `assigned` | A name, an email address, or `me` |
| `label` | `tag` | A label's name |
| `cycle` | `sprint` | A cycle's name |
| `module` | `milestone` | A module's name |
| `project` | | A key or a name |
| `due` | | `overdue` `today` `week` `none` |
| `text` | `title`, `summary` | Anything |

## Operators

| | |
|---|---|
| `=` `:` | is |
| `!=` | is not |
| `in (a, b)` | is one of |
| `not in (a, b)` | is none of |
| `~` | contains — text only |

## Joining clauses

Clauses join with `AND`, and **writing it is optional**: `state = Todo priority = urgent` works.

A **bare word with no operator is a text search**, which is what somebody typing into a filter
box means nine times in ten.

`none` — or `empty`, or `nobody` — is the empty answer. `assignee = none` is the unassigned ones.

## What it deliberately cannot do

A filter is a conjunction of *is one of* and *is not one of*. That is what a saved view stores,
what the board reads, what a share link resolves and what the calendar feed queries — so the
language is exactly that and no more.

**`OR` between two different fields.** `assignee = me OR priority = urgent` cannot be a saved
view. The error says so and suggests the form that works: several answers to *one* field,
`priority in (urgent, high)`.

**A date comparison.** `due < 2026-09-01` is not one of the four buckets a view holds.
`due < today` and `due <= 7d` are accepted as ways of writing `overdue` and `week`, because those
are what people type meaning them.

**Sorting.** `ORDER BY` is a separate control on the view.

**Custom fields.** They are named by an id, and `field.7f3a… = x` is text nobody can read or
retype. A filter containing them keeps them untouched and the box says so, rather than pretending
the query you can see is the whole picture. Use the menus for those.

## Errors are the feature

A query language whose failure mode is *returns nothing* is one people stare at for five minutes.
So an unresolvable name is an **error with the word in it** — *No state here is called "Dnoe"* —
and **the clauses that did parse are still applied**.

The unresolved clause is kept rather than dropped, because a filter that quietly widens is worse
than one that matches nothing and says which word is wrong.

## It prints back

Whatever the dropdowns did prints into the box, and whatever you type comes back out as the same
dropdown state. The two can never disagree.

The printed form is **canonical**: the same filter always prints the same text regardless of the
order it was built in — which is what makes one of these worth pasting into a page, and worth
diffing against last week's.
