<div align="center">

<img src="packages/web/public/icon.svg" width="72" height="72" alt="" />

# Kolibri

**Open source projects, tasks and pages. Offline-first, self-hosted, MCP-native.**

One container. One volume. `docker compose up -d`.

</div>

---

Kolibri is a project and work management tool in the spirit of OpenProject and Plane, built
around three convictions:

1. **The interface should never wait for the network.** Every screen reads from a local copy of
   the workspace, so it is instant on a train, on a plane and on hotel wifi. Changes queue up and
   merge field by field when you come back.
2. **Self-hosting should be boring.** No Postgres, no Redis, no S3, no worker queue. One Node
   process and a SQLite file you can copy.
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
| **Work tracking** | Projects with their own workflow states, tasks with sub-tasks, relations (blocks / relates / duplicates), priorities, estimates, labels, due dates, assignees, archiving |
| **Planning** | Cycles (sprints) with progress and point burn-up, modules (milestones spanning cycles), teams that own projects |
| **Views** | List, Kanban board with drag & drop, calendar; group by state / priority / assignee / label / cycle / project; filter and sort; per-project preferences remembered |
| **Pages** | Nested markdown wiki with version history, drag & drop images, project or workspace scope, private pages |
| **Collaboration** | Comments with markdown and attachments, activity trail per task, inbox notifications, invite links, roles (owner / admin / member / guest), private projects |
| **Files** | Content-addressed uploads with de-duplication, client-side image downscaling, thumbnails, offline caching |
| **Offline & sync** | Full IndexedDB mirror, outbox with retry, hybrid-logical-clock last-writer-wins merge per field, Server-Sent-Events live updates, installable PWA |
| **Search** | Instant local title search plus SQLite FTS5 full text across tasks, pages, comments, projects and cycles |
| **Integration** | REST API for every entity, scoped API tokens, MCP server over HTTP and stdio with 19 tools, 3 prompts and page resources |

## Quick start

```bash
git clone https://github.com/LucaFrankfurt/AIfirstPMO.git kolibri
cd kolibri
cp .env.example .env          # optional — everything has defaults
docker compose up -d --build
open http://localhost:4000
```

The first account you create owns the instance. Set `KOLIBRI_ALLOW_SIGNUP=false` afterwards and
invite the rest of the team from **Settings → Members**.

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
`create_task`, `update_task`, `delete_task`, `comment_task`, `search`, `list_cycles`,
`create_cycle`, `list_pages`, `get_page`, `create_page`, `update_page`, `list_members`,
`project_status`, `my_work`. Prompts: `standup`, `sprint_planning`, `triage`.

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

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together and why
- [`docs/sync.md`](docs/sync.md) — the offline protocol, conflict rules and failure modes
- [`docs/api.md`](docs/api.md) — REST endpoints, auth, uploads
- [`docs/mcp.md`](docs/mcp.md) — every tool, prompt and resource with examples
- [`docs/deployment.md`](docs/deployment.md) — TLS, backups, upgrades, environment variables

## Testing

```bash
npm test          # API, sync merge, permissions, uploads, MCP — no external services
npm run typecheck # all four packages
node scripts/smoke.mjs   # browser walkthrough incl. mobile + offline (needs Playwright)
```

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
