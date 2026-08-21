# The calendar feed

A subscribable `.ics` URL, so work with a date on it appears in whatever calendar
somebody already has open. Settings → Assistant & API → **Calendar feed**.

It is deliberately **not** CalDAV. CalDAV is a write protocol with discovery,
`PROPFIND`, `REPORT`, ETags and conflict handling; a read-only feed is a small
fraction of that and covers most of what people actually want, which is *seeing
what is due without opening another tab*. Writing back from the calendar client
is a separate feature and is not built.

## What is in it

| URL | What it holds |
|---|---|
| `/calendar/<token>.ics` | Everything with a due date that is **on you**, across every workspace you are a member of |
| `/calendar/<token>/<view-id>.ics` | One saved view, resolved the same way a shared link resolves it |

| Query | Effect |
|---|---|
| `?kind=todo` | `VTODO` instead of `VEVENT` |
| `?done=1` | Include finished work |

A task with no due date is not in the feed at all — there is nothing for a
calendar to draw.

## VEVENT or VTODO

`VEVENT` by default, because a subscribed calendar is nearly always read by
something that draws a grid — Google Calendar, Apple Calendar, Outlook,
Thunderbird's calendar — and every one of those ignores `VTODO` completely.

`?kind=todo` is for the other half: Thunderbird's **task list**, DAVx5 on
Android, anything that wants tasks as tasks. Emitting both in one file is legal
and produces every entry twice in the clients that read both, which is worse
than choosing.

The entry carries the identifier and title as its summary, the description and a
link back, the priority (`1` for urgent, the way RFC 5545 counts), the project as
a category, and a status from the state's group — `NEEDS-ACTION`, `IN-PROCESS`,
`COMPLETED` or `CANCELLED`.

## Subscribing

Copy the URL and add it as a **subscribed** calendar — not an import, which
takes a snapshot and never updates.

- **Google Calendar** — Other calendars → *From URL*
- **Apple Calendar** — File → *New Calendar Subscription*
- **Outlook** — Add calendar → *Subscribe from web*
- **Thunderbird** — New Calendar → *On the Network* → iCalendar (ICS)
- **DAVx5 / Android** — add a webcal subscription

The feed asks to be re-fetched hourly (`REFRESH-INTERVAL`). Most clients treat
that as a suggestion and pick their own interval, usually somewhere between a
few minutes and a day; none of them can be made to check more often than they
want to.

## The URL is the password

There is no other authorisation. Anybody holding the link can read the titles,
descriptions and dates of everything in it — so:

- **It does not exist until you ask for it.** A subscribable URL that exists
  before anybody wanted one is a URL that can leak before anybody knew it was
  there. A person who never opens that screen has no feed to leak.
- **A new link kills the old one.** *New link* writes a fresh token; every copy
  of the previous URL answers `404` from that moment, and every calendar
  subscribed to it stops updating and has to be re-added. The confirmation says
  so before it happens.
- **Turn off** removes it entirely.
- It is **rate limited by address** like a share link, never cached
  (`no-store`), and carries `noindex`.

What it can never do is widen what somebody can see. Every query runs as the
person the token belongs to, through the same resolver a shared link uses,
scoped to workspaces they are a member of — a feed token pointed at a view in
somebody else's workspace answers `404`.

## The format, and why the details matter

`lib/ical.ts` writes RFC 5545 by hand. Three of its rules are the kind whose
absence produces an **empty calendar rather than an error**, which is why each
one is asserted on the bytes in `calendar.test.ts`:

- **Folding at 75 octets.** Not 75 characters — octets. A title with an umlaut
  folds earlier than one without, and a break in the middle of a multi-byte
  character produces a file some clients refuse outright.
- **Escaping `\`, `;`, `,` and newlines.** A task called *Buy milk, eggs* ends
  its `SUMMARY` at the comma without it.
- **An exclusive `DTEND`.** A task due on the 4th ends on the 5th. Get this
  wrong and every client draws it on the 3rd — the single most common way one of
  these is quietly incorrect.

Every line ends `CRLF`, including the last one.

## What it does not do

- **No writing back.** Ticking a task off in a calendar client changes nothing
  here.
- **No times.** Due dates in Kolibri are days, so every entry is all-day.
- **No alarms.** `VALARM` would fire on the reader's device on a schedule
  Kolibri did not choose; reminders live in
  [`notifications.md`](notifications.md), where they can be turned off.
- **No per-project feed.** A saved view scoped to a project is the same thing
  with a name on it.
