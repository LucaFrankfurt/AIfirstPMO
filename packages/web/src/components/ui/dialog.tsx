import * as Primitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * A dialog, on Radix rather than on a `createPortal` and a keydown listener.
 *
 * What the hand-written one did not do, and could not be talked into doing
 * without becoming this: trap focus inside itself, return focus to whatever
 * opened it, mark the rest of the page `aria-hidden`, and hold the scroll
 * position of the page behind. Somebody using a keyboard could Tab straight out
 * of an open sheet and start editing the screen underneath it.
 *
 * It still looks like the sheet it replaces — full width from the bottom on a
 * phone, centred and bounded on a desktop — because that part was right.
 */
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;

export function DialogContent({
  className, children, wide, closeLabel, ...props
}: ComponentProps<typeof Primitive.Content> & { wide?: boolean; closeLabel: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay
        className="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none"
      />
      <Primitive.Content
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-raised text-fg shadow-[var(--shadow)]',
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[var(--radius-lg)] border-t border-line',
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[86dvh] sm:-translate-x-1/2 sm:-translate-y-1/2',
          'sm:rounded-[var(--radius-lg)] sm:border',
          wide ? 'sm:w-[min(940px,94vw)]' : 'sm:w-[min(560px,94vw)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          className="absolute right-3 top-3 grid size-8 place-items-center rounded-[var(--radius-sm)] text-muted transition-colors hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label={closeLabel}
        >
          <X size={16} />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export const DialogTitle = ({ className, ...props }: ComponentProps<typeof Primitive.Title>) => (
  <Primitive.Title className={cn('truncate pr-10 text-[15px] font-semibold', className)} {...props} />
);

/** Present but invisible: Radix warns without one, and a screen reader needs it. */
export const DialogDescription = Primitive.Description;

export const DialogHeader = ({ children }: { children: ReactNode }) => (
  <header className="flex items-center gap-2 border-b border-line px-4 py-3">{children}</header>
);

/** `body` is kept as a hook for the few screens and tests that reach for it. */
export const DialogBody = ({ children }: { children: ReactNode }) => (
  <div className="body min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
);

export const DialogFooter = ({ children }: { children: ReactNode }) => (
  <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{children}</footer>
);
