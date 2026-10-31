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

**Offline.** The service worker is never asked for a sandboxed frame — measured: a frame served only
from its cache did not load offline. The browser's HTTP cache is: the server sends `artboard.html`
with a year-long `immutable` cache, the app asks for it by its hash (`FRAME_VERSION`, which
`test/frame.test.ts` checks against the file), and fetches it once at start (`warmFrame`) so a
canvas never opened before still draws offline. Measured: a frame warmed that way, then opened with
the server gone, draws.

So a board is self-contained by necessity: no CDN scripts, no web fonts, no remote images. System
fonts, inline SVG and `data:` pictures work. The MCP tools say so in their descriptions, because the
assistant writing the board is the one who has to know.

## Editing

Double-click a board. **Design** shows it at its own width, scaled to fit: click to select, double-
click text to type where it stands, drag the grip to move an element before or after another, and an
inspector beside it for the selected element's text, link and inline style, its table rows and
columns, and blocks to insert after it — heading, text, box, two columns, table, list, button,
divider, callout. **Source** is the same board as HTML. Undo and redo cover the session's design
edits. **Try it** runs the board as written — links, buttons, scripts.

Elements are found by number. Before a board is drawn for editing, every element a person may pick
gets its document-order number as `data-k`; the frame reports clicks by it and the edit comes back
against the same text. Each render is numbered, and a message about an older render is dropped — an
edit against yesterday's numbers would change the wrong thing. The numbers are never saved.

Only what is in the source can be edited in place. What a board's script draws at runtime — a chart,
a computed total — can be commented on and changed in its source, but not clicked and retyped.

## Comments

A comment on a canvas is a pin: a board and a point on it in the board's own pixels, so it stays on
the thing it was put on however the canvas is panned or the board moved. Pins are ordinary page
comments with `anchor: { board, x, y }` and live in the page's one thread. Export and import carry
them over to the new board ids.

## Over MCP

`create_page` with `format: "canvas"` makes one; `add_artboard`, `update_artboard`, `get_artboard`
and `delete_artboard` work on boards; `get_page` lists a canvas's boards without their HTML;
`comment_page` pins a comment to a board, and `list_page_comments` reads the discussion back — so an
assistant can be asked to act on what people said. See [`mcp.md`](mcp.md).

## Not done

In [`TODO.md`](../TODO.md), with the reason for each: suggestions, a saved history per board, boards
in search, pictures and fonts from this server, a fixed set of libraries boards may use, live cursors,
share links and exports of a canvas, canvases as templates, and the browsers nobody has run it in.
