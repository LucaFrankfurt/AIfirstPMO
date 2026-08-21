# What Kolibri does not do yet

An honest gap analysis against the five tools Kolibri is most often compared to: **Jira** (the
default), **Confluence** (wiki), **Plane** (issue tracker), **Vikunja** (self-hosted task manager)
and **OpenProject** (classic, plan-driven project management).

Two caveats before the tables.

- The **Kolibri column is verified against this codebase**, not remembered. If something is listed
  as missing here, `grep` says it is missing.
- The **other five are not**. Their feature sets come from their own documentation and from
  general knowledge, and they move. Treat that side as "roughly current", not as a specification.
  Check before quoting it at somebody.

Nothing here is a promise. It is a map of where the edges are, so a decision to build or not to
build is made with the edges visible. The prioritised end of it lives in [`TODO.md`](../TODO.md).

## Where Kolibri is ahead

Worth stating first, because it is the reason the gaps below are acceptable:

- **Offline-first with per-field merge.** Two people editing the same task while one is on a train
  both keep their change. None of the five do this; they are all request/response applications with
  a spinner. Vikunja comes closest by syncing to a calendar client, which is a different thing.
- **MCP natively.** An assistant is a user with a scoped token, not a plugin or a chat sidebar. 23
  tools over the same permissions as a person, and a read-only token is refused by all nine that
  write. Jira has AI features; none of the five is an MCP server you can point a client at.
- **A messenger in the same box**, and made of the same rows — so a message sends from a train and
  arrives when the tunnel ends. None of the five has one: Plane, Vikunja and OpenProject send you to
  Slack, Confluence has comments, Jira has comments and a Slack app. What that buys is not a feature
  so much as an absence — no second account, no second search, no second place a decision might be
  recorded. See [`chat.md`](chat.md).
- **One container, no database to run.** SQLite in the data volume, one Node process, zero runtime
  npm dependencies on the server. Confluence, Jira and OpenProject all want a Postgres and a few
  gigabytes of RAM before they say hello; Vikunja is the only one in the same weight class.
- **A manual inside the product**, animated and narrated, in three languages, with a first-run tour
  that configures the instance as it goes.
- **A timer that is a database row**, so it survives a reload, a second device and a tunnel — see
  [`time.md`](time.md).
- **An import that shows you what it read before it writes**, and names the spreadsheet row of
  everything it could not — see [`import.md`](import.md).
- **Templates and rules whose recipients are selectors**, not stored names — see
  [`automation.md`](automation.md).
- **The interface is measured rather than reviewed.** Four scripts drive a real browser: contrast
  against the background each element actually sits on, layout from 340px to 1600px, accessible
  names and 24px targets, and every class the source uses. See [`design.md`](design.md).

## Against Jira

The tool most people are leaving, and the one whose absence is felt in specific places rather than
broadly. Kolibri has: projects with their own workflow states, work item types per project, custom
fields limited to the types they belong on, sub-tasks, relations, cycles (sprints) with burn-up,
estimates, saved views, bulk edit, an audit log, rules that fire on an event, scoped API tokens,
signed webhooks out and commit-linking webhooks in.

| Missing | Weight | Note |
|---|---|---|
| **A query language.** JQL is the thing Jira users actually miss | **High** | Filters here are structured — a column, a set of values. There is no way to write `assignee = me AND due < 7d AND state != done ORDER BY priority`, and no way to save one as text, share it, or paste it into a webhook |
| **Dashboards you compose** — gadgets, per-user, across projects | Medium–high | Insights is a fixed set of three charts per project; the portfolio is a fixed roadmap. Neither is arrangeable and neither crosses to "my dashboard" |
| **Workflow *schemes*** — a workflow shared by several projects, versioned | Medium | States are per project and copied when a project is copied. Changing "the workflow" everywhere means changing each project |
| **Transition rules beyond who** — required fields on a transition, validators, post-functions | Medium | Kolibri has per-column rules for *who* may move work where. It has no "you may not close this without a resolution" |
| **SLAs and service management** | Low, unless you run a helpdesk | Intake is built; the clock, the calendar and the breach are not. This is a different product's job |
| **Marketplace / apps** | Out of scope | Deliberately. The extension surface here is the REST API, webhooks and MCP |
| Plans / Advanced Roadmaps — cross-project capacity scenarios | Low–medium | The portfolio and the team planner cover the reading half; there is no scenario modelling |

## Against Confluence

Kolibri has: nested markdown pages that two people can edit at once (the body is a CRDT), version
history with restore *and* a diff, labels and filtering, watching, page templates, per-page
visibility, markdown export, printing to PDF, public read-only share links, drag-and-drop images,
attachments, comments with @mentions on every page — including **inline comments** on a selected
passage, which survive the passage being edited around — and full-text search across pages and
tasks.

| Missing | Weight | Note |
|---|---|---|
| **Export** to Word | Low | A markdown bundle is built — the page and everything under it — and printing (which is how a PDF is made) is built on the browser's own engine rather than a renderer here |
| Macros — table of contents, cross-page task lists, embeds | Low–medium | A table of contents is the cheapest of these and the most asked for |
| A table editor | Low | Markdown tables render; they cannot be edited as tables |
| Spaces as a separate container concept | Design difference | Workspace + project carries most of it |
| Whiteboards, databases | Out of scope | A different product |

## Against Plane

The closest of the five. Kolibri has cycles, modules, list/board/table/calendar, saved views,
multi-select with bulk actions, labels, per-project workflow states, estimates, time tracking,
sub-tasks, relations, pages — and templates with rules, which Plane does not have in this form.

Nothing structural is missing. Import and intake, which used to head this list, are both built:
exports from Jira, Linear, Plane and OpenProject are recognised by shape and converted with a list
of what cannot come across shown *before* the write, and a share link can be a form whose
submissions wait under Reports until a member accepts them.

## Against Vikunja

The one closest to Kolibri in spirit — small, self-hosted, one binary, no Postgres required — and
the comparison that produces the most buildable list, because everything it has that Kolibri lacks
is small.

Kolibri has more of almost everything structural: cycles, modules, sub-projects, a portfolio, page
wiki, chat, time tracking, custom fields, automation, MCP. What Vikunja has that Kolibri does not is
a handful of ergonomics that people are unreasonably attached to.

| Missing | Weight | Note |
|---|---|---|
| **CalDAV** — tasks in Thunderbird, DAVx5, iOS Reminders | **High for the value** | Kolibri has no calendar protocol at all: no CalDAV, no `VTODO`, not even a read-only `.ics` feed of due dates. This is the single biggest "it does not fit my life" gap, and a subscribable feed is a fraction of the work of full CalDAV |
| **Natural-language quick add** — `Call client !2 *weekly +work @alice due:Friday` | **High for the work** | `QuickAdd` is a form with dropdowns. Parsing the same tokens out of the title would be one shared module, testable without a browser, and usable by the MCP `create_task` tool for free |
| **Import from Todoist, Trello, Microsoft To-Do** | Medium | Kolibri reads Jira, Linear, Plane, OpenProject and CSV. Trello in particular is what small teams are leaving |
| Per-task reminders at an arbitrary time | Low–medium | Reminders exist, relative to a due date. "Remind me Thursday at 09:00" does not |
| A published mobile app | Low | The PWA is installable and the layout is built for a phone |

## Against OpenProject

The widest gap, because this is a different genre — classic, plan-driven project management with
money in it.

| Missing | Weight | Note |
|---|---|---|
| **Cost tracking**, hourly rates, budgets | High | Time itself is tracked and `billable` is stored; nothing reads it. This is where OpenProject is genuinely ahead |
| **Reports** — cost and utilisation | High | Progress across projects is built (the portfolio); money is not |
| **Meetings** — agenda, minutes, attendees, follow-ups | Medium | Nothing at all. Pages plus a template covers the artefact but not the workflow |
| **Capacity in hours** | Medium | A team planner is built — a row per person, load counted in tasks running at once. Hours would need estimates to carry a unit, which is a decision about how a team plans |
| **Type-dependent workflows** | Medium | Type-dependent *fields* are built: a field names the types it is asked on. A workflow that changes per type is not |
| Forums, news, documents | Depends on audience | Chat covers the forum case better than a forum does |
| BIM / construction | Out of scope | An entire edition of a different product |
| ~30 interface languages | Low each | Kolibri has three, and adding one is a typed catalogue file |
| BITV / WCAG certification | Unverified | Kolibri has never been audited. `check:a11y` and `check:contrast` measure specific things well; neither is an accreditation |

## Across all of them: running it in a company

The category where Kolibri has least and all five have something. Rate limiting, the
Content-Security-Policy, refusing cross-site-forgeable content types, single sign-on, and the
workspace isolation and injection work all used to be here and are now built — see
[`security.md`](security.md).

| Missing | Note |
|---|---|
| **SSO — SAML / LDAP** | OIDC is built, including mapping provider groups onto roles (see `deployment.md`). SAML and LDAP are not |
| **SCIM provisioning** | Accounts are created on first sign-in or by invite; there is no directory push |
| Multi-node / high availability | Deliberate: the sequence counter, the SSE bus and the mail worker live in the process |
| An external audit | Nobody outside this repository has reviewed the security model |

## What to build next

Re-ordered as things get built, by value per unit of work rather than by size. Everything above the
line in earlier revisions is done; what follows is what is actually left.

| # | What | Why it is next | Effort |
|---|---|---|---|
| 1 | **An `.ics` feed** — one subscribable URL per person or per saved view, due dates as events | The biggest "it does not fit my life" gap, and the cheapest thing on this list. A share-style token, a text serialiser, no new storage. Full CalDAV write-back is the sequel, not the prerequisite | small |
| 2 | **Natural-language quick add** — `!2`, `@alice`, `+project`, `due:friday`, `*weekly` | One shared parser, tested without a browser, and the MCP `create_task` tool gets it for nothing. Vikunja's most-loved feature and the smallest of its advantages to close | small |
| 3 | **A saved filter as text** — a small query language over the fields views already filter on | The one thing Jira leavers ask for by name. Kolibri already has the filter *model*; this is a parser onto it plus a printer back, so a filter can be shared, pasted and put in a webhook | medium |
| 4 | **Trello and Todoist importers** | The two exports small teams arrive with. `foreign.ts` already recognises four shapes; these are two more entries in the same registry | small |
| 5 | **A table of contents, and a cross-page task list** | The only Confluence macros anybody actually misses. The renderer already produces the headings and already parses task items | small |
| 6 | **Cost on top of time** — rates, budgets, a cost report | Time is tracked and `billable` is stored; nothing reads it. Where OpenProject is genuinely ahead, and parked rather than rejected | medium |
| 7 | **Composable dashboards** — arrange the charts that exist, per person, across projects | Insights and the portfolio already compute everything; what is missing is letting somebody choose the arrangement | medium |
| 8 | **Transition validators** — required fields, a resolution on close | The per-column *who* rule is built; the *what* rule is not. Small in the schema, fiddly in the interface | medium |
| 9 | **Meetings** — agenda, minutes, follow-ups that become tasks | Only worth it for the audience that asks for OpenProject by name | medium–large |
| 10 | **SAML / LDAP** | Asked for by exactly the organisations that will not adopt without it, and by nobody else | large |

Items 1, 2, 4 and 5 are the ones that are small **and** wanted. They would be a good next block.

## What has been closed

For anyone reading this against an older revision: saved views, page comments and mentions in pages,
rate limiting and the content policy, multi-select with bulk actions, the table layout, time
tracking, CSV and foreign import, intake, custom fields, sub-projects and the portfolio, OIDC,
Gantt with dependency scheduling, the trash browser, presence and typing indicators, and the
accessibility pass were all on the lists above and are now built. The tables reflect that.
