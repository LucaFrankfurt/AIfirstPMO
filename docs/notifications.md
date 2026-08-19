# Notifications

Two channels, one source of truth: everything lands in the **in-app inbox**, and email is an
optional delivery of the same events. Nothing is ever email-only, so turning email off never means
missing something — it just means you have to look.

## What triggers a notification

| Kind | When | Counts as "important" |
|---|---|---|
| `assigned` | Someone assigns a task to you (on creation or later) | yes |
| `mention` | Your `@handle` appears in a comment, a task description or a page | yes |
| `comment` | A comment on a task you are assigned to, subscribed to, or created | no |
| `comment` | A comment on a page you wrote, or on one you have already commented on | no |
| `due_soon` | A task you are on is due within two days, or is already past due | yes |
| `invite` | You were invited to a workspace (email only — you have no account yet) | yes |

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

## What is deliberately not here

- **No daily/weekly digest.** The batching window covers the "too many emails" problem; a scheduled
  digest is a different feature and is listed in [`TODO.md`](../TODO.md).
- **No email-to-task inbound.** Receiving mail means running an MTA, which is a much bigger
  commitment than sending.
- **No web push.** It needs VAPID keys and a subscription store; also in the to-do list.
