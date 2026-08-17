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
→ { changes: { task: [...], page: [...] }, cursor: 4711 }
```

Clients persist the cursor next to the data. A fresh client starts at `0` and receives the whole
workspace; a client that was offline for a week receives exactly what changed. If one entity has
more than 2000 rows to send, the server truncates the whole response at the last fully-covered
sequence and the client immediately asks again — so a page boundary can never hide a row.

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

## Testing it

`packages/server/test/api.test.ts` covers the parts that are easy to get wrong:

- a replayed push does not create a second task,
- concurrent field-level edits merge as described above,
- a delta pull returns only what changed,
- private projects never appear in another member's pull.

`scripts/smoke.mjs` drives a real browser: it creates a task, switches the context offline and
verifies the app still renders from IndexedDB.

## What this is not

It is not a text CRDT. Two people typing in the same page body at the same time will resolve to one
version, with the other kept in page history. If simultaneous prose editing matters more to you
than simplicity, this is the seam where a CRDT (Yjs or Automerge) would be introduced — the page
`content` field, not the whole model.
