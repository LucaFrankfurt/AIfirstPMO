# Meetings

A meeting with a time, the people expected, and an agenda everybody in the workspace can add
topics to. Each topic carries the projects it is about, notes written by everybody in the room at
once, and the tasks that came out of it. What was not discussed is carried to the next meeting;
what was said is filed as a page. Off by default; switched on per workspace under
**Settings → Workspace**.

## The shape of it

| | |
|---|---|
| **Meeting** | When, where, who is expected, what it is for, and whether it is still ahead or closed |
| **Agenda point** | One topic: a title, an optional description, the projects it is about, who is responsible for it, where it got to — *open*, *discussed* or *deferred* — and its notes. Its own row, so two people adding topics at once from two devices both end up on the agenda |
| **Task** | An ordinary task that knows the point it came out of (`tasks.agenda_item_id`). On the task, not as a list on the point, so two tasks filed from one point at once are both kept |

A point records who brought it, and that is the server's to say: `created_by` cannot be written by
a client, so "everybody can bring a topic" comes with an agenda that is truthful about who did.

Who is **responsible** for a point is a different fact and its own list, `assignees`: the person who
raises "the pricing page is wrong" is rarely the one who has to fix it, and the agenda wants to say
both. Any number of people, and none is fine. Only the workspace's members can be named — not its
guests, for the reason a guest is not sent meetings at all; the picker does not offer them and the
write path takes them off a list that arrives from somewhere else. The same rule applies to who is
expected at the meeting. Filing a task from a point starts with the point's first responsible person
as the assignee, changed in one click.

Being made responsible is a notification of its own kind, `agenda`, and it counts as important —
the same weight as being assigned a task. It goes to the people newly on the list and never to
whoever put them there, and it leads to the meeting. Carrying a point forward does not send it
again: the new point is compared with the one it continues, so a topic deferred for three weeks is
one notification, not four. See [`notifications.md`](notifications.md).

## The notes are a merge, not a race

A point's notes are a text CRDT — the same one a page body is (see `text-crdt.ts` and
[`sync.md`](sync.md)). `notes_body` holds the state and `notes` is what it reads as, derived by the
write path through the same function a page's `content` is (`settleCrdtText`). Two people typing
the minutes of one point at the same time both keep their sentences, offline included, in the same
order on every device.

While somebody is typing in a point, everybody else looking at the meeting sees *"Ada is writing
here…"* under it. That rides the presence channel chat already has, with the point's id where a
conversation's would be: it is ephemeral, never a row, and a client that drops it syncs exactly as
before.

A caller that knows nothing of CRDTs — the REST API, an import, an assistant — writes `notes` as
text and the state is rebuilt to match, the way a page's `content` replaces its body. MCP's
`update_agenda_item` takes `append_notes` for the case that matters: an assistant taking minutes
while people type. A replacement is turned into the smallest edit that reaches the new text, so
appending is an insertion at the end and the half-written sentence above it survives.

The title and the description are ordinary last-writer-wins fields. They are a sentence one person
rewords, not a document several people write.

## Who sees a meeting

Every **member** of the workspace, and no **guest**. A meeting is not scoped by project, and that is
the decision the feature rests on: one meeting gathers topics from several projects, and a weekly
half its attendees cannot open is not a weekly. The line that *is* drawn is the guest's — a client
or a contractor is on a project, not in the room where the projects are compared.

It is drawn where `secret` draws its own: in the sync filter (`case 'meeting'` in `sync.ts`), in the
REST routes, listed or by id, and in every MCP tool. Hiding the screen would have left the agenda in
the guest's IndexedDB.

A point may name a project a member cannot see. They see the point and not the project's name — the
chip is simply not drawn, because the project row never reached their device.

## A meeting is not over because its hour has passed

`status` is what somebody said: *planned* or *closed*. Nothing closes a meeting on a clock. A meeting
from Tuesday that nobody closed is still on the list on Thursday, marked **nobody closed it** once
its day is over, because that is the honest description of it — it happened, and nobody wrote down
what came of it.

## Carrying the unfinished topics forward

Everything that was not *discussed* — open and deferred alike — goes onto the next meeting's agenda,
at the end and open, in the order it had, with the same people responsible for it: a topic deferred
is not a topic handed back. What was still *open* is marked *deferred* where it was,
because that is what happened to it. The notes stay where they were written: the new point links
back to the one it continues (*"Continued from …"*), rather than copying a conversation into a room
that did not have it.

"The next meeting" is the earliest one still planned that starts after this one. An undated meeting
is never a candidate. If there is none, a follow-up is called a week later with the same title,
place and people — and the sheet says so before anything is written.

The carried point's id is derived — `<next meeting>.<the point where the topic was first raised>` —
for the reason a vote's is: two people pressing the button on two devices, or one person pressing it
twice, write the same rows instead of an agenda with every topic on it twice. Built from where the
topic was *first* raised, so a topic deferred five weeks running has an id one meeting long.

A carried point keeps who brought it. Whoever pressed the button at the end of the meeting did not.

## The minutes are a page

**File the minutes as a page** writes the meeting up as markdown: the time and place, who was
expected, and one section per point with its state, its projects, who is responsible, who brought it,
the notes, and the tasks filed from it. The page is linked from the meeting. Filing again rewrites *the same page* from
the meeting as it stands, after asking — somebody may have tidied it by hand — and the previous text
stays in the page's history like any other edit.

Task lines are plain list items, deliberately not `- [ ]` checkboxes: a checkbox on a page is ticked
*on the page*, and the minutes would then claim work was done that the task itself says is not.

The browser and MCP write the minutes through the same function (`minutesMarkdown` in
`@kolibri/shared`), so they cannot produce two different documents of the same meeting.

**The minutes page is a workspace page,** and it follows the wiki's rules about who can read it, not
the meeting's. A guest can read workspace pages. Filing the minutes is publishing them.

## Deleting a meeting

Deleting a meeting takes its agenda with it. Restoring it from the trash brings back the points that
went with it — every point deleted at or after the moment the meeting was — and not the one somebody
removed from the agenda the week before. Tasks filed from a point are never deleted with it; they
are work, and the work is still owed.

## Over MCP

| Tool | |
|---|---|
| `list_meetings` | still open first, soonest first, then the closed ones; `unclosed` names the meeting nobody closed |
| `get_meeting` | the agenda in order, with each point's notes, projects, author and tasks. A title several meetings share — a weekly — means the next one still open |
| `create_meeting` | a time, a place, who is expected, and optionally the first topics |
| `update_meeting` | move it, rename it, change who is expected, or close it |
| `add_agenda_item` | a topic at the end of the agenda, as whoever the token belongs to, optionally with who is responsible |
| `update_agenda_item` | state, title, description, projects, who is responsible, and the notes — `append_notes` while people may be typing |
| `create_task_from_agenda_item` | a task that remembers the point; the project defaults to the point's first |
| `carry_over_agenda` | the button, as a tool — same rows, same ids |
| `file_meeting_minutes` | the minutes as a page, or the same page rewritten |

## What it does not do, yet

- **No calendar invitation.** A meeting is not in the `.ics` feed and sends nobody an email. The feed
  carries what is *due*; a meeting is something people attend, and an invitation is a promise about
  somebody else's calendar that this instance cannot keep in sync.
- **No series.** A weekly is a meeting and its follow-ups, each called by carrying the agenda forward.
  A recurrence rule would need an answer to "what happens to next week's agenda when this week's
  moves", and that answer is a design, not a column.
- **No notification** when somebody adds a topic or is put on a meeting. Being made responsible for
  a point does notify — see above. Asked for the first time
  somebody misses a meeting because of it, not before.
- **Not searchable.** Agenda points are not in the full-text index. The index carries one project per
  row and a point carries several, which is the budget's problem and wants the budget's answer.
- **Not in the workspace export.** Like decisions and KPIs, meetings stay behind in a workspace
  document; see [`export.md`](export.md).
- **Tombstones in the notes accumulate.** `kolibri doctor --fix` compacts page bodies and not yet
  agenda notes. A point's notes are a few hundred characters, so this is a note rather than a
  problem.
- **No cursor presence** inside the notes — the same limit the pages have.
