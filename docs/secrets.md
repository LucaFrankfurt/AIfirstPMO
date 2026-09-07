# The vault: credentials, per person and per workspace

**Secrets** in the sidebar, once a workspace admin has switched it on in
*Settings → Workspace*. A place to keep the API keys, passwords and connection
strings that otherwise end up pasted into a page or a chat message — where
everybody has them for ever, and nobody can answer who read them.

Off by default, and that switch is a promise rather than a preference: a
half-adopted vault, three keys in it and eleven still in the handbook, is worse
than none, because it makes people believe the handbook has been cleaned up.

## What it protects, exactly

This is the part to read before deciding anything.

A value is encrypted with **AES-256-GCM** under a key derived from the
instance secret, which lives in `.secret` in the data directory and **not in
the database**. It is the same `seal.ts` the SMTP password and a mailbox
credential already use, under a purpose of its own so that a ciphertext lifted
out of one table cannot be opened as a value from another.

| | |
|---|---|
| A copied **database** | carries no values |
| A **backup**, or a stolen snapshot | carries no values |
| A **workspace export** | carries no secrets at all — the collection is not in it |
| A **synced device**, or its IndexedDB | carries labels and never a value |
| An **API token**, however broad | reaches values only through one route, which logs every use |
| The **search index** | never sees a value, and never a name |
| **MCP** | has no secret tool at all. An assistant cannot list them, read them or write them |
| The **operator** of this server | **can read everything.** They have the database and the key file beside it |

That last row is the honest one and it is on the screen too, not only here.
Self-hosting means the person running the server can read what is on the
server; a vault that implied otherwise would be worse than a page, because a
page at least looks like what it is. If you need a secret your own operator
cannot read, it does not belong on your own server — it belongs in a hardware
token or in somebody else's hosted vault, and this feature is honest about not
being either.

What it *does* buy is the thing that actually goes wrong: a credential in a
page is in every export, every device mirror, every search result and every
backup, readable by anybody who can read the page, for ever, with no record.
None of that is true here.

## Who can read one

The same three words a page uses, because it is the same question and learning
a second vocabulary at the moment you are filing a production key is the worst
possible time:

| | |
|---|---|
| **Everyone in the workspace** | every member can reveal it |
| **The project it belongs to** | only people who can see that project |
| **Only me** | its author, and nobody else — including an owner |

`Only me` has no override and is not going to get one. An admin who needs a
colleague's key asks the colleague. The one place this is visible is the audit
log: a reveal of a private secret is recorded as having happened, without its
name, so anomalies are still visible and the name is still nobody's business.

A secret set to *the project it belongs to* with no project chosen falls back
to **Only me** on the way in, on every path — the interface, the API, an
import. `project` on a secret in no project reads as "the project it is in",
there is none, and the fallback that felt natural would have put it in front
of the whole workspace.

## Reading one leaves a mark

That is the difference from a page, and it is the point.

`POST /api/secrets/:id/reveal` returns the value and writes an audit row: who,
when, which secret. **⋯ → Who has read it** on any row answers it in a line;
the full record is in the workspace audit log, where an admin already looks.
The row itself carries `last_used_at`, which syncs — so a secret nobody has
touched in a year is visible in the list without asking anybody anything.

A reveal is a `POST` rather than a `GET` on purpose. A GET is a thing browsers
prefetch, proxies cache and servers write into an access log with its full
path; a reveal is an act with a consequence and should look like one on the
wire. It also writes, and a GET that writes is worse than a POST that reads.

On screen the value appears for **45 seconds** and then goes. That is not a
security property — anybody looking at the screen has already read it — it is
for the tab left open on a shared machine and the screen share started two
minutes after somebody copied a key.

## Rotation

A secret can carry a cadence: *rotate every N days*. With one, the list says
when it is due and shouts when it is late; with `0`, nothing is said at all.

This is deliberately the loudest thing on the screen, because it is the actual
risk in a shared vault. The encryption is arithmetic and it works. The
contractor's database password from two years ago is what gets somebody in.

## What it is made of

| | |
|---|---|
| `packages/shared/src/modules/secrets/secret.ts` | the kinds, the rotation arithmetic, the mask — everything about the *label* |
| `packages/server/src/modules/secrets/rules/secrets.ts` | the invariants, and `canSeeSecret` |
| `packages/server/src/modules/secrets/routes/secrets.ts` | the three routes a value has |
| `packages/web/src/modules/secrets/routes/secrets.tsx` | the screen |
| `packages/server/test/secrets.test.ts` | the six absences, one test each |

The **label** is an ordinary entity. It syncs, it merges per field, it works
offline, it appears in the audit log, it has the five REST routes every entity
gets. Only the value is special, and it is special in one way: it is listed
under `secret` in the registry, so `serialize` cannot emit it and no client can
write it. Everything else follows from that one line.

## The API

```
POST   /api/workspaces/:ws/secrets     the row and its value, in one call
PUT    /api/secrets/:id/value          rotate it
POST   /api/secrets/:id/reveal         read it once, and be recorded
GET    /api/secrets/:id/history        who has read it
PATCH  /api/secrets/:id                the label — an ordinary entity route
```

**Creating one needs the network**, and it is the only row in this application
of which that is true. Everything else is written optimistically on the device
and synced afterwards; a secret's value has to be sealed with a key the browser
does not have, so it cannot be. The first version did create the row locally
and then ask the server to seal a value for it — which asked the server about a
row it had never heard of, answered `Secret not found`, and left a fresh orphan
row behind on every retry. One request that either happens or does not is the
honest shape.

Everything *after* birth is ordinary: renaming it, moving it, changing who it
is for and deleting it are optimistic writes that merge per field and work with
no network, like any other row.

## What is deliberately not here

- **No sharing outside the workspace.** A share link renders a page for a
  stranger; there is no version of that for a credential.
- **No MCP surface**, not even a list of names. An assistant that can name your
  secrets is an assistant whose transcript names your secrets. Easy to relax
  later, impossible to un-leak.
- **No end-to-end encryption.** It would mean a key derived from a password,
  which means losing every secret when somebody resets one, and it would still
  not protect against an operator who serves the JavaScript. The honest version
  of that promise needs a client this project does not ship.
- **No generated passwords.** A generator is one line and belongs where the
  password is used, and every browser and every operating system now has one.
- **No files.** 64 KB is the ceiling, which fits a certificate and not a
  keystore. Files have a place in this application already, with thumbnails and
  a storage backend, and it is not this one.
