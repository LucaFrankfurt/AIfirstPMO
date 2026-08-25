---
title: Saved views
description: Keep a filter under a name, pin one as what a project opens on, and share it with people who cannot sign in.
sidebar:
  order: 3
---

Once you have set the same three filters twice in a day, save them.

**Save view** at the top of any filtered list. A saved view stores the layout, the grouping, the
filter, the sort and the display options — everything you set. Give it a name and an icon; it
appears in the project's header beside the others.

## What a saved view is good for

| | |
|---|---|
| *My open work here* | `assignee = me AND is: open` |
| *Ready to pick up* | `state = Todo AND assignee = none` |
| *Stuck* | Blocked tasks, which is a relation filter rather than a state |
| *This week* | `due = week AND is: open` |
| *Needs an estimate* | Everything in the cycle with no estimate — the pre-planning check |

## Pinning one as the default

A view can be set as **what this project opens on**. That is a project-level decision, not a
personal one, so use it for the view the team should land on rather than yours — usually the
current cycle's board.

Everyone's personal views stay in the same list; pinning only decides what is showing before
anybody clicks.

## Sharing one

A saved view can be given a **read-only share link**. Somebody holding that link sees the tasks
the view resolves to, with no account and no session.

Two things about that:

- **The link is the password.** There is no second check. Anybody holding it can read what is in
  the view, so treat it like one.
- **It resolves as you.** The view runs with the permissions of the person who shared it, which
  is why sharing a view that spans a private project shares that project's tasks. Look at what
  the view actually contains before you send the link.

Revoking is one button and every copy of the link stops working immediately.

## Subscribing to one in a calendar

Every saved view can also be a `.ics` feed, so *what is due in this view* appears in Google
Calendar, Apple Calendar, Outlook or Thunderbird. Same warning as above — the URL is the
password — and the same one-button revoke. [Calendar subscriptions](/beyond/calendar/).

## Views you cannot save

The filter behind a saved view is a conjunction of *is one of* and *is not one of*. Two things
therefore cannot be saved, and the interface says so rather than saving something subtly
different:

- **`OR` across two different fields.** *Assigned to me **or** urgent* is not one filter. Several
  answers to one field is: `priority in (urgent, high)`.
- **A date comparison other than the four buckets.** `due < 2026-09-01` is not
  *overdue / today / this week / none*.

See [the filter reference](/reference/filters/#what-it-deliberately-cannot-do).
