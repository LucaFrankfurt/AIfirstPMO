---
title: Bringing a backlog in
description: A CSV, or an export from Jira, Linear, Plane, OpenProject, Trello or Todoist — read by shape, previewed before anything is written.
sidebar:
  order: 4
---

*Project → Settings → Import from a file.* Pick a CSV, check what each column means, read the
summary, import.

**Nothing is written until the last step.** The preview is a real run against the server with the
writing switched off — the same code — so what it promises and what lands cannot drift apart.

## What it reads

Exports from Jira, Linear, Plane, OpenProject, Trello and Todoist are recognised by shape. Any
other CSV works too; the mapping is guessed from the header names, in English and German and in
the words those tools actually use:

| Field | Headers it recognises |
|---|---|
| Title | `Title` · `Summary` · `Subject` · `Name` · `Titel` · `Aufgabe` |
| Description | `Description` · `Details` · `Notes` · `Beschreibung` |
| State | `Status` · `State` · `Stage` · `Column` · `Zustand` |
| Type | `Type` · `Issue type` · `Work item type` · `Art` · `Vorgangsart` |
| Priority | `Priority` · `Severity` · `Priorität` |
| Assignee | `Assignee` · `Assigned to` · `Owner` · `Bearbeiter` |
| Labels | `Labels` · `Tags` · `Components` · `Schlagworte` |
| Due date | `Due` · `Due date` · `Deadline` · `End date` · `Fällig` |
| Estimate | `Estimate` · `Story points` · `Schätzung` · `Aufwand` |
| Original ID | `Key` · `Issue key` · `ID` · `Ticket` · `Nummer` |
| Parent | `Parent` · `Epic` · `Epic link` · `Übergeordnet` |
| Blocks / Blocked by | `Blocks` · `Blocked by` · `Depends on` · `Predecessor` |

Every guess is a dropdown you can change, and anything unmapped is ignored.

It copes with what real exports actually contain: semicolon separators from a German Excel, tabs
and pipes, quoted fields containing commas and newlines, a byte-order mark Excel writes and never
mentions, and short rows with the trailing empty columns left off.

## How values land

| | |
|---|---|
| **Priority** | `Highest`, `Blocker`, `Major`, `Trivial` and the German words all map onto Kolibri's five. Anything it cannot read is reported and the priority left alone |
| **State** | Matched by name against the project's workflow, case-insensitively. No match → the project's default state, and a line in the report |
| **Type** | An issue type from another tracker arrives as a **label**, matched against labels the project already has, so `Bug` lands on an existing `bug` rather than beside it |
| **Assignee** | By email, full name or first name. No match → unassigned, and a line in the report |
| **Labels** | Split on `,` `;` or `|`; existing ones reused, missing ones created once for the run |
| **Dates** | `2026-12-31` and `31.12.2026`. **`01/02/2026` is refused** — that is two different days in two different countries, and guessing wrong moves a deadline five weeks without saying so |
| **Original ID** | Appended to the description as *Imported from PROJ-417*, because that is what somebody searches for later |

Parents and blocking links are resolved on a **second pass**, once every row exists — so a file
where a child appears before its parent works.

## A row it cannot fully read

It imports it, and says what it could not read.

A row with a title and four unreadable columns is still a task somebody wanted; refusing the file
over it means the file gets fixed in a spreadsheet, which is exactly the work the import was
meant to avoid. Every problem names the **spreadsheet row number** — the header is row 1, as
Excel counts — and what it could not make sense of.

A row with no title is skipped, and that is also reported. A task without a title is nothing.

## Limits

- **5 000 rows** per file. More is refused rather than run for ten minutes behind a spinner.
- **No comments.** Parents and blockers come across; comments need the JSON format below.
- **One project at a time.** The target is the project you started from.
- **No undo button** — but an import is ordinary tasks. Filter to them, select them all, delete
  them together. And if you delete one too many, *Settings → Data* has it.
- **CSV only** from other tools. All of them export it.

## Moving between two Kolibri instances

*Project → Settings → Export as JSON* writes the project as a document, and *Import a JSON export*
reads it back. That round trip carries what CSV cannot: comments, relations, custom fields, cycles
and pages.

Two things it is not. It is **not a backup** — `kolibri backup` copies the database, which has to
be exact — and it is **not the way to duplicate a project inside one instance**, which is
*Copy this project*. See [across projects](/planning/portfolio/#copying-a-project).

If somebody in the export does not exist on the receiving instance, their work arrives unassigned
and the report names them.
