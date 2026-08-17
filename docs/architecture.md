# Architecture

Kolibri is four packages in one repository. The rule that shapes all of them: **the client owns a
full copy of the workspace, the server owns the truth, and one registry describes both.**

```
packages/shared   entity registry · types · hybrid logical clock · fractional indexing
      │                    ▲                              ▲
      ▼                    │                              │
packages/server   HTTP · sync · MCP · SQLite     packages/web   React PWA · IndexedDB · sync
                           │
                           ▼
                    packages/mcp   stdio ⇄ HTTP bridge
```

## The entity registry

`packages/shared/src/entities.ts` lists every syncable entity, its table, its mutable fields and
which of them only the server may write. Everything else is derived from it:

- the server's generic write path, REST routes and sync queries,
- the client's IndexedDB object stores and cache,
- the merge rules for offline conflicts.

Adding a field is one line there plus a column in `schema.sql`. Nothing else needs to know.

## Server

Zero runtime dependencies — `node:http`, `node:sqlite`, `node:crypto` and nothing else. Node 22.18+
runs the TypeScript sources directly, so there is no build step and no `dist/` to keep in sync.

| Module | Responsibility |
|---|---|
| `lib/http.ts` | ~150-line router, JSON/body helpers, typed HTTP errors |
| `lib/auth.ts` | scrypt passwords, hashed session and API tokens, role checks |
| `lib/repo.ts` | **the only write path** — per-field LWW merge, side effects, search index |
| `lib/bootstrap.ts` | workspace/project creation with default states and labels |
| `lib/mcp.ts` | MCP tools, prompts, resources; plain JSON-RPC, no SDK |
| `routes/sync.ts` | `pull`, `push` and the SSE change stream |
| `routes/entities.ts` | generic REST CRUD for every registry entity |
| `routes/files.ts` | content-addressed uploads and downloads |

Every mutation — REST, sync push, MCP tool, seed script — goes through `writeEntity`. That is what
keeps merge semantics, activity records, notifications and the search index from drifting apart
between entry points.

### Why not Redis, Postgres, S3 or a worker queue

Kolibri does have a database — SQLite is a full relational database with transactions, foreign keys
and full-text search. What it does not have is a *separate server* for any of it. That was a
deliberate choice, made per component:

**Postgres → SQLite (embedded).** A team tool is a low-write, high-read workload with strong
locality: one workspace, one machine, a few dozen people. WAL-mode SQLite serves that from
memory-mapped pages with no network hop, and removes an entire operational surface — connection
pools, a second container to patch, a migration service, a backup agent, a `pg_hba.conf` to get
wrong. `cp kolibri.sqlite` is a backup. The price is horizontal scaling, which a self-hosted team
tool does not need until it has thousands of users; the schema is plain SQL, so that migration is
mechanical when someone actually needs it.

**Redis → nothing.** Redis usually shows up for four jobs, and none of them exists here:

| Typical Redis job | Why it is absent |
|---|---|
| Session store | Sessions are hashed rows in SQLite. A session lookup is an indexed read on a local file — microseconds, and it survives a restart, which an unpersisted Redis does not. |
| Cache | The expensive reads happen *on the client*, out of IndexedDB. The server answers deltas, not full pages, so there is very little worth caching in front of a local B-tree. |
| Pub/sub for realtime | Realtime is one in-process `EventEmitter` feeding SSE connections. A message bus between processes only earns its keep once there is more than one process. |
| Job queue | There are no background jobs. Notifications, the search index and the activity trail are written inside the same transaction as the change that caused them, which also makes them impossible to lose. |

**S3 → the filesystem.** Uploads are content-addressed by SHA-256 under the data directory, so
de-duplication is free and the URL is stable. A bucket adds credentials, egress cost and a second
failure mode to back up; a volume is already being backed up because the database lives on it. If
you need object storage, `KOLIBRI_UPLOAD_DIR` can point at a network mount.

**Elasticsearch → FTS5.** Full-text search is built into SQLite and is maintained transactionally
with the rows it indexes, so it can never drift out of date the way an async indexer can.

**Image processing service → the browser.** Photos are downscaled to WebP on the client before
upload. That removes a native dependency (`sharp`/libvips) from the server *and* saves the upload
bandwidth on the device that has least of it.

The honest cost of all this is written down in the trade-offs below and in
[`TODO.md`](../TODO.md): a single node, no shared cache, no background workers. The moment you
genuinely need two replicas, the seams are `nextSeq()` and `lib/bus.ts` — that is the point where
Redis or Postgres stops being ceremony and starts being the right answer. Until then, every piece
of infrastructure you do not run is one you cannot misconfigure, forget to patch, or be woken up
by.

The result is measurable, not just aesthetic: zero runtime npm dependencies on the server, one
container, one volume, and a cold start that is a process spawn rather than a dependency graph.

### Realtime

Server-Sent Events, not WebSockets. The payload is only "the workspace advanced to sequence N" —
clients then use the same delta pull they use after being offline. One code path serves live
updates and catch-up, and SSE needs no dependency and survives proxies that mangle upgrades.

## Web

React with a hand-rolled store rather than a data-fetching library, because the network is not the
source of truth here — IndexedDB is.

- `lib/idb.ts` — one object store per entity, plus `outbox` and `meta`
- `lib/store.ts` — in-memory maps + `useSyncExternalStore`; `useQuery(fn, deps)` recomputes on change
- `lib/sync.ts` — hydrate from disk, pull deltas, flush the outbox, listen to SSE, back off on errors
- `lib/mutations.ts` — the write API: local update → IndexedDB → outbox → network
- `lib/markdown.ts` — small escape-then-render markdown pass (no parser + sanitiser pair to ship)

Rendering reads maps; writes never await the network. Offline is not a mode, it is the normal path
with the network stage delayed.

### Design

Mobile-first CSS with a token palette in `styles/app.css`, dark mode from `prefers-color-scheme`
with a manual override, bottom navigation and bottom sheets below 900px, sidebar above. No CSS
framework: the whole stylesheet is ~20 kB and there is no build-time class generation.

## MCP bridge

`packages/mcp` is a ~90-line stdio pipe that forwards JSON-RPC to `POST /mcp`. The tools live in
the server so there is exactly one implementation, and a remote instance is reachable from any
client without opening anything but HTTPS.

## Trade-offs we accepted

- **Single node.** Sequence numbers and the SSE bus are in-process. Running two replicas needs an
  external counter and bus; the code isolates both behind `nextSeq()` and `lib/bus.ts`.
- **LWW, not full CRDT.** Concurrent edits merge per field, but two people typing in the same page
  body still resolve to one winner (the other revision stays in page history). A text CRDT would
  fix that at a large complexity cost; the history-based escape hatch was the better trade.
- **No email.** Invites are links, notifications are in-app. Adding SMTP is a route and a template,
  but it is not a dependency the default install should carry.
