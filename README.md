<div align="center">

<img src="packages/web/public/icon.svg" width="72" height="72" alt="" />

# Kolibri

**Open source projects, tasks and pages. Offline-first, self-hosted, MCP-native.**

`docker compose up -d` — app and object storage, wired and configured.

</div>

---

Kolibri is a project and work management tool in the spirit of OpenProject and Plane, built
around three convictions:

1. **The interface should never wait for the network.** Every screen reads from a local copy of
   the workspace, so it is instant on a train, on a plane and on hotel wifi. Changes queue up and
   merge field by field when you come back.
2. **Self-hosting should be boring.** One command brings up a complete, self-configuring stack;
   the app itself is one Node process and a SQLite file you can copy — no Postgres, no Redis, no
   worker queue. Strip it down to a single container when that is all you want.
3. **An assistant is a first-class user.** Kolibri speaks the Model Context Protocol natively, so
   an AI can read the backlog, file issues, move them through the workflow and write documentation
   with exactly the permissions you grant it.

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

## What is in the box

| | |
|---|---|
| **Work tracking** | Projects with their own workflow states and kinds of work (bug / feature / chore, editable per project), tasks with sub-tasks, relations (blocks / relates / duplicates), priorities, estimates, labels, due dates, assignees, archiving, and CSV import with a preview before anything is written |
| **Planning** | Cycles (sprints) with progress and point burn-up, modules (milestones spanning cycles), teams that own projects, time tracking with a timer that survives a reload, and an Insights tab — throughput, burn-up, cycle time — computed from the local mirror |
| **Templates & rules** | Task templates with a checklist that becomes sub-tasks, repeating tasks, and rules that file one when something happens — including *n* days before a due date — a task entering review asks the people you named for feedback. Recipients are selectors (the lead, whoever is on it, a team), so they keep meaning the right people |
| **Views** | List, Kanban board with drag & drop, table with sortable columns, calendar; group by state / priority / assignee / label / cycle / project; filter and sort; select several tasks and change them together; save a view under a name and share it |
| **Pages** | Nested markdown wiki with version history, restore and a what-changed diff; labels and filtering; watch a page; page templates; per-page visibility; export as a markdown bundle; comments and `@mentions`; drag & drop images |
| **Collaboration** | Comments with markdown, attachments and reactions on tasks *and* pages, `@mentions` with autocomplete in comments, descriptions and page bodies, following a task or a page, activity trail per task, invite links, roles (owner / admin / member / guest), private projects |
| **Notifications** | In-app inbox plus optional email — batched into one message per person, an optional daily or weekly digest, reminders before a due date, per-user preferences, signed one-click unsubscribe, queued with retry |
| **Files** | Content-addressed uploads with de-duplication, client-side image downscaling, offline caching; on the data volume by default, or in any S3-compatible bucket (MinIO, Ceph, R2, AWS) with pre-signed downloads |
| **Offline & sync** | Full IndexedDB mirror, outbox with retry, hybrid-logical-clock last-writer-wins merge per field, Server-Sent-Events live updates, installable PWA. Deletes are tombstones, so nothing is really gone — Settings → Data lists it and brings it back |
| **Search** | Instant local title search plus SQLite FTS5 full text across tasks, pages, comments, projects and cycles |
| **Learning it** | A first-run tour that sets the instance up as it goes, a checklist ticked from your actual data, and a guide with animated, narrated diagrams of each area of the app plus an explorer for how the pieces nest. A screen with nothing on it yet links to the card that explains what goes there. Press `?` |
| **Languages** | English and German throughout — interface, notifications and emails, each written in the recipient's own language. Adding a third is one typed catalogue file |
| **Integration** | REST API for every entity, scoped API tokens, signed outgoing webhooks, MCP server over HTTP and stdio with 23 tools, 3 prompts and page resources |
| **Deployment** | One command brings up app + object store, self-configuring: bucket created on boot, owner account and demo data from the environment, optional automatic HTTPS and a dev overlay with a mail capture inbox |
| **Hardening** | Rate limits on sign-in, registration and invite lookup — per account as well as per address — a Content-Security-Policy with no inline script, two-factor authentication with recovery codes, a device list you can revoke from, and a workspace audit log |

## Quick start

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

Email is **off** until `KOLIBRI_SMTP_URL` points at a relay you control — notifications live in the
in-app inbox either way. To try delivery locally, add the dev overlay, which runs a capture inbox
(Mailpit on <http://localhost:8025>) and wires the app to it:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Kolibri recognises a capture inbox and labels it as such in the log, in `/api/health` and in the
settings screen, so it can never be mistaken for real delivery.

To skip the browser step that claims the instance, set the owner in `.env` before the first start
— the account then exists the moment the stack is up:

```bash
cp .env.example .env
# KOLIBRI_ADMIN_EMAIL=you@example.com
# KOLIBRI_ADMIN_PASSWORD=something long
# KOLIBRI_SEED_DEMO=true      ← optional demo workspace to look around in
docker compose up -d --build
```

Otherwise the first account you create in the browser owns the instance. Either way, set
`KOLIBRI_ALLOW_SIGNUP=false` afterwards and invite the rest of the team from **Settings → Members**.

**Variants**

```bash
docker compose -f docker-compose.lite.yml up -d --build   # single container, uploads on the volume
docker compose --profile tls up -d                        # + Caddy, automatic HTTPS for KOLIBRI_DOMAIN
```

Put `COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml` in `.env` and plain
`docker compose up -d` picks up the overlay every time.

Deploying on **Coolify** or a similar PaaS? Use the Docker Compose build pack with
`docker-compose.coolify.yml` — it drops the host port mappings, fixed container names and the
bundled TLS proxy, because the platform provides all three. See
[`docs/deployment.md`](docs/deployment.md#coolify-and-other-paas).

### Without Docker

Node 22.18 or newer is the only requirement — the server runs TypeScript directly and SQLite is
built into Node.

```bash
npm install
npm run build          # bundles the web app into packages/web/dist
npm run seed           # optional demo workspace (ada@kolibri.dev / kolibri-demo)
npm start              # http://localhost:4000
```

For development, run the API and the Vite dev server side by side:

```bash
npm run dev:server     # :4000
npm run dev:web        # :5173, proxies /api to :4000
```

## Connect an assistant (MCP)

Create a token under **Settings → API & MCP**, then point any MCP client at the instance:

```jsonc
{
  "mcpServers": {
    "kolibri": {
      "command": "npx",
      "args": ["-y", "@kolibri/mcp"],
      "env": {
        "KOLIBRI_URL": "https://kolibri.example.com",
        "KOLIBRI_TOKEN": "kol_…"
      }
    }
  }
}
```

Clients that speak streamable HTTP can skip the bridge and talk to `POST /mcp` directly with an
`Authorization: Bearer kol_…` header.

Tools: `list_workspaces`, `list_projects`, `create_project`, `list_tasks`, `get_task`,
`create_task`, `update_task`, `delete_task`, `comment_task`, `search`, `list_templates`,
`apply_template`, `list_cycles`, `create_cycle`, `list_pages`, `get_page`, `create_page`,
`update_page`, `list_members`, `project_status`, `my_work`.
Prompts: `standup`, `sprint_planning`, `triage`.

A read-only token (`scopes: "read"`) is refused for every write tool, so you can hand an assistant
a view of the backlog without handing it a pen.

## How the offline sync works

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
so a flaky connection cannot duplicate a task. Details and trade-offs: [`docs/sync.md`](docs/sync.md).

## Documentation

- [`TODO.md`](TODO.md) — what is missing, what is unverified, what was deferred on purpose
- [`docs/comparison.md`](docs/comparison.md) — an honest gap analysis against Confluence, Plane and
  OpenProject, and the order those gaps are worth closing in
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together, including
  [why there is no Redis or Postgres, and why S3 and email are optional](docs/architecture.md#why-no-redis-or-postgres--and-why-s3-and-email-are-optional)
- [`docs/sync.md`](docs/sync.md) — the offline protocol, conflict rules and failure modes
- [`docs/automation.md`](docs/automation.md) — task templates, rules, who gets the task and why one might not fire
- [`docs/notifications.md`](docs/notifications.md) — in-app and email delivery, batching, mentions
- [`docs/time.md`](docs/time.md) — logging time, what a running timer actually is, and what it is not
- [`docs/import.md`](docs/import.md) — bringing a backlog in from a CSV, and what it does with a row it cannot read
- [`docs/insights.md`](docs/insights.md) — throughput, burn-up and cycle time, and the rules the charts follow
- [`docs/i18n.md`](docs/i18n.md) — how a language is picked, and how to add one
- **The guide inside the app** (`?` or the sidebar) — what every feature does, how the
  pieces nest, and the shortcuts. It is the manual for using Kolibri; the files here are the
  manual for running and extending it.
- [`docs/storage.md`](docs/storage.md) — disk vs. S3/MinIO, pre-signed downloads, migrating
- [`docs/api.md`](docs/api.md) — REST endpoints, auth, uploads
- [`docs/mcp.md`](docs/mcp.md) — every tool, prompt and resource with examples
- [`docs/deployment.md`](docs/deployment.md) — TLS, backups, upgrades, environment variables

## Testing

```bash
npm test          # API, sync merge, permissions, uploads, MCP, SMTP, S3, translations — no external services
npm run typecheck # all four packages
node scripts/smoke.mjs                    # browser walkthrough incl. mobile + offline (needs Playwright)
KOLIBRI_LOCALE=de node scripts/smoke.mjs  # the same walk through the German interface
```

The mail tests run against a real SMTP server implemented in the test, and the storage tests
against a fake S3 that verifies the request signature — so both protocols are exercised, not
mocked.

## Project layout

```
packages/
  shared/   types, entity registry, hybrid logical clock, fractional indexing
  server/   HTTP API, sync engine, MCP server, SQLite schema — zero runtime dependencies
  web/      React PWA: local store, sync engine, views, editor
  mcp/      stdio ⇄ HTTP bridge for MCP clients that cannot speak HTTP
```

## Contributing

Issues and pull requests are welcome. Run `npm test && npm run typecheck` before opening one.
The codebase deliberately avoids frameworks on the server and heavyweight dependencies on the
client — please keep new dependencies to a minimum and say why one is needed.

## Licence

MIT — see [LICENSE](LICENSE).
