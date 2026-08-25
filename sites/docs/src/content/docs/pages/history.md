---
title: History and restore
description: Every save is a version you can read, compare and put back — which is the undo for an editor that has no save button.
sidebar:
  order: 3
---

**History** in a page's menu. Every save is a version, with who made it and when.

Because the editor saves as you type, this is the real undo: closing the tab, a bad paste, an
overenthusiastic rewrite and a merge nobody meant are all recoverable here rather than by
<kbd>⌘</kbd><kbd>Z</kbd>.

## What you can do with a version

| | |
|---|---|
| **Read it** | The page as it stood |
| **Compare it** | A what-changed diff against the version before it, or against now |
| **Restore it** | Puts that text back as a **new** version |

Restoring never deletes anything. The version you restored *from* is still in the list, so
restoring the wrong one is fixed by restoring again.

## Reading a diff

Additions and deletions inline. Two things are worth knowing:

- **Reformatting shows up as a change**, because it is one. A paragraph rewrapped to a different
  width is a different set of lines.
- **A merge of two people's edits appears as one version**, not two, with both sets of changes
  in it — that is the point of [how a page body merges](/pages/together/). If you need to see
  who wrote which half, the versions on either side of it are in the list.

## How far back it goes

Every version is kept until the trash is emptied or a retention window passes, whichever comes
first. Both of those are workspace settings that an admin controls — see
[members and roles](/people/members/) — so if history matters to you, check what the window is
before you need it.

A deleted **page** works the same way as a deleted task: it is a tombstone, it disappears
everywhere, and *Settings → Data* brings it back until the trash is emptied.
