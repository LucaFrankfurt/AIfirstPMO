# Taking it with you

Three different questions, three different files, and the difference between
them matters more than any of them:

| | What it is | Where |
|---|---|---|
| **An export** | A readable document of a workspace or a project. Survives a schema that has moved on. Imports into any Kolibri. | Settings → Data, and Project → Settings |
| **A snapshot** | The database, copied exactly. Restores this instance to this moment and nothing else. | `kolibri backup`, and Settings → Data for an instance admin |
| **Your own data** | Everything this instance holds about one person, as a file they can read. Nothing reads it back. | Settings → Data |

A snapshot is the one to restore from. An export is the one to move with, to
read, and to hand to somebody who is leaving. Using either for the other's job
is the mistake this page exists to prevent.

## A workspace as one file

**Settings → Data → Export this workspace.** Two formats, and the choice is only
about the uploaded files:

- **JSON** — the whole workspace as one document you can open in a text editor.
  Every project, its tasks, sub-tasks, relations, comments, pages, custom fields
  and their answers, templates, rules and logged time; plus what sits above the
  projects — the teams, who is in them, the saved views, the pages that belong to
  no project — and what runs *between* them: the project tree, a cycle three
  projects share, a task in one blocking a task in another.
- **`.zip`** — the same document, plus the files it refers to. Attachments, the
  pictures pasted into descriptions, the images dropped into pages, the covers.
  Named by the SHA-256 of their own contents, which is also how the document
  refers to them.

Exporting the whole workspace is for an **admin** of it, because it includes the
private projects. Anybody can export a project they can see, from that project's
own settings.

### What it does not carry, and why

Each of these is left out for the same reason: an export is a document somebody
emails, and these are either secrets or somebody else's.

- **Passwords, sessions, API tokens, two-factor secrets.** People are matched by
  email on the way in. Nobody is created and nobody is invited — that is a
  decision with an email attached to it, and reading a file is not the moment to
  make it.
- **Share links.** The token *is* the authorisation. Carrying one would publish
  a page on the far instance that nobody there agreed to publish.
- **Private and direct conversations.** Being able to read the export is not
  being in the room. Open channels travel; private ones do not.
- **Notifications, read markers, push subscriptions.** One person's state about
  a workspace, not the workspace.
- **Intake reports**, which carry the email addresses of people outside the
  workspace who filled in a form.

## Reading one back

**Settings → Data → Import a workspace**, or `POST /api/import/archive`.

It always arrives as a **new** workspace. Merging two workspaces is not an
import — it is a migration with a hundred decisions in it, and none of them
belong to a file. A new workspace is the one outcome that cannot damage
anything already here, which is what makes it safe to try.

People are matched **by email address**, the only identifier that means the same
thing on two instances. Anybody with no account here is named in the report and
their work arrives unassigned. Whoever imported the file owns what they
imported: a role recorded in the file is a claim about a different instance.

A project archive can go into a workspace you already have — see
[`import.md`](import.md), which also covers importing into a project that
already exists.

## Tasks as a spreadsheet

**Project → Settings → Export tasks as CSV**, or the whole workspace from
Settings → Data.

The columns are **the ones the importer reads**, under the header names it
recognises, so a list exported and imported again lands where it started:

```
Key, Title, Description, State, Priority, Assignee, Labels,
Start date, Due date, Estimate, Parent, Blocks, Blocked by,
Project, Cycle, Module, Created, Completed, Archived
```

Everything from `Project` on is context and is ignored on the way back in.

- **`?delimiter=;`** for the Excel that only splits on semicolons. A byte-order
  mark is always written, because without one Excel reads UTF-8 as the local
  code page and every umlaut arrives as nonsense.
- **A cell beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe.** A
  spreadsheet reads those as formulas, and a task titled `=HYPERLINK(...)`
  should be a task title rather than a link somebody clicks. The apostrophe
  shows the value exactly as typed and never runs it.
- **Both assignees.** A task can be on several people, and the importer reads a
  list back — which is the whole reason the export writes one.

## Your own data

**Settings → Data → Download my data.** One person's account, the tasks they are
on and the ones they made, what they have written, the time they have logged,
their own messages, their saved views, their notifications, and the devices
they are signed in on.

Their password, tokens, two-factor secret, recovery codes and calendar feed
token are **not** in it. The *existence* of each is, with its dates: knowing you
have four devices signed in is the useful half, and it is the half that is not a
credential. Handing back the other half would make a copy nobody could revoke.

There is no `:userId` on that route. An administrator who needs somebody else's
data has the database.

## Snapshots

The exact copy. See [`deployment.md`](deployment.md#backups) — how to schedule
them, how many are kept, how to get one off the machine, and how to put one
back.

## The archive format

A plain ZIP, written by hand rather than by a dependency:

```
kolibri.json          the document, exactly as the JSON export writes it
files/<hash>.<ext>    the blobs it refers to, named by their own checksum
README.txt            what this is, for whoever opens it in three years
```

- **Deflate, unless that makes it bigger.** A JPEG deflates to slightly more
  than a JPEG; both are tried and the smaller kept.
- **UTF-8 names**, flagged the way every unpacker has honoured for fifteen
  years — without it a German filename arrives as mojibake on Windows.
- **Written as it goes**, one blob at a time, so exporting a workspace with a
  gigabyte of attachments costs one attachment of memory.
- **No Zip64.** An archive over 4 GB, or with more than 65 535 files in it, is
  refused by name rather than written as a file only some unpackers can read.
  Export project by project if you hit it.

On the way back in, **every entry is checked against the hash it is filed
under**. That is not belt-and-braces: storage is content-addressed, so accepting
bytes under somebody else's hash would replace *their* file with these. An entry
that fails is listed in the report and dropped.

An attachment whose bytes are nowhere — a JSON-only export, or an archive that
lost a file — is **dropped and named in the report** rather than written as a
paperclip that opens onto a 404.

## From a shell

```bash
kolibri export acme                    # → acme-2026-08-26.kolibri.zip
kolibri export acme /tmp/acme.zip
```

The same document the app hands out, by the same function — an operator's export
and somebody's download cannot drift apart if they are the same code.

## Over the API

| | |
|---|---|
| `GET /api/workspaces/:ws/export` | the workspace as JSON. `?format=zip` for the archive |
| `GET /api/workspaces/:ws/export/preview` | what an export would contain, before waiting for one |
| `GET /api/workspaces/:ws/export/tasks.csv` | `?project_id=` `?cycle_id=` `?state_id=` `?assignee=` `?delimiter=;` `?archived=1` |
| `GET /api/workspaces/:ws/projects/:id/export` | one project as JSON |
| `GET /api/workspaces/:ws/projects/:id/export.zip` | one project, with its files |
| `GET /api/me/export` | your own data |
| `POST /api/import/workspace` | `{ document }` → a new workspace |
| `POST /api/import/archive` | a `.zip` body. `?workspace=` for a project archive, `?project_id=` to merge |
| `POST /api/workspaces/:ws/import/json` | `{ document, project_id? }` — see [`import.md`](import.md) |

Every download is an ordinary authenticated request. Nothing here mints a link.
