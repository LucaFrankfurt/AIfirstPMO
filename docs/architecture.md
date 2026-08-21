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

Adding an *entity* used to need one more thing, and it is worth saying why it no longer does. Each
entity is an IndexedDB object store on the client, and IndexedDB only creates stores inside an
upgrade, which only runs when the version number goes up. That number was a constant with a comment
asking whoever added an entity to bump it. Chat was added; it was not bumped. Every browser that had
opened the app before was then missing three stores, and the symptom was not an error anybody would
have read as a schema problem: a channel appeared, vanished a few seconds later, and came back on
the next tab switch — because the pull applied its rows to memory, failed to *save* them, therefore
never wrote the sync cursor, therefore started from zero next time and got a snapshot, and a
snapshot empties the tables before it refills them. The version is derived from the store list now:
the client opens the database, asks whether every entity has a store, and upgrades if not.

Four flags on an entity are worth knowing about, because they are how an exception stays declared
rather than scattered: `serverOnly` (a field a client may not write), `private` (rows belong to one
person and are not shared with the workspace), `guestWritable` (a row somebody with no write access
may still write, because it is a note they keep about themselves — currently `channelRead` and only
that) and `crossWorkspace` (a row that may belong to *no* workspace: a direct conversation is
between two people who may share none, along with its messages, read markers and notifications).

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
| `lib/automation.ts` | rules: what fired, who it resolves to, and why it did nothing |
| `lib/notify.ts` | writing a notification, and every channel that has to hear about it |
| `lib/telegram.ts` | the bot: long-polled updates, single-use link codes, delivery |
| `lib/ratelimit.ts` | token buckets per address **and** per account, in memory |
| `lib/csp.ts` | the content policy, computed because the object store may be off-origin |
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

#### The editor is a textarea, on purpose

Everything written here — a description, a comment, a page, a chat message — is markdown in a plain
`<textarea>`. A rich-text surface would mean the document and what is on screen were two different
things, with a conversion between them that is wrong in some corner for ever.

The cost of that choice is that conveniences have to be written by hand, and `shared/src/editor.ts`
is where they live: Enter continues the list you are in (another bullet, the next number, another
empty checkbox, the same indent) and ends it on an item you left empty; Tab and Shift-Tab nest and
unnest inside a list and stay a plain indent everywhere else; Cmd/Ctrl-B, -I and -K wrap the
selection.

All of it is **pure** — text and a caret in, text and a caret out — which is why it is in `shared`
rather than in the component. It is a behaviour that can be tested without a browser, and the tests
are mostly about the cases that must do *nothing*: a plain Enter in a paragraph staying a plain
Enter is what makes the rest bearable.

A checkbox is tickable where it is rendered, and that is the same idea from the other end: the
renderer numbers each box top to bottom, skipping fenced code, and `toggleTask` counts the source
the same way — so a click hands back an index and the *markdown* is what changes. Off by default,
because an enabled checkbox with nothing listening toggles on screen and then silently disagrees
with the text it came from. It is switched on where the reader owns the words: the editor's own
preview, and a task description. Somebody else's chat message stays read-only.

### Design

Tailwind v4 over the design tokens that were already here, with Radix primitives behind the
interactive components. The tokens are not re-declared for Tailwind — they are *aliased* into it with
`@theme inline`, so `bg-raised` resolves to the same `var(--bg-raised)` the hand-written rules use.
That has one consequence that made the port possible without a flag day: **dark mode needs no `dark:`
variants**, because the variables are already redefined for dark, so a ported screen and an unported
one agree on every colour.

The rules the interface follows — tokens, the type scale, the layout breakpoint, and the seven
checkable ones about focus, labels, colour and empty states — are in [`design.md`](design.md), along
with the order to port a screen in.

The interactive primitives — dialog, menu, tooltip — are Radix underneath (`components/ui/`). Their
API in `components/ui.tsx` is unchanged, because forty screens import `Sheet` and `MenuButton` and
the point was the behaviour, not churning the call sites. What that behaviour is, concretely: focus
trapped inside an open dialog and returned to whatever opened it, the rest of the page hidden from a
screen reader, arrow keys and typeahead in menus, a menu that flips rather than hanging off a short
window, and tooltips that appear on keyboard focus rather than only under a pointer. None of that was
there before, and none of it is the kind of thing that can be added to a hand-rolled version without
becoming the library.

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

Adding a feature means adding a card: a lead sentence, a scene, a handful of how-to steps and a
link into the screen. Every string is a catalogue key, so a new language gets an explained product rather
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

### Templates and rules

`lib/automation.ts` hangs off the same write path as notifications: `afterWrite` sees every
non-system task write, works out whether a state was entered or a task created, and asks the
enabled rules whether they care.

Three decisions shape it:

- **Recipients are selectors, not ids.** "Whoever leads the project" survives a change of lead;
  a stored id does not. They combine, de-duplicate, and are filtered through `canSeeProject`, so a
  rule cannot hand somebody a task inside a private project they are not in.
- **Generated tasks are recognisable.** Every run is written to `automation_runs` with the id of
  what it made, so "did a rule create this?" is one indexed lookup — and rules skip such tasks
  unless deliberately told otherwise. A depth counter backs that up.
- **Deciding to do nothing is a result.** A rule whose recipients all resolve away looks identical
  to a broken one from outside, so the skip and its reason are written down and shown in the UI.

`automation_runs` is server-side bookkeeping and is deliberately *not* in the entity registry: it is
an audit trail, not shared state, and syncing it would put every rule's history on every device.

## MCP bridge

`packages/mcp` is a ~90-line stdio pipe that forwards JSON-RPC to `POST /mcp`. The tools live in
the server so there is exactly one implementation, and a remote instance is reachable from any
client without opening anything but HTTPS.

## Who may see what

Two questions, asked in that order, and the order is the point.

**Workspace membership first.** A workspace is the outer boundary — `docs/sync.md` says nothing is
shared across two — and every id that arrives from outside is a *claim about a row anywhere in the
database*, not a statement about the person holding it. The REST routes get this right structurally:
`requireWorkspace(ctx, row.workspace_id)` runs before any finer guard, so a stranger is turned away
before visibility is even considered.

**Then project visibility.** `canSeeProject` answers the second question, and **"public" means
everyone in the project's own workspace** — the screen that sets it says *Everyone in the
workspace*. It has never meant everyone with an account on the instance.

It used to answer only the second question, and returned `true` for any public project without
asking whose workspace it was in. That was safe exactly as long as every caller had already scoped
its query — which nineteen of twenty had. The twentieth was an MCP lookup that took a raw uuid, and
a stranger holding a task's id could read it, change it and delete it. The workspace check now lives
inside `canSeeProject`, because a rule that twenty callers have to remember is a rule that one of
them will forget.

Two consequences worth keeping:

- **A lookup by id is scoped by workspace in the query**, not only by the guard afterwards. An
  identifier like `WEB-42` is meaningful only inside a workspace and was always scoped; a uuid is
  meaningful everywhere, which is precisely why it needs the `WHERE`.
- **Both layers are tested independently.** `test/isolation.test.ts` drives the whole thing from
  outside with a second account, and also asks `canSeeProject` directly — because with two layers in
  place, removing either one on its own leaves every end-to-end test green.

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
