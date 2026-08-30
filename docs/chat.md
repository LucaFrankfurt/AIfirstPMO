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
| Where it lives | the workspace, or a project | nowhere — see below |
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

## Pointing at the work

A message can name the thing it is about. `WEB-42` becomes a link to that task and `#WEB` a link to
that project, and `#` in the composer offers both — projects first, then tasks, matched on key,
identifier or title.

What goes into the message is the **token, not a link**: `WEB-42`, exactly what somebody would have
typed anyway. A markdown link would make the text say something different from what was written,
would not survive being quoted or edited by hand, and would break the moment a message was read
somewhere that is not this app.

The renderer is told **which project keys exist** rather than given a pattern, and that is the whole
trick. `[A-Z]+-\d+` also matches `UTF-8`, `COVID-19` and `ISO-8601`, and a conversation about an
encoding standard that fills up with dead links is worse than no references at all. The keys come
out of the synced cache, so this resolves offline like everything else — and when nobody passes any
keys, as on a publicly shared page, nothing is linked at all, which is right: that reader has no
workspace to be sent into.

Clicking one stays inside the app — a task opens as a sheet over the conversation, the way task
links everywhere else do — and `/t/WEB-42` resolves the identifier, so a reference typed by hand
lands on the same screen as a link clicked in a list. Ctrl- or Cmd-click still opens a new tab.

It is not a chat feature: the composer, the comment box and the page editor are the same editor, so
this works in all three.

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
from one definition in `shared/src/modules/chat/chat.ts` so they cannot drift; an earlier version had two sets
and a comment claiming they matched. See [`notifications.md`](notifications.md).

## Unread

An unread count is computed on the device from rows it already has: messages newer than your read
marker, not counting your own. No endpoint, no polling, and it is right while offline.

The marker only ever moves **forwards**. A marker that went backwards would make a conversation
somebody has just read unread again on their other device.

## Where a direct conversation lives

Nowhere, and that is the point.

Every other row here belongs to a workspace: a task, a page, a label only mean anything inside one,
and `workspace_id` is how sync, permissions and export all find them. A conversation between two
people is not like that. They may share no workspace — that is the *normal* state on a fresh
instance, because signing up a second time makes a second workspace rather than joining the first —
and they may share several, in which case filing the conversation under one of them would make it
disappear the moment either switched.

So a direct channel carries `workspace_id = NULL`, and so do the messages in it, the read markers,
and the notifications about them. The entities allowed to do that are marked `crossWorkspace` in the
registry rather than special-cased in the four places that ask, so the next query cannot forget the
case.

**"No workspace" widens where a conversation is delivered, never to whom.** The lock is the id: a
direct channel is always private, and its two members are read back *out of its id* on every write,
so the question "is this person in it" is one the id itself answers and cannot be talked out of. A
delta pull carries it whichever workspace the device happens to have open; everybody else's pull
does not carry it at all, in either workspace.

Two smaller things had to follow:

- **The other person's name has to travel with the conversation.** A `user` row is normally visible
  to people who share a workspace with it; that now also includes anybody you are in a direct
  conversation with. Not a directory — you learn about people you are already talking to, and about
  nobody else. And the row is *restamped* when the conversation opens, because being allowed to see
  a row is not the same as receiving one: an account whose sequence a device already walked past
  would arrive as an id with no name behind it. Same fix as joining a workspace late; see
  [`sync.md`](sync.md).
- **Which workspace a row is in stopped being something a client may say.** It always came from the
  write's own scope, but the override was written in a way that a `null` could have slipped past —
  and an *open* channel outside every workspace would have been delivered to every device on the
  instance. It is refused now, and tested.

## Finding somebody to write to

The **People** list beside a conversation is the workspace's members: the people somebody works with
every day, one click away. It is the right shortcut and the wrong answer to *"can I message this
colleague at all"*, so under it is **Find somebody…**, which searches every account on the instance.

That reach is deliberate. A self-hosted instance *is* a set of people who work together — the setup
checklist tells you to close sign-up once everybody has an account — and requiring two of them to be
put in the same project before they can say hello is a rule that exists in no messenger anybody
likes. Two limits on it:

- **A guest gets nothing.** The only thing the list is for is starting a conversation, and a guest
  cannot write one. Handing them the instance's address book instead would be a straight leak.
- **It is a search, not a dump.** A hundred rows at a time, by name or email, from the server rather
  than the synced cache — a way to find one person, not a copy of the address book on every device.

## Guests

A guest can **read** an open channel and cannot write in it — that is the workspace-wide guest rule,
not a chat rule. Chat says so before somebody types rather than after: no composer, no *new channel*
button, no list of people to start a conversation with, and a line explaining why.

**With one exception: a guest may write their own read marker.** Not because chat is special, but
because that row is not content — it is a note somebody keeps about their own position in a
conversation, private to them and read by nobody else. Without it a guest's unread count would climb
and never come down, and a number that cannot reach zero is worse than no number.

The exception is declared where every other entity rule lives, as `guestWritable` on the entity in
the registry, and it is currently true of exactly one entity:

```ts
GUEST_WRITABLE  // ['channelRead']
```

Both write paths ask that question rather than the role alone — the REST routes and, per mutation,
the sync push. Per mutation matters: a read marker batched beside something a guest may not write
still goes through, and the rest come back in the `rejected` list the client already knows how to
undo.

One thing this does *not* fix, and it is the same problem: a guest cannot mark a **notification**
read either, so the Inbox badge has the flaw the chat badge just lost. It is one word in the
registry when somebody wants it.

## In a project export

A project export takes the **open** channels tied to that project and what was said in them, and
reads them back on import. A **private** one is left out on purpose: a project export is a document
somebody emails, and a private room's whole point is that being able to see the project is not
enough to be in it. There is also nothing sensible to do with a membership list on another instance.

Message authors are matched by email like everything else in the document; anybody this instance
does not know becomes the person who pressed import. Reactions do not survive — those ids mean
nothing here.

## Presence and typing

This is the one thing in the messenger that is **not a row**, and it is worth being explicit about
why the rule bent rather than pretending it did not.

Everything else here is written down, synced, and still true tomorrow. Presence is true for the next
few seconds and then it is not. A row per heartbeat would mean a write per keystroke, a tombstone
per closed tab, and a sync cursor that moves constantly for information nobody will ever read back.
So it lives in memory on the server, it is lost on restart, and that is correct.

This document used to say that if presence were ever added it should be **its own transport, not a
widening of the change stream**. What it was protecting is that catching up after a tunnel and
hearing about a change live are one code path — a second kind of event carrying a cursor would be a
second way for a client's idea of `seq` to be wrong. So presence shares the *connection* (one socket
per client rather than two) and nothing else: it carries no `seq`, it never touches the cursor, it
arrives under its own event name, and a client that drops every presence frame syncs exactly as
correctly as one that reads them.

**Two clocks, deliberately different.** *Online* expires after 45 seconds and clients beat every 25,
so one missed beat is forgiven and a closed laptop goes dark inside a minute. *Typing* expires after
8 and is refreshed no more than every 3 while somebody is actually typing — a stale "still typing…"
over an empty composer is worse than no indicator at all, because it is a wrong answer rather than a
missing one.

**The heartbeat follows the tab, not the socket.** A backgrounded tab on a phone can hold a
connection open for minutes after the phone went into a pocket, so "the socket is up" is a poor
answer to "is anyone there". The client beats only while `document.visibilityState` is `visible`,
and stops typing the moment the tab is hidden.

**It is not a directory.** Presence obeys the same rule the sync filter applies to a `user` row:
somebody in a workspace with you, or somebody you are already in a direct conversation with. Without
that, a dot would be a way to enumerate the accounts on an instance — the exact thing the `user`
filter exists to prevent. The set is recomputed at most twice a minute per connection, and only when
somebody unknown turns up, so a new direct conversation lights up within half a minute.

**What is shown.** A dot on a person, never on a channel: *somebody in here is online* is not a fact
anybody acts on. Online is a dot and offline is its absence rather than a second colour, so the
reader who cannot separate green from red is reading a shape. The typing line sits on a fixed row
above the composer whether or not anybody is typing, because a line that appears and disappears
shoves the conversation up and down while somebody is trying to read it.

Signing out drops the dot immediately. Closing a tab does not — a person with two tabs open would
blink offline and back on every time they closed one, so the last tab simply stops beating and they
fade within the minute.

## What is deliberately not here

- **No read receipts.** The read marker exists and is private. Making it public is a different
  product with different social consequences, and it is a one-way door.
- **No voice or video.** Not a thing a project tool should be reimplementing.
- **No threads as a separate view.** A message can answer another one and the answer is shown in
  place; a conversation that needs its own view is a page.

## Where it lives in the code

| | |
|---|---|
| `packages/shared/src/modules/chat/chat.ts` | the rules both sides have to agree on — the derived id, unread, titles, name shape |
| `packages/shared/src/kernel/registry/entities.ts` | `channel`, `message`, `channelRead` |
| `packages/server/src/kernel/write-path/repo.ts` | the invariants, the guards, and the notification rules |
| `packages/server/src/kernel/sync/routes/sync.ts` | the visibility filter for a delta pull, and the presence frames on the stream |
| `packages/server/src/modules/chat/presence.ts` | who is here and who is typing — in memory, never a row |
| `packages/web/src/modules/chat/presence.ts` | the same on the client: the heartbeat, the store, and the hooks |
| `packages/web/src/modules/chat/routes/chat.tsx` | the screen |
| `packages/shared/src/modules/pages/markdown.ts` | `#WEB` and `WEB-42`, turned into links — given the keys, never guessed |
| `packages/web/src/modules/pages/Markdown.tsx` | the composer's `#` menu, and following a reference without a reload |
| `packages/web/src/kernel/identity/routes/Login.tsx` | `AcceptInvite` — the invite link, opened by an account that already exists |
| `packages/server/src/kernel/identity/routes/auth.ts` | `GET /api/people` — the instance's directory, for starting a conversation |
| `packages/server/src/kernel/write-path/bootstrap.ts` | `addMember`, which is what makes somebody appear in the People list at all |
