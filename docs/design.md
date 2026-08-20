# Design

The rules the interface follows, and the ones it is being brought back to.

This is a working document rather than a description of a finished thing: the port to Tailwind and
Radix is under way, so some of what follows is **how it is** and some is **what a screen must look
like once it has been touched**. Each section says which.

## The idea, in one paragraph

Quiet by default. One accent colour, hairline borders, almost no shadow, and no decoration that is
not carrying information. A project tool is looked at for six hours a day; anything that shouts on
the first morning is something somebody is still flinching at in week three. Colour means *status* —
overdue, blocked, done — so a colour spent on chrome is a colour that no longer means anything when
it appears on a task. Density is high enough to see a working set at once and no higher.

## Layers, which decide who wins

`app.css` has two halves and the boundary between them matters more than it looks.

The top is Tailwind's: `@import "tailwindcss"`, the `dark` variant, the two animations, the phone
helpers, `@theme inline`, and the token blocks. Everything after that — every hand-written rule
still waiting to be ported — sits inside **`@layer components`**.

That one line is the reason a ported element behaves. `@import "tailwindcss"` puts every utility in
`@layer utilities`, and CSS gives *unlayered* rules precedence over every layer no matter their
specificity. While this file was unlayered, `h1, h2, h3, h4 { margin: 0 }` beat `mt-5` on a heading,
`p { margin: 0 0 0.75em }` beat `m-0`, and the global focus outline beat `outline-none` on a button
that had already drawn its own ring. Every one of those was silent — the class was in the DOM and
did nothing.

So the order is the documented one, and the rules follow from it:

| | |
|---|---|
| `theme` | the tokens |
| `base` | preflight |
| `components` | **everything hand-written in `app.css`** |
| `utilities` | every Tailwind class |

- **A utility beats a legacy rule.** That is the premise of an incremental port: touching a screen
  means its classes now describe it, whatever the old stylesheet said.
- **A legacy rule that must beat a utility goes in `@layer utilities` with a doubled selector.**
  There are exactly three — `hide-sm`, `only-sm`, `not-sm` — because they set `display` and have to
  beat a `flex` sitting on the same element. Inside one layer specificity decides, so
  `.not-sm.not-sm` wins. Adding a fourth is a decision, not a shortcut.
- **`scripts/unstyled.mjs` compares the classes the source uses against the ones the stylesheet
  defines.** Run it after a build. A class name is a string, so nothing else can tell you that
  `class="field"` stopped meaning anything — which is what happened when the port deleted `.field`
  and left seventy-six call sites behind.
- **`packages/web/test/forms.test.ts` catches the rest of what a codemod does quietly**: a form
  whose submit button lost `type="submit"`, a `htmlFor` pointing at nothing, and two utilities in
  one string that contradict each other.

## Width is not the window

The three helpers that switch a control between its wide form and its compact one — `hide-sm`,
`only-sm`, `not-sm` — are **container queries on `.main`**, not media queries on the viewport. The
distinction is the whole point:

At 900px the sidebar appears and takes 248px. A window growing from 899 to 900 therefore leaves the
screen with *less* room than it had — 652px instead of 899. Keyed to the window, the wide project
header rendered into that and did not fit: its controls wrapped onto a second row, drew over the tab
strip below, and squeezed the title to nothing. The band was 900–940px, which is a laptop with the
window not quite maximised, and nobody finds that by looking at one screenshot.

- **The threshold is 764px of content**, which is what the busiest bar in the app needs — a project
  header carrying saved views, five layout buttons, filter, display and the add button. Measured,
  not guessed.
- **Every use of the three must be inside `.main`.** A container query with no container never
  matches, so a label moved into the sidebar, or into a dialog (Radix portals those to `<body>`),
  would not turn compact — it would vanish.
- **`container-type` does not make `.main` a containing block for `position: fixed` descendants**,
  whatever layout containment usually implies. The selection bar still positions against the
  viewport and still carries `--sidebar-width` in its inset. This was checked in a browser after
  being written the other way, which put the bar under the sidebar.
- **Nothing in a one-row bar may `flex-wrap`.** `.header` is 52px tall and scrolls sideways when its
  contents do not fit; a second row has nowhere to go and lands on whatever is beneath it.
- **A bar's title carries `min-w-[72px]`, never `min-w-0`.** The floor is what makes "the header
  scrolls rather than squeezing the title away" true, and a utility saying `0` silently removes it.

`node scripts/responsive.mjs` (`npm run check:responsive`) walks every screen from 340px to 1600px
in 20px steps and asks whether the page scrolls sideways, whether a one-row bar is taller than
itself, whether a header control reaches over the tabs, and whether a title has been squeezed away.

## Tokens

Everything visual comes from a CSS custom property in `styles/app.css`. They are aliased into
Tailwind with `@theme inline`, so `bg-raised` and `var(--bg-raised)` are the same value and always
will be.

The consequence is worth stating once, because it is what made a gradual port possible: **dark mode
needs no `dark:` variants.** The variables are redefined under `[data-theme='dark']` and under
`prefers-color-scheme: dark`, so a Tailwind class built on a token is already correct in both
themes. A ported screen and an unported one cannot disagree about a colour.

### Surfaces and ink

| Token | Tailwind | What it is for |
|---|---|---|
| `--bg` | `bg` | the page |
| `--bg-sunken` | `sunken` | what sits *behind* the content — the app frame, an empty state |
| `--bg-raised` | `raised` | cards, sheets, menus, anything with an edge |
| `--bg-hover` / `--bg-active` | `hover` / `active` | the two interaction states, never a colour of their own |
| `--fg` | `fg` | body text and headings |
| `--fg-soft` | `soft` | labels, secondary text, icon buttons at rest |
| `--fg-muted` | `muted` | hints, timestamps, placeholders — *never* something you must read |
| `--line` / `--line-strong` | `line` / `line-strong` | hairlines, and the edge of a control |

Three levels of ink and no more. A fourth grey is how a hierarchy stops being one.

### Accent and status

`--accent` is the only brand colour, and it means **"this is the action"** or **"you are here"**.
`--accent-soft` is its background for a chip or a selected row; `--accent-fg` is what goes on top of
it.

`--ok`, `--warn`, `--danger` mean exactly what they say, and are **reserved**: a warning colour used
for emphasis is a warning nobody will believe. They always ship with a word or an icon as well as
the colour, because roughly one reader in twelve cannot separate the red from the green.

Charts get `--chart-1` and `--chart-2`, re-stepped rather than flipped for dark. See
[`insights.md`](insights.md).

### Radius, shadow, motion

`--radius-sm` (7px) for controls, `--radius` (10px) for cards, `--radius-lg` (16px) for sheets.
Pills use `999px`. **Nothing else** — `border-radius: 4px` and `5px` and `6px` all appear in the
current stylesheet, which is a thing to remove as screens are ported, not a set of choices.

Two shadows: `--shadow-sm` for a raised control, `--shadow` for something floating over the page.
A card in a list gets a border, not a shadow.

Motion is short and only ever confirms something happened: the enter and exit of a menu or a sheet.
Everything honours `prefers-reduced-motion`, and the Radix components carry `motion-reduce:animate-none`.

## Type

The system stack — `-apple-system`, `Segoe UI`, `Roboto` — because a project tool should look like
the machine it is running on, and a webfont is a second network request before anybody can read
anything.

**The scale, for anything ported:**

| Size | Where |
|---|---|
| 11.5px | chips, counts, timestamps |
| 12.5px | labels, secondary rows, hints |
| 13.5px | body: task titles, menu items, buttons |
| 15px | a sheet title, a section heading |
| 19px | a screen title |

Five sizes. The current stylesheet has fourteen, from 9px to 26px, which is not a scale but an
accumulation — half a pixel of difference is a decision nobody made on purpose. Ported screens use
the table above.

**16px is the floor for anything typed into on a phone.** Below it iOS zooms the page in on focus
and never zooms back out. The `Input` component handles this: `text-[16px] sm:text-[13.5px]`.

## Layout

Mobile-first. One breakpoint that matters, **900px**: below it the bottom bar and full-width sheets,
above it the sidebar and centred dialogs. That one is about the *window*, because it decides what
the window contains.

Everything about whether a control fits is about the *content column* instead, and asks `.main` —
see [Width is not the window](#width-is-not-the-window). The two are not interchangeable and the
bug that proved it lived at 910px.

The stylesheet also breaks at 699, 800 and 1000; those are accidents to be folded into 900 (or into
Tailwind's `sm`/`lg`) as screens are ported.

Spacing is Tailwind's 4px scale. The sidebar is `--sidebar-width` (248px) and the header
`--header-height` (52px), because two things need to agree about them.

**Touch targets are 36px or more**, which is what the `default` button size is. `iconSm` (32px) is
for a control inside a dense row where the whole row is also clickable.

## Components

The interactive primitives are Radix underneath, in `components/ui/`. Their wrappers in
`components/ui.tsx` keep the API the screens already use.

| | Built on | Why not by hand |
|---|---|---|
| `Sheet` | Radix Dialog | focus trap, focus restored to the opener, the rest of the page hidden from a screen reader, scroll position kept |
| `MenuButton` | Radix DropdownMenu | arrow keys, Home/End, typeahead, `role=menu` with matching item roles, flipping when there is no room below |
| `Tooltip` | Radix Tooltip | appears on keyboard focus, not only under a pointer |
| `Button` | CVA | one focus ring, one disabled state, one height table |
| `Input`/`Select`/`Textarea` | CVA | one focus treatment, and the 16px rule above |

Still hand-written and still candidates, in the order they are worth doing: `Select` (a native one
cannot be styled consistently or show an icon per option), `Checkbox`, `Tabs`, `Popover` for the
filter and display controls.

### Icons

45 hand-drawn paths in `ui.tsx`, typed as `IconName` so a shape that does not exist is a compile
error rather than three quiet dots. `lucide-react` is now available and is the right source for
anything new; the hand-drawn set stays until a screen that uses it is ported.

One stroke weight, one size per context: 16px inline, 15px in the sidebar, 13–14px inside a small
button.

## Rules that are not about looks

These are the ones that decide whether the thing is usable, and they are checkable.

1. **Focus is always visible, and only for the keyboard.** `focus-visible`, never `focus`. A ring on
   a mouse click is noise people learn to ignore, and then they ignore it on Tab too.
2. **Every icon-only control has an `aria-label`.** A tooltip is not a name — it is decoration that
   happens to contain the same words.
3. **Colour is never the only carrier.** Status has a word or a shape beside it.
4. **An empty state says what to do next**, and links to the guide where there is one. `Empty`
   exists for this; a blank panel is a dead end, and a dead end is where somebody decides the tool
   is broken.
5. **Nothing that writes is shown to somebody who may not write.** `useCanWrite()`, once, rather
   than `role !== 'guest'` in fifteen places.
6. **A destructive action is confirmed and says what it will destroy** — `useConfirm()`, with the
   name of the thing in the sentence.
7. **Text is translated, always.** Three catalogues with enforced key parity; a string in a
   component is a bug the walkthrough catches in German and French.

## Porting a screen

The port is deliberately incremental. The order inside one screen:

1. Replace `.btn`, `.input`, `.card` with the components. Do not re-style them inline.
2. Replace `style={{ … }}` with Tailwind classes. There are ~575 inline style props left, and they
   are the main reason two screens that should look the same do not.
3. Fold odd font sizes into the five-step scale and odd radii into the three tokens.
4. Delete the CSS class from `app.css` **once the last screen stops using it, and not before** —
   `node scripts/unstyled.mjs` after a build is how you know. This is the step that went wrong: the
   commit that added the field components deleted `.field` while seventy-six `<div class="field">`
   were still on screen, and every form in the app lost its spacing without a single error.
5. Walk the screen with the keyboard only, and once at 390px wide.
6. Run `npm test` — the source-level checks in `packages/web/test/forms.test.ts` catch the three
   things a codemod breaks silently — then `npm run check:css` and `npm run check:responsive`.

`app.css` is the progress bar: **1,862 lines** when the port started, **1,847** now — up from 1,713,
because four rules the port had deleted too early came back.

## What stays in CSS, and why

The port is not aiming at zero. Three kinds of rule belong in the stylesheet and moving them would
make the code worse:

- **The tokens and the reset.** Everything else is built on them, including Tailwind's own theme.
- **`.md` — the rendered markdown.** That HTML is produced by `renderMarkdown` as a *string*, on the
  server as well as in the browser: a shared page and a notification email go through the same
  renderer. It cannot carry Tailwind classes, so its styling is CSS by necessity rather than by
  preference.
- **Bespoke layout scenes**: the gantt grid, the roadmap, the planner rows, the board columns, the
  guide's animated diagrams. These are one-of-a-kind geometry, often with keyframes and
  `grid-template` maths. A component's worth of utility classes describing a single chart is not
  more maintainable than the twelve lines of CSS it replaces; it is the same thing, written where it
  is harder to read.

Everything that is a *component* — anything that appears twice — is Tailwind.
