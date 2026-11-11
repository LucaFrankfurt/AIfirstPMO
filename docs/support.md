# Support chat

Chat widgets on other websites, and an inbox inside Kolibri the team answers them from.

**Status:** phases 1 and 2 are built, the team chat included. What is open, and why, is at the end
and in `TODO.md`.

## The goal

A workspace defines **several chat widgets**, each for one audience — signed-in B2B customers,
prospects, end customers — and embeds each on other websites with one script tag. The same team
answers all of them, live from Kolibri; when nobody is there, the answer reaches the customer by
email. Later a model answers first and hands over to a person.

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
| allowed sites | exact origins allowed to frame the widget; `https` only, `http` only for `localhost`; no wildcards |
| greeting | the first line a visitor reads |
| colour | the button, the window's header and the visitor's own messages |
| who is told | members notified of a new message; nobody ticked means the workspace's owners and admins |
| replies by email go to | an inbox connected under Mail; answering the support email then writes into the conversation |
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

**One conversation per visitor per widget.** A returning visitor finds their history by widget and
`sub`. A visitor writing into a resolved conversation reopens it. There is no contacts table.

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
description. Once; after that the button opens it.

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

What was measured: a token from `jose`'s `SignJWT` verifies against the server's check, and the
same two tags on a plain HTML page on another origin open the chat, send, and receive an answer
live. The Next.js wrapper itself has not been run inside a Next.js app.

## Phase 3 — the model (not started)

1. **Suggested replies.** The model drafts and an agent sends. Nothing it writes reaches a visitor
   unread, so it can be wrong without harm.
2. **The model answers first.** It answers from the pages a widget names as its knowledge — never the
   workspace-wide search — with sources, hands over on request or when unsure, and the agent sees
   everything it said. No tools and no writes, and a daily budget per widget, because otherwise an
   anonymous stranger spends the operator's key. It needs the existing double switch: the operator's
   key and the workspace's `ai` flag.

## Not doing

Other channels (WhatsApp, social, email as an inbox), SLA clocks, satisfaction ratings, routing
rules, canned responses, reports, a contacts register — and **one tenant per shop**: if each shop
owner were to answer their own end customers, that is a platform of its own, not a widget.

## Open

- **The visitor's window costs about 125 KB gzipped on the first click**, measured from the build
  when this changed: most of it React itself (about 55 KB) and the app's stylesheet (26 KB). It was
  222 KB until the window stopped importing the app's catalogue and its menus and dialogs — it now
  carries its own thirty words (`adapters/widget/words.ts`, held to the app's wording by a test) and
  draws icons from `ui/icon.tsx` rather than through `ui.tsx`.
