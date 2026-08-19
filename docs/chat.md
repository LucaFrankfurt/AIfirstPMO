# Chat

Channels and direct messages, built out of the same rows as everything else.

That is not a shortcut — it is the point. A message is an ordinary synced row, so it sends from a
train and arrives when the tunnel ends, appears on the other person's screen without a socket to
reconnect, survives a reload, and shows up in search and in a backup. There is no second protocol
here to get right, and no second thing to be down.

## The two kinds

| | Channel | Direct |
|---|---|---|
| Named | `#design-review`, lowercase and dash-joined | no name of its own |
| Who is in it | the workspace, or a member list if private | exactly two people |
| Who may change that list | per channel: anybody in it, or only its creator and workspace admins | nobody — its members are its id |
| Where it lives | the workspace, or a project | between the two of you |
| Notifies | when you are named, or if you asked for all of it | always, unless you say otherwise |

A conversation between **three or more people is a private channel with a name**, not a bigger
direct message. That is a product decision and a technical one at once — see the next section.

## Why a direct conversation has no id of its own

Two people can open a conversation with each other while both are offline. If each device invented
an id, the tunnel would end and there would be two conversations holding half the history each,
with no way to tell which was the real one.

So a direct conversation's id is **derived from its members**:

```
dm.<first user id>.<second user id>      // sorted
```

Sorted, so it does not matter who opened it. Built from the ids themselves rather than a hash of
them, because a hash can collide and a concatenation of two unique strings cannot — and a collision
here would silently merge two people's private conversations. That is also why three-person
conversations are channels instead: the id only stays collision-free while it is a concatenation.

Creating a conversation and finding one are therefore the same operation, and the question of who
did it first stops mattering.

The server does not take the membership on trust: for a direct channel it reads the members back
*out of the id* and overwrites whatever was sent. A client that disagreed was either confused or
trying something, and either way the id wins, because the id is what the other device derived too.

## Who can read what

The rule is one sentence — *a conversation is visible when it is not private, or when you are named
in it, and a channel tied to a project also follows that project* — and it is written in four
places, because each has to be shaped for its own query:

| Where | Shape |
|---|---|
| The sync pull | SQL, so a delta pull stays one query |
| The REST list | SQL, so `limit` counts rows you may actually have |
| Reads and writes by id | `canSeeChannel()` in `repo.ts`, which can refuse |
| Search | a join, resolved once for a whole page of hits |

Four copies of a rule is four chances to get it wrong, so `test/chat.test.ts` asks each of them the
same question about the same channels and requires the same answer.

That test was written after the fact and immediately earned its place: the sync copy checked a
channel's privacy and its project and **forgot its tombstone**, so a deleted conversation carried on
posting messages to devices that no longer had a channel to put them in. Not a leak — only members
ever received them — but exactly the kind of disagreement four copies produce. It is now covered
both alive and deleted.

Two consequences worth stating:

- **Search does not leak.** A message is indexed like anything else, but the index has no idea who
  may read a conversation. Message hits are checked against their channel *before* the result list
  is trimmed, so a private conversation cannot even push a readable result off the end of the page.
- **Membership cannot be self-granted.** The member list is an ordinary synced field, which is what
  makes adding somebody to a channel work offline — and would also make adding *yourself* work.
  Only somebody already in a conversation may change it.
- **Leaving the workspace closes the door.** Being removed from a workspace does not take your name
  out of the channels you were in — the member list is a synced field, not a foreign key — so
  `canSeeChannel` checks workspace membership as well. Every route that reaches it already checks
  that too, so this is the second lock rather than the only one; it is there so the next caller
  cannot forget.

## What the server decides

| | |
|---|---|
| Who said it | the session, never the payload |
| Which conversation | fixed at creation; a message cannot move |
| `edited_at` | stamped when the body actually changes, because "edited" is a claim about this server's clock |
| Who may edit | the author, and nobody else |
| Channel names | normalised, so `#Design Review` and `#design-review` cannot be two channels that look like one |

An archived conversation refuses new messages. Deleting a message leaves a tombstone like every
other delete here, so it disappears on every device rather than only on the one that pressed the
button.

## Managing a channel, and closing it

A private channel keeps a member list, and **who may change it is set per channel**: `members` (the
default — anybody in the room can invite) or `admins` (its creator, plus workspace owners and
admins). Per channel rather than per instance, because a team channel and a channel a client can
see want different answers and the same workspace holds both. Changing the *setting* is itself an
admin decision, or it protects nothing.

Two rules hold whatever the policy says:

- **Leaving is always yours to do.** Taking only your own name off the list is not managing the
  room, and a room you cannot leave without permission is not one anybody should be added to.
- **The last person out cannot leave the room standing empty.** It would be invisible to everybody
  and impossible to reopen.

**Archiving** hides a channel and refuses new messages, and keeps everything said in it.
**Deleting** hides the room the same way — it does *not* destroy the conversation. Both are
reversible from the trash until the trash is emptied, which is the point at which anything is
actually gone. A chat history is often the record of a decision, so nothing here throws one away on
a single click.

Messages are not listed in the trash. A message somebody deleted should stay deleted, and a list of
them would be a way to read what was withdrawn.

## Pictures, and reacting

Paste or drop a screenshot straight into the composer: it uploads, downscales, and goes in as
markdown, the same path comments and pages use. The blob store is content-addressed, so the same
image pasted twice costs one copy.

One thing that had to be added by hand: `reclaimFiles` only keeps a blob while *something* still
names its hash, from a written-out list of places. A new place to paste an image is a line on that
list, and the first version of chat did not add it — so emptying the trash took the picture while
the message went on showing it. `messages.body` is on the list now.

Anybody in a conversation can react to a message with an emoji, including somebody else's. That is
the one thing you may do to another person's words, and it is not a change to them — it is your name
in a list beside them. The server allows exactly that and nothing alongside it: a reaction sent
together with an edit is an edit, and refused.

## Being told about it

The default is deliberately **not** "tell everyone about every line". A channel that pings its whole
membership on every message is a channel people mute, and a muted channel tells nobody anything.

- A **channel** notifies whoever was named with `@`, plus anybody who asked for all of it.
- A **direct message** notifies the other person — being written to directly is exactly the case
  where silence would be wrong.
- **Muting beats a mention.** Somebody who set a conversation to *nothing* means it.

Per-conversation, in the bell menu at the top of a conversation. The setting lives in a
`channel_reads` row, which is private to you: where you have got to is nobody else's business, and a
read receipt is deliberately not a feature here.

A message notification carries the conversation it is about, so pressing it opens that conversation.
A notification that announces something and then does nothing when pressed is worse than one that
was never sent.

Message notifications count as *important* for the **instant** channels — Telegram and Web Push —
and deliberately **not** for email. Email here is batched into a digest on purpose, and a chat
message that arrives in a two-hour summary is one answered too late to matter. Both answers come
from one definition in `shared/src/chat.ts` so they cannot drift; an earlier version had two sets
and a comment claiming they matched. See [`notifications.md`](notifications.md).

## Unread

An unread count is computed on the device from rows it already has: messages newer than your read
marker, not counting your own. No endpoint, no polling, and it is right while offline.

The marker only ever moves **forwards**. A marker that went backwards would make a conversation
somebody has just read unread again on their other device.

## Guests

A guest can **read** an open channel and cannot write anywhere — that is the workspace-wide guest
rule, not a chat rule. Chat says so before somebody types rather than after: no composer, no *new
channel* button, no list of people to start a conversation with, and a line explaining why.

Unread counts are **hidden** from guests, and not because there is nothing to read. A read marker is
itself a write, so a guest's count would climb and never come down; a number that cannot reach zero
is worse than no number. Letting guests keep their own private read state would be a change to the
permission model, which is a decision rather than something to slip in here — it is in `TODO.md`.

## In a project export

A project export takes the **open** channels tied to that project and what was said in them, and
reads them back on import. A **private** one is left out on purpose: a project export is a document
somebody emails, and a private room's whole point is that being able to see the project is not
enough to be in it. There is also nothing sensible to do with a membership list on another instance.

Message authors are matched by email like everything else in the document; anybody this instance
does not know becomes the person who pressed import. Reactions do not survive — those ids mean
nothing here.

## What is deliberately not here

- **No typing indicator, and no presence dot.** Both are ephemeral state, and this app's realtime
  channel carries *"something changed up to seq N"* and nothing else — on purpose, so that catching
  up after a tunnel and hearing about a change live are one code path. Per-keystroke state would
  mean a second mechanism with its own failure modes and its own reconnection logic, in exchange for
  something nobody has needed to do their work. If it is added later it should be its own transport,
  not a widening of this one.
- **No read receipts.** The read marker exists and is private. Making it public is a different
  product with different social consequences, and it is a one-way door.
- **No voice or video.** Not a thing a project tool should be reimplementing.
- **No threads as a separate view.** A message can answer another one and the answer is shown in
  place; a conversation that needs its own view is a page.

## Where it lives in the code

| | |
|---|---|
| `packages/shared/src/chat.ts` | the rules both sides have to agree on — the derived id, unread, titles, name shape |
| `packages/shared/src/entities.ts` | `channel`, `message`, `channelRead` |
| `packages/server/src/lib/repo.ts` | the invariants, the guards, and the notification rules |
| `packages/server/src/routes/sync.ts` | the visibility filter for a delta pull |
| `packages/web/src/routes/chat.tsx` | the screen |
