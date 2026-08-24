---
title: Working offline
description: What actually happens on a plane, what happens when you land, and the one case where a merge has to pick a winner.
sidebar:
  order: 1
---

Kolibri does not have an offline *mode*. It reads from your device all the time, so being
offline is not a different way of running — it is the same way of running with nothing to sync
to yet.

## What works with no connection

Everything you can see, and most of what you can do:

- Every board, list, table and calendar, in every project.
- Filtering, grouping, sorting, saved views.
- Creating and editing tasks, pages, comments and chat messages.
- Title search, and the Insights charts.
- The inbox.

## What does not

| | Why |
|---|---|
| Full-text search | The body-of-everything search is the server's. Title search still works |
| Attachments you have not opened before | Files are cached once you have seen them, not preemptively |
| Presence and typing indicators | Both are claims about right now, carried on a connection |
| Anything a [rule](/automation/rules/) does | Rules run on the server, so they fire when your change arrives |
| Sending an invite, or anything that emails | |

## What happens when you come back

Your queued changes go up; everything that happened while you were away comes down. Both usually
finish before you have noticed the sync indicator.

Two guarantees are worth knowing:

**A flaky connection cannot duplicate anything.** Every change carries an id, and a change the
server has already applied is ignored rather than applied twice.

**Merging is per field.** You changed a task's title while somebody else changed its priority:
both survive. This is the normal case and it is why the offline half is usable rather than
frightening.

## The case where somebody loses

If two people change **the same field** of the same task while apart, one of them wins. The
winner is decided by a clock that every device agrees on, not by who reconnected first — which
makes it consistent, but does not make it fair. The other person's value is gone from the field;
the [activity trail](/tasks/detail/#the-activity-trail) still records that they set it.

**A page body is the exception**, and deliberately so: it merges character by character, so two
people typing in the same paragraph both keep their sentences. See
[two people, one page](/pages/together/).

## Deletes are not gone

A deletion is a tombstone that syncs like anything else — which is what makes "I deleted it on
my phone" reach your laptop. *Settings → Data* lists what has been deleted and puts it back, until
an admin empties the trash or a retention window passes. That last step is the only irreversible
one, and every device honours it.

## How to tell what state you are in

The sync indicator in the sidebar. It says *up to date*, *syncing*, or *offline, n changes
waiting*. If it says the last one and you did not expect it to, you are on a network that is
answering DNS and nothing else, which is most hotel wifi.

Nothing is lost while it says that. The queue is on disk, so closing the tab, closing the
laptop or a browser crash does not empty it.
