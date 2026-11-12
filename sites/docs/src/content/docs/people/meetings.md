---
title: Meetings
description: A time, the people expected and an agenda everybody can add topics to — notes written together, tasks filed from it, the unfinished carried forward, the minutes filed as a page.
sidebar:
  order: 8
---

*Settings → Workspace → Meetings*, then **Meetings** in the sidebar. Off by default.

| | |
|---|---|
| Who sees meetings | every **member** of the workspace — never a guest |
| Who adds topics | any member |
| Scoped by project | no — one meeting gathers topics from several projects |

## A meeting

*New meeting*:

| field | |
|---|---|
| Title | a weekly keeps the same title every week |
| Date and time | optional; a meeting with none is never "the next one" |
| Place | a room, or the link to a call |
| What it is for | optional |
| Attendees | members only |

| state | |
|---|---|
| Planned | still ahead |
| Closed | somebody pressed *Close the meeting* |
| Nobody closed it | its day is over and it is still planned — nothing closes a meeting on a clock |

## The agenda

*Add a topic* — at the end, filed under whoever added it (*Brought by …*).

Each topic carries:

| | |
|---|---|
| Projects | what it is about; a project you cannot see is simply not shown |
| Responsible | who has to act — not always who brought it; being made responsible is a notification |
| Where it got to | *Open* · *Discussed* · *Deferred* |
| Notes | written by everybody at once |
| Tasks | filed from the topic |

Reorder with *Move up* / *Move down*; *Remove the topic* takes its notes, never its tasks.

## Notes, together

- Everybody in the meeting types into the same notes at the same time — both sentences survive,
  offline included.
- *"Ada is writing here…"* under a topic while somebody types in it.
- Title and description are not shared like that: the last edit wins.

## Tasks from a topic

*File a task* — an ordinary task that remembers the topic it came out of.

- Project: the topic's first, by default.
- Assignee: the topic's first responsible person, by default.
- Listed under the topic, and in the minutes.

## Carrying topics forward

*Carry open topics forward* — everything not *Discussed* goes onto the next meeting:

| | |
|---|---|
| Where to | the earliest planned meeting after this one |
| No such meeting | a follow-up a week later, same title, place and people — the sheet says so first |
| Here | what was *Open* becomes *Deferred* |
| There | the topic, at the end, *Open*, same people responsible, *Continued from …* |
| The notes | stay where they were written |

Pressing it twice, or on two devices, carries nothing twice.

## The minutes

*File the minutes as a page* — a workspace page, linked from the meeting:

- time, place, who was expected;
- one section per topic: state, projects, responsible, brought by, notes, tasks.

*Rewrite the minutes* rewrites the same page from the meeting as it stands, after asking; the old text
stays in the page's history.

:::caution[Filing is publishing]
The minutes are a wiki page and follow the wiki's rules about who reads it — guests included.
:::

## Deleting

- A meeting goes to the trash with its agenda; restoring brings the agenda back.
- Tasks filed from it are never deleted with it.

## With an assistant

Over MCP: `list_meetings`, `get_meeting`, `create_meeting`, `update_meeting`, `add_agenda_item`,
`update_agenda_item`, `create_task_from_agenda_item`, `carry_over_agenda`, `file_meeting_minutes`,
and `prepare_meeting` for an agenda drawn from the workspace's reports. See
[Connecting an assistant](/beyond/assistant/).

## Not yet

- No calendar invitation; a meeting is not in the calendar feed.
- No series — a weekly is a meeting and its follow-ups.
- No notification when a topic is added or somebody is put on a meeting.
- Agenda topics are not in search, and not in the workspace export.
