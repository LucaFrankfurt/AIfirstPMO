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
  a chat sidebar. 23 tools over the same permissions as a person.
- **One container, no database to run.** SQLite in the data volume, one Node
  process. Confluence and OpenProject both want a Postgres and a few gigabytes
  of RAM before they say hello.
- **A manual inside the product**, animated and narrated, in two languages, with
  a first-run tour that configures the instance as it goes.
- **A timer that is a database row**, so it survives a reload, a second device
  and a tunnel — see [`time.md`](time.md).
- **An import that shows you what it read before it writes**, and names the
  spreadsheet row of everything it could not — see [`import.md`](import.md).
- **Templates and rules whose recipients are selectors**, not stored names — see
  [`automation.md`](automation.md).

## Against Confluence

Kolibri has: nested markdown pages, version history with restore *and a diff*,
labels and filtering, watching, page templates, per-page visibility, markdown
export, drag-and-drop images, attachments, comments with @mentions on every
page, full-text search across pages and tasks.

| Missing | Weight | Note |
|---|---|---|
| **Inline comments** (select text → comment) | High | The thing Confluence is actually used for |
| **Export** to PDF or Word | Low–medium | A markdown bundle is built — the page and everything under it. PDF needs a renderer and is worse at not locking writing in |
| Macros — table of contents, cross-page task lists, embeds | Low–medium | |
| A table editor | Low | Markdown tables render; they cannot be edited as tables |
| Spaces as a separate container concept | Design difference | Workspace + project carries most of it |
| Whiteboards, databases | Out of scope | A different product |

## Against Plane

The closest of the three. Kolibri has cycles, modules, list/board/table/calendar,
saved views, multi-select with bulk actions, labels, per-project workflow states,
estimates, time tracking, sub-tasks, relations, pages — and templates with rules,
which Plane does not have in this form.

| Missing | Weight | Note |
|---|---|---|
| **Gantt layout** | High | `LAYOUTS` declares five; four are built. Gantt needs scheduling, not a layout |
| **Analytics across projects** | Medium | Per project is built — throughput, burn-up, cycle time. Nothing aggregates a portfolio |
| **Import** beyond CSV | Medium | CSV is built, with a preview and a per-row report. Sub-task parents, relations and comments need a second pass |
| **Integrations** — GitHub/GitLab commit linking, Slack | High | |
| **Custom fields** | High | Invasive in the data model |
| **Intake / triage** — an inbox for reports from outside | Medium | |
| Recurring tasks | Medium | |

## Against OpenProject

The widest gap, because this is a different genre — classic, plan-driven project
management with money in it.

| Missing | Weight | Note |
|---|---|---|
| **Gantt with real scheduling** | High | Relations exist (`blocks`, `relates_to`, …) but nothing reschedules: moving a predecessor moves nothing |
| **Cost tracking**, hourly rates, budgets | High | Time itself is tracked; money is not |
| **Reports** — cost, utilisation, progress *across* projects | High | Per-project progress is built; money and portfolio-wide are not |
| **Resource and capacity planning**, team planner | High | |
| **Type-dependent forms and workflows** | High | Types themselves are built; a form that changes per type is custom fields with a visibility rule |
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
are **P1** in `TODO.md`, which is to say: known, and not yet done. Rate limiting,
the Content-Security-Policy header and refusing cross-site-forgeable content
types used to head this list and are now built.

| Missing | Note |
|---|---|
| **SSO** (OIDC / SAML / LDAP) | Non-negotiable past roughly fifty people |
| **Two-factor authentication** | |
| **Workspace-wide audit log** | Activity is recorded per task; there is no global view |
| **Session management** — list devices, revoke one | Changing the password invalidates all of them, which is the blunt version |
| **Outgoing webhooks** | Rules only act inwards |
| Multi-node / high availability | Deliberate: the sequence counter, the SSE bus and the mail worker live in the process |

## What to build next

Re-ordered as things get built. Everything above the line in the earlier
revision of this file is done; what follows is what is actually left, ordered by
value per unit of work rather than by size.

| # | What | Why it is next | Effort |
|---|---|---|---|
| ~~1~~ | ~~Import — CSV~~ | **Done** — mapping guessed, dry run, per-row report. What is left is the parts CSV cannot carry | |
| ~~2~~ | ~~Work item types~~ | **Done** — per project, grouped and filtered by. Type-*dependent fields* are custom fields, below | |
| ~~3~~ | ~~Analytics~~ | **Done** — per project, computed from the local mirror | |
| ~~4~~ | ~~Page extras~~ | **Done** — labels, watching, diff, templates, access, markdown export | |
| 5 | **SSO** (OIDC first) | The gate on adoption past roughly fifty people. Nothing in the auth layer anticipates it, so it is a project | large |
| 6 | **Cost on top of time** — rates, budgets, reports | Time is tracked and `billable` is stored; nothing reads it. This is where OpenProject is genuinely ahead | medium |
| 7 | **Gantt with dependency scheduling** | Relations exist but nothing reschedules. The largest single piece missing, and the hardest to do without making it wrong | large |
| ~~8~~ | ~~Trash / archive browser~~ | **Done** — Settings → Data, with a way back | |

Items 1 and 8 are each a sitting. Items 5 and 7 are projects.

## What has been closed

For anyone reading this against an older revision: saved views, page comments
and mentions in pages, rate limiting and the content policy, multi-select with
bulk actions, the table layout, and time tracking were all on the list above and
are now built. The tables further up reflect that.
