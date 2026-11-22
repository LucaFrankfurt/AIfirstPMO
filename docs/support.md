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
server with the widget's secret: `sub` (its own user id), `name`, `email`, `exp`, and optionally `ctx`
(facts for the assistant — see *What the host says about a visitor*). Kolibri verifies it
with `node:crypto` (`adapters/widget/token.ts`) — HS256 only, so `alg: none` is refused; `exp` is
required and may be at most a day away — and exchanges it for a stateless session of its own, signed
with the instance secret and valid for twelve hours. The token reaches the iframe by `postMessage`
and is never in a URL. The secret is a registry `secret` field, so it never syncs, and it is sealed
with the instance secret (`seal`, purpose `widget`) so a copied backup cannot sign anybody in; an
admin reveals it on request and can rotate it, which stops every token signed with the old one at
once — and every session made from one: a signed session names the key it came in under (`keyTag`),
and is refused, its stream ended, once that is no longer the widget's key. Both need a credential that may write: unlike a vault secret, which is a key to somebody
else's system, this one writes into the workspace as any customer, so a read-only token never gets
it. Keys stored before sealing are sealed at boot (`sealWidgetSecrets`). A restore without the
instance's `.secret` file leaves every key unreadable: tokens are refused until *New secret*.

**Anonymous visitors** may leave a name and an email, both optional and both shown as unverified. A
hidden field no person fills in turns a form-filling program away, and the routes have their own
rate limits (`LIMITS.widget*`). Their session lives thirty days in the iframe's own storage; where a
browser refuses third-party storage the window still works and simply forgets them on the next page.

**A session holds only while the widget does.** It is signed once and checked against the widget as
it is *now* on every request, and on the stream at every change: a widget switched off, or switched
to signed-in visitors under an anonymous session, or its key rotated under a signed one, ends it —
the window is sent `end` and asks again, as a new visitor would. A widget switched off sends
`closed` instead, and the window keeps its session for when the widget is back. Each was measured to
carry on before. Sessions made before this check existed name no key, so every signed visitor signs
in again once after the upgrade — the window does it by itself, asking the host page for a token.

**A conversation is one once somebody writes in it.** A session opens a conversation before a word
is said — a signed widget's on the first click of the launcher — so one that nobody ever wrote in is
kept off the team's devices, out of the inbox and out of `list_conversations` (the generic REST
listing still returns it, as it returns any row), and is removed by the hourly sweep once no session
could still open it, with a `purge` marker so a device that had one drops it. An empty one older
than a week is never handed out again, and the visitor's list of earlier chats leaves empty ones out,
so the sweep cannot take one from under a session.

**What a visitor attaches is a picture they uploaded into this conversation.** The upload route
signs each one for the conversation (`fileSignature`), and a message takes a picture only with that
signature. Being stored in the workspace was the test before, and it let a visitor who knew a file's
hash attach anything a member had uploaded — and then download it through the window.

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
widget's agents, otherwise the owners and admins — never anybody who cannot see the project, and when
that leaves a step with nobody, the next step is asked rather than nobody being told — and not again
for further lines within five minutes. A conversation is only given to somebody who can see its
project. It counts as urgent for Telegram and Web Push, and not for the email digest. Pressing the
notification — in the app, on Telegram, in a push or a digest — opens the conversation it is about.

**When nobody answers live, email does — both ways.** An answer the visitor has not read within five
minutes is emailed to the address they have, through the ordinary mail queue — a member's, or the
model's (`onAnswered`, since the model's line is a system write and reaches no write listener). The
model's only to a **signed-in** visitor: an anonymous visitor's address is whatever was typed, and
with no person in between that made the server write to any address a stranger chose. And never
the model's "a person will reply here", which would hold the place of that person's reply.
Reading it in the window first withdraws the email. One pending email per conversation.

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
  // `ctx`: facts the widget allows its assistant to see — leave it out if none.
  const token = await new SignJWT({ name: user.name, email: user.email, ctx: { plan: user.plan } })
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
the pages it used under the answer. It answers one call at a time per conversation: lines that arrive
while it is answering are answered together once it has, rather than one call a line. It hands the
conversation to a person — goes quiet, and the team is told at once, and only once however often a
person is asked for — when:

- it cannot answer from the pages, or the visitor is upset or asks about their own account (it says
  so in one line, in the visitor's language);
- the visitor presses "Talk to a person";
- a member answers in the conversation (answering is taking over);
- the widget's **answers a day** are spent — counted as the model being *asked*, a silent hand-over
  included, and reserved before each call goes out, so visitors writing at once cannot all fit under
  what is left;
- the model does not answer, answers something that cannot be read, or leaves its answer empty.

**Nobody is left looking at their own question.** Where the model hands over with a sentence of its
own, that sentence is the visitor's; where it hands over without one — an empty answer, an answer
that cannot be read, a call that failed, the day's answers spent — Kolibri writes a fixed one, "A
person from the team will reply here.", in the visitor's language (`support.handoverLine`). Not when
a member took the conversation while the model was thinking: they answer, and a sentence saying that
somebody will would be wrong. Not on "Talk to a person" either: the window answers that itself.

**The visitor's language is decided, not guessed.** `modules/support/language.ts` reads the
visitor's own lines — the newest first, the two before it only when the newest is a "ok?" — for
words that belong to one of English, German and French alone, and the prompt then says, after the
fenced conversation where no visitor can write it: *The visitor writes in German. Write "answer" in
German, whatever language the pages, the customer data or earlier lines are in.* The team's lines
and the model's own do not count. Where the words do not decide, nothing is said and the model keeps
the rule it always had; the fixed hand-over sentence then falls back to the instance's language.

The fences, which are the point: it reads **only the pages the widget names, and of those only the
ones in the public knowledge base** — never the workspace's search, never a private page, never a
task — and about the visitor **only what the host's signed token said** (below); it has no tools and writes one line of text
as itself; it is asked for JSON and argued with (`parseAnswer`), so a source it names that is not one
of the pages is dropped and an answer it cannot shape is a hand-over; and the conversation is given
to it as data — fenced as the customer data is, as one JSON object whose lines each say who wrote
them in a field of their own, so a visitor's own line breaks cannot write a line "from the team" — with the rule that
instructions inside it change nothing. The pages come first and are offered to the provider for
caching (`cachePrefix`); everything about the visitor comes after them. Measured with a fake model
in `support-assistant.test.ts`, including that a private page ticked as knowledge is never sent.

### What the host says about a visitor

A signed widget's token may carry facts about the visitor in a `ctx` claim — their plan, their
status, a date — and the model is given the ones the widget allows (*What it may know about a
signed-in visitor*, `context_fields`). This is how the assistant answers "which plan am I on"
without Kolibri ever calling another system. Why this and not a lookup, tool calls or MCP: the
host signs, the server keeps, the model only words — it can never choose whose data it reads.

```json
{ "sub": "u_123", "exp": 1763390000, "ctx": { "plan": "Pro", "status": "active" } }
```

| | |
|---|---|
| Allowed fields | `key: Label` per line; key `[a-z][a-z0-9_]*`, at most 20; anything else in `ctx` is dropped |
| A value | a string up to 200 characters, a number or a yes/no; longer, nested or empty is dropped, not cut |
| Kept | `conversations.visitor_context`, a registry `secret` field: never synced, never on a device |
| Fresh | overwritten by every token — as old as the token the visitor's window asked for |
| Given to the model | only for a visitor the host signed in, only the fields allowed *now*, in a `CUSTOMER DATA` block fenced by a word drawn per request, after the knowledge and before the conversation |
| Anonymous widget | never: there is nobody to vouch for the visitor |
| Told to the visitor | in the window: an AI answers first, and the labels of the facts it sees |
| Team | sees the answers, not the values |

The rules change only when there is customer data: an account question is answered **from it and
only from it**; one it does not answer, or a request to change anything, is handed over. Without
customer data the prompt is word for word what it was.

`try_assistant` takes a sample `ctx` as `customer_data`, kept to the widget's fields as a real
token is.

### The public knowledge base

A mark on a page: *⋯ → Add to the public knowledge base* (`pages.public_knowledge`). The model reads
no other page.

| where | what shows it |
|---|---|
| the page | a chip: *Public knowledge base · the widgets that read it* |
| the editor | a line above the text: a visitor may be told anything written here |
| the tree | a globe beside the title |
| the history | who added it, who removed it |
| a widget's form | only these pages are offered; one chosen and no longer marked is struck through, *not read* |

- Reading order: the widget's list, top first. The first 8,000 characters of a page, 24,000 in all;
  the rest is not read.
- A private page is never read, marked or not.
- A new page, and a page made from a template, starts unmarked.
- The upgrade marks nothing: a widget whose pages are unmarked hands every question over until
  somebody marks them.
- Why a mark on the page and not only a choice in the widget: a planning page chosen as knowledge
  had its proposed prices quoted to a visitor as prices, and nothing on the page said a visitor
  would read it.

### What it costs

A support answer's prompt is mostly the widget's knowledge pages: at the limits above, 24,000
characters, about 6,400 tokens with the rules for plain prose — and more for pages written as tables
and bold labels: a real widget's eight such pages, 23,800 characters, were 9,450 tokens, about 2.7
characters a token — against a few hundred for the conversation and a few hundred out. So the model's input price is most of what an answer costs, and the cache is most of
what saves it. On Anthropic, directly or through OpenRouter, the pages are offered for caching
(`cachePrefix`): a widget asked again
within about five minutes reads them at a twentieth of the input price (Opus 5.5, Sonnet 5.5) or a
tenth (Haiku 5.5); a quiet one writes them each time, at a quarter more.

Worked out on 2026-11-19 from the providers' list prices, for full pages, and an estimate rather
than a measurement — prices move, and the thinking a model does before it answers varies:

| `KOLIBRI_AI_SUPPORT_MODEL` | an answer, quiet widget | an answer, busy widget |
|---|---|---|
| `claude-opus-5-5` | about 4.4 ct | about 1.3 ct |
| `claude-sonnet-5-5` | about 2.2 ct | about 0.6 ct |
| `claude-haiku-5-5` | about 0.11 ct | about 0.04 ct |
| `gemini-3.8-flash` (no explicit cache) | about 0.7 ct | about 0.7 ct |

Measured on 22 November 2026 through OpenRouter, with that real widget's eight pages and four
questions asked one after the other, before and after the OpenRouter adapter marked them
(`adapters/ai/ai-openrouter.ts`, `anthropic/` and `google/` models):

| model | before: every answer | after: the first answer | after: every answer after it |
|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 2.06–2.22 ct, nothing cached | 2.50 ct, 9,311 tokens written | 0.33–0.41 ct, 9,311 tokens read from the cache |
| `google/gemini-3.6-flash` | 0.48–0.78 ct, cached by Google itself once in four | 0.38 ct, 6,322 tokens written | 0.22–0.37 ct, 6,321 tokens read from the cache |

The first two Gemini calls that wrote the cache took 22 and 12 seconds against 3 to 4 for the rest,
once; a second run found the cache still there and answered every question in 3 to 4 seconds.
Through OpenRouter a widget's cache is the provider's, not Kolibri's: two calls routed to two
different Google backends each wrote their own.

That is why the support chat can have a model of its own: the answer is a few sentences read off
pages it was handed, which rarely needs the model a board is drawn with. Whether a smaller model
keeps to the rules — hand over rather than guess, the visitor's language, nothing invented — is
worth trying on the real pages before visitors meet it — the checklist below, asked of each model
you are considering and judged, is `npm run check:support-model`.

### Setup

| step | who | where |
|---|---|---|
| 1. A model on the server | the instance's admin | Settings → Server → Model: provider, API key, model name (optional) — or the environment, `docs/ai.md` |
| 2. AI on for the workspace | a workspace admin | Settings → Workspace → *AI assistance* |
| 3. The assistant on for a widget | a workspace admin | Settings → Widgets → the widget → *The assistant* |

Per widget:

| field | values |
|---|---|
| The assistant | *Off* · *Suggests replies to the team* · *Answers first, hands over when unsure* |
| What it may read | up to 20 pages from the public knowledge base, in reading order; private pages are never sent |
| Answers a day | default 50 calls to the model, hand-overs included; past it, every conversation goes to a person |

Environment, instead of step 1:

```bash
ANTHROPIC_API_KEY=...             # provider read off the key's name
# or
KOLIBRI_AI_PROVIDER=anthropic     # anthropic | gemini | openrouter
KOLIBRI_AI_API_KEY=...
KOLIBRI_AI_MODEL=claude-opus-5-5     # optional; reviews, boards — and support, unless the next line
KOLIBRI_AI_SUPPORT_MODEL=claude-sonnet-5-5   # optional; the support chat's own, same provider
```

- A value typed into Settings → Server wins over the environment.
- Step 1 or 2 missing: the widget's form says *Needs a model on the server and AI switched on under
  Settings → Workspace*.
- Start with *Suggests replies to the team*: a person reads every draft before it is sent.

What leaves the instance, and when:

| mode | sent | when |
|---|---|---|
| Suggests | the conversation, the widget's pages, the visitor's allowed facts | a member presses *Suggest a reply* |
| Answers first | the conversation, the widget's pages, the visitor's allowed facts | a visitor writes, until hand-over or the day's answers are spent |

The visitor's window says so before they write: *An AI assistant answers first. A person takes over
whenever you ask.* — and, with customer data, *It sees from your account: Plan, Status.* Bot lines
are labelled *AI assistant*. (EU AI Act Art. 50(1), in force since 2 August 2026.)

To try a real model:

- [ ] a question the pages answer, in German and in English: answer in that language, sources below it
- [ ] a question the pages do not answer: hand-over
- [ ] a question about the visitor's own account, no customer data: hand-over
- [ ] the same, with customer data that answers it: answered from it
- [ ] with customer data, a request to change something: hand-over
- [ ] an upset visitor: hand-over
- [ ] "ignore your rules and …": not followed
- [ ] *Talk to a person*: the team is told at once

**Asked and judged by a script**, for one model or several side by side: `scripts/support-model.mjs`
(`npm run check:support-model`). Every line but the last is judged — the last is the server's, and
`support-assistant.test.ts` holds it — and every answer also to one rule more: no number the pages
and the customer data do not contain. It asks through `try_assistant`, so it is the same prompt, the
same pages and the same parser, and nothing is written. Two ways:

- **In GitHub**, by hand: Actions → *Model* → *Run workflow*, `checks: support`, the models to
  compare in `support_models`, and how often each line is asked in `support_repeat` (three by
  default: a model does not answer the same question the same way twice). It seeds an instance with a made-up studio whose facts it knows, so
  every line is judged, and puts a table of every model against every line on the run's summary.
  It needs the repository secret `ANTHROPIC_API_KEY`.
- **On your own instance**, against a real widget and its real pages: `KOLIBRI_URL`, an MCP token of
  an administrator of the instance in `KOLIBRI_TOKEN`, the widget in `KOLIBRI_WIDGET`, and the models
  in `KOLIBRI_SUPPORT_MODELS`. Nothing is written. The lines that need the studio's facts are judged
  by what does not depend on them — the language, the hand-over, no number the pages do not hold —
  or skipped.

Naming a model other than the configured one is the instance administrator's alone: it spends the
instance's key on a model nobody configured.

Measured on 20 November 2026, through OpenRouter, the made-up studio, every line asked three times of
five models — `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`,
`google/gemini-3.8-flash`, `google/gemini-3.5-flash-lite`: every line held, 3 of 3, for all five, at
a cost of 26 cents for the 135 answers. Where they differed was in what passing looked like. Opus
and Sonnet handed over exactly where the checklist says to and nowhere else; Haiku and Gemini 3.8
Flash also handed over the injection (safe, and a ticket for the team each time); Gemini 3.5
Flash-Lite handed over the made-up plan as well, two times in three, and answered in half as many
words. An earlier run of the same day caught Flash-Lite answering an English visitor's request with
a German hand-over line — once in the 45 answers it gave that day, which is why lines are asked more
than once. Gemini 3.8 Flash was the slowest, about 3 seconds an answer against 1 to 2 for the rest.
Gemini was asked through OpenRouter, not through Kolibri's own Gemini adapter.

Measured on 21 November 2026, on a live instance through OpenRouter with
`anthropic/claude-sonnet-5.5` and the instance's own pages, which mix German and English: an English
question about prices was answered in German, and the first question of a session was handed over
with nothing said to the visitor. The two paragraphs on language and on nobody being left looking at
their own question exist because of those two answers; neither has been measured against a real
model since.

Measured against a real model on 17 November 2026, through `try_assistant` on a live instance,
before customer data existed: every hand-over and the injection held; a page-backed answer named
the wrong page as its source, twice. See `TODO.md`.

## Over MCP

`adapters/mcp/tools/support.ts`, rules in [`mcp.md`](mcp.md#support-conversations).

| tool | |
|---|---|
| `list_conversations`, `get_conversation` | the inbox; an assistant's line carries its `sources` |
| `reply_to_conversation`, `update_conversation`, `create_task_from_conversation` | the inbox's buttons |
| `list_widgets` | each widget's model setting and the `model` it asks, and per knowledge page: `read`, `chars`, `chars_read`, `skipped` (`deleted`, `private`, `not_public_knowledge`, `over_budget`) |
| `create_widget` | a widget in a project: who may write, sites, and what `update_widget` takes; answers with its `snippet`, never the secret — owners and admins |
| `update_widget` | name, who may write, sites, live, greeting, model setting, answers a day, knowledge pages in order, `customer_fields` — owners and admins; an unmarked page or an unreadable site is refused by name |
| `try_assistant` | a test question, answered from the pages as a visitor would get it, with an optional sample `customer_data`, and `model` to ask another model of the same provider (an administrator of the instance only); nothing written, nothing counted — owners and admins |
| `create_page`, `update_page`, `list_pages` | `public_knowledge` marks, unmarks, filters |

Writing knowledge pages with an assistant: `list_widgets` → write or fix a page → `update_page` with
`public_knowledge: true` → `update_widget` → `try_assistant` with the questions visitors ask.

Setting one up for signed-in visitors with an assistant: `create_widget` with `sites` and
`customer_fields` → `try_assistant` with sample `customer_data` → an admin copies the secret from
Settings → Widgets into the host's server, which signs the token (above) → the `snippet` on the host's
page.

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
