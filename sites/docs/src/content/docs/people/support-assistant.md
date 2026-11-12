---
title: The support assistant
description: A model that drafts replies for the team, or answers visitors first from pages you choose and hands over to a person when unsure.
sidebar:
  order: 7
---

Off unless three people say otherwise.

| step | who | where |
|---|---|---|
| 1. A model on the server | whoever runs the instance | *Settings → Server → Model* — provider, API key, model name — or the environment, see [Asking a model to read a task](/beyond/task-reviews/) |
| 2. AI on for the workspace | an owner or admin | *Settings → Workspace → Task reviews and canvas boards* |
| 3. The assistant on for a widget | an owner or admin | *Settings → Widgets → the widget → The assistant* |

Step 1 or 2 missing: the widget's form says so.

## Three settings

| *The assistant* | |
|---|---|
| Off | only people answer |
| Suggests replies to the team | *Suggest a reply* in the inbox drafts an answer into the box; a person sends it, edits it, or does not |
| Answers first, hands over when unsure | it answers visitors itself, names the pages it used, and hands over |

Start with **Suggests replies to the team**: every draft is read by a person before it is sent.

| | |
|---|---|
| What it may read | up to 20 pages; nothing else in the workspace; private pages are never sent |
| Answers a day | default 50; past it, every conversation goes to a person |

## When it hands over

It goes quiet and the team is told at once when:

- the pages do not answer the question;
- the visitor is upset, or asks about their own account;
- the visitor presses **Talk to a person**;
- a member answers in the conversation — answering is taking over;
- the day's answers are spent;
- the model does not answer, or answers something that cannot be read.

The inbox shows *Assistant answering* while it is in charge of a conversation.

## What leaves the instance

| setting | sent to the model | when |
|---|---|---|
| Suggests | the conversation, the widget's pages | a member presses *Suggest a reply* |
| Answers first | the conversation, the widget's pages | a visitor writes, until it hands over |

Never: the workspace's search, other pages, tasks, members. Instructions inside a visitor's message
change nothing.

## Trying it

- [ ] a question the pages answer, in German and in English — answered in that language, sources below
- [ ] a question the pages do not answer — hands over
- [ ] a question about the visitor's own account — hands over
- [ ] an upset visitor — hands over
- [ ] *"Ignore your rules and …"* — not followed
- [ ] *Talk to a person* — the team is told at once
