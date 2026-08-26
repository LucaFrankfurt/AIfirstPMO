---
title: Taking it with you
description: A workspace as one readable file, tasks as a spreadsheet, your own data on request, and moving a whole instance to another machine.
sidebar:
  order: 5
---

An export is not a backup, and the difference is the whole of this page.

| | What it is | Where |
|---|---|---|
| **An export** | A readable document of a workspace or a project. Imports into any Kolibri, and still means something after the software has moved on. | Settings → Data, and Project → Settings |
| **A snapshot** | The database, copied exactly. Restores this instance to this moment and nothing else. | Settings → Data, for whoever administers the instance |
| **Your own data** | Everything held about one person, as a file they can read. Nothing reads it back. | Settings → Data |

A snapshot is what you restore from. An export is what you move with, read, and
hand to somebody who is leaving.

## A workspace as one file

**Settings → Data → Export this workspace.** Two formats, and the only
difference is the uploaded files.

**JSON** is the workspace as one document you can open in a text editor. Every
project, its tasks, sub-tasks, relations, comments, pages, custom fields and
their answers, templates, rules and logged time — plus the parts that live above
the projects and so are in no project's own export:

- the teams and who is in them,
- the saved views everybody works from,
- the pages that belong to no project,
- the project tree, a cycle several projects share, and a task in one project
  blocking a task in another.

**`.zip`** is the same document with the files beside it: attachments, pictures
pasted into descriptions, images dropped into pages, covers.

Exporting the whole workspace is for an admin of it, since it includes the
private projects. Anybody can export a project they can see from that project's
own settings.

### What does not travel

Each of these is left out for the same reason — an export is a document somebody
emails, and these are either secrets or somebody else's.

- **Passwords, sessions, tokens, second factors.** People are matched by email
  on the way in; nobody is created and nobody is invited.
- **Share links.** The token *is* the permission. Carrying one would publish a
  page on the other instance that nobody there agreed to publish.
- **Private and direct conversations.** Being able to read the file is not being
  in the room. Open channels travel.
- **Notifications and read markers.** One person's state about a workspace, not
  the workspace.
- **Intake reports**, which carry the addresses of people outside the workspace.

## Reading one back

**Settings → Data → Import a workspace.** It always arrives as a **new**
workspace — merging two workspaces is a migration with a hundred decisions in
it, and none of them belong to a file. A new one is the outcome that cannot
damage anything already here, which is what makes it safe to try.

People are matched **by email address**, the only identifier that means the same
thing on two instances. Anybody with no account here is named in the report and
their work arrives unassigned, rather than being handed to somebody who is not
there.

## Tasks as a spreadsheet

**Project → Settings → Export tasks as CSV**, or the whole workspace from
Settings → Data. The columns are the ones the
[importer](/beyond/import/) reads, so a list exported and imported again lands
where it started.

Two details you will only notice when they are missing:

- **A byte-order mark is always written.** Without one, Excel reads UTF-8 as the
  local code page and every umlaut arrives as nonsense.
- **A cell beginning `=`, `+`, `-` or `@` gets an apostrophe in front of it.** A
  spreadsheet reads those as formulas, and a task called `=HYPERLINK(…)` should
  be a task title rather than a link somebody clicks. The apostrophe shows the
  value exactly as typed and never runs it.

Add `?delimiter=;` for the Excel that only splits on semicolons.

## Your own data

**Settings → Data → Download my data.** Your account, the tasks you are on and
the ones you made, what you have written, the time you have logged, your
messages, your saved views and the devices you are signed in on.

Your password, tokens, second factor and calendar feed token are **not** in it.
That each of them exists, and when, is — knowing you have four devices signed in
is the useful half, and it is the half that is not a credential. Handing back
the other half would make a copy you could never revoke.

## Moving to another machine

This is the case an export is *not* for. An export moves a workspace; moving a
whole instance — every account, every workspace, the settings, the files — is a
**snapshot**, because there the point is to be exact.

1. On the old instance: **Settings → Data → Backups → Download**.
2. Deploy the new one and claim it. The first account to register administers
   the instance.
3. **Settings → Data → Restore from a file**, and upload the `.zip`.
4. Sign in with your password from the old instance.

The account that deployed it is replaced along with everything else, which is
correct: afterwards the instance *is* the old one. Everybody is signed out —
that is how each device knows to fetch the restored data rather than merge its
own copy into it — and passwords carry across untouched.

## Snapshots

Whoever administers the instance sees the backups in the same place: when the
last one ran, what is on disk, and buttons to take one, check one, download it,
or put it back. They are taken every night if the instance is set up for it.

Restoring asks you to type *restore* first, says what will arrive and what will
go, and takes a snapshot of the current state before replacing it — so
restoring the wrong file is something you can undo. The
[deployment guide](https://github.com/LucaFrankfurt/AIfirstPMO/blob/main/docs/deployment.md#restoring)
has the mechanics, and the command-line route for an instance that will not
start.
