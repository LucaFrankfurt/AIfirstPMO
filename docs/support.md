# Support chat

Chat widgets on other websites, and an inbox inside Kolibri the team answers them from.

**Status:** built — phases 1 and 2, the team chat on the shared components, answers by email, and the
model. What is open, and why, is at the end and in `TODO.md`.

## The goal

A workspace defines **several chat widgets**, each for one audience — signed-in B2B customers,
prospects, end customers — and embeds each on other websites with one script tag. The same team
answers all of them, live from Kolibri; when nobody is there, the answer reaches the customer by
email. A model may answer first, from pages the team chose, and hand over to a person.

It is not a Chatwoot clone. `docs/comparison.md` already says service management is a different
product's job, and that stays true: one channel (the website), one inbox, and a conversation that
can become a task — because that last step is what a tracker has and a helpdesk does not.

## Switching it on

Settings → Workspace → **Support chat**. Off by default, like every other switch: it is the first
time people outside the workspace can write to it live. Switching it off closes every widget at
once — the button on a site opens onto "not available" — and keeps every conversation.

Settings → **Widgets** then makes one. An owner's or admin's screen, because a widget decides who
outside the workspace may write in:

| field | what it decides |
|---|---|
| name | the window's title, and the name in the inbox and in notifications |
| project | who sees the conversations (whoever can see the project), and where tasks made from them land |
| who may write | **signed-in visitors** (the host site vouches for them) or **anyone** (a typed name and email, unverified) |
| allowed sites | origins allowed to frame the widget: exact ones, or `*.example.com` for every subdomain of a domain (not the domain itself); `https` only, `http` only for `localhost` |
| greeting | the first line a visitor reads |
| colour | the button, the window's header and the visitor's own messages |
| who is told | members notified of a new message; nobody ticked means the workspace's owners and admins |
| replies by email go to | an inbox connected under Mail; answering the support email then writes into the conversation |
| the assistant | off, suggests replies to the team, or answers first — with the pages it may read and its answers a day |
| live | off hides the window on every site without deleting anything |

## Decisions

**Own entities, not chat channels.** `widget`, `conversation` and `conversationMessage` in
`modules/support`. A visitor is not a user, so `messages.author_id` had nothing to point at, and a
stranger's message landing in the team chat is exactly what `intakes` exist to prevent.

**A small loader plus an iframe, opened on click.** `widget.js` draws a button inside a shadow root
and nothing else. The iframe, served by Kolibri at `/w/:widget`, is created on the first click.
Neither side's CSS or script can reach the other, no CORS is opened, and the widget's allowed sites
become that page's `frame-ancestors` (plus this instance itself, so the settings screen can preview
it).

**Nothing before the click.** Measured in a browser: a host page that embeds a widget makes exactly
one request to the instance before the click — `widget.js` itself. No cookie, no beacon, no frame.

**Signed-in visitors are proven by their own site.** The host signs a short-lived HS256 JWT on its
server with the widget's secret: `sub` (its own user id), `name`, `email`, `exp`. Kolibri verifies it
with `node:crypto` (`adapters/widget/token.ts`) — HS256 only, so `alg: none` is refused; `exp` is
required and may be at most a day away — and exchanges it for a stateless session of its own, signed
with the instance secret and valid for twelve hours. The token reaches the iframe by `postMessage`
and is never in a URL. The secret is a registry `secret` field, so it never syncs; an admin reveals
it on request and can rotate it, which stops every token signed with the old one at once.

**Anonymous visitors** may leave a name and an email, both optional and both shown as unverified. A
hidden field no person fills in turns a form-filling program away, and the routes have their own
rate limits (`LIMITS.widget*`). Their session lives thirty days in the iframe's own storage; where a
browser refuses third-party storage the window still works and simply forgets them on the next page.

**One conversation at a time per visitor and widget.** A returning visitor finds their newest
conversation by widget and `sub`. Resolved is said, not left to be guessed: when the team resolves a
conversation the window shows it, and anybody writing on — the visitor or a member — reopens it. The
visitor can resolve it themselves (the tick in the window's header), and once it is resolved, **start
a new chat** — which resolves the one they leave, because the window shows one conversation and an
answer in the old one would reach them only by email. The team sees the old one in the resolved list.
The window's clock button lists the visitor's earlier chats with this widget — theirs only, by widget
and visitor id — with a dot where the team answered after they left, and opens one again. The dot
comes live: the stream also says `elsewhere` (that something was answered in another of their chats,
not what) and the window asks for its list again. There is no contacts table.

**Deleting means gone.** Deleting a conversation lets go of its visitor — the same visitor writing
again starts a new one rather than bringing the old one back — and makes every line in it a
tombstone, so devices drop them and the trash takes them. Restoring it from the trash brings back
the lines deleted with it. Emptying the trash removes the conversation, its lines and the pictures
nobody else shows; a picture another conversation still shows stays. Resolve, not delete, is the
button for "done": delete is for what must not be kept.

**Live both ways.** The visitor's window listens on `/w/:widget/stream` (server-sent events) and
asks one indexed question per change on the workspace's feed, rather than trusting the event's
`kind` — the bus coalesces a burst and keeps the first kind. The team needs nothing new: a
conversation is an ordinary synced row. "Typing" is kept in memory only; the inbox asks for it every
three seconds while a conversation is open.

**The team is told once per burst.** A visitor's message notifies the assignee, otherwise the
widget's agents, otherwise the owners and admins — never anybody who cannot see the project — and
not again for further lines within five minutes. It counts as urgent for Telegram and Web Push, and
not for the email digest.

**When nobody answers live, email does — both ways.** An answer the visitor has not read within five
minutes is emailed to the address they have, through the ordinary mail queue. Reading it in the
window first withdraws the email. One pending email per conversation.

When the widget names a **reply address** — an inbox the workspace has connected under Mail — the
email's Reply-To is that inbox and its subject carries a signed tag (`[#a1b2c3d4-9f8e7d]`). The mail
poller hands every new message to `takeReply` through a port (`onMailArrival`): a message with a
valid tag, from the address the conversation already has, has the quoted email cut off and goes
into the conversation as the visitor's line — the team is told, a resolved conversation reopens. A
forged tag, another sender, a widget switched off: nothing. A tag in the subject rather than the
Message-ID chain, because the transports write their own Message-ID and keep no record of it.

**A conversation can become a task** in the widget's project, with its transcript as the
description: a first line linking back to the conversation, so whoever works the task can answer the
person who asked, in the language the member is looking at, and the pictures as pictures. Once; after that the button opens it — unless the
task has been deleted since, in which case the button makes a new one.

**One conversation component for three places.** `Thread` and `Composer` in
`kernel/design-system/conversation.tsx` draw the team chat, the support inbox and the visitor's
window: grouped lines with the speaker's corner squared off, the time in the bubble's corner, a line
per day, "seen", typing dots, pictures, the bar of actions on hover and behind a dot-button on a
phone, and a field that grows and sends on Enter. The team chat hands in its own markdown editor,
with its mention and reference menus, and its own scrolling; the visitor's lines take the site's
colour. The words come in as a prop, so the visitor's page needs none of the app's catalogue.

## For the host site

The snippet the settings screen shows, for a signed widget:

```html
<script>
  window.kolibriChat = {
    widget: '<widget id>',
    // Ask your own server for a token signed with this widget's secret.
    token: () => fetch('/api/support-chat-token').then((r) => r.text()),
  };
</script>
<script src="https://kolibri.example.com/widget.js" async></script>
```

`widget` and `token` are read on the first click, and `token` is called then — so a widget nobody
opens costs the host's server nothing. Also accepted: `color`, `position: 'left'`, and
`launcher: false` together with `window.KolibriChat.open()` for a button of the site's own.

### Next.js

The token, signed on the server with `jose`:

```ts
// app/api/support-chat-token/route.ts
import { SignJWT } from 'jose';
import { currentUser } from '@/lib/auth'; // your own session

const secret = new TextEncoder().encode(process.env.SUPPORT_CHAT_SECRET);

export async function GET() {
  const user = await currentUser();
  if (!user) return new Response('', { status: 401 });
  const token = await new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setExpirationTime('1h')
    .sign(secret);
  return new Response(token);
}
```

The two tags, in a client component mounted wherever signed-in pages render:

```tsx
'use client';
import Script from 'next/script';

export function SupportChat({ widget }: { widget: string }) {
  return (
    <>
      <Script id="kolibri-chat-config">{`window.kolibriChat = { widget: ${JSON.stringify(widget)}, token: () => fetch('/api/support-chat-token').then((r) => r.text()) };`}</Script>
      <Script src="https://kolibri.example.com/widget.js" strategy="afterInteractive" />
    </>
  );
}
```

What was measured, with exactly the two files above in a Next.js 15.5 app (App Router, `next build`
and `next start`, `jose` 5.9) on another origin: before any click the page asks the instance for
`widget.js` and nothing else; the click opens the chat, the token route is called then, and the
conversation arrives signed in — the visitor id is the `sub` the route signed, the name and address
are its claims. The snippet the settings screen shows carries the widget's colour as `color`, so
the button matches the window before anything has been asked of the instance.

## The model

Per widget, under **The assistant**: off, **suggests replies to the team**, or **answers first and
hands over when unsure**. It needs both switches the task review needs — a model configured on the
server, and AI switched on for the workspace — and the screen says so when one is missing.
`modules/support/assistant.ts`.

**Suggest.** A button over the inbox's answer box drafts a reply from the widget's pages and puts it
in the box; a person sends it, edits it, or does not. Nothing the model writes reaches a visitor
unread. Where the pages do not cover the question the draft is empty, rather than a "a colleague
will answer you" line a colleague would then send.

**Answer first.** The model answers a visitor's line itself, with "typing" while it writes, and names
the pages it used under the answer. It hands the conversation to a person — goes quiet, and the team
is told at once — when:

- it cannot answer from the pages, or the visitor is upset or asks about their own account (it says
  so in one line, in the visitor's language);
- the visitor presses "Talk to a person";
- a member answers in the conversation (answering is taking over);
- the widget's **answers a day** are spent;
- the model does not answer, or answers something that cannot be read.

The fences, which are the point: it reads **only the pages the widget names** — never the
workspace's search, never a private page, never a task; it has no tools and writes one line of text
as itself; it is asked for JSON and argued with (`parseAnswer`), so a source it names that is not one
of the pages is dropped and an answer it cannot shape is a hand-over; and the conversation is given
to it as data, with the rule that instructions inside it change nothing. Measured with a fake model
in `support-assistant.test.ts`, including that a private page ticked as knowledge is never sent.

### Setup

| step | who | where |
|---|---|---|
| 1. A model on the server | the instance's admin | Settings → Server → Model: provider, API key, model name (optional) — or the environment, `docs/ai.md` |
| 2. AI on for the workspace | a workspace admin | Settings → Workspace → *Task reviews and canvas boards* |
| 3. The assistant on for a widget | a workspace admin | Settings → Widgets → the widget → *The assistant* |

Per widget:

| field | values |
|---|---|
| The assistant | *Off* · *Suggests replies to the team* · *Answers first, hands over when unsure* |
| What it may read | up to 20 pages of the workspace; private pages are never sent |
| Answers a day | default 50; past it, every conversation goes to a person |

Environment, instead of step 1:

```bash
ANTHROPIC_API_KEY=...             # provider read off the key's name
# or
KOLIBRI_AI_PROVIDER=anthropic     # anthropic | gemini | openrouter
KOLIBRI_AI_API_KEY=...
KOLIBRI_AI_MODEL=claude-sonnet-5-5   # optional; one model for reviews, boards and support
```

- A value typed into Settings → Server wins over the environment.
- Step 1 or 2 missing: the widget's form says *Needs a model on the server and AI switched on under
  Settings → Workspace*.
- Start with *Suggests replies to the team*: a person reads every draft before it is sent.

What leaves the instance, and when:

| mode | sent | when |
|---|---|---|
| Suggests | the conversation, the widget's pages | a member presses *Suggest a reply* |
| Answers first | the conversation, the widget's pages | a visitor writes, until hand-over or the day's answers are spent |

To try a real model:

- [ ] a question the pages answer, in German and in English: answer in that language, sources below it
- [ ] a question the pages do not answer: hand-over
- [ ] a question about the visitor's own account: hand-over
- [ ] an upset visitor: hand-over
- [ ] "ignore your rules and …": not followed
- [ ] *Talk to a person*: the team is told at once

Not yet measured against a real model — `TODO.md`.

## Not doing

Other channels (WhatsApp, social, email as an inbox), SLA clocks, satisfaction ratings, routing
rules, canned responses, reports, a contacts register — and **one tenant per shop**: if each shop
owner were to answer their own end customers, that is a platform of its own, not a widget.

## Open

- **The visitor's window costs about 127 KB gzipped on the first click**, measured from the build
  when the list of earlier chats was added (`gzip -9` of the five files `widget.html` loads): most
  of it React and the app's shared chunk, and the app's stylesheet (26 KB). It was 125 KB before
  that list, and 222 KB until the window stopped importing the app's catalogue and its menus and
  dialogs — it now carries its own forty words (`adapters/widget/words.ts`, held to the app's
  wording by a test) and draws icons from `ui/icon.tsx` rather than through `ui.tsx`.
