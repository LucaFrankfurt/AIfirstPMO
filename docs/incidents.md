# Incidents

Something stopped working: what, how bad, who is running it, what was said while it was down, what
it cost, and what is owed afterwards. Off by default; switched on per workspace under
**Settings → Workspace**.

The shape is the meeting's and the ballot's: a record, the rows that happened against it, and pure
functions in `@kolibri/shared` that every screen and every assistant reads it through — so the start
page, the incident screen and `list_incidents` cannot disagree about which incidents are still
burning or how long the last one took to put out.

## The shape of it

| | |
|---|---|
| **Incident** | The record. A number, a summary, a description, a status, a priority with the impact and urgency behind it, a category, the affected applications, a manager and responders, three times, a financial impact, how it ended, the root cause, and the pages and tasks it links to |
| **Update** | One line on the timeline. An *update* for whoever is waiting, a *working note* among the people fixing it, or a *change* the server wrote because the status, priority or manager moved |
| **Application** | Something that can break, in the words of the people affected — "the shop", "the VPN". The list an incident's affected applications are chosen from |

An update is its own row rather than a list on the incident, for the reason an agenda point is: three
people write updates during the same outage from three devices, and a JSON array would keep
whichever synced last.

## The number is the server's

`INC-1`, `INC-2`, counted per workspace inside the write that creates the incident: the maximum this
workspace has ever handed out, plus one. A device offline cannot know which number is next, and two
that guessed would both mint `INC-7` — the one collision a number exists to make impossible. So
`number` and `identifier` are `serverOnly`, the way a task's are, and a new incident reads `INC-…`
until the server has answered.

**Tombstones count.** A deleted incident keeps its number and the next one does not reuse it: a number
quoted in last month's email has to keep naming exactly one thing, including when that thing was a
false alarm somebody deleted.

## Priority is suggested, not computed

ServiceNow's matrix, folded onto four priorities:

| | urgency high | medium | low |
|---|---|---|---|
| **impact high** | P1 | P2 | P3 |
| **medium** | P2 | P3 | P4 |
| **low** | P3 | P4 | P4 |

Its bottom-right corner is P5, "planning", which is a change request wearing an incident's clothes;
it lands on P4 here. `priorityFor` is the matrix, and it is what a **new** incident starts with — on
the form, the priority follows impact and urgency until somebody picks one; over the API and MCP, an
incident created without a priority gets the matrix's.

After that the priority is whatever the person running it says. A derived column nobody may correct is
the one an incident manager overrides in a side channel at three in the morning, and then the record
says P3 about an outage the whole company was on a call for. Changing the impact of an existing
incident therefore leaves its priority alone.

## Three times, not one

| | |
|---|---|
| `started_at` | When people were first hurt |
| `detected_at` | When somebody here noticed. Defaults to the moment the incident was opened — whoever is writing it down noticed it by then at the latest |
| `ended_at` | When the hurting stopped. Set to the moment of resolving if nobody said |
| `resolved_at`, `closed_at` | Not typed by anybody: the moments the status said so, stamped by the write path |

Conflating any two of them is how a report ends up flattering itself. The three clocks a review is
about fall out of them — `incidentClocks` in `@kolibri/shared`:

- **duration of impact**: started → ended, or → now while it goes on;
- **time to detect**: started → detected;
- **time to resolve**: detected (or started, when nobody wrote down noticing) → the service back —
  `ended_at`, or the resolution stamp when nobody said when it ended. Null while still active.

The end of the last one is `ended_at` before `resolved_at` because of a measurement: an incident
written up the next morning is resolved when somebody presses the button, hours after the service
came back, and the first walk through these screens reported a mean time to resolve of a day and
five hours for an outage that lasted three. Live, the two agree — resolving with no `ended_at` sets
it to that moment — so the stamp is only ever the fallback.

Each is **"—" when one of its ends was never written down**, never guessed from `created_at`. The row
was created when somebody opened the form, which is neither when the outage started nor when it was
noticed, and a duration measured from it is a measurement of the paperwork.

### Resolved is not closed

`resolved` is "the service is back". `closed` is "and the paperwork is done" — the root cause written
down, the follow-ups filed, the review held. The gap between the two is where post-incident reviews go
to die, so it is a state of its own, the index screen has a tab for it ("Review open"), and the
**Resolve** button resolves rather than closes. Closing is a second, deliberate step.

Going back to an active status clears both stamps: an incident that came back was not resolved, and
leaving the old stamp would make the next resolution look minutes long.

## The timeline writes itself

A change of **status, priority or manager** adds a `change` line in the same transaction, through the
write path, so it reaches every device like anything else. The record is then complete without anybody
having to remember to say "moved to monitoring" — which is exactly the line nobody writes at three in
the morning and everybody looks for at the review. Creating an incident writes the first line: opened,
at the status it was opened in.

A change line stores the field and its two values rather than a sentence, so each device reads it in
its own language. It is the server's alone: a client that sends `kind: "change"` is refused, and so is
an edit of one — a client that could write one could claim an incident was resolved an hour before it
was.

A person's line is theirs: only its author edits or deletes it, so nobody can change what the team was
told during the outage. A line can be **backdated** with `occurred_at`, so a timeline can be put
together afterwards from a chat log — "14:02, the alerts fired", written at five o'clock, is still a
line at 14:02.

## Money: not costed is not free

`financial_impact` is integer minor units with one currency, on the same terms as budgets. **Null is
"nobody costed it"**, and the report counts those as `unpriced` rather than adding nothing to the
total — the same rule `unallocated` follows in budgets. A month that "cost nothing" because nobody
costed it is a report flattering itself. The form's input is therefore not the budget's `MoneyInput`,
which reads an empty box as zero.

Two currencies are never added together; the report sums per currency.

## Applications: a short list, in people's words

Not the infrastructure register's components, because the two answer different questions: the
register says what runs where and what it costs, this list says what the people affected would call
the thing that stopped working. `component_id` is the bridge for a workspace that keeps both.

Archiving is the button offered, not deleting: an application that was retired is still the one last
year's incidents name. Over MCP, an application named that the list does not have yet is **added**
rather than refused, for the reason `record_component` creates a vendor — an assistant writing down an
outage at speed should not have to stop and curate a dropdown first. Matched without case, so "crm"
is the CRM.

## People are members

An incident goes to the members of the workspace and **not to its guests** — a clause in the sync
filter, the meeting's line. An incident record says what broke, what it cost and whose fault the root
cause was, which is a sentence about the company that a client or a contractor on one project has no
business mirroring. Not scoped by project, because an outage hits applications, not boards.

The REST door, MCP and search ask the same question. The manager and responders are narrowed to
members by the write path, so the picker never offers a name the server would take back off.

## Who is told

- **Being made manager or responder** tells that person (`incident`, in the "important" set — it is
  addressed to one person, the way an assignment is). Not the person who did it, not somebody who
  already had the role, and not for an incident that is already over.
- **A P1 or a major incident** tells every member of the workspace once (`incident_major`) —
  opened as one or escalated to one while active. `announced_at` is what keeps the next edit from
  ringing again. It is in the *instant* set rather than the email one: an outage announced in
  tomorrow morning's digest is announced after it is over.

The rest of `notifications.md` argues against telling a whole workspace anything; a critical outage is
the exception for the reason a ballot is — rare, about everybody's day, and staying quiet has a cost:
the colleague still telling a customer "everything is fine".

## The start page

Active incidents — new, investigating, identified, monitoring, on hold — are listed above everybody's
own work on **My work**, worst first: priority, then a major incident before an ordinary one, then the
longest-running. The panel is **absent** when nothing is active rather than saying "no incidents"
every morning: a panel that is always there and almost always empty is a panel people stop looking at.

## The post-incident review

**Write the post-incident review** on the incident screen, and `write_incident_review` over MCP, file a
page from `reviewMarkdown` in `@kolibri/shared` and link it to the incident. Everything the record
knows is filled in — the facts table, the three clocks, the timeline, the root cause, the resolution,
the follow-ups. What only a person can write — the impact in words, the lessons — is a heading with
*To be written.* under it, rather than an empty section that reads as finished. **The lessons are never
filled in by anybody but a person**: an assistant writing "we learned to monitor better" is the review
that changes nothing.

Over MCP, calling it again rewrites the same page rather than filing a second one.

## Through MCP

| Tool | |
|---|---|
| `list_incidents` | Worst first; `state` active (default), review, resolved, closed or all |
| `get_incident` | One in full: the timeline, the people, the links, the three clocks |
| `create_incident` | Opens one; priority suggested when left out; a first update optional |
| `update_incident` | Changes only what is passed; the timeline records status, priority and manager moves |
| `add_incident_update` | A line on the timeline, optionally backdated, optionally moving the status in the same call |
| `resolve_incident` | Resolves, or closes with `close: true`, with how it ended |
| `link_to_incident` | Links a page or a task, or takes the link off |
| `create_incident_follow_up` | Files a task in a project and links it |
| `write_incident_review` | Files the post-incident review as a page and links it |
| `incident_report` | Counts over a window: by priority, category and resolution, MTTR, MTTD, cost per currency, unpriced, and the same per application |
| `list_applications`, `create_application` | The list affected applications are chosen from |

Every tool takes an incident as `INC-12`, `12`, `#12` or its id — whatever was pasted from the email
subject or the chat — and people and applications by the words an assistant was given.

## What it is not

- **Not monitoring.** Nothing opens an incident on its own: no alert integration, no pager. An
  incoming webhook or an assistant can open one; a monitor cannot yet.
- **Not an on-call rota.** Who is on call is not here; who is *on this incident* is.
- **Not a status page.** Updates are for the workspace. Nothing is published to customers.
- **Not problem management.** A recurring cause is a follow-up task linked from several incidents,
  not a record of its own.
- **Not in the workspace export.** `exportWorkspace` carries meetings but not incidents yet, the
  same as it carries no decisions, KPIs or budgets.
