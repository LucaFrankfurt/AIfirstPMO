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
  'flex w-full min-h-[34px] cursor-pointer select-none items-center gap-2.5 rounded-[var(--radius-sm)] '
  + 'border-none bg-transparent px-2.5 py-1.5 text-left text-[13.5px] text-soft transition-colors '
  + 'hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60 '
  + 'aria-[current=page]:bg-active aria-[current=page]:font-medium aria-[current=page]:text-fg',
  {
    variants: {
      active: { true: 'bg-active font-medium text-fg', false: '' },
    },
    defaultVariants: { active: false },
  },
);

/** The number at the end of a nav row — unread, open, whatever it counts. */
export const navCount = 'ms-auto text-[11.5px] text-muted tabular-nums';
