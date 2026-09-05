# The thirty-second spot

A Remotion composition that renders `kolibri-30s.mp4` — 1920×1080, 30fps, exactly 900 frames.
It is the video for the top of [demo.kolibri.day](https://demo.kolibri.day) and for the places that
cut an upload at thirty seconds without asking.

```bash
npm install
npm run dev              # the studio, on http://localhost:3000
npm run build            # out/kolibri-30s.mp4          — 1920×1080
npm run build:vertical   # out/kolibri-30s-vertical.mp4 — 1080×1920
npm run poster           # out/poster.jpg — the frame a <video> shows before it plays
```

`out/` is a build directory and is not committed. The rendered master that ships lives in
[`assets/video/`](../../assets/video); copy both files over after a change that is meant to go out.

Like `sites/docs` and `sites/demo`, this is **not** a workspace of the root project. It has its own
dependency tree, and nothing in the root `npm test` knows about it — Remotion brings React, a
bundler and a renderer with it, and the server's "no runtime dependencies" rule is not a rule this
folder should be allowed to bend.

## The storyboard

Seven beats. The table in [`src/timing.ts`](src/timing.ts) is the only place their lengths are
written down, and `src/Root.tsx` refuses to render if they do not add up to 900.

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 105 | the mark, the name, the one-line tagline |
| 2 | offline | 150 | the real board, with the outbox drawn over it: three edits queue, then merge |
| 3 | layouts | 138 | list → board → timeline, the same nine tasks, the chrome holding still |
| 4 | quick add | 156 | the one-line syntax typed, parsed into fields, filed as a task |
| 5 | dependencies | 126 | a bar dragged four working days; the task it blocks follows |
| 6 | assistant | 126 | an MCP `create_task` call arriving and the task it files |
| 7 | close | 99 | pages, chat, insights and my-work at the edges; the install command; the two URLs |

## What is real and what is drawn

Beats 2, 3 and 7 are **real screenshots**, imported straight out of `sites/docs/src/assets/screens/`
rather than copied here — one source, and a re-shoot of the product's screens updates the spot with
no step in between.

Beats 4, 5 and 6 are **drawn**, to the app's own measurements and out of the app's own palette
(`src/theme.ts` is the dark theme from `sites/demo/src/styles/site.css`). Each is drawn for a reason
that is written at the top of its file; the short version is that a screenshot cannot show a drag, a
parse or a tool call arriving, and compositing motion onto a capture looked like exactly what it was.

Nothing on screen is invented. The quick-add line is quoted verbatim from the docblock of
`packages/shared/src/modules/work/quickadd.ts`; the MCP arguments are four of the properties
`create_task` declares in `packages/server/src/adapters/mcp/tools/tasks.ts`; WEB-4 is the same WEB-4
in the In Progress column three beats earlier.

## The 9:16 cut

`KolibriThirtyVertical` is the same seven beats, on the same frames, re-laid-out — not this one
letterboxed. It shares everything that carries meaning (`copy.ts`, `timing.ts`, the widgets in
`src/components/`, the backdrop) and duplicates only what genuinely differs between a wide frame and
a tall one, which is where things go: `src/scenes/tall/` against `src/scenes/`.

Three things the vertical cut decides for itself:

- **A safe area.** `TALL` in `src/components/Layout.tsx` reserves the bottom of the frame — the strip
  a phone puts a caption, a handle and three buttons over. Reserving it once is what stops seven
  beats from having seven ideas about where the floor is.
- **Bleed, deliberately.** The board and the layout deck are *wider* than the frame and hang off one
  edge, because a desktop UI letterboxed politely inside a vertical frame reads as a screenshot of a
  screenshot. Which edge is not arbitrary: the layouts beat hangs off the left so the view switcher
  in the top-right corner stays on screen, since its walk from the first icon to the fifth is the
  point of the beat.
- **Its own grid, not a scaled one.** The gantt is rebuilt from `day` and `rowHeight` rather than
  shrunk, which is why those are props. Scaled down, its four-day drag would have been four days of
  eleven pixels each.

## One thing it deliberately does not have

**Audio.** The spot is built for a muted autoplaying `<video>` and for a social timeline, which are
both silent by default, and every frame of it is legible without sound. Adding music means shipping
a licence with the repository. If you want a bed, drop an `<Audio>` into `src/Video.tsx` — the
composition is 30.0s to the frame, so anything cut to thirty seconds lines up.


## Fonts, and the browser

Inter and JetBrains Mono come from `@fontsource/*` in `node_modules`, not from a CDN, so a render on
a machine with no DNS produces the same file as one with. `src/fonts.ts` holds frame 0 back until
the faces are actually decoded — `font-display: swap` otherwise draws the first frames at fallback
metrics, which is how a headline that fitted in the studio ends up wrapping in the output.

Remotion downloads its own Chrome Headless Shell on the first render. Where that download cannot
reach `remotion.media`, point `CHROMIUM_PATH` at a Chromium that is already on disk — the same
variable `scripts/responsive.mjs` and its neighbours read:

```bash
CHROMIUM_PATH=/path/to/headless_shell npm run build
```
