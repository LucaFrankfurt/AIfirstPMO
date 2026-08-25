---
title: Sharing a page
description: Per-page visibility, read-only links for people outside the workspace, exporting the wiki, and printing.
sidebar:
  order: 4
---

## Inside the workspace

A page is visible to the workspace by default. Per-page visibility narrows that — a page in a
private project follows the project, and a page can be restricted on its own.

Nesting does not leak: a child of a restricted page is not visible to somebody who cannot see the
parent.

## Outside the workspace

**Share** on a page produces a read-only link. Somebody holding it reads the page with no
account, no session and no way into anything else.

Three things about that link:

- **The link is the password.** There is no second check. Treat it the way you would treat the
  contents.
- **It is read-only, and it is one page.** Child pages are not included unless you share them
  too, and task references in the text are not links for that reader — they have no workspace to
  be sent into, so nothing is linked at all.
- **Revoking is one button**, and every copy stops working immediately.

### Letting them write back

A shared page can accept a **note** from its reader: a short message that arrives beside the page
for the people inside, without showing the outsider the thread. That is the "we sent the spec to
the client and they had one correction" case, without giving the client an account or letting
them see what everybody said about their last correction.

## Exporting

**Export as markdown** writes the page and everything nested under it as a bundle of `.md`
files, with the tree as folders. That is a real archive: plain files, readable in any editor,
with the links between them rewritten to relative paths.

For a whole project including its tasks and comments, use *Project → Settings → Export*, which
writes JSON another Kolibri can read. See [bringing a backlog in](/beyond/import/).

## Printing and PDF

**Print** in the page menu. The print stylesheet drops the sidebar, the header and every
control, expands anything collapsed, and prints link targets after the link text so a printed
page is still usable. *Save as PDF* in the print dialog is how you get a PDF; there is no
separate PDF exporter.
