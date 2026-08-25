---
title: Two people, one page
description: Both sets of changes survive, because a page body merges character by character rather than field by field.
sidebar:
  order: 2
---

Two people can type in the same page at the same time and both keep their words. So can two
people who are both offline, on different continents, editing the same paragraph.

## Why this is different from the rest of the app

Everything else in Kolibri merges **field by field**: if you change a task's title while
somebody else changes its priority, both changes survive because they are different fields. If
you both change the *title*, the later stamp wins and the other one is lost.

That rule is wrong for a page body. A page body is one field, and "the later save wins" would
mean the second person to reconnect silently deletes the first person's afternoon.

So a page body is stored as a **text CRDT** — a structure that records edits as insertions and
deletions at positions that survive other people's edits, rather than as a new copy of the whole
document. Two people adding a paragraph each end up with both paragraphs, in a consistent order
that every device agrees on.

## What that means in practice

- **You do not have to coordinate.** No locking, no "checked out by", no merge dialog.
- **Offline editing is the same thing.** Two people writing on a plane merge when they land.
  There is no special case for it, because there is no special case in the mechanism.
- **Every device reads the same thing.** Not "eventually roughly the same" — the order edits end
  up in is decided by the structure, not by who reconnected first.

## What it does not do

- **No cursors.** You do not see the other person's caret moving. Presence — the green dot and
  the "somebody is typing" line — exists in [chat](/people/chat/), not in the page editor.
- **It does not merge meaning.** If you write "we will use Postgres" and somebody else writes
  "we will use SQLite" in the same sentence, you get a sentence containing both. That is a
  conversation, and no algorithm was going to have it for you.
- **Only the body.** A page's title, labels and parent are ordinary fields and merge the ordinary
  way.

## When it goes wrong, look at the history

Every save is a version. If a merge produced something nobody meant, [the history](/pages/history/)
has both sides of it, a diff, and a restore button. That is the recovery path, and it is why the
history is not optional decoration.
