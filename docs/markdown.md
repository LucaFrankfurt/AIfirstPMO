# Writing: the markdown Kolibri accepts

Every box in Kolibri you can write more than a line into takes the same markdown, rendered by the
same function in [`packages/shared/src/modules/pages/markdown.ts`](../packages/shared/src/modules/pages/markdown.ts). There is
one dialect, not one per screen, and this is it.

It is **not CommonMark** and does not try to be. What it is instead: small enough to read in one
sitting, safe by construction rather than by a sanitiser bolted on afterwards, and identical on the
client and the server so a page looks the same whether the browser drew it or a share link did.

## Contents

[Where you can write it](#where-you-can-write-it) · [Text](#text) · [Blocks](#blocks) ·
[Lists and checklists](#lists-and-checklists) · [Tables](#tables) · [Links, images and files](#links-images-and-files) ·
[Code and diagrams](#code-and-diagrams) · [Kolibri's own additions](#kolibris-own-additions) ·
[What the editor does while you type](#what-the-editor-does-while-you-type) ·
[What is deliberately missing](#what-is-deliberately-missing) · [Why it is safe](#why-it-is-safe)

---

## Where you can write it

| Surface | Field | Notes |
|---|---|---|
| **Page body** | `pages.content` | The big one. Also a text CRDT, so two people can type at once |
| **Task description** | `tasks.description` | The only place checkboxes can be ticked where they are rendered |
| **Comments** | `comments.body` | On tasks and on pages, including a comment anchored to a passage |
| **Chat messages** | `messages.body` | Same renderer; a message is not a lesser citizen |
| **Project descriptions** | `projects.description` | Written in the create form and in project settings |
| **Cycle goals** | `cycles.description` | Written in the cycle form, rendered above the cycle's tasks |
| **Module descriptions** | `modules.description` | Edited on the module's own screen, rendered above its tasks |
| **Automation rule bodies** | template `description` | What a rule writes into the task it files, so it arrives rendered |
| **Task review suggestions** | — | A model's proposed replacement is rendered before you accept it |

Everything above is stored as **markdown text**, never as HTML. That is the point of the plain
`<textarea>`: what is in the database is what you typed, so it exports, diffs, greps and outlives
this application.

### Where a description is a line rather than a document

A project's description appears in places that are not the same shape. At the top of the project's
own screen it is a document, rendered. In the **card** on the projects list, and in a **search
result's** snippet, it is one truncated line — so it goes through `excerpt()` first, which takes the
markup out and leaves the sentence. A heading or a bulleted list dropped into a one-line card would
break the row rather than say anything, and raw `**asterisks**` there would be worse still.

The one place it is not drawn at all is above a **board**, which is sized as the whole rest of the
window: anything added above it pushes the bottom of every column off the screen. A board is the
screen it is on. Switch that project to a list, a table or a calendar and the description is there.

That is the general rule wherever this comes up: **rendered where there is room, stripped where
there is not.** The pages list does the same thing with a page body.

---

## Text

| You type | You get |
|---|---|
| `**bold**` or `__bold__` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `~~struck~~` | ~~struck~~ |
| `` `code` `` | `code` |
| `**bold *and* italic**` | Nesting works in both directions |

Two rules worth knowing, because both were bugs once:

- **Underscores need a word boundary.** `snake_case_name` stays `snake_case_name`; only `_this_`
  with a non-word character on each side becomes italic. Asterisks have no such rule, so
  `*this*` works anywhere.
- **A code span wins.** `` `*not bold*` `` renders the asterisks, because code spans are taken out
  before any other inline rule runs and put back at the end.

### Line breaks

A single newline inside a paragraph is a **soft wrap** and renders as a space — so you can hard-wrap
your source at 80 characters and the paragraph still flows. To force a break, end the line with
**two spaces** or a **backslash**. A blank line starts a new paragraph.

Emphasis may open on one line and close on the next: the paragraph is rendered as one string.

---

## Blocks

| You type | You get |
|---|---|
| `# Heading` … `###### Heading` | `<h1>` to `<h6>`. A space after the hashes is required |
| `## Heading ##` | Trailing hashes are decoration and come off |
| `Title` then `===` | An `<h1>`, the underlined way |
| `Title` then `---` | An `<h2>` |
| `---`, `***`, `___` | A horizontal rule |
| `> quoted` | A blockquote |

`---` is both a rule and a heading underline, and which one it is depends on what is above it: under
a paragraph it underlines that paragraph, on its own it is a rule. Every markdown you have used
agrees on this, so Kolibri does too.

A blockquote can hold anything a document can — a list, a fence, a table, another blockquote — and
`> > b` nests. The one thing inside a quote that behaves differently is a checkbox; see below.

---

## Lists and checklists

```markdown
- a bullet          * and this      + and this
1. numbered         1) or this

- outer
  - nested, at two spaces
    - and deeper
```

**Nesting is two spaces per level.** A tab counts as four spaces. That number is not arbitrary: it
is what the editor's Tab key inserts, so indenting with the keyboard and indenting by hand produce
the same tree.

An ordered list that starts at `5.` renders starting at 5. Changing marker at the same depth —
a bullet where a number was — starts a *new* list rather than continuing the old one with the wrong
shape.

### Checklists

```markdown
- [ ] not done yet
- [x] done
```

Every checklist renders. Whether it can be **ticked in place** depends on where you are:

| Where | Tickable? | Why |
|---|---|---|
| Task description | **Yes** | It is your checklist and ticking it should not require opening an editor |
| The editor's own preview | **Yes** | You are already editing |
| Page body | No — edit the text | The body is a CRDT; a tick has to go through the same merge as a keystroke |
| Comments, chat | No | The one thing you may do to somebody else's words here is react to them |

A checkbox inside a blockquote is drawn **inert everywhere**. Ticking one rewrites the source by
counting boxes from the top, and that counter cannot see past a `>` — so rather than let a click
land on the wrong box, a quoted box is not counted by either side. Boxes inside fenced code are
skipped by both, which is why `- [ ]` in an example is safe to write.

---

## Tables

```markdown
| Column | Aligned | Right |
|:-------|:-------:|------:|
| left   | centre  | 12.00 |
```

- The **delimiter row is what makes it a table** — a row of dashes with at least one pipe. Without
  it the lines are a paragraph.
- Leading and trailing pipes are optional. `a | b` over `--- | ---` is a table.
- `:---`, `:-:` and `---:` set the alignment of that column.
- A row shorter than the header is **padded**; a longer one loses the extra. Every row ends up the
  shape the header promised.
- `\|` is a literal pipe in a cell.
- A table may interrupt a paragraph, the way GitHub allows.
- Cells are split **before** inline rules run, so `` `a | b` `` is two cells, not one — again,
  because that is what GitHub does, and matching the tool people learned this in beats being clever.

---

## Links, images and files

| You type | You get |
|---|---|
| `[label](https://example.com)` | A link, opening in a new tab |
| `[label](/pages/abc)` | A link inside this Kolibri |
| `[label](#section)` | A jump within the document |
| `[label](mailto:a@b.com)` | A mail link |
| `[label](/x "a title")` | The same link; the title is accepted and discarded |
| `https://example.com` | Bare URLs are linked as they stand |
| `![alt text](/files/…)` | An image, lazily loaded |

**Only four kinds of URL survive**: `http:`, `https:`, `mailto:`, and a same-origin path starting
with a single `/` (or a `#` anchor). Everything else — `javascript:`, `data:`, a protocol-relative
`//host` — is left as the literal text you typed. It does not become a link, and it never reaches an
attribute.

Images are usually not typed at all. **Paste or drop one into any editor** and it is downscaled in
the browser, uploaded, and the `![…](…)` written for you — which is what keeps a phone photo from
pushing 12 MB through a mobile connection. Non-image files land as an ordinary link.

---

## Code and diagrams

````markdown
```js
const x = 1;
```
````

Fences take backticks or tildes, and a fence closes only on **its own marker, at least as long as
the one that opened it** — so a block containing ``` is written with ````. A language after the
opening fence becomes a `language-…` class. A fence that is never closed runs to the end of the
document rather than swallowing the rest as prose.

A fence indented inside a list has that indentation stripped from every line, so the code arrives
without the list baked into it.

### Diagrams

A ` ```mermaid ` fence is drawn as a diagram in the app. Everywhere without the app's scripts — a
shared page carries none, on purpose — it stays readable as its own source text, which is the right
failure: a diagram nobody can render should still be a diagram somebody can read.

---

## Kolibri's own additions

These are the four things that are not in any other markdown, and each exists because it is what
people write anyway.

| You type | It becomes | Where |
|---|---|---|
| `WEB-42` | A link to that task | Anywhere `WEB` is a real project key in this workspace |
| `#WEB` | A link to that project | Same |
| `#anything-else` | A tag, styled but not linked | Everywhere |
| `@ada` | Notifies that person | Comments, chat, page bodies, task descriptions |

**A reference is only linked when the key is real.** The pattern is not `[A-Z]+-\d+`, because that
also matches `UTF-8`, `COVID-19` and `ISO-8601` — and a sentence about an encoding standard should
not sprout a broken link to a task nobody has. The renderer is told which project keys exist and
links only those. `NOPE-1` in a workspace with no `NOPE` project stays as plain text.

The list of keys comes from the local synced copy, so a reference resolves on a train like
everything else here. On a **public share link** no keys are passed at all: a stranger has no
workspace to be sent into, so `WEB-42` renders as text.

### Mentions

`@` in an editor opens a picker. Somebody answers to their email address, the part before the `@`,
their name without spaces, and their first name — so `@ada`, `@ada.lovelace` and
`@ada@example.com` all reach the same person. A single character is never a handle, or `@a` in a
sentence would be a mention.

Only handles that are **newly added** notify. A page autosaves as you type, and re-notifying
everybody named in it on every keystroke is the fastest way to make people turn notifications off.

---

## What the editor does while you type

The editor is a plain `<textarea>`. Every convenience below is a small rewrite of the string —
pure, testable, and doing nothing at all unless the line asks for it.

| Key | What happens |
|---|---|
| **Enter** in a list | Continues it: next bullet, next number, another empty `[ ]`, same indent |
| **Enter** on an empty item | Ends the list — which is how every editor that does this lets you stop |
| **Enter** in a quote | Continues the `>`, and an empty one ends it |
| **Tab** / **Shift-Tab** in a list | Two spaces on or off every line the selection touches |
| **Tab** outside a list | An ordinary indent, which is what somebody writing code wants |
| Paste or drop an image | Downscaled, uploaded, and written in as `![…](…)` |

There is a toolbar for **bold**, *italic*, `code`, a heading, a bullet, a checkbox and a quote, and a
**Preview** toggle that renders exactly what will be stored. In chat the toolbar is collapsed until
you ask for it, because a one-line message rarely needs it.

---

## What is deliberately missing

Each of these is an omission rather than an unfinished job.

| Not supported | Why |
|---|---|
| **Raw HTML** | Everything is escaped before any markup is produced. `<b>bold</b>` renders as text, and `<script>` cannot exist. This is the whole safety model, not a limitation on top of one |
| **HTML entities** | `&copy;` stays `&copy;`. It follows from escaping first, and the alternative is a second decoder to keep safe |
| **Four-space indented code** | Fences do this job. Indented code cannot be told from a nested list without the checkbox counter becoming a second parser, and a checkbox that ticks the wrong line is worse than a missing shorthand |
| **Reference-style links** `[a][ref]` | Rarely written by hand, and a second pass over the document to collect definitions |
| **Footnotes** | Same |
| **`www.` without a protocol** | A bare `www.` is as often prose as a URL |
| **Emoji shortcodes** `:tada:` | Type the emoji. Every keyboard has a picker now |
| **Headings without a space** | `#NoSpace` is a tag, and tags are common enough in this app that the ambiguity is settled in their favour |

If something here turns out to matter, the renderer is one file and one test file
([`markdown.test.ts`](../packages/web/test/markdown.test.ts),
[`markdown-blocks.test.ts`](../packages/web/test/markdown-blocks.test.ts)) — but the bar is that it
earns its place against the two properties above: readable in one sitting, safe by construction.

---

## Why it is safe

The order is the argument:

1. **Escape everything first.** `&`, `<`, `>`, `"` and `'` become entities before a single rule
   runs. Nothing after that point can produce a tag the renderer did not write itself.
2. **Produce a fixed set of tags.** Paragraphs, headings, lists, tables, quotes, `pre`/`code`,
   `a`, `img`, `input[type=checkbox]`, `strong`/`em`/`del`, `span`, `hr`, `br`. That is the whole
   vocabulary.
3. **Check every URL against a four-scheme allowlist** before it reaches an `href` or a `src`.
4. **Put attributes in from a fixed set of values.** Table alignment is one of three words chosen
   three lines above where it is written, not something copied out of the document.

That is why there is no sanitiser in the dependency list: there is nothing to sanitise, because
nothing dangerous is ever constructed. External links additionally carry `rel="noopener
noreferrer"` and open in a new tab; internal ones do not, so navigating within the app stays a
single-page navigation.

The rendering is the same function on both sides. A shared page is rendered by the server with no
project keys and no interactive checkboxes, and is otherwise byte-for-byte the page you wrote.
