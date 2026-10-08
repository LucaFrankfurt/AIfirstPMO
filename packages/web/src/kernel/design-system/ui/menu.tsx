import * as Primitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '../cn';

/**
 * A dropdown menu that behaves like one.
 *
 * The hand-written menu measured the button, positioned itself absolutely and
 * listened for a click outside. It worked, and it was missing everything a
 * menu is expected to do: arrow keys, Home and End, typeahead, returning focus
 * to the button on close, `role="menu"` with the item roles that go with it,
 * and flipping when it would otherwise open off the bottom of a short window.
 *
 * Radix brings all of that. The styling is unchanged — quiet, hairline
 * borders, one accent — because the look was never the problem.
 */
export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
export const MenuSeparator = ({ className, ...props }: ComponentProps<typeof Primitive.Separator>) => (
  <Primitive.Separator className={cn('my-1 h-px bg-line', className)} {...props} />
);

export const MenuLabel = ({ className, ...props }: ComponentProps<typeof Primitive.Label>) => (
  <Primitive.Label className={cn('px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted', className)} {...props} />
);

export function MenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          // The window, and not a number. `24rem` was chosen when a menu was
          // where a workspace's labels, projects and people were all poured,
          // and scrolling was the only way any of it fitted; it also meant a
          // menu could hide half of itself and look fine. Now the lists live in
          // drawers and `check:menus` holds every top level to fitting — so the
          // cap's job is to stop a menu running off a short window, not to
          // absorb a menu that is too long.
          'menu z-50 min-w-[13rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto',
          'rounded-[var(--radius)] border border-line bg-raised p-1 text-[13.5px] shadow-[var(--shadow)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function MenuItem({ className, danger, ...props }: ComponentProps<typeof Primitive.Item> & { danger?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none',
        // Radix marks the item under the cursor *and* the one the keyboard is
        // on with the same attribute, so both are highlighted the same way and
        // there is never a second, competing highlight.
        'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        danger ? 'text-danger data-[highlighted]:bg-danger/10' : 'text-fg',
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------- submenus */

/**
 * A drawer off the side of a menu.
 *
 * Here because a menu was doing two jobs at once: carrying *commands* — add a
 * sub-page, archive, delete — and carrying *values* out of lists that grow
 * with the workspace, which is where all the length came from. The page's own
 * menu measured 39 rows with 1140px of it below the fold on a demo workspace
 * of three projects, and the commands were the part that had scrolled away.
 *
 * A drawer keeps the list reachable and stops it setting the length of the
 * menu it hangs off. The list inside may scroll; the menu in front of it is
 * supposed to fit, which is what `check:menus` holds it to.
 */
export const MenuSub = Primitive.Sub;

export const MenuSubTrigger = ({ className, ...props }: ComponentProps<typeof Primitive.SubTrigger>) => (
  <Primitive.SubTrigger
    className={cn(
      'flex cursor-pointer select-none items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none text-fg',
      // `data-[state=open]` as well as highlighted: the row that opened the
      // drawer stays marked while the pointer is inside it, or the trail back
      // out of a submenu is a row that looks like nothing.
      'data-[highlighted]:bg-hover data-[state=open]:bg-hover',
      className,
    )}
    {...props}
  />
);

export function MenuSubContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          'menu z-50 min-w-[13rem] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto',
          'rounded-[var(--radius)] border border-line bg-raised p-1 text-[13.5px] shadow-[var(--shadow)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export const MenuCheckboxItem = ({ className, ...props }: ComponentProps<typeof Primitive.CheckboxItem>) => (
  <Primitive.CheckboxItem
    className={cn(
      'flex cursor-pointer select-none items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none',
      'data-[highlighted]:bg-hover data-[state=checked]:text-accent',
      className,
    )}
    {...props}
  />
);
