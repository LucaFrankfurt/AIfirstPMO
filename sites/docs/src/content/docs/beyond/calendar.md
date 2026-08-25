---
title: Calendar subscriptions
description: A subscribable .ics link so what is due shows up in the calendar you already have open — and why the URL is a password.
sidebar:
  order: 3
---

*Settings → Assistant & API → Calendar feed.* Ask for a link, copy it, and add it to your
calendar as a **subscription**.

Two kinds of feed:

| | |
|---|---|
| **Yours** | Everything with a due date that is **on you**, across every workspace you are a member of |
| **A saved view** | One [saved view](/views/saved/), resolved the way its share link resolves it |

A task with no due date is not in the feed at all — there is nothing for a calendar to draw.

## Subscribing, not importing

Import takes a snapshot and never updates. You want *subscribe*:

- **Google Calendar** — Other calendars → *From URL*
- **Apple Calendar** — File → *New Calendar Subscription*
- **Outlook** — Add calendar → *Subscribe from web*
- **Thunderbird** — New Calendar → *On the Network* → iCalendar (ICS)
- **DAVx5 / Android** — add a webcal subscription

The feed asks to be re-fetched hourly. Most clients treat that as a suggestion and pick their
own interval, usually between a few minutes and a day, and none of them can be made to check
more often than they want to. If something you just changed has not appeared, that is why.

## Events or tasks

By default every entry is a `VEVENT` — an all-day entry on the day it is due — because a
subscribed calendar is nearly always read by something that draws a grid, and every one of those
ignores `VTODO` completely.

Add `?kind=todo` to the URL for the other half: Thunderbird's task list, DAVx5, anything that
wants tasks as tasks. Add `?done=1` to include finished work.

Each entry carries the identifier and title, the description, a link back, the priority, the
project as a category, and a status derived from the state's group.

## The URL is the password

There is no other check. Anybody holding the link can read the titles, descriptions and dates of
everything in it. So:

- **It does not exist until you ask for it.** A feed that existed before anybody wanted one is a
  feed that can leak before anybody knew it was there.
- **A new link kills the old one.** *New link* writes a fresh token; every copy of the previous
  URL stops working from that moment, and every calendar subscribed to it stops updating and has
  to be re-added. The confirmation says so before it happens.
- **Turn off** removes it entirely.

What a feed can never do is widen what you can see. Every query runs as you, scoped to workspaces
you are a member of — a token pointed at a view in somebody else's workspace answers with
nothing.

## What it does not do

- **No writing back.** Ticking a task off in a calendar client changes nothing here. This is a
  read-only feed, not CalDAV.
- **No times.** Due dates in Kolibri are days, so every entry is all-day.
- **No alarms.** A `VALARM` would fire on your device on a schedule Kolibri did not choose;
  reminders live in [notifications](/people/notifications/), where you can turn them off.
- **No per-project feed.** A saved view scoped to a project is the same thing with a name on it.
