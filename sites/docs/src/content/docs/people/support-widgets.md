---
title: Chat widgets
description: One widget per audience — signed-in customers, prospects, end customers — each on its own sites, with one script tag.
sidebar:
  order: 6
---

*Settings → Widgets → New widget.* Owners and admins only: a widget decides who outside the
workspace may write in. [Support chat](/people/support/) has to be switched on first.

## The fields

| field | what it decides |
|---|---|
| Name | the window's title; the name in the inbox and in notifications |
| Project | who sees the conversations; where tasks made from them land |
| Who may write | **Signed-in visitors** — your site vouches for them · **Anyone** — name and email optional, unchecked |
| Allowed sites | the only sites that may show the widget |
| Greeting | the first line a visitor reads |
| Colour | the button, the window's header, the visitor's own lines |
| Who is told | members notified of a new message; nobody ticked means owners and admins |
| Replies by email go to | a connected mailbox — see [below](#replies-by-email) |
| The assistant | see [The support assistant](/people/support-assistant/) |
| Live | off hides the window on every site, deletes nothing |

### Allowed sites

One per line.

| you type | allowed |
|---|---|
| `example.com` | `https://example.com` |
| `https://shop.example.com/cart` | `https://shop.example.com` |
| `*.example.com` | every subdomain of `example.com` — not `example.com` itself |
| `http://localhost:3000` | for development |
| `http://example.com`, `*.com`, `*.localhost` | dropped |

## Putting it on a site

*Copy snippet* on the widget's card. It carries the widget's id and colour.

```html
<script>
  window.kolibriChat = {
    widget: '<widget id>',
    color: '#e5383b',
  };
</script>
<script src="https://kolibri.example.com/widget.js" async></script>
```

| option | |
|---|---|
| `widget` | the widget's id — required |
| `token` | signed-in widgets: a token, or a function returning one — called on the first click, never before |
| `color` | the button's colour, `#rrggbb` |
| `position` | `'right'` (default) or `'left'` |
| `launcher` | `false` draws no button; open it with `window.KolibriChat.open()` |

Before anybody clicks, the page asks Kolibri for `widget.js` and nothing else.

## Signed-in visitors

Your site's server signs a short-lived token with the widget's **signing secret**
(*Show secret* on the card). Kolibri checks it and trusts the name and email in it.

| claim | |
|---|---|
| `sub` | your own user id — how a returning visitor finds their chats |
| `name` | shown in the inbox |
| `email` | where answers go when they have left |
| `exp` | required; at most a day ahead |

HS256 only. *New secret* stops every token signed with the old one at once.

:::caution[Keep the secret on the server]
It signs tokens for anybody. Never put it in a page, a bundle or a URL.
:::

### Next.js

The token route, signed with [`jose`](https://github.com/panva/jose):

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

The two tags, in a client component rendered on signed-in pages:

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

## Anyone

No token. The window asks for a name and an email, both optional, both marked *Unverified* in the
inbox. A hidden field turns form-filling programs away; the widget's routes are rate limited.

## Replies by email

Without it, the email that follows a visitor who left asks them to come back to the site.

With a mailbox connected under *Settings → Mailboxes* and named here:

- the email's reply address is that mailbox;
- answering it writes into the conversation, without the quoted email below;
- only from the address the conversation already has, and only with the tag in the subject.
