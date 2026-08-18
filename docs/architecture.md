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
| `lib/storage.ts` | disk and S3 backends behind one interface (`lib/s3.ts` signs SigV4 by hand) |
| `lib/mail.ts` | notification batching, the mail queue and its retry loop (`lib/smtp.ts` speaks SMTP) |

Every mutation — REST, sync push, MCP tool, seed script — goes through `writeEntity`. That is what
keeps merge semantics, activity records, notifications and the search index from drifting apart
between entry points.

### Why no Redis or Postgres — and why S3 and email are optional

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
| Job queue | The only asynchronous work is sending email, and its queue is a SQLite table with `send_after`, `attempts` and `last_error`. At this volume that is a better queue than Redis: it is transactional with the notification that caused it, it survives a restart, and you can inspect it with `SELECT`. Everything else — the search index, the activity trail, in-app notifications — is written inside the same transaction as the change that caused it. |

**S3 → optional, off by default.** Uploads are content-addressed by SHA-256, and the same key is
used in both backends. On the default `disk` backend they live in the data volume, which is already
being backed up because the database is there too — for most teams that is the whole story, with no
credentials to rotate and no egress bill. Set `KOLIBRI_STORAGE=s3` and they go to MinIO, Ceph, R2 or
AWS instead, with downloads served by short-lived pre-signed URLs so the bytes never pass through
the app. Each `files` row records its backend, so switching does not orphan what is already stored.
See [`storage.md`](storage.md).

**Elasticsearch → FTS5.** Full-text search is built into SQLite and is maintained transactionally
with the rows it indexes, so it can never drift out of date the way an async indexer can.

**A mail service → 200 lines of SMTP.** Notifications are delivered by an SMTP client written
against `node:net`/`node:tls`. Sending mail is a small, stable protocol; a mail library would have
been the largest dependency in the server, and the queue in front of it is the part that actually
matters. Email stays off until a relay is configured — the in-app inbox is always the source of
truth. See [`notifications.md`](notifications.md).

**Image processing service → the browser.** Photos are downscaled to WebP on the client before
upload. That removes a native dependency (`sharp`/libvips) from the server *and* saves the upload
bandwidth on the device that has least of it.

The pattern is the same each time: the default install runs one process, and the pieces that some
teams genuinely need — an object store, a mail relay — are configuration rather than architecture.
The honest cost is written down in the trade-offs below and in [`TODO.md`](../TODO.md): a single
node, no shared cache, one mail worker. The moment you genuinely need two replicas, the seams are
`nextSeq()`, `lib/bus.ts` and the mail worker's polling loop — that is the point where Redis or
Postgres stops being ceremony and starts being the right answer. Until then, every piece of
infrastructure you do not run is one you cannot misconfigure, forget to patch, or be woken up by.

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
framework: the whole stylesheet is ~35 kB and there is no build-time class generation.

### The guide

`routes/help.tsx` is the manual, and it is built the same way as the rest of the app rather than as
an embedded video or a pile of screenshots — both of which go stale the day after a redesign.

- `components/explain.tsx` — the stage. Every diagram is a **pure function of one number**, the step
  it is on, and CSS transitions do the moving. That buys the narration (one sentence per step, in an
  `aria-live` region, so the picture is not sighted-only), the pause and step controls, and a
  sensible answer to `prefers-reduced-motion`: stop advancing, stay steppable. Stages idle until an
  `IntersectionObserver` says they are on screen.
- `components/diagrams.tsx` — the scenes, drawn out of the same tokens as the real interface, so a
  card that crossed a board in the guide is recognisable in a project a minute later. Connectors are
  laid out with the panels rather than drawn over them; an SVG overlay has to guess where the boxes
  ended up and shears at any width it was not drawn for.
- `components/hierarchy.tsx` — the containment tree, transcribed from `ENTITIES`. If a relationship
  changes in the registry it should change here too.

Adding a feature means adding a card: a lead sentence, a scene, four how-to steps and a link into
the screen. Every string is a catalogue key, so a new language gets an explained product rather
than a translated menu bar.

Two things point at it from the rest of the app:

- `lib/guide.ts` names the targets. Any screen can render `<GuideHint to="planning" />`, or pass
  `guide="planning"` to `Empty`; the link is `/guide?to=planning`, and the guide switches section,
  scrolls to the card and marks it. An empty screen is when an explanation is most wanted, so that
  is where the links live.
- `components/tour.tsx` holds the first-run tour and the setup checklist. The tour *does* things —
  it sets the language and creates a project rather than describing how to — and drops the steps a
  plain member would only be refused. The checklist derives its ticks from the store, not from
  what has been clicked, so it stays honest on a second device and after a restore, and hides
  itself when there is nothing left to say. Both can be summoned again from the guide by a window
  event, so nothing else has to own their state.

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
- **Email is best-effort.** One worker polls a SQLite queue; there is no separate delivery service
  and no bounce handling. If a relay is down for longer than the retry budget, the message is
  marked failed and stays in the table — the in-app notification is unaffected, which is why the
  inbox, not the inbox provider, is the source of truth.
