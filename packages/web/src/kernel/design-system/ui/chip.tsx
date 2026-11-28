import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../cn';

/**
 * A small piece of metadata: a label, a due date, an estimate, a state.
 *
 * Chips carry a colour from the data often enough that `style` stays the right
 * tool for that one property — what this settles is everything around it, so a
 * label chip and a date chip are the same shape.
 *
 * 32px tall, which is the floor for something you tap. They were 22: a fine
 * label and a poor button, and enough of them navigate — a project chip on a
 * team card, an option in a field — that the difference was real on a phone.
 * One height for all of them rather than two, because a row of chips at two
 * sizes reads as a mistake.
 */
export const chipVariants = cva(
  // Square-ish rather than a pill, so a chip is never mistaken for a button
  // beside it; and filled rather than outlined, so a row of five chips is five
  // shapes and not five borders. The border stays, transparent, because the
  // line height below was measured with it.
  'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent px-2.5 '
  + 'text-caption leading-[30px] h-8',
  {
    variants: {
      tone: {
        default: 'bg-fill text-soft',
        // A chosen option, or a type a field applies to.
        on: 'bg-accent-soft text-accent',
      },
      interactive: {
        true: 'cursor-pointer transition-colors hover:bg-active outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        false: '',
      },
    },
    defaultVariants: { tone: 'default', interactive: false },
  },
);

export function Chip({ className, tone, interactive, ...props }: ComponentProps<'span'> & VariantProps<typeof chipVariants>) {
  return <span className={cn(chipVariants({ tone, interactive }), className)} {...props} />;
}

/** The coloured dot some chips carry — a label's colour, a state's group. */
export const chipDot = 'size-[7px] flex-none rounded-full';
