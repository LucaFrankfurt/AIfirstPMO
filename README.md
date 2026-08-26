<div align="center">

<img src="packages/web/public/icon-192.png" width="72" height="72" alt="" />

# Kolibri

**Open source projects, tasks and pages. Offline-first, self-hosted, MCP-native.**

[![CI](https://github.com/LucaFrankfurt/AIfirstPMO/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaFrankfurt/AIfirstPMO/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-5FA04E.svg)](https://nodejs.org)

[Live demo](https://demo.kolibri.day) · [Manual](https://docs.kolibri.day) · [Quick start](#quick-start) · [Architecture](docs/architecture.md)

</div>

---

Kolibri is a project and work management tool in the spirit of OpenProject and Plane, built around
three convictions:

1. **The interface should never wait for the network.** Every screen reads from a local copy of the
   workspace, so it is instant on a train, on a plane and on hotel wifi. Changes queue up and merge
   field by field when you come back.
2. **Self-hosting should be boring.** One command brings up a complete, self-configuring stack; the
   app itself is one Node process and a SQLite file you can copy — no Postgres, no Redis, no worker
   queue. Strip it down to a single container when that is all you want.
3. **An assistant is a first-class user.** Kolibri speaks the Model Context Protocol natively, so an
   AI can read the backlog, file issues, move them through the workflow and write documentation with
   exactly the permissions you grant it.

<table>
  <tr>
    <td width="50%"><img src="docs/images/board.png" alt="Kanban board" /></td>
    <td width="50%"><img src="docs/images/task-dark.png" alt="Task detail in dark mode" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/pages.png" alt="Wiki page" /></td>
    <td align="center"><img src="docs/images/mobile.png" alt="Mobile layout" width="55%" /></td>
  </tr>
</table>

## Contents

[Quick start](#quick-start) · [Features](#features) · [Connect an assistant](#connect-an-assistant-mcp) ·
[How offline sync works](#how-offline-sync-works) · [Documentation](#documentation) ·
[Development](#development) · [Project layout](#project-layout) · [Contributing](#contributing)

## Quick start

Or try it first: **[demo.kolibri.day](https://demo.kolibri.day)** is a real instance with a workspace
already in it, wiped back to its starting state on a schedule.

**Requirements** — Docker with Compose v2, or Node 22.18+ for a source install. Nothing else: SQLite
is built into Node, and the server runs TypeScript directly.

```bash
git clone https://github.com/LucaFrankfurt/AIfirstPMO.git kolibri
cd kolibri
docker compose up -d --build
open http://localhost:4000
```

That is the whole installation. It brings up the app and an S3-compatible object store for uploads,
**already wired to each other** — the bucket is created on first boot and nothing has to be
configured afterwards.

| | |
|---|---|
| App | <http://localhost:4000> |
| Object store console | <http://localhost:9001> — login is `KOLIBRI_S3_ACCESS_KEY` / `KOLIBRI_S3_SECRET_KEY`, bound to localhost |

### Claiming the instance

The first account created in the browser owns the instance. To skip that step, set the owner in
`.env` before the first start and the account exists the moment the stack is up:

```bash
cp .env.example .env
# KOLIBRI_ADMIN_EMAIL=you@example.com
# KOLIBRI_ADMIN_PASSWORD=something long
# KOLIBRI_SEED_DEMO=true      ← optional demo workspace to look around in
docker compose up -d --build
```

Either way, set `KOLIBRI_ALLOW_SIGNUP=false` afterwards and invite the rest of the team from
**Settings → Members**.

### Email

Email is **off** until `KOLIBRI_SMTP_URL` points at a relay you control — notifications live in the
in-app inbox either way. To try delivery locally, add the dev overlay, which runs a capture inbox
(Mailpit on <http://localhost:8025>) and wires the app to it:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Kolibri recognises a capture inbox and labels it as such in the log, in `/api/health` and in the
settings screen, so it can never be mistaken for real delivery.

### Variants

```bash
docker compose -f docker-compose.lite.yml up -d --build   # single container, uploads on the volume
docker compose --profile tls up -d                        # + Caddy, automatic HTTPS for KOLIBRI_DOMAIN
```

Put `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` in `.env` and plain `docker compose up -d`
picks up the overlay every time.

Deploying on **Coolify** or a similar PaaS? Use the Docker Compose build pack with
`docker-compose.coolify.yml` — it drops the host port mappings, fixed container names and the bundled
TLS proxy, because the platform provides all three. See
[`docs/deployment.md`](docs/deployment.md#coolify-and-other-paas).

### From source

```bash
npm install
npm run build          # bundles the web app into packages/web/dist
npm run seed           # optional demo workspace (ada@kolibri.dev / kolibri-demo)
npm start              # http://localhost:4000
```

## Features

Each line links to the long version. The manual for *using* Kolibri is
[docs.kolibri.day](https://docs.kolibri.day) and the guide inside the app; the files under `docs/`
are the manual for running and extending it.

| | |
|---|---|
| **Work tracking** | A whole task typed on one line — `Redraw the empty state !high @ada #WEB *design due:friday` — with sub-tasks, relations, priorities, estimates, labels, due dates and custom fields in nine kinds. Archiving, CSV import with a preview before anything is written, readers for Jira, Linear, Plane, OpenProject, Trello and Todoist exports, and a JSON round trip that moves a whole project to another Kolibri. [Syntax](docs/query.md) · [Import](docs/import.md) |
| **Getting it back out** | A whole workspace as one readable document — every project, the teams, the pages, the saved views, and the wiring between projects a per-project export cannot hold — or as a `.zip` with the uploaded files beside it. Tasks as CSV in the columns the importer reads back. "Download my data" for one person, with none of their secrets in it. And an import that goes into a new project or merges into one you already have. [Export](docs/export.md) |
| **Moving house** | Snapshots taken nightly, verified before the older ones are pruned, optionally copied to the object store — and put back **from the app**, while it is running: deploy a Kolibri somewhere new, upload the snapshot, sign in with your old password, and it *is* the old instance. Accounts, workspaces, files and settings included. It replaces the tables in one transaction rather than swapping the file, so an older snapshot still restores and what it replaces is snapshotted first. [Backups](docs/deployment.md#backups) |
| **Planning** | Cycles (sprints) for one project, a chosen set of them, or all — one fortnight several teams run together rather than a copy in each. Modules (milestones) scoped the same way, a timeline where dragging a task moves everything blocked by it — counted in working days, with an optional wait per dependency, and applied on the server too. Baselines, WIP limits, projects that nest (including **containers** that hold only other projects), teams, project templates, time tracking, per-project insights, a portfolio roadmap and a team planner where dragging a task between rows hands it over. [Insights](docs/insights.md) · [Time](docs/time.md) |
| **Views** | List, Kanban, sortable table and calendar; group by state, assignee, cycle, project or a custom field, where dropping a card writes the answer. Filter with the menus or **as text** — `assignee = me AND priority in (urgent, high) AND state != Done` — which prints back from whatever the menus did. Select several tasks and change them together. Save, pin and share a view. [Filter language](docs/query.md) |
| **Pages** | A nested markdown wiki two people can edit at once: bodies are text CRDTs, so both sets of changes survive. Version history with a what-changed diff, templates, labels, watching, per-page visibility, read-only share links, drag & drop images, export as a markdown bundle or PDF, and inline comments that survive the text being edited around them. |
| **Chat** | Channels and direct messages made of the same synced rows as everything else, so a message sends from a train and arrives when the tunnel ends — no socket to reconnect. Private channels with their own membership rules, pasted screenshots, reactions, replies, per-conversation mention settings, and presence held in memory rather than in a row. [Details](docs/chat.md) |
| **Offline & sync** | A full IndexedDB mirror, an outbox with retry, and hybrid-logical-clock last-writer-wins **per field**, so two people editing one task offline both keep their change. Deletes are tombstones and can be restored. Installable PWA. [Protocol](docs/sync.md) |
| **Automation** | Task templates whose checklists become sub-tasks, repeating tasks, and rules that file work when something happens — including *n* days before a due date. Recipients are selectors (the lead, whoever is on it, a team), so they keep meaning the right people. [Details](docs/automation.md) |
| **Notifications** | In-app inbox; optional email batched into one message per person, with digests, reminders, per-user preferences, signed one-click unsubscribe, retry on failure and automatic suppression of hard bounces; native push sent with no payload; and Telegram, where each person connects their own chat and nothing ever learns a phone number. [Details](docs/notifications.md) |
| **Collaboration** | Comments with markdown, attachments and reactions on tasks *and* pages; `@mentions` with autocomplete; following; a per-task activity trail; invite links; roles (owner / admin / member / guest); private projects. |
| **Intake** | A link that is a form, for people who have no account and should not need one — no session, no script, works on any phone. What arrives waits in a queue and becomes a task only when somebody accepts it. |
| **Search** | Instant local title search plus SQLite FTS5 full text across tasks, pages, comments, projects, cycles and chat messages — where a private conversation is checked against its membership before the page of results is trimmed, so it cannot even push a readable hit off the end. |
| **Files** | Content-addressed uploads with de-duplication, client-side image downscaling and offline caching; on the data volume by default, or in any S3-compatible bucket (MinIO, Ceph, R2, AWS) with pre-signed downloads. [Storage](docs/storage.md) |
| **Calendar** | A subscribable `.ics` link per person or per saved view — Google, Apple, Outlook, Thunderbird, DAVx5. The link does not exist until you ask for it, and one button makes every copy of the old one stop working. [Details](docs/calendar.md) |
| **Integration** | A REST API for every entity, scoped API tokens, signed outgoing webhooks (Slack and Discord shapes too) and incoming ones that link a commit to the task it names, plus an MCP server over HTTP and stdio with 50 tools, 5 prompts and page resources. [API](docs/api.md) · [MCP](docs/mcp.md) |
| **Task reviews** | Optional, manual and off by default: a button asks a model to read a task back and suggest clearer wording, with the replacement already written and applied only by a click. Anthropic, Gemini or OpenRouter, chosen by an environment variable. [What leaves the instance](docs/ai.md) |
| **Languages** | English, German and French throughout — interface, notifications and emails, each in the recipient's own language. French is machine-written and says so under the language picker, because an unchecked translation is worth having and worth admitting to. [Adding one](docs/i18n.md) |
| **Learning it** | A first-run tour that sets the instance up as it goes, a checklist ticked from your actual data, and a guide with animated, narrated diagrams of each area. A screen with nothing on it yet links to the card explaining what goes there. Press `?`. |
| **Deployment** | One command brings up app and object store, self-configuring: bucket created on boot, owner account and demo data from the environment, optional automatic HTTPS, and a dev overlay with a mail capture inbox. [TLS, backups, upgrades](docs/deployment.md) |
| **Hardening** | Rate limits on sign-in, registration and invite lookup, per account as well as per address. A CSP with no inline script, two-factor authentication with recovery codes, a revocable device list, OpenID Connect SSO with roles mapped from directory groups, per-column rules for who may move work where, and a workspace audit log. [Threat model](docs/security.md) |

## Connect an assistant (MCP)

Create a token under **Settings → API & MCP**, then point a client at the instance. Anything that
speaks streamable HTTP needs nothing installed — the tools are in the server:

```bash
claude mcp add --transport http kolibri https://kolibri.example.com/mcp \
  --header "Authorization: Bearer kol_…"
```

A client that only speaks stdio runs the bridge in `packages/mcp`, which pipes JSON-RPC to that same
endpoint. And **Claude on the web** takes neither: add the instance URL as a custom connector and
sign in when it asks — the instance is an OAuth authorization server for exactly that case, and what
it grants is an ordinary token you can revoke in Settings.

A read-only token (`scopes: "read"`) is refused for every write tool, so you can hand an assistant a
view of the backlog without handing it a pen.

**50 tools**, in six groups:

| | |
|---|---|
| Workspace | `list_workspaces`, `list_projects`, `create_project`, `update_project`, `list_members`, `search` |
| Tasks | `list_tasks`, `get_task`, `create_task`, `create_tasks_batch`, `update_task`, `delete_task`, `comment_task`, `create_task_relation`, `my_work` |
| Attachments | `upload_attachment`, `list_attachments`, `delete_attachment` |
| Planning | `list_cycles`, `create_cycle`, `update_cycle`, `delete_cycle`, `list_modules`, `create_module`, `update_module`, `delete_module`, `log_time`, `list_time`, `list_templates`, `apply_template` |
| Configuration | `list_states`, `create_state`, `update_state`, `list_labels`, `create_label`, `update_label` |
| Pages | `list_pages`, `get_page`, `create_page`, `update_page`, `list_page_templates`, `create_page_from_template` |
| Reports *(read-only)* | `project_status`, `changes_since`, `deadlines_at_risk`, `workload`, `blocked_tasks`, `stale_tasks`, `cycle_review`, `prepare_meeting` |

The six reports answer for the **whole workspace** unless narrowed to a project, because who is
overloaded is a question about a person and a person works in several. Each answers with a *reason*
rather than a list: "overdue" is a fact anybody can compute, and "due Thursday, still in Backlog,
nobody on it" is the sentence somebody acts on.

`prepare_meeting` is those six as one agenda, in the order a meeting runs — it calls the other
tools rather than repeating their queries, so a number in the agenda is the number the tool gives.

**5 prompts**: `weekly_review`, `meeting_notes`, `standup`, `sprint_planning`, `triage` — the list a
client offers under "add from Kolibri", which is not the tool list. Every tool, prompt and resource
with examples: [`docs/mcp.md`](docs/mcp.md).

## How offline sync works

```
 browser                                  server
┌──────────────────────────┐             ┌───────────────────────────────┐
│ UI reads from IndexedDB  │             │ SQLite, one row per entity    │
│           ▲              │  POST push  │ + per-field HLC stamps        │
│  writes ──┼──► outbox ───┼────────────►│ last-writer-wins per field    │
│           │              │             │ + monotonic `seq` counter     │
│  applyChanges ◄──────────┼─ GET pull ──┤ "everything after seq N"      │
│           ▲              │             │                               │
│           └──── SSE ─────┼─────────────┤ "workspace moved to seq N"    │
└──────────────────────────┘             └───────────────────────────────┘
```

Each mutation carries a hybrid logical clock stamp and a client-generated id. The server keeps a
stamp **per field**, so two people editing the same task offline — one the title, one the priority —
both keep their change instead of one silently winning. Replayed pushes are ignored by mutation id,
so a flaky connection cannot duplicate a task. Details and trade-offs:
[`docs/sync.md`](docs/sync.md).

## Documentation

**Using it** — the guide inside the app (press `?`) is the manual, and
**[docs.kolibri.day](https://docs.kolibri.day)** is the same manual as a website, written out at
length. Source in [`sites/docs`](sites/docs).

**Running it**

| | |
|---|---|
| [`deployment.md`](docs/deployment.md) | TLS, backups, upgrades, environment variables |
| [`storage.md`](docs/storage.md) | Disk vs. S3/MinIO, pre-signed downloads, migrating |
| [`security.md`](docs/security.md) | The threat model, what is checked and where, what has been reviewed and what has not |
| [`notifications.md`](docs/notifications.md) | In-app, email, Web Push and Telegram delivery, batching, mentions |
| [`i18n.md`](docs/i18n.md) | How a language is picked, and how to add one |
| [`import.md`](docs/import.md) | Bringing a backlog in from a CSV or another tool's export, and what it does with a row it cannot read |
| [`export.md`](docs/export.md) | Taking a workspace, a project or your own data out — and the difference between an export and a backup |
| [`ai.md`](docs/ai.md) | The optional task review: what leaves the instance, the two switches, and the one function that trusts a model |

**Building on it**

| | |
|---|---|
| [`architecture.md`](docs/architecture.md) | How the pieces fit together, including [why there is no Redis or Postgres](docs/architecture.md#why-no-redis-or-postgres--and-why-s3-and-email-are-optional) |
| [`sync.md`](docs/sync.md) | The offline protocol, conflict rules and failure modes |
| [`api.md`](docs/api.md) | REST endpoints, auth, uploads |
| [`mcp.md`](docs/mcp.md) | Every tool, prompt and resource with examples |
| [`query.md`](docs/query.md) | The two small languages: a task on one line, and a filter as text |
| [`automation.md`](docs/automation.md) | Task templates, rules, who gets the task and why one might not fire |
| [`chat.md`](docs/chat.md) | Channels and direct messages, why a direct conversation has no id of its own, and what is deliberately not in it |
| [`time.md`](docs/time.md) | Logging time, what a running timer actually is, and what it is not |
| [`calendar.md`](docs/calendar.md) | The `.ics` feed, what a subscription is worth, and why the URL is a password |
| [`insights.md`](docs/insights.md) | Throughput, burn-up and cycle time, and the rules the charts follow |
| [`design.md`](docs/design.md) | The tokens, the type scale, the ten rules that are not about looks, and the order to port a screen in |

**Where it stands**

| | |
|---|---|
| [`TODO.md`](TODO.md) | What is missing, what is unverified, what was deferred on purpose |
| [`comparison.md`](docs/comparison.md) | An honest gap analysis against Jira, Confluence, Plane, Vikunja and OpenProject, and the order those gaps are worth closing in |

## Development

Run the API and the Vite dev server side by side:

```bash
npm run dev:server     # :4000
npm run dev:web        # :5173, proxies /api to :4000
```

### Tests

```bash
npm test              # API, sync merge, permissions, uploads, injection, MCP, SMTP, S3, translations
npm run typecheck     # every package, plus the client test project
npm run check:compose # every setting the server reads is reachable from a deployment
```

The mail tests run against a real SMTP server implemented in the test, and the storage tests against
a fake S3 that verifies the request signature — so both protocols are exercised, not mocked.
`check:compose` catches the failure no compiler can: a variable documented in `.env.example` that no
compose file passes into the container, which is silent in the worst way — the feature simply stays
off and nothing reports an error.

### In a real browser

A walkthrough, and four checks that measure the interface rather than asserting about the source —
because "it has an `aria-label` somewhere" and "the grey is fine" are both claims that have been
wrong here. Each needs Playwright and a seeded instance on `KOLIBRI_URL` (default
`http://localhost:4400`):

```bash
node scripts/smoke.mjs                    # walkthrough incl. mobile + offline
KOLIBRI_LOCALE=de node scripts/smoke.mjs  # the same walk through the German interface
KOLIBRI_LOCALE=fr node scripts/smoke.mjs  # and the French one

npm run check:css         # every class the source uses is actually defined — no build needed
npm run check:responsive  # 14 screens, 340px to 1600px in 20px steps, looking for overflow
npm run check:contrast    # WCAG ratios for every element that renders text, light and dark
npm run check:a11y        # names, keyboard reach, focus rings, landmarks, 24px targets
```

They are not decoration. `check:contrast` found twenty unreadable places on its first run,
`check:responsive` found a layout that came apart between 880 and 940 pixels, and `check:a11y` found
forty-four problems including the checkbox in front of every task.

The two websites carry the same questions in one script, because the same claims were wrong there
too — it found a `git clone` line holding a column open at 562px inside a 300px phone:

```bash
node sites/check.mjs sites/docs/dist                         # links
node sites/check.mjs sites/docs/dist http://127.0.0.1:4300   # + widths and contrast
node sites/check-redirects.mjs                               # nginx, behind a proxy
```

The last one is separate because it is the one thing the others cannot see: they run against
`serve`, and what is deployed is nginx. A 301 that names the container's own port sends every
visitor who omits a trailing slash to an address nothing answers on.

Everything above runs in [CI](.github/workflows/ci.yml) on every pull request, along with a job that
brings up the full Docker stack and checks that it provisions itself.

## Project layout

```
packages/
  shared/   types, entity registry, hybrid logical clock, fractional indexing
  server/   HTTP API, sync engine, MCP server, SQLite schema — zero runtime dependencies
  web/      React PWA: local store, sync engine, views, editor
  mcp/      stdio ⇄ HTTP bridge for MCP clients that cannot speak HTTP
sites/
  docs/     docs.kolibri.day — the manual for using Kolibri (Astro + Starlight)
  demo/     demo.kolibri.day — the page in front of the live demo (Astro)
```

`sites/*` are deliberately **not** npm workspaces of this project. They carry their own
`package.json` and lockfile, so `npm ci` at the root still installs only what the app needs and
neither the test job nor a contributor's first clone pays for a documentation toolchain. Both are
built and served by one `sites/Dockerfile`; see
[`docs/deployment.md`](docs/deployment.md#the-two-websites-and-the-public-demo).

## Contributing

Issues and pull requests are welcome.

- Run `npm test && npm run typecheck` before opening one.
- If the change touches the interface, run the browser checks above as well — CI runs them, and they
  fail on things a unit test cannot see.
- The server has **zero runtime dependencies** and the client keeps them few on purpose. Please keep
  new ones to a minimum and say in the pull request why one is needed.
- [`TODO.md`](TODO.md) and [`docs/comparison.md`](docs/comparison.md) are the honest list of what is
  missing; both are good places to find something worth doing.

## Security

The threat model, what is checked and where, and what has *not* been reviewed are written down in
[`docs/security.md`](docs/security.md). Please report a vulnerability privately through
[GitHub's advisory form](https://github.com/LucaFrankfurt/AIfirstPMO/security/advisories/new) rather
than in a public issue.

## Licence

MIT — see [LICENSE](LICENSE).
