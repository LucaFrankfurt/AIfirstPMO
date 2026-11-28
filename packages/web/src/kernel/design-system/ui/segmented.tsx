import type { ComponentProps } from 'react';
import { cn } from '../cn';
import { buttonVariants } from './button';

/**
 * A choice of one out of a few, shown all at once: a layout, a list's mode.
 *
 * It was the same twelve lines in three screens — a box with a hand-written
 * border, ghost buttons inside, and the pressed one marked twice, by a class
 * and again by an inline `background`, because the class alone had once lost
 * to a rule in `app.css`. Here it is a track and a thumb: the track is the
 * `fill` every tonal control is made of, the chosen option is lifted out of it
 * onto the raised surface. The difference between chosen and not is a surface
 * and a shadow as well as a colour, so it survives a screen that renders
 * colours badly.
 *
 * Each option is a toggle button with `aria-pressed`, which is what the three
 * screens already said and what a screen reader announces as "pressed". A
 * radio group would be the stricter reading; it would also change what Tab
 * does in three places nobody has asked to change.
 */
export function Segmented({ className, ...props }: ComponentProps<'div'>) {
  return <div role="group" className={cn('inline-flex items-center gap-0.5 rounded-full bg-fill p-0.5', className)} {...props} />;
}

export function SegmentedItem({ pressed, className, ...props }: ComponentProps<'button'> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'rounded-full',
        pressed && 'bg-raised text-fg shadow-sm hover:bg-raised',
        className,
      )}
      {...props}
    />
  );
}
