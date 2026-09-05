# The spots

Six thirty-second films, each rendered in two shapes — twelve masters. All of them are 30fps and
**exactly 900 frames** — 30.00s — because that is what a social upload cuts at and what a
landing-page loop can hold.

| spot | composition | output | |
|---|---|---|---|
| the product | `KolibriThirty` | `kolibri-30s.mp4` | offline-first, five layouts, quick add, dependencies, MCP |
| tasks | `TasksThirty` | `tasks-30s.mp4` | one line to file it, every field, the query |
| pages | `PagesThirty` | `pages-30s.mp4` | markdown, wiki links, two at once, comments, history |
| sign-up | `SignUpThirty` | `signup-30s.mp4` | the first account, invites, SSO, two-factor, sessions |
| workspace | `WorkspaceThirty` | `workspace-30s.mp4` | what a workspace is, roles, feature switches, teams |
| hierarchy | `HierarchyThirty` | `hierarchy-30s.mp4` | workspace → team → project → task, and the two rules |

Each has a `…Vertical` sibling at 1080×1920, and a `build:…:vertical` script beside its own.

```bash
npm install
npm run dev                # the studio, on http://localhost:3000
npm run build              # → out/kolibri-30s.mp4
npm run build:vertical
npm run build:tasks        #   :vertical
npm run build:pages        #   :vertical
npm run build:signup       #   :vertical
npm run build:workspace    #   :vertical
npm run build:hierarchy    #   :vertical
npm run poster             # the frame a <video> shows before it plays
```

`out/` is a build directory and is not committed. The rendered masters that ship live in
[`assets/video/`](../../assets/video); copy them over after a change that is meant to go out.

Like `sites/docs` and `sites/demo`, this is **not** a workspace of the root project. It has its own
dependency tree, and nothing in the root `npm test` knows about it — Remotion brings React, a
bundler and a renderer with it, and the server's "no runtime dependencies" rule is not a rule this
folder should be allowed to bend.

## Where things are

```
src/
  plan.ts        900 frames, and the refusal to render anything that is not
  product.ts     facts quoted from the product — every spot quotes the same copy
  theme.ts       the app's dark palette, lifted from sites/demo/src/styles/site.css
  fonts.ts       Inter and JetBrains Mono, bundled rather than fetched
  assets.ts      the screenshots, imported out of sites/docs rather than copied
  components/    the primitives, and the eleven animated widgets
  spots/
    kolibri/     the flagship — seven beats, half of them real screenshots
    tasks/       what a task is
    pages/       what a page is
    signup/      how somebody gets in, and who decides
    workspace/   what a workspace is, and what it has switched on
    hierarchy/   the six levels, and the two rules that keep them honest
```

**A widget is where the behaviour lives; a scene only says how big it is.** The outbox knows when
the wifi comes back, the quick-add field knows where its tokens are, the gantt knows how far the
drag went, the query box knows which row each clause removes. A scene positions them and nothing
else, which is why one animation can appear in two spots and two shapes without being written four
times.

## The three storyboards

Each spot's beat table is the only place its lengths are written down, and `plan()` refuses to
return if they do not add up to 900.

**Kolibri** — the product. `src/spots/kolibri/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 105 | the mark, the name, the one-line tagline |
| 2 | offline | 150 | the real board, with the outbox drawn over it: three edits queue, then merge |
| 3 | layouts | 138 | list → board → timeline, the same nine tasks, the chrome holding still |
| 4 | quick add | 156 | the one-line syntax typed, parsed into fields, filed as a task |
| 5 | dependencies | 126 | a bar dragged four working days; the task it blocks follows |
| 6 | assistant | 126 | an MCP `create_task` call arriving and the task it files |
| 7 | close | 99 | pages, chat, insights and my-work at the edges; the install command; the URLs |

**Tasks.** `src/spots/tasks/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 96 | Kolibri / Tasks |
| 2 | quick add | 150 | the line typed, parsed, filed |
| 3 | fields | 138 | state, priority, assignee, label, cycle and module arriving one at a time |
| 4 | sub-tasks | 132 | a sub-task typed, filed, and given an identifier of its own |
| 5 | workflow | 132 | a task walking its states, and being refused at the last door |
| 6 | query | 156 | a query typed, and eight rows becoming three, clause by clause |
| 7 | close | 96 | |

**Pages.** `src/spots/pages/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 96 | Kolibri / Pages |
| 2 | editor | 168 | markdown typed on the left, the page rendering on the right |
| 3 | links | 126 | `[[` opening a picker, and the backlink that costs no table |
| 4 | two at once | 150 | two carets in one sentence, both insertions surviving |
| 5 | comments | 138 | a passage selected, commented, and a whole sentence typed above it |
| 6 | history | 126 | three versions, a line diff, and a restore |
| 7 | close | 96 | |

**Sign-up.** `src/spots/signup/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 96 | Kolibri / Sign-up |
| 2 | the first account | 150 | a form filled in, and the workspace and starter project it makes |
| 3 | invites | 132 | a role picked, a link copied, and the link becoming nothing |
| 4 | single sign-on | 126 | two doors, and the switch that closes one |
| 5 | two-factor | 144 | six digits landing, and ten recovery codes |
| 6 | sessions | 156 | three devices, one revoked, and what the database actually holds |
| 7 | close | 96 | |

**Workspace.** `src/spots/workspace/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 96 | Kolibri / Workspace |
| 2 | one at a time | 132 | a switcher, two workspaces, two roles, and the projects changing behind it |
| 3 | roles | 156 | a four-by-five matrix filling in as a staircase |
| 4 | features | 228 | six switches off, five turned on, one turned back off, and no rows touched |
| 5 | teams | 156 | two teams, their keys, their people and their projects |
| 6 | close | 132 | |

**Hierarchy.** `src/spots/hierarchy/timing.ts`

| | beat | frames | what is on screen |
|---|---|---|---|
| 1 | open | 96 | Kolibri / Hierarchy |
| 2 | the shape | 222 | the tree building a level at a time, workspace down to sub-task |
| 3 | identifiers | 138 | a key and a number fusing into `WEB-6`, twice |
| 4 | nesting | 162 | a container project, a private child, and a guest who sees one of them |
| 5 | cycles and modules | 156 | a cycle across two projects, then an emptied list and all three |
| 6 | close | 126 | |

## What is real and what is drawn

The **Kolibri** spot's beats 2, 3 and 7 are real screenshots, imported straight out of
`sites/docs/src/assets/screens/` rather than copied here — one source, and a re-shoot of the
product's screens updates the spot with no step in between.

Everything else is **drawn**, to the app's own measurements and out of the app's own palette. Each
widget's file says why at the top; the short version is that a screenshot cannot show a drag, a
parse, a merge or a tool call arriving, and compositing motion onto a capture looked like exactly
what it was.

Nothing on screen is invented. The quick-add line and the query are quoted verbatim from
`packages/shared/src/modules/work/quickadd.ts` and `query.ts`; the MCP arguments are four of the
properties `create_task` declares in `packages/server/src/adapters/mcp/tools/tasks.ts`; the CRDT,
anchor, diff and link beats each say what their module's docblock says. The tasks in the query
beat are the seeded workspace's own, and Ada is `me`.

## Two shapes

The flagship spot has a wide layout and a tall layout written out separately — `src/spots/kolibri/scenes/`
against `scenes/tall/` — because half its beats are screenshots whose crops genuinely differ. The
two explainers do not: every beat is words plus one widget, so `components/Beat.tsx` holds both
arrangements and a scene says only how big the widget is in each.

Three things the vertical cuts decide for themselves:

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

## One thing they deliberately do not have

**Audio.** The spots are built for a muted autoplaying `<video>` and for a social timeline, which are
both silent by default, and every frame of them is legible without sound. Adding music means
shipping a licence with the repository. If you want a bed, drop an `<Audio>` into a spot's
`Spot.tsx` — each is 30.0s to the frame, so anything cut to thirty seconds lines up.

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
