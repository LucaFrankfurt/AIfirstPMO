---
title: Support chat
description: A chat button on your own websites, answered by the team from an inbox in Kolibri — and a conversation that can become a task.
sidebar:
  order: 5
---

Visitors write through a button on your website. The team answers from **Support** in the sidebar.

| | |
|---|---|
| Switch it on | *Settings → Workspace → Support chat* — an owner or admin |
| Set up a widget | *Settings → Widgets* — see [Chat widgets](/people/support-widgets/) |
| Let a model help | per widget — see [The support assistant](/people/support-assistant/) |

Off by default. Switching it off closes every widget at once and keeps every conversation.

## The inbox

| | where |
|---|---|
| Open / Resolved | the screen's header |
| One widget only | the header's widget menu, with more than one widget |
| Find a conversation | the box above the list — by name, email or widget |
| Unread | bold, with a dot |
| *Signed in* / *Unverified* | beside the name — whether the website vouched for who they are |
| Assigned to | the menu in the conversation's header |
| Make a task / Open task | the conversation's header |
| Resolve / Reopen | the conversation's header |

Who sees a conversation: whoever can see the widget's project.

## Answering

- **Enter** sends. Pictures by pasting or with the picture button.
- *Seen* under your line once the visitor has read it. Typing shows both ways.
- Answering a conversation marks it read for the whole team.

Who is told about a new message:

1. the person it is assigned to, otherwise
2. the widget's *Who is told*, otherwise
3. the workspace's owners and admins

Never anybody who cannot see the project. Once per burst — a visitor's three lines in a row are one
notification.

### When the visitor has left

Not read within a few minutes, your answer follows them by email — if they left an address. Reading
it in the window first cancels the email.

With *Replies by email go to* set on the widget, answering that email writes into the conversation.
See [Chat widgets](/people/support-widgets/#replies-by-email).

## Resolved, and back again

| | |
|---|---|
| The team resolves | the visitor's window says so at once |
| Anybody writes on | it reopens — the visitor with a question, a member with an answer |
| The visitor presses *Done* | resolved, from their side |
| The visitor starts a new chat | the one they leave is resolved; it stays in *Resolved* for the team |

## A conversation as a task

*Make a task* files a task in the widget's project:

- **Title** — the visitor's first words.
- **Description** — a link back to the conversation, then who said what, with the pictures.

Once. After that the button opens the task. Delete the task, and the button makes a new one.

## What the visitor sees

- A round button on the site. Nothing loads until it is clicked — no cookie, no frame.
- The window: greeting, the conversation, pictures, *Seen*, typing.
- **Done** — marks the chat resolved.
- **New chat** — once a chat is resolved.
- **Earlier chats** (the clock) — their own chats with this widget, with a dot where the team answered
  after they left. The dot appears while the window is open.

| | how long they stay recognised |
|---|---|
| Signed-in visitor | their website signs them in again on each visit |
| Anyone | 30 days, in that browser |

## With an assistant

Over MCP, with a token of a member who can see the widget's project:

| tool | |
|---|---|
| `list_conversations` | the inbox — open or resolved, by widget, unread only |
| `get_conversation` | one conversation and its thread |
| `reply_to_conversation` | answer as yourself — the same as answering in the inbox |
| `update_conversation` | resolve, reopen, assign |
| `create_task_from_conversation` | the *Make a task* button |
| `list_widgets` | each widget, and which of its pages the model reads and how much |
| `update_widget` | name, greeting, the assistant, its pages — owners and admins |
| `try_assistant` | a test question to a widget's model; nothing written — owners and admins |

See [Connecting an assistant](/beyond/assistant/).

## Deleting

*Resolve* is the button for "done". *Delete* is for what must not be kept:

- the conversation and every line go to the trash, and from every device;
- restoring brings the lines back;
- emptying the trash removes them for good, with every picture nothing else shows.

The same visitor writing again starts a new conversation.

:::note[Not here]
Other channels (WhatsApp, social, email as an inbox), SLA clocks, satisfaction ratings, routing
rules, canned replies, reports, a contacts register.
:::
