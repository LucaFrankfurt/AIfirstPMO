---
title: Comments and mentions
description: Markdown comments with attachments and reactions, who gets told, and inline comments that survive the text being edited around them.
sidebar:
  order: 4
---

Comments sit at the foot of a task and at the foot of a page. They are the same editor as the
chat composer and the page body, so everything below works in all three.

## What a comment can hold

- **Markdown** — the usual, plus checkboxes and code blocks.
- **`@mentions`** with autocomplete. `@ada`, `@adalovelace` and `@ada@example.com` all work;
  a handle nothing answers to is left as written.
- **Images**, pasted or dropped straight in. They upload, downscale in your browser before
  sending, and go in as markdown. The same picture pasted twice costs one copy on the server.
- **Attachments** of any kind.
- **Task and project references.** Type `WEB-42` and it becomes a link to that task; `#WEB`
  becomes a link to that project, and typing `#` offers both.

What is stored is the **token, not a link** — `WEB-42`, exactly what you typed. A markdown link
would make the text say something different from what was written and would break the moment
somebody quoted it somewhere that is not this app.

:::note
The renderer is told which project keys actually exist rather than matching a pattern, which is
why a conversation about `UTF-8` or `ISO-8601` does not fill up with dead links.
:::

## Reactions

Anybody who can see the thread can react to any comment with an emoji, including somebody
else's. That is the one thing you may do to another person's words, and it is not a change to
them — it is your name in a list beside them.

## Who gets told

| You do this | Who hears |
|---|---|
| Comment on a task | Everyone assigned to it, everyone following it, and whoever created it |
| Comment on a page | Whoever wrote the page, and whoever has already commented on it |
| Mention somebody | That person, whether or not any of the above applies |

Mentioning yourself does nothing. Mentions and assignments are treated as *important*, which
matters because that is the set a channel falls back to when somebody has chosen "only what
needs me" — see [notifications](/people/notifications/).

A page's audience is deliberately the people who have shown up rather than everyone who *could*
see it, because everyone who could see a page is the whole workspace, and notifying all of them
teaches people to ignore the bell.

## Mentions in a description or a page body

The same `@handle` works in a task description and in a page. Only a **newly added** handle
notifies: a page saves itself as you type, so a rule of "tell whoever is named" would ping the
same person once a second for a name they were told about at the first keystroke. Editing the
paragraph around an existing mention says nothing new.

## Inline comments on a page

Select a passage in a page and comment on it, and the comment is anchored to those words rather
than to the bottom of the document. The anchor survives the text being edited around it — a
paragraph inserted above does not slide the comment onto somebody else's sentence.

If the passage itself is deleted, the comment stays in the thread and says it has lost its
anchor, rather than disappearing with the text. A comment is often the reason the text changed.

## Editing and deleting

You can edit your own comment; the thread shows that it was edited. You can delete your own, and
an admin can delete anybody's — it goes to the trash like everything else, and *Settings → Data*
can restore it until the trash is emptied.

Deleted chat messages are the one exception: they are not listed in the trash. A message somebody
withdrew should stay withdrawn, and a list of them would be a way to read exactly that.
