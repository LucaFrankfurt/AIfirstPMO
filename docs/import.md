# Importing a CSV

**Project → Settings → Import tasks.** Pick a file, check what each column
means, read the summary, import.

Nothing is written until the last step. The preview is a real run against the
server with the writing switched off — the same code, so what it promises and
what lands cannot drift apart.

## What it reads

It guesses the mapping from the header names, in both languages and in the
words the tools people are leaving actually use:

| Field | Headers it recognises |
|---|---|
| Title | `Title` · `Summary` (Jira) · `Subject` (OpenProject) · `Name` (Plane) · `Titel` · `Aufgabe` |
| Description | `Description` · `Details` · `Notes` · `Beschreibung` |
| State | `Status` · `State` · `Stage` · `Column` · `Zustand` |
| Priority | `Priority` · `Severity` · `Priorität` |
| Assignee | `Assignee` · `Assigned to` · `Owner` · `Bearbeiter` · `Zugewiesen` |
| Labels | `Labels` · `Tags` · `Components` · `Schlagworte` |
| Due date | `Due` · `Due date` · `Deadline` · `End date` · `Fällig` |
| Start date | `Start` · `Start date` · `Startdatum` |
| Estimate | `Estimate` · `Story points` · `Schätzung` · `Aufwand` |
| Original ID | `Key` · `Issue key` · `ID` · `Ticket` · `Nummer` |

Every guess is a dropdown you can change, and anything unmapped is ignored.
The first column to claim a field keeps it, so a file with both `Summary` and
`Name` does not end up titled by the second one.

## What it copes with

Real exports contain all of this, which is why the parser is written out rather
than pulled in:

- **Semicolons.** A German Excel writes `a;b;c`. A file that arrives as one
  enormous column is the most common "the import is broken", so the separator
  is detected — by which one gives a *consistent* column count, not by which
  occurs most, or a description full of commas would win.
- Tabs and pipes, for the same reason.
- **Quoted fields** containing commas, newlines and doubled `""`.
- **A byte-order mark**, which Excel writes and never mentions.
- **CRLF and lone CR** line endings.
- **Short rows.** Trailing empty columns are routinely left off; they are padded
  rather than rejected.

## Values

| | |
|---|---|
| **Priority** | `Highest`, `Blocker`, `Major`, `Trivial` and the German words all land on the five Kolibri has. Something it cannot read is reported and the priority left alone |
| **State** | matched by name against the project's own workflow, case-insensitively. No match → the project's default state, and a line in the report |
| **Assignee** | by email, full name or first name — the same handles a `@mention` accepts. No match → unassigned, and a line in the report |
| **Labels** | split on `,` `;` or `|`; existing ones are reused, missing ones created once for the whole run |
| **Dates** | `2026-12-31` and `31.12.2026`. **`01/02/2026` is refused** — that is two different days in two different countries, and guessing wrong moves a deadline five weeks without saying so |
| **Estimate** | a number, comma or point |
| **Original ID** | appended to the description as `Imported from PROJ-417`, because that is what somebody searches for later |

## What it does with a row it cannot fully read

It imports it, and says what it could not read.

A row with a title and four unreadable columns is still a task somebody wanted;
refusing the file over it means the file gets fixed in a spreadsheet, which is
exactly the work the import was supposed to avoid. Every problem names the
**spreadsheet row number** — the header is row 1, as Excel counts — and what it
could not make sense of.

A row with no title is skipped, and that is also reported. A task without a
title is nothing.

## Limits worth knowing

- **5 000 rows** per file. More than that is refused rather than run for ten
  minutes behind a spinner.
- **No sub-tasks, relations or comments.** A parent column would need the parents
  to exist first, which is a second pass this does not do yet.
- **One project at a time.** The target is the project you started from.
- **No undo button.** But an import is ordinary tasks: select them in the list
  and delete them together, which is why the multi-select landed first.
- **No Jira XML or JSON**, only CSV. Every one of the three exports CSV.
