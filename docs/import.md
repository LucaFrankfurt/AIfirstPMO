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
| Type | `Type` · `Issue type` · `Work item type` · `Art` · `Vorgangsart` |
| Priority | `Priority` · `Severity` · `Priorität` |
| Assignee | `Assignee` · `Assigned to` · `Owner` · `Bearbeiter` · `Zugewiesen` |
| Labels | `Labels` · `Tags` · `Components` · `Schlagworte` |
| Due date | `Due` · `Due date` · `Deadline` · `End date` · `Fällig` |
| Start date | `Start` · `Start date` · `Startdatum` |
| Estimate | `Estimate` · `Story points` · `Schätzung` · `Aufwand` |
| Original ID | `Key` · `Issue key` · `ID` · `Ticket` · `Nummer` |
| Parent | `Parent` · `Epic` · `Epic link` · `Übergeordnet` |
| Blocks | `Blocks` · `Successor` · `Blockiert` |
| Blocked by | `Blocked by` · `Depends on` · `Predecessor` · `Blockiert von` |

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
| **Type** | an issue type from another tracker arrives as a label — Kolibri has one way of saying what sort of thing a task is. Matched case-insensitively against the labels the project already has, so `Bug` lands on an existing `bug` rather than beside it |
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
- **No comments.** Parents and blocking links *are* read, on a second pass once
  every row exists (see below); comments need the JSON format.
- **One project at a time.** The target is the project you started from.
- **No undo button.** But an import is ordinary tasks: select them in the list
  and delete them together, which is why the multi-select landed first — and if
  you delete one too many, **Settings → Data** has it.
- **No Jira XML or JSON**, only CSV. Every one of the three exports CSV — and
  moving between two Kolibri instances has its own format, below.

## Parents and blockers

A spreadsheet can only name another task in words, and the task it names does
not exist until the file has been read. So those columns are resolved on a
**second pass**: every row is created first, then `Parent`, `Blocks` and
`Blocked by` are looked up — by the original key where the file has one, by
title otherwise.

```csv
Key,Title,Parent,Blocked by
EPIC-1,Move house,,
SUB-1,Book the van,EPIC-1,
SUB-2,Pack the kitchen,EPIC-1,SUB-1
```

Anything naming a task that is not in the file is **reported, not guessed at** —
a parent link to the wrong task is much harder to notice than a missing one. The
row itself still arrives; one unreadable column never loses a task. A dry run
counts the links it would make without writing any of them.

Several can be named in one cell, separated by a comma or a semicolon.

## Moving a project between two Kolibri instances

CSV is for leaving another tool. For moving a project from one Kolibri to
another, **Project → Settings → Export as JSON** writes the whole thing as one
readable document: structure, tasks, sub-tasks, relations, comments, pages,
custom fields and their answers, templates and rules. Importing it makes a new
project with every reference rewritten, so the same file can be imported twice
and produce two projects rather than one tangle.

This is deliberately *not* the backup format. A backup has to be exact, which is
why `kolibri backup` copies the database (see
[`deployment.md`](deployment.md)); this is a portable description that still
means something after the schema has moved on.

People are matched **by email address** — the only identifier that means the
same thing on two instances. Anybody with no account on the target is named in
the report and their work arrives unassigned, rather than being handed to
somebody who is not there. Who reacted to a comment is not carried across for
the same reason.

## Leaving another tool with its own export

**Project → Settings → Import from JSON** also takes an export from Jira, Linear,
Plane, OpenProject, Trello or Todoist. The file is recognised by its **shape**
rather than by what the browser called the download:

| Tool | The file | Recognised by |
|---|---|---|
| Jira | a `/rest/api/*/search` response | `issues[].fields` |
| Linear | a GraphQL `issues` query result | `data.issues.nodes` |
| OpenProject | a `/api/v3/work_packages` collection | `_embedded.elements[].subject` |
| Plane | an issue list from the API | `results[]` with `name` and `priority` |
| Trello | *Board menu → More → Print and export → Export as JSON* | `cards[].idList` alongside `lists` |
| Todoist | a Sync API response or a backup of one | `items[].content` with `project_id` |

What comes across is what those tools agree with Kolibri about: title,
description, state — with the bucket the source put it in, so a Jira status in
`indeterminate` arrives as *in progress* — priority, dates, labels, assignee,
parent, and comments where the file has them. **The team's own column names are
kept.** A team that has spent two years arguing about what to call a column
should get that column, not Kolibri's opinion of it.

What does not come across is everything each tool has invented for itself, and
the screen lists it **before** the import rather than after:

- **Jira**: sprints, epics-as-a-hierarchy-level, workflows, permission schemes,
  and custom field *values* — Jira sends them as `customfield_10021` with no clue
  in the same file about what that is called.
- **Linear**: cycles, Linear's own "projects", estimates.
- **OpenProject**: relations, time entries, budgets and custom fields, which are
  in separate endpoints and simply are not in this file. Its categories are not
  labels and are left out rather than renamed into something they are not.
- **Plane**: cycles, modules and relations, for the same reason — and its people,
  because the issue list identifies them by id and carries no address, so nobody
  can be matched and the tasks arrive unassigned.
- **Trello**: priority, estimates and relations, because Trello has none of them.
  Attachments, covers and Power-Up data are not in the file. Archived cards are
  counted and left out.
- **Todoist**: reminders, sections, filters, and the *time* on a due date —
  Kolibri due dates are days.

### The two that need a word of their own

**Trello has no idea which column means finished.** A list is a column and
carries nothing else, so the state group is guessed from the name — a short list
of words in the three languages this app speaks, and *in progress* for
everything else. That guess is in the notes before the import, because a column
read as "done" makes every card in it look done. Check the states afterwards.

A Trello **checklist** becomes a markdown checklist in the description rather
than sub-tasks. A Kolibri sub-task is a whole task with its own state, assignee
and dates; a three-word checklist item is not one, and promoting it to one
produces a board full of noise.

**Todoist has no columns at all**, so exactly two states are invented — *Open*
and *Done* — rather than a workflow nobody asked for. Its priorities run the
other way (`4` is P1, the urgent one) and are inverted on the way in. Everything
lands in one project, so the Todoist project a task came from becomes a **label**
— the closest thing that survives and can be filtered on.

Todoist's repeat rules are richer than Kolibri's, which repeats daily, weekly or
monthly and nothing else. `every 2 weeks` comes across; `every 3rd friday` does
not, and rather than approximate it into a rule that fires on the wrong day the
task arrives with its due date and no repeat — counted in the notes.

A link or a parent pointing at an issue that is not in the file is reported and
dropped rather than guessed at: a task filed under the wrong parent is harder to
notice than one filed under none.

> **These converters have never been run against a real export.** They were
> written against each tool's *documented* API shape. The recognisers are narrow
> — a file that is not clearly one of the six is refused rather than half-read —
> and an import always makes a **new** project, so nothing existing can be
> damaged by trying. If your export does not read, the shape is the thing to
> compare; a bug report with the first two issues of the file in it is enough to
> fix one of these.
