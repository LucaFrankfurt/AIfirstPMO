import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * The text controls, with one focus treatment between them.
 *
 * `field-sizing-content` on the textarea is the modern answer to the oldest
 * hack in this file: a textarea that grows with its content, without a resize
 * observer and without a hidden mirror element.
 */
const control = cva(
  'w-full bg-raised text-fg placeholder:text-muted transition-shadow '
  + 'border border-line-strong rounded-[var(--radius-sm)] '
  + 'outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 '
  + 'disabled:opacity-60 disabled:cursor-not-allowed aria-invalid:border-danger aria-invalid:ring-danger/25',
  {
    variants: {
      inputSize: {
        // 16px on a phone, because anything smaller makes iOS zoom the page in
        // on focus and never zoom back out.
        default: 'h-9 px-2.5 text-[16px] sm:text-[13.5px]',
        sm: 'h-8 px-2 text-[16px] sm:text-[12.5px]',
      },
    },
    defaultVariants: { inputSize: 'default' },
  },
);

export const Input = ({ className, inputSize, ...props }: ComponentProps<'input'> & VariantProps<typeof control>) => (
  <input className={cn(control({ inputSize }), className)} {...props} />
);

export const Select = ({ className, inputSize, ...props }: ComponentProps<'select'> & VariantProps<typeof control>) => (
  <select className={cn(control({ inputSize }), 'cursor-pointer pr-8', className)} {...props} />
);

export const Textarea = ({ className, ...props }: ComponentProps<'textarea'>) => (
  <textarea
    className={cn(
      control({ inputSize: 'default' }),
      'h-auto min-h-20 resize-y py-2 leading-relaxed field-sizing-content',
      className,
    )}
    {...props}
  />
);

/**
 * A caption, a control, and the line under it that explains the control.
 *
 * The control is the child and the caption is a prop, which is the way round
 * that lets the label *wrap* its input — so the caption is clickable without
 * an `htmlFor` and an `id` that have to be kept pointing at each other. The
 * first version had it the other way and took everything as children, which
 * meant the input rendered inside the caption's span at 12.5px and the hint
 * came out underneath it. Nothing used it, so nothing noticed.
 *
 * The hint sits *below* the control on purpose: "at least 8 characters" is
 * read after a rejected password far more often than before a typed one.
 */
export function Label({ className, label, hint, children, ...props }: ComponentProps<'label'> & { label: ReactNode; hint?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)} {...props}>
      <span className="text-[12.5px] font-medium text-soft">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}
