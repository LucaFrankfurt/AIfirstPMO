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
above it the sidebar and centred dialogs. The stylesheet currently also breaks at 699, 700, 800 and
1000; those are accidents to be folded into 900 (or into Tailwind's `sm`/`lg`) as screens are
ported.

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
4. Delete the CSS class from `app.css` **as soon as the last screen stops using it**, so the
   stylesheet shrinks along the way instead of in one frightening commit at the end.
5. Walk the screen with the keyboard only, and once at 390px wide.

`app.css` is the progress bar: it was **1,862 lines** when the port started, and **1,847** after the
primitives went in.
