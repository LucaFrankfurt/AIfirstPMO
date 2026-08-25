---
title: Search
description: Two searches, one box — instant titles from your own device, and full text across everything from the server.
sidebar:
  order: 4
---

Press <kbd>⌘</kbd><kbd>K</kbd> — <kbd>Ctrl</kbd><kbd>K</kbd> on Windows and Linux. Type. Use
<kbd>↑</kbd> and <kbd>↓</kbd> to move through the results and <kbd>↵</kbd> to open one.

## Two searches behind one box

**Titles, instantly, from your device.** The first results appear before you have finished the
word, because they are matched against the copy of the workspace already in your browser. No
request, and it works with no connection.

**Full text, from the server.** Underneath, a full-text search across tasks, pages, comments,
projects, cycles and chat messages — the body of things, not just their names. This one needs a
connection and arrives a moment later, merged into the same list.

You do not choose between them. If you are offline you get the first, and the list says so.

## What it will not show you

Search never returns something you could not have opened. A private project you are not in, a
private channel you are not a member of, a direct conversation between two other people — none of
those appear.

The chat case is worth stating precisely, because it is the one that is easy to get subtly
wrong: a private conversation is **checked against its membership before the page of results is
trimmed**. That means a hit you may not read cannot even push a readable one off the end of the
page — you would notice the gap, and the gap would be information.

## Jumping rather than searching

The palette is also a navigator. Typing a project key, a person's name or a task identifier
takes you there; `WEB-42` opens that task directly, from anywhere, including from a different
project.

## When you want a list rather than a hit

Search is for *find the one thing*. For *show me everything matching* — every open urgent task
across three projects — use a filtered view and save it. The
[filter language](/reference/filters/) has a `text` field for the case where the thing you are
filtering on is a word:

```text
text ~ migration AND is: open
```
