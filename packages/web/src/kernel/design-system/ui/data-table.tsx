/**
 * The table every data screen draws: budgets, rates and the timesheet, prices,
 * costs and campaigns, KPIs, the infrastructure register, the portfolio, the
 * import preview, and the task table it is named after.
 *
 * It was `.task-table` — named for the first screen that had one and borrowed
 * by twenty-eight more — a block of descendant rules in `app.css` that each
 * cell opted into by class name: `num`, `narrow`, `title`, `wraps`, `actions`.
 * A cell that should have carried one of them and did not simply looked a
 * little wrong, and nothing said so; `actions` had stopped doing anything at
 * all and was still written on fourteen cells. Here the ones that mean
 * something are props, so a misspelling is a type error, and the styling
 * stands beside the thing it styles.
 *
 * What each is for:
 *
 * - `numeric` — an amount or a count: aligned to the end, with tabular digits.
 *   A column of amounts whose digits do not line up cannot be compared by eye,
 *   which is the only thing anybody does with it.
 * - `optional` — a column that is only useful for comparing. On a phone it is
 *   dropped rather than squeezed; the ones left are the ones you would read
 *   out. Never the column you act from: while that was optional, every
 *   catalogue table on a phone could be read and not changed, and nothing
 *   announced it, because a missing column looks exactly like a column that was
 *   never there.
 * - `wraps` — prose. A cell is `nowrap` by default, which is right for an
 *   amount, a date or a chip and wrong for a sentence: three nowrap sentence
 *   columns made the capability table 200px wider than a tablet and pushed the
 *   column you act from off the side.
 * - `lead` (a `Td` only) — the cell a row is named by. It wraps too, with a
 *   240px floor, so the name is never the column that gives way. Not `title`,
 *   which is HTML's tooltip attribute and is passed through as one.
 *
 * A table that may be wider than the screen goes in a `.table-wrap`, which
 * scrolls inside itself. That one stays a class: `check:responsive` knows it
 * by name as a box that is meant to scroll, and the rule that lets it shrink
 * inside a grid is about its parent, which no prop on the table can reach.
 */
import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../cn';

/**
 * A cell, header or not. Exported for the cells that are neither a column's
 * heading nor a row's data — a group's heading inside the body, a total in the
 * footer — which want the table's rhythm without a heading's stickiness.
 *
 * Seven pixels of gutter on the narrowest screen rather than ten: ten either
 * side is four columns' worth of nothing at 340px, and the costs table came to
 * 343px there — three over, which `check:responsive` reports rather than
 * tolerates, because a box that scrolls by a sliver is rounding, not a
 * decision.
 */
export const tableCell = cva('whitespace-nowrap px-2.5 py-2 text-start max-[400px]:px-1.75', {
  variants: {
    numeric: { true: 'text-end tabular-nums' },
    optional: { true: 'max-[700px]:hidden' },
    wraps: { true: 'whitespace-normal' },
    lead: { true: 'min-w-60 whitespace-normal' },
  },
});

interface Variants {
  numeric?: boolean;
  optional?: boolean;
  wraps?: boolean;
}

export function DataTable({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-body', className)} {...rest} />;
}

/**
 * A column's heading. Sticky, so a long table still says what its columns are
 * once the heading has scrolled away, and opaque, so the rows pass under it
 * rather than through it.
 */
export function Th({ numeric, optional, wraps, className, ...rest }: Variants & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        tableCell({ numeric, optional, wraps }),
        'sticky top-0 z-1 border-b border-line-strong bg-bg text-caption font-semibold text-soft',
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ numeric, optional, wraps, lead, className, ...rest }: Variants & { lead?: boolean } & TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn(tableCell({ numeric, optional, wraps, lead }), className)} {...rest} />;
}

/**
 * A row of the body. Every row is lit under the pointer, because a wide row is
 * hard to follow across; only a row that does something says so with the
 * cursor. Every row used to, which on the timesheet promised a screen that is
 * not there — it had a rule of its own to take the promise back.
 */
export function Tr({ selected, className, ...rest }: { selected?: boolean } & HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-line hover:bg-hover',
        rest.onClick && 'cursor-pointer',
        // The hover as well, or pointing at a chosen row would un-choose it to the eye.
        selected && 'bg-accent-soft hover:bg-accent-soft',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A link in a table cell, big enough to hit.
 *
 * An inline link is as tall as its text — fifteen pixels — and WCAG 2.2 asks
 * for twenty-four. The spec exempts a link inside a sentence, and rightly:
 * padding one out would break the paragraph around it. A table cell is not a
 * sentence, so the link gets the height instead of the exemption.
 */
export const cellLink = 'inline-flex min-h-6 items-center';

/**
 * A row's name as a button: the keyboard's way into a row whose click opens
 * it. The click bubbles to the row's own handler, so this does nothing of its
 * own. It inherits the row's strike-through, which a button otherwise drops.
 */
export const rowOpen = 'cursor-pointer text-start [text-decoration:inherit]';
