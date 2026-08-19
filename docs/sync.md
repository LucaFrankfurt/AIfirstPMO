# Offline and sync

The promise: **you can work with no connection for as long as you like, and when you come back
nobody's changes get lost.** This is how that is implemented, and where the edges are.

## Data flow

```
write in the UI
   │
   ├─► store map (instant re-render)
   ├─► IndexedDB (survives a reload)
   └─► outbox  ──► POST /api/sync/push ──► SQLite
                                             │
       IndexedDB ◄── GET /api/sync/pull ◄────┤ seq > cursor
                                             │
       "pull again" ◄──── SSE /api/sync/stream
```

## Stamps: hybrid logical clocks

Every mutation carries an HLC stamp: `<millis>-<counter>-<clientId>`, base36, zero-padded so plain
string comparison is the correct ordering.

```
0mfk2p8x1c-0000-a3f9d201
└ wall clock ┘ └ tick ┘ └ node ┘
```

The counter breaks ties inside the same millisecond; the node id breaks ties between clients whose
clocks agree exactly. Observing a remote stamp advances the local clock, so a device with a wrong
system time cannot permanently win or lose — it converges after the first exchange.

## Merging: last writer wins, per field

Each row stores a `clocks` JSON column mapping field name → stamp of the write that produced it.
When a mutation arrives, `writeEntity` compares stamp by stamp:

```ts
for (const [field, value] of Object.entries(patch)) {
  if (!hlcGreater(mutation.hlc, clocks[field])) continue; // stale, drop this field only
  values[field] = value;
  clocks[field] = mutation.hlc;
}
```

Consequences worth knowing:

- Alice renames a task offline while Bob changes its priority offline. Both survive — they touched
  different fields.
- Alice and Bob both retitle the same task offline. The later stamp wins; the earlier title is gone
  from the row but visible in the task's activity trail.
- Deletion is a field too (`__deleted`). An edit stamped *after* a delete resurrects the row, which
  is what people expect when someone deletes a task while a colleague is still working on it.

Rows are soft-deleted (`deleted_at`), so a delete syncs like any other change instead of leaving
peers with a row they can never learn about.

## Cursors: one monotonic counter

Every write bumps a global counter and stamps the row with it. A pull is then a range scan:

```
GET /api/sync/pull?workspace=<id>&since=<cursor>
→ { changes: { task: [...], page: [...] }, cursor: 4711, hasMore: false }
```

Clients persist the cursor next to the data. A fresh client starts at `0` and receives the whole
workspace; a client that was offline for a week receives exactly what changed. If one entity has
more than 2000 rows to send, the server truncates the whole response at the last fully-covered
sequence and the client immediately asks again — so a page boundary can never hide a row.

`hasMore` is **stated, not inferred**. The server asks for one row more than a page and so knows
for certain whether it truncated; a client guessing from "was any page exactly full" is right until
a workspace has exactly one page of changes, and being wrong there means it stops syncing without
saying so.

Permission filtering happens inside the pull query: private projects a user is not a member of are
excluded there, not in the UI.

## Push: idempotent by construction

Mutations have client-generated UUIDs. The server records applied ids in `applied_mutations` and
ignores repeats, so a push that succeeded but whose response was lost cannot duplicate anything on
retry. Ids older than 30 days are swept.

The response carries `patched`: fields the server decided (task identifiers such as `WEB-42`,
default states, `completed_at`). The client shows an optimistic `WEB-?` placeholder until that
comes back.

## Failure handling

| Situation | Behaviour |
|---|---|
| Offline | Status pill switches to *Offline · N queued*; writes keep working |
| Back online | `online` event triggers flush → pull → reconnect SSE |
| Server error / 5xx | Exponential backoff 1s → 30s, outbox untouched |
| Session expired (401) | Local data is kept, a sign-in prompt appears, the outbox flushes after sign-in |
| Mutation rejected (e.g. permission) | Reported in `rejected[]`, dropped from the outbox, logged and surfaced in the status pill |
| Tab in background | Polls every 60s; pulls immediately when it becomes visible again |

## Deletion, and the end of it

A delete stamps `deleted_at` and the row keeps syncing. That is not squeamishness — it is the only
way two devices ever *agree* something is gone. A row that simply vanished from the server would
still be sitting in every client's IndexedDB, with nothing to tell them otherwise.

Which means emptying the trash cannot just drop the row either: every device holding the tombstone
would keep showing it in its own trash, with a button offering to put it back. So a purge writes a
**`purge` marker** in its place — `{ entity, row_id, reason }` — and that marker syncs like anything
else. A client applying one deletes its copy of the row the marker names, from the store and from
IndexedDB.

The markers are small and are kept. They are the only remaining record that the thing was ever here,
and dropping them would bring the original problem back one level up.

What this does not fix, and does not claim to: a device that has been offline since before the purge
still holds its copy. It drops it the moment it syncs. Until then the bytes are on that device —
which is true of anything anybody has ever had a copy of.

## Testing it

`packages/server/test/api.test.ts` covers the parts that are easy to get wrong:

- a replayed push does not create a second task,
- concurrent field-level edits merge as described above,
- a delta pull returns only what changed,
- private projects never appear in another member's pull.

`scripts/smoke.mjs` drives a real browser: it creates a task, switches the context offline and
verifies the app still renders from IndexedDB.

## Page bodies: the one field that is not last-writer-wins

Everything above is per-field LWW, and for a title or a due date that is the right answer: the field
has one value and the newer one is it. A page body does not work like that. Two people typing at
once both have something to contribute, and picking one of them files the other in history — nothing
is *lost*, but somebody's paragraph disappears from the page they were looking at, which is a merge
in name only.

So `pages.body` carries a **text CRDT**, and the write path merges it instead of replacing it. The
registry says so — `crdt: ['body']` on the page entity — and both the server and the client store
honour it.

**Why a state-based one.** This engine syncs *rows*, and every row reaches every device exactly once
in any order. That is an unusually good fit for a state-based CRDT, where merging two states is a
pure function of the two: the whole document lives in one column, the merge replaces LWW for that
one column, and none of the rest of this document changes. The alternative — an operation per
keystroke as its own row — grows without bound and needs a compaction scheme nobody can make safe,
because "every device has certainly seen this" is not knowable offline-first.

**The model** is RGA, stored as runs. Every character has an identity `(agent, clock)` that never
changes and remembers the character that was to its left when it was typed. The document order is
then a deterministic function of the character *set*: walk the origin tree, and among characters
sharing an origin the causally newer one comes first — a Lamport clock, with the agent id breaking
ties. A deterministic function of a set converges no matter how the rows arrived, and that is the
whole proof.

`pages.content` stays, as what the CRDT reads as. Everything else that touches a page — search,
export, the share document, the markdown renderer, the REST API, MCP — carries on reading plain
text and knows nothing about any of this. A `content` written on its own, by the API or an import,
*replaces* the CRDT: whoever sent a whole document meant the whole document.

### What it does not do

- **Two people typing at the same instant at the same position** can interleave at run boundaries.
  RGA keeps each person's run together far better than a position-key scheme does — in practice two
  people typing a word into the same spot get the two words side by side, not their letters shuffled
  — but Fugue and Peritext handle the remaining cases properly and this does not. It converges and
  never loses a character; that is the promise.
- **It is not per-keystroke.** Typing settles for about seven hundred milliseconds, then becomes a
  state and a synced row. Somebody else's paragraph appears in your editor a second or so after they
  stop typing, with your caret kept where the writing is. There is no cursor presence.
- **Tombstones accumulate.** Every deleted character is kept, because that is what lets a device
  that was away for a week merge without resurrecting text. `kolibri doctor --fix` folds away the
  ones nothing still points at — deliberately not on a schedule, since "everybody has seen this
  delete" is not knowable and a person running it knows who has been away.
- **Cost is linear in the document per merge**, not per keystroke. Fine for a wiki page; this is not
  the CRDT for a 200 MB log.

## What this is not

It is not multiplayer *presence*: no cursors, no avatars in the margin, no "Ada is typing". The
merging is the part that matters and the part that is hard to add later; the decoration is not.
