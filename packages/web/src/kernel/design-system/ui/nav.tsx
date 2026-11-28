import { cva } from 'class-variance-authority';

/**
 * A row in a list you navigate with.
 *
 * A function rather than a component, because the same row is a `<button>` in
 * one place, a `<Link>` in another and a `NavLink` in the sidebar — and which
 * of those it is matters. A sidebar entry is a link, so it opens in a new tab;
 * a row that runs an action is a button, so it announces as one.
 *
 * The selected state is read from `aria-current` rather than from a class,
 * which means the styling and the thing a screen reader announces cannot come
 * apart. `NavLink` sets it for free.
 */
export const navItem = cva(
  // "You are here" is the accent's job (design.md), so the current row is the
  // accent's container colour, a pill: Material's active indicator. It used to
  // be `bg-active`, the same grey as a pressed button, which said "something
  // happened here" rather than "this is where you are".
  'flex w-full min-h-[34px] cursor-pointer select-none items-center gap-2.5 rounded-full '
  + 'border-none bg-transparent px-3 py-1.5 text-left text-body text-soft transition-colors '
  + 'hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 '
  + 'aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium aria-[current=page]:text-accent',
  {
    variants: {
      active: { true: 'bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent', false: '' },
    },
    defaultVariants: { active: false },
  },
);

/** The number at the end of a nav row — unread, open, whatever it counts. */
export const navCount = 'ms-auto text-caption text-muted tabular-nums';

/**
 * The same row with the words taken away: one square, for the folded sidebar.
 *
 * A square that centres rather than a line that fills, because a rail is as
 * wide as one icon and `navItem`'s padding and left-aligned text would push
 * the glyph off centre. The selected state is still read from `aria-current`,
 * for the reason it is there — the styling and what a screen reader announces
 * cannot come apart. Every caller must pass the name as a `title` and an
 * `aria-label`: an icon on its own names nothing.
 */
export const navRailItem =
  'relative flex size-9 shrink-0 cursor-pointer select-none items-center justify-center '
  + 'rounded-full border-none bg-transparent p-0 text-soft transition-colors '
  + 'hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 '
  + 'aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent';
