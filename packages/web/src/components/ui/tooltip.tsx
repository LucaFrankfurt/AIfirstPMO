import * as Primitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * A tooltip that a keyboard can reach.
 *
 * `title=""` was doing this job, which meant it appeared after a browser-chosen
 * delay, could not be styled, was invisible on a touch screen and — the part
 * that matters — never showed for somebody who arrived on the control with Tab.
 * Radix shows it on focus as well as hover.
 *
 * It is decoration, never the only place something is said: every icon-only
 * control also carries an `aria-label`.
 */
export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <Primitive.Provider delayDuration={350} skipDelayDuration={200}>{children}</Primitive.Provider>
);

export function Tooltip({ label, children, side = 'bottom' }: {
  label: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof Primitive.Content>['side'];
}) {
  if (!label) return <>{children}</>;
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-[16rem] rounded-[var(--radius-sm)] border border-line bg-raised px-2 py-1',
            'text-[12px] text-soft shadow-[var(--shadow)]',
            'data-[state=delayed-open]:animate-in motion-reduce:animate-none',
          )}
        >
          {label}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
