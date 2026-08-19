# Notifications

Four channels, one source of truth: everything lands in the **in-app inbox**, and email, Web Push
and Telegram are optional deliveries of the same events. Nothing is ever delivery-only, so turning
every channel off never means missing something — it just means you have to look.

## What triggers a notification

| Kind | When | Counts as "important" |
|---|---|---|
| `assigned` | Someone assigns a task to you (on creation or later) | yes |
| `mention` | Your `@handle` appears in a comment, a task description or a page | yes |
| `comment` | A comment on a task you are assigned to, subscribed to, or created | no |
| `comment` | A comment on a page you wrote, or on one you have already commented on | no |
| `due_soon` | A task you are on is due within two days, or is already past due | yes |
| `invite` | You were invited to a workspace (email only — you have no account yet) | yes |

"Important" is what the *email* and *Telegram* channels fall back to when somebody chooses "only
what needs me". The in-app inbox always gets everything — it is the source of truth, not a channel.

Mentions accept what people actually type: `@ada`, `@adalovelace`, `@ada@example.com`. Unknown
handles are left alone, and mentioning yourself does nothing.

Only a **newly added** handle notifies. A page saves itself while you type, so a rule of "notify
whoever is named" would ping the same person once a second for a name they were told about at the
first keystroke; editing the paragraph around a mention says nothing new.

A page has no assignees, so its audience is the people who have shown up: whoever wrote it, and
whoever has commented on it. Everyone who *can* see a page is the whole workspace, and notifying
them all would teach people to ignore the bell.

A due-date reminder is sent **once per task per due date**. Moving a deadline is a new deadline and
earns a new reminder; missing one does not earn a daily repeat of the same sentence.

Notifications are ordinary synced rows, so the inbox works offline and marking something read on
your phone marks it read on your laptop.

## A summary instead of each one

**Settings → Notifications → A summary instead of each one**: off, daily or weekly. It widens the
batching window for that person only. Mentions and assignments still go out on the normal window —
a digest that swallows those is a digest people turn off.

## Email

Email is **off** until `KOLIBRI_SMTP_URL` points at a relay you control. That is deliberate: a
default that accepted every message and quietly dropped it would look identical, from inside the
app, to one that delivers — same green ticks, same "sent" in the queue, no recipient. Notifications
are not lost in the meantime; they are in the in-app inbox, which is the source of truth.

Delivery follows three rules:

**1. Queued, never inline.** A notification writes a row; a worker sends it. A slow or broken relay
can never make a request hang, and a failed send is retried with exponential backoff (1, 2, 4, 8…
minutes) until `KOLIBRI_MAIL_MAX_ATTEMPTS` is reached.

**2. Batched.** Notifications wait `KOLIBRI_MAIL_BATCH_SECONDS` (default two minutes) and are then
collapsed into **one** message per person. An afternoon of activity is one email with five lines,
not five emails. Anything you have already read in the app by then is skipped entirely.

**3. Unsubscribable.** Every message carries a `List-Unsubscribe` header and a footer link, signed
with the instance secret so it works straight from an inbox without a session.

**4. In the recipient's language.** Notification titles are rendered when the row is written — a
notification belongs to exactly one person, so it is stored in that person's language and never
needs translating again. Emails are rendered the same way at send time. Ada working in English
produces a German notification for Lin. An invitation is the exception: the invitee has no account
yet, so it goes out in the inviter's language. See [`i18n.md`](i18n.md).

Each person chooses their level under **Settings → Notifications**:

- **Everything** — assignments, mentions and comments
- **Only what needs me** (default) — assignments and mentions
- **Nothing** — in-app inbox only

### Configuring a relay

```bash
KOLIBRI_SMTP_URL=smtp://user:pass@smtp.example.com:587    # STARTTLS, the usual case
KOLIBRI_SMTP_URL=smtps://user:pass@smtp.example.com:465   # implicit TLS
KOLIBRI_MAIL_FROM=kolibri@example.com
KOLIBRI_MAIL_FROM_NAME=Kolibri
KOLIBRI_PUBLIC_URL=https://kolibri.example.com            # links in the mail need this
```

Or set the pieces separately: `KOLIBRI_SMTP_HOST`, `KOLIBRI_SMTP_PORT`, `KOLIBRI_SMTP_USER`,
`KOLIBRI_SMTP_PASS`, `KOLIBRI_SMTP_SECURE`. For an internal relay with a self-signed certificate,
`KOLIBRI_SMTP_INSECURE=true`.

### Trying it without a mail provider

The dev overlay adds **Mailpit**, a capture inbox, and wires the app to it in one command:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
open http://localhost:8025      # everything the app "sent" is here
```

Mailpit accepts every message and delivers none of them. Kolibri detects that shape of relay
(`mailpit`, `localhost`, `127.0.0.1`, and the usual capture tools) and says so in three places, so
it can never be mistaken for working delivery:

- a warning in the log on every boot,
- `"mail": "test-inbox"` from `GET /api/health` instead of a plain `true`,
- a banner in **Settings → Notifications**.

Then hit **Send a test email** in Settings → Notifications. It reports the relay's own error
message if something is wrong, which is usually enough to diagnose it (wrong port, bad credentials,
sender not allowed).

### Deliverability

Kolibri talks to a relay; it is not a mail server. If mail lands in spam, the fix is at the relay:

- Send from a domain you control and set **SPF**, **DKIM** and **DMARC** for it.
- Use a `From` address on that domain — not `kolibri@localhost`.
- Prefer a transactional provider (Postmark, SES, Mailgun, your own Postfix) over sending directly
  from a residential or cloud IP, which most receivers reject on sight.

The queue is visible in Settings → Notifications (`pending`), and every attempt records the relay's
error in `email_queue.last_error`.

## Push

Settings → Notifications turns on a banner for **this device**. Permission belongs to a browser, and
somebody who wants banners on their phone rarely wants them on the machine the app is already open
on all day. Permission is only asked for when the switch is pressed: a site that asks on load is a
site people block, and a blocked permission cannot be asked for a second time.

The push itself **carries nothing**. The usual way to send one encrypts a payload, which means ECDH
against the browser's key, HKDF, AES-128-GCM and a padding scheme — several hundred lines of
cryptography to deliver a sentence the app can ask for itself. So Kolibri sends an empty push, which
the specification allows, and the service worker fetches `/api/notifications/latest` over the same
origin and the same session. Same notification, none of the crypto, and nothing of yours sitting
encrypted on a push service's disk.

What is still needed is VAPID: a signed claim that this server is the one that asked to be allowed
to push. The key pair is generated into the data directory on first use.

| Variable | Meaning |
|---|---|
| `KOLIBRI_PUSH` | `false` turns push off entirely |
| `KOLIBRI_VAPID_PUBLIC` / `KOLIBRI_VAPID_PRIVATE` | Set them to keep subscriptions across a restore into a fresh data directory. Otherwise generated and stored in `vapid.json` |
| `KOLIBRI_VAPID_SUBJECT` | `mailto:` or a URL, for a push service that wants to complain to somebody |

A subscription that answers `404` or `410` is deleted: that is how a push service says the browser
threw it away.

## Telegram

The bell only works while the app is open, email is slow on purpose, and Web Push needs a browser
that asked for permission. Telegram is the one that reaches a phone in a second without any of
that — which is also why it needs a limit, and has one: an "important only" setting, the same set
of kinds email uses.

An operator configures **one thing**, a bot token from [@BotFather](https://t.me/botfather):

```
KOLIBRI_TELEGRAM_BOT_TOKEN=123456:AA...
```

Everything else is per person, in Settings → Notifications → Telegram. **Connect** asks the server
for a single-use code and opens `https://t.me/<yourbot>?start=<code>`; tapping *Start* there sends
the code to the bot, and the update it arrives in carries the chat id. The page notices within a few
seconds.

That order is not decoration. A bot **cannot message a chat that has never written to it**, so
there is no version of this where an admin points somebody else's notifications anywhere. Kolibri
never learns a phone number, and the code lasts fifteen minutes and works once — a stolen one would
only connect the thief's own chat to the account it was issued for, and only inside that window.

Disconnecting works from either end: the button in Settings, or `/stop` in the chat. An account that
blocks the bot is disconnected automatically — Telegram answers `403`, and retrying that forever is
how a queue fills with something that will never succeed.

### Long polling, not a webhook

Updates are collected with `getUpdates`, held open for `KOLIBRI_TELEGRAM_POLL_SECONDS` (25 by
default). A webhook would be fewer moving parts and is the wrong shape here: it needs a public HTTPS
URL, which a self-hosted instance behind NAT does not have. Long polling needs only an outbound
request, which is what this app already makes for object storage and SMTP.

One consequence worth knowing: `getUpdates` has a single consumer. **Two instances sharing one bot
token will steal each other's updates** — give each instance its own bot.

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_TELEGRAM_BOT_TOKEN` | — | The bot. Empty turns the channel off entirely |
| `KOLIBRI_TELEGRAM_POLL_SECONDS` | `25` | How long one long-poll waits. Telegram allows up to 50 |
| `KOLIBRI_TELEGRAM_MAX_ATTEMPTS` | `5` | Failed sends are retried on the hourly sweep until this |
| `KOLIBRI_TELEGRAM_API` | `https://api.telegram.org` | Overridable, which is how the tests point it at a local stand-in |

Delivery is recorded on the notification row itself — `telegram_sent_at`, an attempt count and the
last error — rather than in a second queue. The row already exists and already belongs to one
recipient, so it is the thing being delivered.

Sends are **not awaited** by the write that caused them. Somebody else's chat service must never sit
in the path of somebody's edit.

## When an address stops working

A `5xx` from the relay is final — retrying it five more times only tells the receiving domain that
nobody here is listening — so the address is **suppressed** and nothing is queued for it again.

Providers can report the rest. Set `KOLIBRI_BOUNCE_TOKEN` and point the provider's webhook at:

```
POST /api/mail/bounces
Authorization: Bearer <KOLIBRI_BOUNCE_TOKEN>
```

It reads Postmark's shape, Amazon SES over SNS, and an obvious generic one (`{"email":…,
"type":"bounce"}`). A shared secret rather than a per-provider signature, because every provider
signs differently and this endpoint does exactly one thing.

Only **permanent** bounces and complaints suppress. A full mailbox or a greylisting is a bad
afternoon, and cutting somebody off for one is worse than the retry. Suppressed addresses are listed
in Settings → Notifications and can be cleared — the person it happened to is the one who knows it
is fixed.

## What is deliberately not here

- **No email-to-task inbound.** Receiving mail means running an MTA, which is a much bigger
  commitment than sending. A commit *can* reach a task — see the incoming hooks in
  [`api.md`](api.md).
