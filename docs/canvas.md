# Canvas pages

A canvas is a page of boards: whole, styled HTML documents — a dashboard, a screen, a one-pager —
laid out side by side on a plane you pan and zoom, with sticky notes between them. People edit a
board by pointing at it; Claude writes and rewrites boards over MCP; everybody comments by pinning
a note to the spot they mean.

It exists because an artifact made with Claude could be shared but not changed or discussed by
anybody else. A canvas is where such a thing can live in the workspace instead: editable by every
member who can see the page, by hand and by an assistant, with the discussion beside it.

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

Only what is in the source can be edited in place. What a board's script draws at runtime — a chart,
a computed total — can be commented on and changed in its source, but not clicked and retyped.

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
may use, live cursors, share links and exports of a canvas, canvases as templates, and the browsers
and the packaged app nobody has run it in.
