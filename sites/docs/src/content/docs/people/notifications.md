---
title: Notifications
description: One inbox and three optional deliveries of the same events — and how to make it quieter without missing anything.
sidebar:
  order: 2
---

Everything lands in the **in-app inbox**. Email, a phone banner and Telegram are optional
*deliveries* of the same events, not separate feeds.

That is the design worth knowing: **nothing is ever delivery-only.** Turning every channel off
never means missing something — it means you have to look.

## What produces one

| Kind | When | Counts as "important" |
|---|---|---|
| **Assigned** | Somebody assigns a task to you | yes |
| **Mention** | Your handle appears in a comment, a task description or a page | yes |
| **Comment** | On a task you are assigned to, following, or created | no |
| **Comment** | On a page you wrote, or one you have already commented on | no |
| **Due soon** | A task you are on is due within two days, or is already past due | yes |
| **Invite** | You were invited to a workspace | yes |
| **Message** | Somebody wrote to you directly, or named you in a channel | instant channels only |

*Important* is what a channel falls back to when you choose **only what needs me**. The in-app
inbox always gets everything — it is the source of truth, not a channel.

A due-date reminder is sent **once per task per due date**. Moving a deadline is a new deadline
and earns a new reminder; missing one does not earn a daily repeat of the same sentence.

Notifications are ordinary synced rows, so the inbox works offline and marking something read on
your phone marks it read on your laptop.

## Making it quieter

*Settings → Notifications.* In rough order of how much they help:

**A summary instead of each one** — off, daily or weekly. It widens the batching window for you
alone. Mentions and assignments still go out on the normal window; a digest that swallows those
is a digest people turn off.

**Only what needs me** — per channel. Drops everything not marked important above.

**Per conversation, in chat** — the bell at the top of a channel. All messages, only mentions,
or nothing. [Muting beats a mention.](/people/chat/#being-told-about-it)

**Unfollow things.** You are followed automatically when assigned, when you comment and when you
create. The Follow button on a task or page is also an unfollow button.

## The four channels

**In-app inbox.** Always on. The bell in the sidebar.

**Email.** Off unless whoever runs the instance has pointed it at a mail relay — and if they have
not, you are not missing anything, because the inbox has it. Email is **batched into one message
per person** rather than one per event, and every message carries a one-click unsubscribe that
works without signing in.

**A banner on this device.** *Settings → Notifications* turns on Web Push **for the browser you
are sitting at**, and asks for permission only when you press the switch. Permission belongs to
a browser, and somebody who wants banners on their phone rarely wants them on the machine the
app is already open on all day.

The push itself carries **nothing** — no title, no text. Your browser receives an empty ping and
the app fetches the notification itself over the same session, so nothing of yours sits on a
push service's disk.

**Telegram.** The one that reaches a phone in a second without a browser being open. If the
operator has configured a bot, *Settings → Notifications → Telegram → Connect* gives you a link;
tapping **Start** in Telegram connects your own chat.

The order matters and is not decoration: a bot cannot message somebody who has not written to it
first, so there is no version of this where an admin points your notifications anywhere. Kolibri
never learns a phone number. Disconnect from either end — the button here, or `/stop` in the
chat.

## When email stops arriving

Two ordinary reasons before you assume a bug:

- **The instance has no mail relay configured.** *Settings → Notifications* says so plainly, and
  labels a local capture inbox as a capture inbox so it can never be mistaken for delivery.
- **Your address was suppressed.** A permanent bounce or a spam complaint stops Kolibri writing
  to an address again. Suppressed addresses are listed in *Settings → Notifications* and can be
  cleared by hand — the person it happened to is the one who knows it is fixed. A full mailbox or
  a greylisting does *not* suppress; that is a bad afternoon, not a dead address.

## What is deliberately not here

**No email-in.** You cannot file a task by writing to an address — receiving mail means running a
mail server, which is a much bigger commitment than sending. A commit *can* reach a task, through
an incoming webhook.
