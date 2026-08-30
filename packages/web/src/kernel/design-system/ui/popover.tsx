import * as Primitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '../cn';

/**
 * A panel hung off a button, for the things a menu is the wrong shape for.
 *
 * `MenuContent` is a column of full-width rows at least thirteen rem across,
 * which is right for a list of commands and wrong for six emoji — those came
 * out as a tall ladder with two hundred pixels of empty space beside them. A
 * popover holds whatever it is given and is sized by its content.
 *
 * Same borders, same shadow, same open animation as the menu: this is a
 * different shape, not a different look.
 */
export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          'z-50 rounded-[var(--radius)] border border-line bg-raised p-1 shadow-[var(--shadow)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
