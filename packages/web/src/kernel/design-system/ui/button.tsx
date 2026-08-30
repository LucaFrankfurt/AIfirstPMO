import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Children, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../cn';

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

/**
 * Does this button say anything out loud?
 *
 * An icon and a tooltip is a button that reads as "button" and nothing else,
 * which is most of what an accessibility audit of a tool like this one finds.
 * A button with words in it already has a name and must not be given a second
 * one — an `aria-label` *replaces* the visible text, so a label that drifts
 * from the words on screen is worse than no label at all.
 */
export function hasText(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (typeof child === 'string') return child.trim().length > 0;
    if (typeof child === 'number') return true;
    if (isValidElement(child)) return hasText((child.props as { children?: ReactNode }).children);
    return false;
  });
}

export function Button({
  className, variant, size, block, asChild = false, ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  // A `title` is a hint for a mouse. It is not announced reliably, and on a
  // touchscreen it never appears at all — so on a button with no words of its
  // own it becomes the name as well as the hint, here, once, rather than at
  // each of the ninety call sites that would otherwise have to remember.
  const named = props['aria-label'] ?? props['aria-labelledby'];
  const label = !named && typeof props.title === 'string' && !hasText(props.children)
    ? props.title
    : undefined;
  return (
    <Component
      type={asChild ? undefined : (props.type ?? 'button')}
      className={cn(buttonVariants({ variant, size, block }), className)}
      aria-label={label}
      {...props}
    />
  );
}
