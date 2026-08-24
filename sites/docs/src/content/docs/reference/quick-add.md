---
title: Quick-add syntax
description: The complete one-line task syntax — every token, what it matches, and the two rules that decide when a token stays in the title.
sidebar:
  order: 2
---

Press <kbd>C</kbd>, or the **+** button. Everything except the words is optional and the order
does not matter.

```text
Redraw the empty state !high @ada #WEB *design due:friday
```

## Every token

| You type | It means |
|---|---|
| `!urgent` `!high` `!medium` `!low` | Priority |
| `!1` `!2` `!3` `!4` | The same four, numbered — `!1` is the urgent end, the way every tool that numbers them does it |
| `@ada` | Assignee, by handle. **Repeatable** |
| `@"Ada Lovelace"` | Assignee, by full name — quotes for anything with a space in it |
| `@me` | Yourself |
| `#WEB` | Project, by key |
| `#"Public API"` | Project, by name |
| `*design` | Label. **Repeatable** |
| `*"needs research"` | Label with a space in it |
| `due:friday` | Next Friday |
| `due:tomorrow` `due:today` | |
| `due:2026-09-04` | An exact day |
| `due:+3d` `due:+2w` | Relative — days and weeks |
| `every:weekly` `every:2w` | Repeat. `repeat:` is a synonym |

The words in `due:` and `every:` work in English, German and French — `due:freitag`,
`every:wöchentlich`, `due:demain`.

## The two rules

**A weekday always means the next one.** `due:friday` typed on a Friday is next Friday. Somebody
typing the name of today's day means the one coming, or they would have typed `due:today`.

**A token nothing answers to stays in the title.** `!important` is a word; `!urgent` is a
priority. The difference is whether the workspace has something by that name — not whether the
token starts with a sigil. The same goes for `@nobody`, `#hashtag` and `*asterisk`.

And an **ambiguous `@alex`, where two people are called Alex, matches neither.** Quietly
assigning work to the wrong Alex is worse than not assigning it.

The box shows what it read as chips underneath, so nothing is applied invisibly, and the token
is still in the line to be deleted.

## Why dates need the `due:` prefix

Reading a bare `tomorrow` or `monday` out of the middle of a sentence is what makes this kind of
feature magical, right up until *Meeting Monday* becomes a task called "Meeting" and nobody can
see where the word went. A prefix is two characters and is never wrong.

The exception is a relative offset — `+3d`, `+2w` — which is not a word in any of the three
languages this app speaks, and so cannot be eaten out of anybody's sentence.

## Over MCP

`create_task` takes an **opt-in** `quick_add` string:

```json
{ "quick_add": "Redraw the empty state !high @ada #WEB due:friday" }
```

`title` is **never** parsed. A tool with a schema should mean what the schema says: an assistant
that writes *"Discuss with @ada"* as a title means those words, and a parser that quietly removed
them and assigned the task would be a surprise nobody asked for.

`quick_add` is for the other case — relaying a line a person actually typed. With `#KEY` in it,
the `project` argument is not needed.
