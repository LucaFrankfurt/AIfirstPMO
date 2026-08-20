import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * The button, as one description instead of eleven.
 *
 * Every variant this app had was a hand-written `.btn.primary.sm.icon`
 * combination, which meant the focus ring, the disabled state and the height
 * were decided independently in each of them and only mostly agreed. Here they
 * are one table, so a new variant cannot forget the ring.
 *
 * The focus style is `focus-visible` and never `focus`: a ring that appears on
 * a mouse click is noise people learn to ignore, and the same ring on Tab is
 * the only way somebody navigating by keyboard knows where they are.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors '
  + 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg '
  + 'disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent/90 shadow-sm',
        secondary: 'border border-line-strong bg-raised text-fg hover:bg-hover',
        ghost: 'text-soft hover:bg-hover hover:text-fg',
        danger: 'border border-danger/40 text-danger hover:bg-danger/10',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        // 36px and 32px: comfortably above the 24px target that makes a phone
        // frustrating, without the chunkiness of a touch-only design.
        default: 'h-9 rounded-[var(--radius-sm)] px-3.5 text-[13.5px]',
        sm: 'h-8 rounded-[var(--radius-sm)] px-2.5 text-[12.5px]',
        lg: 'h-11 rounded-[var(--radius)] px-5 text-sm',
        icon: 'size-9 rounded-[var(--radius-sm)]',
        iconSm: 'size-8 rounded-[var(--radius-sm)]',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'default', block: false },
  },
);

export function Button({
  className, variant, size, block, asChild = false, ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      type={asChild ? undefined : (props.type ?? 'button')}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    />
  );
}
