# The spots, and the sheets

Eighteen films and fifty-eight stills, out of one folder. Everything below the fold is about the
films; [**the stills**](#the-stills) — the Instagram carousels — are at the end, because they are
made of the films' own parts.

Six thirty-second films, each rendered in three shapes — eighteen masters. All of them are 30fps
and **exactly 900 frames** — 30.00s — because that is what a social upload cuts at and what a
landing-page loop can hold.

| shape | | |
|---|---|---|
| 16:9 | 1920×1080 | a landing page, YouTube, a slide |
| 9:16 | 1080×1920 | a story, a reel, a short |
| 4:5 | 1080×1350 | the feed post — the tallest thing Instagram and LinkedIn will show without cropping |

| spot | composition | output | |
|---|---|---|---|
| the product | `KolibriThirty` | `kolibri-30s.mp4` | offline-first, five layouts, quick add, dependencies, MCP |
| tasks | `TasksThirty` | `tasks-30s.mp4` | one line to file it, every field, the query |
| pages | `PagesThirty` | `pages-30s.mp4` | markdown, wiki links, two at once, comments, history |
| sign-up | `SignUpThirty` | `signup-30s.mp4` | the first account, invites, SSO, two-factor, sessions |
| workspace | `WorkspaceThirty` | `workspace-30s.mp4` | what a workspace is, roles, feature switches, teams |
| hierarchy | `HierarchyThirty` | `hierarchy-30s.mp4` | workspace → team → project → task, and the two rules |

Each has a `…Vertical` and a `…Feed` sibling, and a `build:…:vertical` and `build:…:feed` script
beside its own.

```bash
npm install
npm run dev                # the studio, on http://localhost:3000
npm run build              # → out/kolibri-30s.mp4
npm run build:vertical     # → out/kolibri-30s-vertical.mp4
npm run build:feed         # → out/kolibri-30s-feed.mp4
npm run build:tasks        # and :pages, :signup, :workspace, :hierarchy —
                           # each with :vertical and :feed beside it
npm run poster             # the frame a <video> shows before it plays
```

`out/` is a build directory and is not committed. The rendered masters that ship live in
[`assets/video/`](../../assets/video) and [`assets/social/`](../../assets/social); copy them over
after a change that is meant to go out.

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
  social/        the stills: seven sets of 4:5 sheets, made of the same widgets
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

## Three shapes, two arrangements

**4:5 is not a third layout.** It is the same 1080 pixels across as 9:16, so every screenshot crop,
every widget and every measurement holds unchanged; what differs is 570 pixels of height. That is
expressed as a budget in `STACKED` (`src/components/Layout.tsx`): how much room the words may take,
how far apart things sit, and where the floor is. Two places genuinely could not absorb it and say
so in their own files — the board window in the offline beat, and the collage in the close.

The flagship spot has a wide layout and a stacked layout written out separately —
`src/spots/kolibri/scenes/` against `scenes/tall/` — because half its beats are screenshots whose
crops genuinely differ from a wide frame's. The five explainers do not: every beat is words plus one
widget, so `components/Beat.tsx` holds both arrangements and a scene says only how big the widget is.

Three things the stacked cuts decide for themselves:

- **A safe area.** `STACKED` reserves the bottom of the frame — in 9:16 the strip a phone puts a
  caption, a handle and three buttons over; in 4:5 a smaller reserve, because a feed post is shown
  whole but a stack that runs to the last pixel still reads as one that ran out of room. Reserving
  it once is what stops seven beats from having seven ideas about where the floor is.
- **Bleed, deliberately.** The board and the layout deck are *wider* than the frame and hang off one
  edge, because a desktop UI letterboxed politely inside a vertical frame reads as a screenshot of a
  screenshot. Which edge is not arbitrary: the layouts beat hangs off the left so the view switcher
  in the top-right corner stays on screen, since its walk from the first icon to the fifth is the
  point of the beat. The crops are anchored at a corner rather than centred for the same reason: a
  centred crop keeps the board's column headers at 9:16's height and loses them at 4:5's.
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


## The stills

Seven sets of **1080×1350** PNGs — six Instagram carousels and one folder of standalone posts, 58
sheets in all. They render out of `src/social/`, they ship in
[`assets/social/`](../../assets/social), and they are made of the films' own parts: the same
palette, the same fonts, the same product facts, and the same eleven animated widgets.

| set | slides | |
|---|---|---|
| `pitch` | 8 | what Kolibri is |
| `quickadd` | 10 | the syntax, one sigil to a slide |
| `offline` | 8 | the mirror, the queue, the clock, the per-field merge |
| `hierarchy` | 8 | the six levels and the two rules |
| `assistant` | 8 | MCP: the tools, the transports, the token |
| `selfhost` | 7 | one command, one process, one file, one directory |
| `singles` | 9 | not a carousel — nine posts for the days between |

```bash
npm run social            # all seven → out/social/<set>/<set>-01.png …
npm run social:quickadd   # or one
npm run social:proof      # a contact sheet per set, for looking before posting
```

### A widget handed a number

**Every widget in `components/` takes `frame` as a prop rather than calling `useCurrentFrame()`.**
That was written for the spots, so that one animation could appear in two of them without being
written twice — and it is the whole reason this folder was cheap. A still is one of those widgets
handed a number: `<QuickAddField frame={140} …>` is the line after it has been parsed and filed, and
it is the same pixels the film draws at second 4.7. Nothing had to be rewritten to hold still.

Which number is the one thing to tune when a sheet looks wrong, so it is written at the call site in
the set and never behind a helper.

### A carousel is a filmstrip

Each set is one composition of *n* frames at 1fps, and frame *n* is slide *n*. That buys two things.
`npm run social:pitch` is one render — one bundle, one browser — that writes the whole deck; and the
studio scrubs it, which is the same gesture the reader's thumb will make.

### Three rules the sheets keep

- **The words are at the ceiling; the picture is centred in what is left.** Not for the look: it is
  so the kicker lands on the same line on every slide of a set. Two earlier versions were worse in
  instructive ways — centring the whole column moved the headline by fifty pixels between a one-line
  sub and a two-line one, and pinning the picture to the floor instead opened a four-hundred-pixel
  hole in the middle of any slide whose widget was short.
- **The cover is composed inside the square.** Instagram shows a post whole in the feed and
  centre-cropped to 1:1 on the profile grid, so 135 pixels come off the top and bottom of the
  thumbnail — and the thumbnail is the cover. The inner slides spend the full height; `SQUARE` in
  `social/sheet.ts` is the budget the cover keeps to.
- **Basic latin only, in anything that has to line up.** `@fontsource` splits JetBrains Mono by
  unicode range, and the box-drawing characters are in no subset this build loads. The clock slide's
  first diagram used `└──┘`, got them from whatever mono the renderer had, and did not line up.

### And one thing they deliberately do not have

**A story format.** 9:16 is the shape this folder already covers properly — six spots are rendered
in it, and a story is where a *video* plays. A still card in that slot would be a worse version of a
file that already exists, and a second thing to remember to re-render.
