# Canvas pages

A canvas is a page of boards: whole, styled HTML documents — a dashboard, a screen, a one-pager —
laid out side by side on a plane you pan and zoom, with sticky notes between them. People edit a
board by pointing at it, or describe one and have a model draw it; Claude writes and rewrites boards
over MCP too; an artifact made elsewhere comes in as a file; everybody comments by pinning a note to
the spot they mean; and the whole canvas prints as a PDF, a page per board.

It exists because an artifact made with Claude could be shared but not changed or discussed by
anybody else. A canvas is where such a thing can live in the workspace instead: editable by every
member who can see the page, by hand and by an assistant, with the discussion beside it.

## A board on its own

A board does not have to live on a canvas. A **board page** — *New board* on the pages list, *Add a
board below* in a page's menu — is a page of format `board` that holds exactly one board and shows
it the way a markdown page shows its text: in the tree, with a title, a status, labels, access and a
place under a parent, opened and read like any page.

It is the same board, a row in `artboards` like every other, so everything a board is, it is —
history, pins and suggestions, pictures, search, MCP, export and the trash ask nothing new. The page
keeps its own text empty, as a canvas does, which is why an older app shows it as an empty page and
why it has no text history — each board keeps its own. Share links, downloads and templates carry
its board; see [Out of the workspace](#out-of-the-workspace). What differs is how it is shown:

- **At its own width, scaled down to fit** the column and never up — the picture the canvas and the
  editor draw, because a board is designed at a width and its pins are points in its own pixels.
  **On a phone**, where that would draw it below 60% — a 1280px board on a 390px screen is a third
  of its size — the page draws it at the screen's width instead, so a board written to be
  responsive reflows the way the same artifact does on claude.ai, and offers *As designed* to go
  back. Measured on an iPhone-sized window: the seeded one-pager drawn 374px wide at its own 16px
  text, against 35% of it scaled.
- **Pins follow what they were put on.** A pin is a point in the board's own pixels, which means
  nothing once the board reflows — so a pin also names the element under it, as the steps down from
  the body (`main:0/div:10`), and where on that element it sat, as fractions of its box. On a
  reflowed board the frame is asked where those elements are now, and answers again whenever the
  board reflows. Each step carries its tag, so an edit that moves the element leaves the pin to its
  point rather than on whatever took its place; a pin without an element — put down before this,
  or over MCP — is shown only on the designed board, and picking it switches there. Putting a pin
  down needs the designed board, so the comment tool does too. On a phone the thread covers the
  board, so picking a comment there puts the thread aside to show the pin. Measured: a pin put on
  the second heading at 1080px sat on that heading at 374px, and the seeded pin on its callout.
- **As tall as it is.** The frame measures what it drew and grows to it, down to the board's own
  height and never below, so the page scrolls rather than a window inside it. A board that is its
  frame's height (`100vh`) stays that; one that is its frame's height *plus a margin* would grow by
  the margin every time it was measured, and growing by exactly what it just grew by is taken as
  that and stopped. Measured on five boards: a `100vh + 40px` board stopped after one step at 640px,
  a script adding 1500px after load grew to 1550px, a board edited from 1800px to 900px shrank to
  900px, a board without a doctype measured its body's margins, and a short `min-height: 100vh` one
  stopped at 616px — its paragraph's margin collapses through the body, so it really does overflow
  its frame by 16px at any height. The smoke walkthrough opens the seeded one-pager, which is taller
  than its frame, and fails if the page did not grow to it.
- **Working, not a picture.** On a canvas a press picks a board up; here nothing moves, so its
  buttons, tabs and links work as in *Try it*. Pinning a comment is a mode — a layer over the board
  that takes one click.

*Edit* in the header opens the editor; renaming the board there renames the page, and the server
keeps the board's own title in step with the page's however the page is renamed. *Ask Claude* on
the page opens the editor with the dialog up, so the answer is one step of *Undo*. A new board page
starts empty with the same ways in as *Add board*, and an untitled page takes the name of the board
it is given.

## Out of the workspace

A canvas or a board page is its boards, so each way out of the workspace carries them:

- **A share link** frames each board in the shared document — a board page's one board as a window
  the height of the screen, a canvas's boards in reading order at their own heights with their
  names, its notes as text. Each board is served sandboxed from its own URL, pictures inlined only
  from its own page; see [`security.md`](security.md#what-reaches-the-outside). A stranger's note box
  works as on any shared page. A board reflows to a phone there too, being drawn at the width the
  document has.
- **Download** in the page menu: *one HTML file* — a board page as its board's own document, the
  file an artifact downloaded from Claude is, which *Import HTML…* takes back; a canvas as one
  document framing each board through `srcdoc` in a sandbox, notes as text. Pictures go in as their
  bytes either way, since a kept file cannot ask this server for them later. Measured: the seeded
  canvas, downloaded and opened from disk, runs its boards — the pipeline tile adds up to €155k.
  *Print, or save as PDF* is the toolbar's PDF; a board page's PDF is the board as designed and as
  tall as it is, measured at its own width whichever view the screen was showing.
- **A template.** *Keep as a template* works on both, and a page made from one — in the app or with
  `create_page_from_template` — is a canvas or a board page with copies of its boards where they
  stood, and none of the comments, pins or history. A board page's copied board takes the new
  page's title. (Making a page from an HTML template used to produce a markdown page showing its
  tags, in the app; it keeps the template's format and icon now.)

## Who holds the shape

The server holds the shape: a second board, or a note, on a board page is refused, and so is turning
a canvas into a board page while it has more than one board. A board page turns into a canvas from
its menu, to put things beside the board, and a canvas of one board back into a board page. A board
on a canvas can be **copied to its own page** — a copy, under the canvas, with the canvas's access
and project: its pins are that canvas's discussion, and a move would either strand them or carry
somebody's comments onto a page they never wrote on.

## What is stored

A canvas is an ordinary page with `format: 'canvas'`, and its boards are rows of their own in
`artboards`: `page_id`, a position (`x`, `y`), a frame (`w`, `h`), a `kind` (`html` or `note`), and
the board's HTML as `body` — a text CRDT — and `content`, what that reads as.

**A row per board, not one document per canvas.** Moving a board is two fields, and per-field
last-writer-wins is exactly right for a position: two people moving two boards never touch the same
field, and two people dragging one board end with it where the later one let go. Kept as one merged
text, a canvas would send every board on every drag and merge a coordinate as characters.

**The source is the document.** There is no second model of a board — no block tree beside the
HTML, no saved DOM. Every visual edit is a rewrite of the source string (`shared/modules/pages/artboard.ts`)
handed to the same collaborative text a keystroke goes through, so two people editing one board both
keep their changes, and what Claude reads over MCP is exactly what the editor wrote.

**Nothing existing changes.** A page that is not a canvas is untouched: the format is a third value
of a column every page already has, and boards are rows nothing else reads. An app from before this
shows a canvas as an empty markdown page, which is what its text columns hold. The server keeps
`canvas` rather than folding it to markdown, and refuses nothing about a page's text — a canvas's
boards cannot be overwritten through it, because they are not in it.

## Who may see a board

Exactly who may see its page; a board has no access of its own. The pull filter, the REST read and
listing, MCP and the write path all ask the page (`visiblePageSql`, `canSeePage`), and a board can
only be written onto a page the writer can see. When a page is opened up — its `access` or project
changes — every board on it gets a fresh `seq`, because a device only pulls rows that moved past its
cursor and the boards did not: without it, the people who may now see the canvas would get the page
and nothing on it. Deleting a canvas takes its boards to the trash; restoring it brings back those
that went with it. `test/artboards.test.ts` asks every door, and fails if any one of them is removed.

## Where a board is drawn

Never in the app. A board is somebody's whole page, scripts included, and the app's origin holds the
session and the offline copy of the workspace. It is drawn in `web/public/artboard.html`, inside an
iframe with `sandbox="allow-scripts"` and nothing else, and the server sends that one file under its
own policy (`buildFrameCsp` in `kernel/platform/csp.ts`). The app hands the frame a document by
`postMessage` and the frame becomes it.

Measured in Chromium before any of it was written, with a board that tries everything:

| From inside a board | Result |
|---|---|
| its own inline `<script>`, `onclick` handlers, `eval`, `<style>` | run |
| `document.cookie`, `localStorage`, IndexedDB | refused (`SecurityError`) |
| `parent.document` | refused |
| `fetch` to this server, `fetch` to the internet, an image beacon | refused (`connect-src 'none'`, `img-src data: blob:`) |
| `window.open` | refused (no `allow-popups`) |

Two things that look simpler do not work, and were measured too: a `srcdoc`, `blob:` or `data:`
frame inherits the app's own policy, so not even the frame's own script runs.

**Every render is a fresh frame.** The first version wrote each new render into the frame it already
had (`document.write`), and that keeps the frame's JavaScript realm: a board whose script declares
`const values = …` at the top threw "already been declared" on every redraw after the first, and
stopped running. So a new render loads the frame file again in a second iframe behind the visible
one, and they swap when the new one reports it is drawn — a new realm every time, no empty board in
between, and from the HTTP cache, so offline too. The scroll position is carried across.

**Offline.** The service worker is never asked for a sandboxed frame — measured: a frame served only
from its cache did not load offline. The browser's HTTP cache is: the server sends `artboard.html`
with a year-long `immutable` cache, the app asks for it by its hash (`FRAME_VERSION`, which
`test/frame.test.ts` checks against the file), and fetches it once at start (`warmFrame`) so a
canvas never opened before still draws offline. Measured: a frame warmed that way, then opened with
the server gone, draws.

So a board is self-contained by necessity: no CDN scripts and no web fonts. System fonts and inline
SVG work, and so do **pictures uploaded to this server**: the board's source names them by their
`/files/<hash>/<name>` path, and the app — which has the session, and the service worker's copy —
fetches each one and hands the frame its bytes as a `data:` URL (`board-files.ts`). The source keeps
the path, so it stays small enough to merge as text, the trash still sees the hash, and a board read
over MCP names the file. Text typed beside a picture comes back out of the frame with the `data:` URL
in it, and is turned back into the path before it is saved. In the editor, **Image** uploads and
inserts one; a selected picture can be replaced and given a description; and pictures dropped on the
canvas become boards of their own, at their own proportions. The MCP tools say all of this in their
descriptions, because the assistant writing the board is the one who has to know.

## Where a board comes from

All under **Add board**:

- **A template** — a blank page, a document, a dashboard, a phone screen.
- **Import HTML…** — an HTML file, or HTML pasted in, kept exactly as it came. This is the way in for
  an artifact made in Claude: download it there, import it here, and from then on everybody can edit
  and discuss it. Nothing is cleaned or converted on the way, because the board is drawn in the
  sandbox and the source is the document. What cannot work in a board — a script or a font from a
  CDN — is written down under [Not done](#not-done), not stripped behind the person's back.
- **Describe it to Claude…** — a sentence, a format (page, wide screen, slide, phone) and whether to
  match the boards already there. The server asks the model with two sets of rules: the ones that
  decide whether the board works at all (one complete document, nothing fetched, inline SVG instead
  of a chart library) and the ones that decide whether people can keep working on it (the look in
  each element's `style` attribute, which is what the visual editor edits; real headings, tables
  and buttons). The answer goes onto the canvas as the asker's own edit.
- **Ask Claude**, in the editor, does the same for the open board: its current HTML and what should
  change go to the model, and the answer replaces the source as one edit, which *Undo* takes back.

The last two exist only where the server has a model and the workspace has switched it on, and they
are named after the model that will answer — Claude, Gemini, or "the model" behind a gateway that
could be serving anybody's. What is sent, the two switches and what it costs are in
[`ai.md`](ai.md#boards-on-a-canvas). An assistant that already has the MCP connector needs neither:
it can write boards directly, see [Over MCP](#over-mcp).

## Editing

Double-click a board. **Design** shows it at its own width, scaled to fit: click to select, double-
click text to type where it stands, drag the grip to move an element before or after another, and an
inspector beside it for the selected element's text, link and inline style, its table rows and
columns, and blocks to insert after it — heading, text, box, two columns, table, list, button,
divider, callout, image. **Source** is the same board as HTML. Undo and redo cover the session's
design edits. **Try it** runs the board as written — links, buttons, scripts.

**History.** A board keeps what it said before each sitting of changes (`artboard_versions`, one row
per author per ten minutes, like a page's). The editor lists them, draws a version in the stage when
it is picked, and restores one — which is itself a change, so the state it replaced is kept too. Read
through the API, never synced; who may read it is who may see the canvas.

Elements are found by number. Before a board is drawn for editing, every element a person may pick
gets its document-order number as `data-k`; the frame reports clicks by it and the edit comes back
against the same text. Each render is numbered, and a message about an older render is dropped — an
edit against yesterday's numbers would change the wrong thing. The numbers are never saved.

**Notes** are edited where they stand: double-click and type. What was typed is saved when the note
stops being edited, however that happens. The first version saved on blur alone, and a click on the
canvas background deselects the note, which takes its text box out of the page before the browser
sends it a blur — so the words vanished the moment anybody clicked away, while Escape and the
toolbar kept them. The smoke walkthrough now leaves a note that way and reads it back from the server.

Only what is in the source can be edited in place. What a board's script draws at runtime — a chart,
a computed total — can be commented on and changed in its source, but not clicked and retyped.

## As a PDF

**PDF** in the toolbar prints the canvas: a page per board, each page exactly the board's size, in
reading order — top to bottom, then left to right — with the notes among them. It goes through the
browser's print dialog, where *Save as PDF* is the choice. The browser is the only thing here that
can draw a board the way it looks: a PDF made on the server would need a browser on the server,
which is a dependency this one does not take.

Every board is drawn the way *Try it* draws it, scripts run, and the dialog opens once each has
said it is drawn — or after eight seconds, for one that never does — so a chart a board's script
draws is in the PDF. Each page gets its size from a named `@page` rule; the app around it is hidden
from print by one rule that looks for the print layer. Measured in Chromium: a canvas with a
1280 × 720 dashboard, a 760 × 720 board and a 300 × 160 note printed as three pages of exactly those
sizes, the script-computed totals in them. Not measured in Safari or Firefox, whose support for
pages of different sizes in one document is the part most likely to differ. What scrolls inside a
board is cut at its frame, as it is on the canvas.

## Comments and suggestions

A comment on a canvas is a pin: a board and a point on it in the board's own pixels, so it stays on
the thing it was put on however the canvas is panned or the board moved. Pins are ordinary page
comments with `anchor: { board, x, y }` and live in the page's one thread. Export and import carry
them over to the new board ids.

**A suggestion** is a comment that carries what its passage should say instead (`suggestion`). On a
text page it starts from a selection — the bubble offers *Suggest* beside *Comment*; on a board, from
a selected element in the editor, whose source becomes the pin's passage. The thread shows the old
words struck through and the new ones beside them, with *Accept* and *Reject*.

Accepting is the server's to carry out, not the client's: it finds the passage again by its quote in
the text **as it stands then**, writes the replacement in as a content-only write — so the CRDT moves
by a diff and everything anybody typed meanwhile stays — and records who accepted it and when. If the
passage has changed since, the acceptance is refused and the comment stays open; a suggestion applied
to the wrong sentence, or marked accepted while changing nothing, would be worse. On an HTML page and
on a board the replacement is escaped: it is words, not markup. An accepted suggestion cannot be
reopened, because reopening would offer to write it a second time.

**Resolving** closes any thread. Somebody else's comment may be settled — resolved, accepted,
rejected — by anybody who can read it, the way it may be reacted to; its words stay its author's.
Settled comments fold away behind a toggle, and their pins leave the canvas.

## Search

Boards are in the full-text index as the words a reader can see on them — `artboard.text`, which drops
scripts, styles and tags, so "div" finds nothing — and a hit opens its canvas. A board has no project
of its own, so each hit is checked against its page (`canSeeBoard`), as a page and a comment are.

## On a phone

The plane pans with one finger and zooms with two, wherever they land — on a board too. A double tap
opens a board or a note, because a touch screen does not reliably send a double click. Handles and
pins grow where the pointer is coarse; the grip inside a board takes a finger without scrolling the
board. The editor stacks the board above its panel, and its bar scrolls rather than pushing buttons
under the close. The seeded instance has a canvas, so every screen check CI runs — 340px to 1600px,
contrast in both themes, keyboard reach — walks one.

## Over MCP

`create_page` with `format: "canvas"` makes one; `add_artboard`, `update_artboard`, `get_artboard`
and `delete_artboard` work on boards; `get_page` lists a canvas's boards without their HTML;
`comment_page` pins a comment to a board, and `list_page_comments` reads the discussion back with
each comment's status — so an assistant can be asked to act on what people said. `suggest_page_edit`
proposes a change to a page or a board instead of making it, and `resolve_comment` settles one. See
[`mcp.md`](mcp.md).

## Not done

In [`TODO.md`](../TODO.md), with the reason for each: web fonts and a fixed set of libraries boards
may use, live cursors, pins on a canvas that know their element too, a board drawn by a model shown
as it is written rather than when it is done, and the packaged app nobody has run it in. The model's
half was tested against a stand-in that answers like the Messages API, not against a real model.

## In other browsers

Everything above was built and measured in Chromium, and a board is the part of the app whose
behaviour belongs to the engine. `npm run check:engines` (`scripts/engines.mjs`) walks it in Firefox
and WebKit — Safari's engine: a board drawing and running its script on the canvas, the editor's
frame answering a click, a board page growing to its board, reflowing at phone width with its pin on
its element, and a shared canvas and board page working for a stranger. CI runs it inside
Playwright's own image, which has both engines and the libraries they need. What it does not reach:
printing, which Playwright drives in Chromium alone, and the packaged app on iOS and Android.
