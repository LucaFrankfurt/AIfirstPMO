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
- **A messenger in the same box**, and made of the same rows — so a message sends
  from a train and arrives when the tunnel ends. None of the three has one:
  Plane and OpenProject send you to Slack, Confluence has comments. What that
  buys is not a feature so much as an absence — no second account, no second
  search, no second place a decision might be recorded. See [`chat.md`](chat.md).
- **One container, no database to run.** SQLite in the data volume, one Node
  process. Confluence and OpenProject both want a Postgres and a few gigabytes
  of RAM before they say hello.
- **A manual inside the product**, animated and narrated, in three languages,
  with a first-run tour that configures the instance as it goes.
- **A timer that is a database row**, so it survives a reload, a second device
  and a tunnel — see [`time.md`](time.md).
- **An import that shows you what it read before it writes**, and names the
  spreadsheet row of everything it could not — see [`import.md`](import.md).
- **Templates and rules whose recipients are selectors**, not stored names — see
  [`automation.md`](automation.md).

## Against Confluence

Kolibri has: nested markdown pages, version history with restore *and a diff*,
labels and filtering, watching, page templates, per-page visibility, markdown
export, printing to PDF, public read-only share links, drag-and-drop images,
attachments, comments with @mentions on every page — including **inline
comments** on a selected passage, which survive the passage being edited around
— and full-text search across pages and tasks.

| Missing | Weight | Note |
|---|---|---|
| **Export** to Word | Low | A markdown bundle is built — the page and everything under it — and printing (which is how a PDF is made) is built on the browser's own engine rather than a renderer here |
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
| ~~**Import** from Jira/Linear/Plane's own formats~~ | **Done** | Recognised by shape and converted, with what cannot come across listed before the import — plus CSV with a preview and a per-row report, and a JSON round trip between Kolibri instances. Written against each tool's documented shape, never against a real export |
| ~~**Intake / triage** — an inbox for reports from outside~~ | **Done** | A share link that is a *form*: what somebody outside sends waits under Reports until a member accepts it, and only then is it a task |

Custom fields used to head this list and are now built — nine kinds, per project, each limited to
the work item types it belongs on, and views filter and group by them.

## Against OpenProject

The widest gap, because this is a different genre — classic, plan-driven project
management with money in it.

| Missing | Weight | Note |
|---|---|---|
| **Cost tracking**, hourly rates, budgets | High | Time itself is tracked; money is not |
| **Reports** — cost and utilisation | High | Progress across projects is built (the portfolio); money is not |
| **Capacity in hours** | Medium | A team planner is built — a row per person, load counted in tasks running at once. Hours would need estimates to carry a unit, which is a decision about how a team plans |
| **Type-dependent workflows** | Medium | Type-dependent *fields* are built: a field names the types it is asked on. A workflow that changes per type is not |
| Meetings module (agenda, minutes), forums, news, documents | Depends on audience | |
| ~30 interface languages | Low each | Kolibri has two, and adding one is a typed catalogue file |
| BITV / WCAG certification | Unverified | Kolibri has never been audited |

## Across all three: running it in a company

The category where Kolibri has least and all three have something. Parts of it
are **P1** in `TODO.md`, which is to say: known, and not yet done. Rate limiting,
the Content-Security-Policy header, refusing cross-site-forgeable content types
and single sign-on used to head this list and are now built.

| Missing | Note |
|---|---|
| **SSO — SAML / LDAP** | OIDC is built (see `docs/deployment.md`). SAML and LDAP are not, nor is mapping provider groups onto roles |
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
| ~~4b~~ | ~~Custom fields, type-dependent~~ | **Done** — nine kinds, per project, limited to work item types, over MCP too | |
| ~~4c~~ | ~~Sub-projects, project copying, portfolio~~ | **Done** — nesting, any project as a template, and a roadmap across all of them | |
| ~~5~~ | ~~SSO (OIDC first)~~ | **Done** — code flow with PKCE, optional password lockout, tested against a real signing provider | |
| 6 | **Cost on top of time** — rates, budgets, reports | Time is tracked and `billable` is stored; nothing reads it. This is where OpenProject is genuinely ahead | medium |
| ~~7~~ | ~~Gantt with dependency scheduling~~ | **Done** — drag to move, arrows for `blocks`, successors follow, baselines behind | |
| ~~8~~ | ~~Trash / archive browser~~ | **Done** — Settings → Data, with a way back | |

Item 6 is what is left of this list, and the user has parked it.

## What has been closed

For anyone reading this against an older revision: saved views, page comments
and mentions in pages, rate limiting and the content policy, multi-select with
bulk actions, the table layout, and time tracking were all on the list above and
are now built. The tables further up reflect that.
