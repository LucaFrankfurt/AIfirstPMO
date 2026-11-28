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

## Tonal: surfaces, the accent's container, glass

The interface is Material 3's idea of a surface, kept quiet. Layers are told apart by *tone* rather
than by a line around each of them: the app sits in a tinted frame (`--bg-sunken`), the content is a
lighter panel set into it from 600px, and the steps between — `hover`, `fill`, `active` — are tones
of the same hue. Hairlines stay where they carry structure, between the rows of a list; they are no
longer what separates the sidebar from the page.

- **One hue.** Every neutral and the accent are steps of `--hue` in `oklch()`, whose first number is
  lightness as an eye reads it. The status colours and the chart series are deliberately not on it.
- **"You are here" is the accent's container.** The current row in the navigation, the current tab
  on a phone, a chosen chip: `--accent-soft` with the accent as ink. The filled accent is kept for the
  one action a bar is for.
- **Tonal before outlined.** A secondary button is made of `fill`, not drawn around with a border;
  `danger` keeps its outline so a destructive button looks different in shape, not only in colour.
  Buttons are pills — the one thing on screen round at the ends — and fields, chips and cards are not.
- **Glass only over content.** Menus, popovers, the header a list scrolls under and the phone's bar
  are `--glass`: opaque enough that the faintest ink clears 4.6:1 with solid `--fg` behind it, and
  fully opaque for anybody who asked for less transparency or more contrast, and in a browser that
  cannot blur. A card in the flow of the page is never glass.

`/design` shows every primitive in every state, and the browser checks walk it in four modes.

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
- **`packages/web/test/reachable.test.ts` asks whether a phone can get there.** Every top-level
  route has to be in `lib/nav.ts` — which the sidebar and the "More" screen both render — in the
  bottom bar, or named in the test with the way it is reached. This is not hypothetical: chat was
  desktop-only for a while, and budgets, the timesheet and the register shipped switched on,
  visible in the sidebar, and unreachable on a phone, because the two navigations were two
  hand-written lists and only one had been remembered.

## Width is not the window

The three helpers that switch a control between its wide form and its compact one — `hide-sm`,
`only-sm`, `not-sm` — are **container queries on `.main`**, not media queries on the viewport. The
distinction is the whole point:

At 900px the sidebar appears and takes 248px. A window growing from 899 to 900 therefore leaves the
screen with *less* room than it had — 652px instead of 899. Keyed to the window, the wide project
header rendered into that and did not fit: its controls wrapped onto a second row, drew over the tab
strip below, and squeezed the title to nothing. The band was 900–940px, which is a laptop with the
window not quite maximised, and nobody finds that by looking at one screenshot.

- **The threshold is 764px of content**, which is what the busiest bar in the app needs — the row of
  tools above a task list, carrying saved views, the query field, five layout buttons, filter and
  display. Measured, not guessed: at 764px of content it is one line in German, the longest of the
  three languages. That row used to be the project header, with the title and the add button in it
  as well; at 1024px in German it ran 284px past its room and squeezed the title to six letters.
  The header now carries only what belongs to the page, and the row stands above the list.
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
itself, whether a header control reaches over the tabs, and whether a title — or a field — has been
squeezed away. The field question was added after the mailbox editor shipped with its host input at
a content width of zero, on a screen the walk could not reach because the feature was switched off.

## Colour is measured, not eyeballed

The person who picks a grey can always read it. That is the whole problem, so none of this is
settled by looking:

`node scripts/contrast.mjs` (`npm run check:contrast`) walks every screen in its list in **four
modes** —
light and dark, desktop and phone — and for every element that renders text computes the real
background (walking up through transparency and blending as it goes) and the WCAG contrast against
it. The floor is 4.5:1, or 3:1 for large text.

Everything it found the first time it ran had been there since long before the port:

| | Was | Now |
|---|---|---|
| `--fg-muted`, light | 3.20 on white, 2.88 on a hovered row | ≥ 4.6 on every surface |
| `--fg-muted`, dark | 4.17 on the page, 3.89 on a card | ≥ 4.6 on every surface |
| `--danger` / `--ok`, dark | 3.06 and 3.92 — never re-stepped | re-stepped for the dark surface |
| `--warn`, light | 2.65 | re-stepped |
| Avatar initials | 6.7:1 on a blue one, 1.6:1 on a yellow-green one | ≥ 4.6 on all of them |
| White on `var(--accent)` | 5.4 light, 3.5 dark | `var(--accent-fg)`, which is what that token is for |

**Avatars solve their own lightness.** A fixed `hsl(hue 62% 52%)` cannot work, because lightness is
not brightness: at the same 52%, blue gave white 6.7:1 and yellow-green gave 1.6. `colorFor` now
binary-searches the darkest-necessary lightness per hue and caps it at the old 52%, so every avatar
that already worked is untouched and only the ones that did not get darker.

**Solve for 4.6, not 4.5.** Rounding a solution to six hex digits moves it by a hundredth or two, and
every value solved at exactly the floor landed on 4.48 — passing the maths and failing the check.

**Touch targets**, checked on the same run: the rule is 36px, or 32 inside a dense row that is itself
clickable. **Chips are 32px** — they were 22, which is a comfortable label and a poor button, and a
good number of them navigate somewhere. What is left below 32 is a timeline bar, a disclosure
triangle and the sync pill: marks and indicators rather than controls, and each is reachable another
way. A control whose *parent* carries the padding is the case to watch — the group-collapse toggle
looked like a 35px row and answered to 19px of it.

## Tokens

Everything visual comes from a CSS custom property in `styles/app.css`, in one of two ways, and
which one depends on a single question: does the value change with the theme?

- **Colours and shadows do.** Their values live in `:root` and the two dark blocks, and
  `@theme inline` points Tailwind at them, so `bg-raised` and `var(--bg-raised)` are the same value
  and always will be.
- **Radius and type do not.** They are declared in `@theme static` and nowhere else, which makes
  that block the one source: `rounded-sm` in a component and `var(--radius-sm)` in a hand-written
  rule read the same line. The block starts with `--radius-*: initial` and `--text-*: initial`, so
  Tailwind's own steps (`rounded-xl`, `text-sm`) do not exist at all rather than sitting beside
  ours as an easier option.

The radii used to be aliased like the colours, under Tailwind 3's names. `--radius-DEFAULT` is not
a key Tailwind 4 reads, so a bare `rounded` fell back to Tailwind's own 4px and the port wrote
`rounded-[var(--radius)]` instead, everywhere. Nothing reported it, because nothing was broken in a
way a check could see: the class existed and drew a corner.

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

**All three are readable, including the faintest.** `--fg-muted` is for hints and timestamps, and
"not important" is not an exemption — it was #8b909b, which is 3.20:1 on white and 2.88 on a hovered
row, and it carried the tab labels. Both themes now solve it for 4.5:1 against `bg`, `sunken`,
`raised`, `hover` and `active`. The hierarchy is intact: 16.9 / 8.2 / 5.5 on the page.

### Accent and status

`--accent` is the only brand colour, and it means **"this is the action"** or **"you are here"**.
`--accent-soft` is its background for a chip or a selected row; `--accent-fg` is what goes on top of
it.

`--ok`, `--warn`, `--danger` mean exactly what they say, and are **reserved**: a warning colour used
for emphasis is a warning nobody will believe. They always ship with a word or an icon as well as
the colour, because roughly one reader in twelve cannot separate the red from the green.

**Dark re-steps them, it does not reuse them.** They are text colours as often as they are fills —
`late` is a red word, a due-today date is an amber one — so each has to clear 4.5:1 against the
surface it lands on. Reused unchanged, the light theme's red measured 3.06 against the dark page and
its green 3.92. Amber was already fine and stays. Same rule the chart pair follows.

Charts get `--chart-1` and `--chart-2`, re-stepped rather than flipped for dark. See
[`insights.md`](insights.md).

### Radius, shadow, motion

| Class | Token | Where |
|---|---|---|
| `rounded-sm` | `--radius-sm`, 7px | controls |
| `rounded` | `--radius`, 10px | cards, panels |
| `rounded-lg` | `--radius-lg`, 16px | sheets |
| `rounded-full` | — | pills, dots, avatars |

**Nothing else.** In the client's TypeScript that is enforced: `npm run check:tokens` refuses an
arbitrary `rounded-[…]`, one of Tailwind's own steps, and a `borderRadius` written as a number in a
style object. The hand-written rules in `app.css` still use `4px`, `5px` and `6px` here and there,
which is a thing to remove as screens are ported, not a set of choices.

Two shadows: `shadow-sm` (`--shadow-sm`) for a raised control, `shadow` (`--shadow`) for something
floating over the page. A card in a list gets a border, not a shadow.

Motion is short and only ever confirms something happened: the enter and exit of a menu or a sheet.
Everything honours `prefers-reduced-motion`, and the Radix components carry `motion-reduce:animate-none`.

## Type

The system stack — `-apple-system`, `Segoe UI`, `Roboto` — because a project tool should look like
the machine it is running on, and a webfont is a second network request before anybody can read
anything.

**The scale.** Each step is a class, declared in `@theme static`:

| Class | Size | Where |
|---|---|---|
| `text-caption` | 11.5px | chips, counts, timestamps |
| `text-label` | 12.5px | labels, secondary rows, hints |
| `text-body` | 13.5px | body: task titles, menu items, buttons |
| `text-title` | 15px | a sheet title, a section heading |
| `text-headline` | 19px | a screen title, the title being edited |
| `text-display` | 26px | the title of a page being read |
| `text-input` | 16px | anything typed into on a phone — see below |

Five sizes for the interface, and two that are not a matter of taste: a page read as a document
has a title larger than any screen's, and a field on a phone has a floor set by iOS. The
hand-written rules in `app.css` still carry sizes of their own, from 8px to 26px, which is not a
scale but an accumulation — half a pixel of difference is a decision nobody made on purpose.

**In the TypeScript there is nothing else.** `npm run check:tokens` refuses an arbitrary
`text-[…px]`, Tailwind's own `text-sm` and its siblings, and a `fontSize` written as a number in a
style object. When the steps became classes, every arbitrary size was folded onto the nearest one:
`12px` became `text-label`, `13px` became `text-body`, `11px` and `10px` became `text-caption`, and a
`14px` heading became `text-title`. A half-pixel either way, on purpose this time.

**The steps carry no line height.** Every one of them replaced an arbitrary size, and those set the
size alone; a step that also set a line height would have moved every line of text it touched,
which is a design change of its own and not this one.

**`cn.ts` has to know the steps by name.** `tailwind-merge` recognises Tailwind's own sizes and an
arbitrary length, and files every other `text-*` under colour — so `cn('text-label', 'text-muted')`
would come back as `text-muted`, the size deleted without a word. `TYPE_STEPS` in `cn.ts` tells it,
and `check:tokens` fails when that list and the stylesheet disagree.

**16px is the floor for anything typed into on a phone.** Below it iOS zooms the page in on focus
and never zooms back out. The `Input` component handles this with `text-input sm:text-body`, and so
does the chat composer. It took two fixes to get there: a placeholder that wraps counts towards a
textarea's `scrollHeight` (61px of content in a 38px box, measured), so it is `placeholder:truncate`;
and the field is refitted when the window changes size, because the font changes at 640px and a
height measured at 13.5px held 16px text three pixels short.

## Layout

Mobile-first. Two breakpoints that matter, both about the *window*, because they decide what the
window contains:

- Below **600px**, a phone held upright: the bottom bar and full-width sheets.
- From 600px the content is a panel set into the tinted frame, and the navigation is the folded
  rail — a phone on its side, a tablet, a window dragged half across a laptop. The bottom bar wastes
  a landscape screen's scarcest direction; the full sidebar would take a third of the width.
- From **900px** the sidebar has room for words, and dialogs are centred.

`RAIL_QUERY` in `narrow.ts` renders the rail and the `@media` band in `app.css` lays it out; the two
have to agree, and `check:figures` holds this paragraph to the first of them.

Everything about whether a control fits is about the *content column* instead, and asks `.main` —
see [Width is not the window](#width-is-not-the-window). The two are not interchangeable and the
bug that proved it lived at 910px.

The stylesheet also breaks at 699, 800 and 1000; those are accidents to be folded into 900 (or into
Tailwind's `sm`/`lg`) as screens are ported.

Spacing is Tailwind's 4px scale. The sidebar is `--sidebar-width` (248px) and the header
`--header-height` (52px), because two things need to agree about them.

**Touch targets are 36px or more**, which is what the `default` button size is. `iconSm` (32px) is
for a control inside a dense row where the whole row is also clickable.

**An index leads with the list, not with the summary.** A page called Budgets exists to open a
budget, and the roll-up above it is context. On a desktop the ordering barely shows — a row of
tiles is 120px and the list is still on screen. On a phone the same tiles stack two-by-two, two
chart cards follow, and the first budget starts 665 pixels down an 844-pixel screen: somebody who
opened the page to open a budget met analysis, scrolled once, met more analysis, and concluded
there were none. So the list comes first at both widths — one reading order, not two.

The corollary is about the rows themselves. A wide table scrolls sideways inside `.table-wrap`,
which is fine for a column somebody goes looking for and not fine for the one figure the row is
about. Where the useful number is off to the right on a phone, it goes under the title as a
`row-sub row-sub-sm` — the second class being the same container query as `hide-sm`, so the line
appears only where the columns it summarises are not already visible.

## Two controls must not be the same drawing

The icon set had `list` and `menu` as the same three horizontal strokes. That was invisible on a
desktop, where both carry a word beside them, and obvious on a phone, where neither does: the
header put the layout switcher and the display menu side by side and the row read as **two
hamburgers that did different things**.

- `list` is bulleted now — it is a list *layout*, not a menu.
- The display control has its own `sliders`, because it sets grouping, sorting and what is shown.

The rule this leaves: **if two controls can appear in one row, they need two glyphs.** Adding a path
that duplicates an existing one is a decision to make deliberately, and there is exactly one place
to check — `PATHS` in `kernel/design-system/ui/icon.tsx`.

**A property that is not set spends no words on a phone.** The task sheet's optional pickers —
labels, cycle, module — used to say *No cycle*, *No module*, *Labels* whether or not anything was
chosen, three chips reporting absence and taking a row of their own. Set, they say what they are;
unset, they are their icon, and the menu behind them is unchanged. `title` still names them for a
pointer and for a screen reader.

**A form is a form.** Three label-and-control pairs sit in one line on a desktop. Letting them wrap
onto a phone gave three rows each trailing a wide empty gap — the height of a form with none of the
tidiness. Below `sm` they get one row each, label at the start, control at the end, ends aligned.

## Components

The interactive primitives are Radix underneath, in `kernel/design-system/ui/`. Their wrappers in
`kernel/design-system/ui.tsx` keep the API the screens already use.

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

Hand-drawn paths in `kernel/design-system/ui/icon.tsx`, typed as `IconName` so a shape that does
not exist is a compile error rather than three quiet dots. `lucide-react` is now available and is the right source for
anything new; the hand-drawn set stays until a screen that uses it is ported.

One stroke weight, one size per context: 16px inline, 15px in the sidebar, 13–14px inside a small
button.

## Rules that are not about looks

These are the ones that decide whether the thing is usable, and they are checkable.

1. **Focus is always visible, and only for the keyboard.** `focus-visible`, never `focus`. A ring on
   a mouse click is noise people learn to ignore, and then they ignore it on Tab too.
2. **Every icon-only control has an `aria-label`.** A tooltip is not a name — it is decoration that
   happens to contain the same words, announced inconsistently and never shown at all on a
   touchscreen. `Button` and `MenuButton` derive the label from `title` when the control has no
   words of its own, so a call site cannot forget; a raw `<button>` that skips them is caught by
   the source check in `forms.test.ts`. The derivation is *conditional* on there being no visible
   text, because an `aria-label` **replaces** the words on screen — a label that drifts from them
   is a control a voice-control user can see and cannot say.
3. **Colour is never the only carrier.** Status has a word or a shape beside it.
4. **An empty state says what to do next**, and links to the guide where there is one. `Empty`
   exists for this; a blank panel is a dead end, and a dead end is where somebody decides the tool
   is broken.
5. **Nothing that writes is shown to somebody who may not write.** `useCanWrite()`, once, rather
   than `role !== 'guest'` in fifteen places.
6. **A destructive action is confirmed and says what it will destroy** — `useConfirm()`, with the
   name of the thing in the sentence.
7. **Text is translated, always.** Three catalogues with enforced key parity; a string in a
   component is a bug the walkthrough catches on its German walk.
8. **What you have to hit is at least 24×24.** The *target*, not the drawing: a 15px checkbox in a
   24px wrapper that carries the click is fine, and padding is how that is done — `.select-box`
   and the guide's step dots both look exactly as they did. `node scripts/a11y.mjs` measures the
   rendered boxes rather than the source, and knows about the wrapper.
9. **The heading outline has no holes in it.** One `h1` per screen, `h2` for the sections under it,
   and nothing skipped — a screen reader's heading list is the outline, and a hole in it is a
   screen somebody has to read linearly. `SectionHeading` renders `h2` for exactly this reason.
10. **The landmarks are real elements and are told apart.** One `<main>`, and any second `<nav>` or
    `<aside>` carries an `aria-label` — two entries called "complementary" name nothing.

## What the accessibility pass found

`scripts/a11y.mjs` drives a real browser and reads the real computed styles, for the same reason
`contrast.mjs` does: "it has an `aria-label` somewhere" is a claim about source, and what matters is
what the accessibility tree ends up holding. It is deliberately not an axe-core wrapper — this
project ships no runtime dependencies, and the rules that matter for an icon-button-dense project
tool are a narrower and stricter set than a generic ruleset applies.

The first run reported **44 problems on desktop and 36 on mobile**. What they were, because the
shape of the list is more useful than the count:

- **Six icon buttons named only by a `title`** — the whole layout switcher (Board, List, Table,
  Calendar, Timeline) and *New project*. On a phone, six identical grey squares.
- **One icon button with no name at all**, and it removed a person from the workspace.
- **Three fields named only by their placeholder** — both password boxes and the new-team field. A
  placeholder disappears the moment somebody types, which is exactly when "which box am I in"
  gets asked.
- **Two screens with no `h1`**, and a `SectionHeading` that rendered `h3` directly under one, so
  every settings screen had a hole in its outline.
- **No `<main>` anywhere**, including the sign-in page. `.main` was a class name.
- **Twenty-six targets under 24×24**, including the checkbox in front of every task in the app.
- **Zero focus-ring failures.** The `focus-visible` rule in `buttonVariants` had already done its
  job everywhere, which is what a rule in one place is for.

And one thing that was not an accessibility problem at all but was found by looking: the sync
indicator's dot carried `chipDot` and not `dot`, so none of the four colours keyed on
`.status-pill .dot` — green, amber, red, and the pulse while syncing — had been drawing anything.
On a desktop the word beside it covered for that. On a phone the word is hidden, and the status
indicator was an empty circle.

## Porting a screen

The port is deliberately incremental. The order inside one screen:

1. Replace `.btn`, `.input`, `.card` with the components. Do not re-style them inline.
2. Replace `style={{ … }}` with Tailwind classes. The inline style props that are left are the main
   reason two screens that should look the same do not. A value that comes from data — a label's
   colour, a bar's width — stays a style; a size or a corner never does.
3. Sizes, radii and shadows are already steps — `check:tokens` sees to it in the TypeScript. What is
   left to fold is the hand-written rule the screen leaned on in `app.css`.
4. Delete the CSS class from `app.css` **once the last screen stops using it, and not before** —
   `node scripts/unstyled.mjs` after a build is how you know. This is the step that went wrong: the
   commit that added the field components deleted `.field` while seventy-six `<div class="field">`
   were still on screen, and every form in the app lost its spacing without a single error.
5. Walk the screen with the keyboard only, and once at 390px wide.
6. Run `npm test` — the source-level checks in `packages/web/test/forms.test.ts` catch the four
   things a codemod breaks silently — then `npm run check:tokens`, `npm run check:css`,
   `npm run check:responsive`, `npm run check:contrast` and `npm run check:a11y`.

`app.css` was meant to be the progress bar: **1,862 lines** when the port started. It stopped being
one, because the screens that arrived after the port began brought hand-written rules of their own
faster than ported screens removed old ones, and the file grew. A line count measures the file, not
the port. What a screen being ported can be held to is the list above, and the checks in step 6.

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

Everything that is a *component* — anything that appears twice — is Tailwind. Where that is not yet
true, it is said here rather than left to be found:

- **The data table** (`task-table`, `table-wrap`, and the cell markers `num`, `narrow`, `title`,
  `actions`, `row-open`, `cell-link`, `wraps`) is still a block of descendant rules in `app.css`. It
  is in the tables of most data screens, so it is a component and belongs in code. Written as one
  utility string on `<table>` it would be the same rules in a form that is harder to read; what it
  wants is a `DataTable` with `Th` and `Td` that take `numeric`, `optional`, `title` as props, and
  each of the tables rewritten to use it. That is its own piece of work.
- **The long tail.** Most of the remaining classes are used by one screen each — `secret-flag`,
  `agenda-card`, `review-finding`, `ballot-mark` and their like. They are components of one screen,
  and they move when that screen is next worked on, by the steps in "Porting a screen" above.
- **Hooks.** Some class names stay on elements with no rule behind them, because the walkthrough
  finds things by them: `check-row`, `stat`, `kpi-row`, `stat-label`, `stat-value`, `mono`, `toast`,
  `empty`, `sheet`. `scripts/unstyled.mjs` names each with the reason, which is how a hook is told
  apart from a class whose rule went missing.
- **Form layouts and figure tiles** were classes and are now strings in code — `formField`,
  `formRow`, `checkRow` in `ui/field.tsx`, the tile and its `Stat` component in `ui/stat.tsx`,
  `pageBody` in `ui/page.ts`, `noticeWarn` in `ui/notice.ts`. Strings rather than components because
  several hundred call sites already wrote them as classes on plain elements, and the change worth
  making was where the styling lives, not the shape of every form.
