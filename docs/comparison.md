# What Kolibri does not do yet

An honest gap analysis against the three tools Kolibri is most often compared
to: **Confluence** (wiki), **Plane** (issue tracker) and **OpenProject**
(classic project management).

Two caveats before the tables.

- The **Kolibri column is verified against this codebase**, not remembered. If
  something is listed as missing here, `grep` says it is missing.
- The **other three are not**. Their feature sets come from general knowledge
  and they move — Plane in particular ships quickly. Treat the comparison side
  as "roughly current", not as a specification. Check before quoting it at
  somebody.

Nothing here is a promise. It is a map of where the edges are, so a decision to
build or not to build is made with the edges visible. The prioritised end of it
lives in [`TODO.md`](../TODO.md).

## Where Kolibri is ahead

Worth stating first, because it is the reason the gaps below are acceptable:

- **Offline-first with per-field merge.** Two people editing the same task while
  one is on a train both keep their change. None of the three do this; they are
  all request/response applications with a spinner.
- **MCP natively.** An assistant is a user with a scoped token, not a plugin or
  a chat sidebar. 21 tools over the same permissions as a person.
- **One container, no database to run.** SQLite in the data volume, one Node
  process. Confluence and OpenProject both want a Postgres and a few gigabytes
  of RAM before they say hello.
- **A manual inside the product**, animated and narrated, in two languages.
- **Templates and rules whose recipients are selectors**, not stored names — see
  [`automation.md`](automation.md).

## Against Confluence

Kolibri has: nested markdown pages, version history with restore, drag-and-drop
images, attachments, full-text search across pages and tasks.

| Missing | Weight | Note |
|---|---|---|
| **Comments on pages** | High | `comment.page_id` exists in the data model and syncs; there is no interface for it |
| **Inline comments** (select text → comment) | High | The thing Confluence is actually used for |
| **@mentions inside page content** | Medium | `findMentions` runs over `task.description` and `comment.body` only; page bodies are never scanned |
| **Version diff** | Medium | History and restore work; "what changed" does not exist |
| **Page templates / blueprints** | Medium | Templates exist, but only for tasks |
| **Labels on pages**, and filtering by them | Medium | |
| **Watch a page** → notified on change | Medium | |
| **Page permissions in the interface** | Medium | The `access` column (`workspace`/`project`/`private`) is stored and synced but never set by any screen |
| **Export** to PDF / Word / a markdown bundle | Medium | |
| Emoji reactions | Low | `reactions` is stored and synced; no picker, no display |
| Macros — table of contents, cross-page task lists, embeds | Low–medium | |
| A table editor | Low | Markdown tables render; they cannot be edited as tables |
| Spaces as a separate container concept | Design difference | Workspace + project carries most of it |
| Whiteboards, databases | Out of scope | A different product |

## Against Plane

The closest of the three. Kolibri has cycles, modules, board/list/calendar,
labels, per-project workflow states, estimates, sub-tasks, relations, pages —
and templates with rules, which Plane does not have in this form.

| Missing | Weight | Note |
|---|---|---|
| **Saved views with an interface** | High | The `view` entity syncs, the seed creates one, the server serves them; there is no screen to save or load one. The largest gap between the data model and what you can click |
| **Table and Gantt layouts** | High | `LAYOUTS` declares five; three are built |
| **Analytics** — burn-down/up, throughput, cycle time | High | |
| **Import** from Jira / CSV / GitHub | High | The single biggest adoption blocker: nobody migrates without it |
| **Integrations** — GitHub/GitLab commit linking, Slack | High | |
| **Time tracking** | High | Estimates exist; logged time does not |
| **Work item types** (bug / feature / epic) | Medium–high | There is no `type` on a task, only labels |
| **Custom fields** | High | Invasive in the data model |
| **Intake / triage** — an inbox for reports from outside | Medium | |
| **Multi-select and bulk actions** | Medium | `POST /tasks/bulk` exists and is tested; the UI has no multi-select |
| **Trash / archive browser** | Medium | Everything is soft-deleted and recoverable in the database; no screen shows it |
| Recurring tasks | Medium | |
| Precise drop position on the board | Low | A drop appends to the end of the column |
| Avatar upload | Low | `users.avatar_url` is respected everywhere; nothing sets it |
| Per-task notification opt-out | Low | `subscribers` is stored and used; nothing toggles it |

## Against OpenProject

The widest gap, because this is a different genre — classic, plan-driven project
management with money in it.

| Missing | Weight | Note |
|---|---|---|
| **Gantt with real scheduling** | High | Relations exist (`blocks`, `relates_to`, …) but nothing reschedules: moving a predecessor moves nothing |
| **Time and cost tracking**, hourly rates, budgets | High | |
| **Reports** — cost, utilisation, progress across projects | High | |
| **Resource and capacity planning**, team planner | High | |
| **Work package types with type-dependent forms and workflows** | High | |
| **Status transition rules per role** (who may move what, where) | Medium–high | |
| **Sub-projects** | Medium | Projects are flat; teams group them but do not nest them |
| **Project templates** | Medium | Task templates exist; copying a whole project does not |
| **Portfolio / roadmap across projects** | Medium | |
| **Baselines** (plan vs. actual) | Medium | |
| Meetings module (agenda, minutes), forums, news, documents | Depends on audience | |
| WIP limits on boards | Low | |
| ~30 interface languages | Low each | Kolibri has two, and adding one is a typed catalogue file |
| BITV / WCAG certification | Unverified | Kolibri has never been audited |

## Across all three: running it in a company

The category where Kolibri has least and all three have something. Parts of it
are **P1** in `TODO.md`, which is to say: known, and not yet done. Rate limiting
and the Content-Security-Policy header used to head this list and are now built.

| Missing | Note |
|---|---|
| **SSO** (OIDC / SAML / LDAP) | Non-negotiable past roughly fifty people |
| **Two-factor authentication** | |
| **Workspace-wide audit log** | Activity is recorded per task; there is no global view |
| **Session management** — list devices, revoke one | Changing the password invalidates all of them, which is the blunt version |
| **Outgoing webhooks** | Rules only act inwards |
| Multi-node / high availability | Deliberate: the sequence counter, the SSE bus and the mail worker live in the process |

## What to build next

Ordered by value per unit of work, not by size.

| # | What | Why now | Effort |
|---|---|---|---|
| 1 | Saved views (interface) | Data and sync are finished; only the screen is missing | small |
| 2 | Page comments + mentions in pages | Makes the wiki collaborative rather than a read-only shelf; the data model is already there | small–medium |
| ~~3~~ | ~~Rate limiting + CSP~~ | **Done** — see `lib/ratelimit.ts` and `lib/csp.ts` | |
| 4 | Multi-select and the table layout | Everyday work; the bulk API already exists | medium |
| 5 | Time tracking | Prerequisite for everything cost-related, and the most common single request for tools like this | medium |
| 6 | Import (CSV first, then Jira/Plane) | Nobody migrates without it | medium |
| 7 | Gantt with dependencies | The largest single piece missing against OpenProject | large |
| 8 | SSO | The gate on company adoption | large |

Items 1 to 3 are one sitting. Items 7 and 8 are projects.
