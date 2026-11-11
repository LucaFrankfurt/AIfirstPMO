# Support chat — the plan

**Status: agreed direction, nothing built yet.** This file is the target the first pull requests
are measured against. It becomes the feature's documentation as the parts land, and anything that
stays unbuilt moves to `TODO.md` with its reason.

## The goal

A workspace defines **several chat widgets**, each for one audience — signed-in B2B customers,
prospects, end customers — and embeds each on other websites with one script tag. The team answers
the conversations live from Kolibri; when nobody is there, the answer reaches the customer by email.
Later a model answers first and hands over to a person.

It is not a Chatwoot clone. `docs/comparison.md` already says service management is a different
product's job, and that stays true: one channel (the website), one inbox per widget, and a
conversation that can become a task — because that last step is what a tracker has and a helpdesk
does not.

## Decisions

**Own entities, not chat channels.** A visitor is not a user, so `messages.author_id` has nothing
to point at. And putting a stranger's message straight into the team chat is exactly what
`intakes` exist to prevent: there, nothing reaches the board until a member accepts it. Support
gets its own capability, `modules/support`, behind its own workspace flag. It is off by default,
like every other flag.

**A small loader plus an iframe, opened on click.** The script tag draws a button and nothing
else. The iframe, served by Kolibri, is created on the first click. Neither side's CSS or script
can reach the other, no CORS is opened, and each widget's allowed sites become that iframe's
`frame-ancestors`. CSP accepts `https://*.example.com` there, which covers a platform whose shops
live on subdomains.

**Nothing before the click.** No cookie, no request to the instance, no pixel. The only request
before then is the script itself. This is a privacy promise worth making out loud, and it also
means a page view costs the instance nothing.

**Signed-in visitors are proven by their own site, not by Kolibri.** The host application signs a
short-lived HS256 JWT on its server with the widget's secret: `sub` (its own user id), `name`,
`email` and `exp`. Every language has a library that produces one. Kolibri verifies it (HS256 only,
`exp` required) and exchanges it once for a short session of its own. The token travels to the
iframe by `postMessage` and never in a URL. The widget's secret is a registry `secret` field, so it
never syncs to a device, the way a webhook's signing secret does not.

**When nobody answers live, email does.** A reply the visitor has not seen within a few minutes is
sent to the address in their token, through the existing mail adapter. Replying to that email into
the conversation comes later, if at all.

**New conversation components.** The current chat screen is the weakest part of the app's UI. The
message list and composer are built fresh, once, for both sides: the agent's inbox and the
visitor's iframe. The team chat moves onto them afterwards, as its own step.

**The model comes last and arrives with fences.** It may read only the pages a widget names as its
knowledge — never the workspace-wide search. It gets no tools and no writes, it cites its sources,
and each widget has a daily budget, because otherwise an anonymous stranger spends the operator's
key. It needs the existing double switch: the operator's key and the workspace's `ai` flag.

## Phase 1 — live chat for signed-in customers

The data, all synced to members who can see the widget's project:

| entity | carries |
|---|---|
| `widget` | name, project, allowed sites, greeting, accent colour, the agents it notifies, enabled; `secret` server-only |
| `conversation` | widget, the visitor's `sub`, name and email (from the token), open or resolved, assignee, last message, task once one is made |
| `conversationMessage` | conversation, from (`visitor`, `agent`, later `bot`), author if an agent, body |

There is no contacts table. A returning visitor is found by widget plus `sub`.

The public surface, in a new `adapters/widget` on the server:

```
GET  /w/loader.js                the button; cacheable, no per-widget content
GET  /w/:widget                  the iframe page; frame-ancestors from the widget
POST /w/:widget/session          signed token in, short Kolibri session out
GET  /w/:widget/messages         the visitor's history
POST /w/:widget/messages         a message from the visitor
GET  /w/:widget/stream           server-sent events for that one conversation
```

The visitor side is a second Vite entry in `packages/web`, loaded only inside that iframe. The
agent side needs nothing new for live updates, because a conversation is an ordinary synced row.

In the order it should land, each a pull request of its own:

1. **Widgets.** Flag, registry, schema, the settings screen: define a widget, copy the snippet,
   reveal and rotate the secret.
2. **The visitor side.** Loader, iframe, token exchange, messages, the stream, rate limits.
3. **The inbox.** The new components, conversation list, reply, resolve, assign, notifications
   (bell, push, Telegram — whatever the agent already has on).
4. **The rest of the loop.** Email when a reply goes unseen, and making a task from a conversation.

## Phase 2 — prospects and the rough edges

- **Anonymous widgets**: a name and email prompt, the honeypot and buckets intake already uses, and
  the allowed sites as the only gate. Deliberately after phase 1, because it is the first time a
  stranger with no account can open a live line into the team.
- Attachments (a screenshot is half of every support question) and a typing indicator.
- The team chat on the new components.

## Phase 3 — the model

1. **Suggested replies.** The model drafts and an agent sends. Nothing it writes reaches a visitor
   unread, so it can be wrong without harm.
2. **The model answers first.** It answers from the widget's knowledge pages with sources, hands
   over on request or when unsure, and the agent sees everything it said.

## Not doing

Other channels (WhatsApp, social, email as an inbox), SLA clocks, satisfaction ratings, routing
rules, canned responses, reports, a contacts register — and **one tenant per shop**: if each shop
owner were to answer their own end customers, that is a platform of its own, not a widget.

## Open questions

- End customers: does this team answer them, or each shop owner? The first is just another widget;
  the second is the tenant model listed above as not doing.
- Does the end-customer widget run on one domain, or on every shop's own domain? The second needs a
  wildcard, or "any site", in the allowed list.
- Which stack is the first host application? The documentation should carry a tested signing
  example for it.
