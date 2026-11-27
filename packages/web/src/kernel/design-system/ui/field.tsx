import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../cn';

/**
 * The text controls, with one focus treatment between them.
 *
 * `field-sizing-content` on the textarea is the modern answer to the oldest
 * hack in this file: a textarea that grows with its content, without a resize
 * observer and without a hidden mirror element.
 */
const control = cva(
  'w-full bg-raised text-fg placeholder:text-muted transition-shadow '
  + 'border border-line-strong rounded-sm '
  + 'outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 '
  + 'disabled:opacity-60 disabled:cursor-not-allowed aria-invalid:border-danger aria-invalid:ring-danger/25',
  {
    variants: {
      inputSize: {
        // 16px on a phone, because anything smaller makes iOS zoom the page in
        // on focus and never zoom back out.
        default: 'h-9 px-2.5 text-input sm:text-body',
        sm: 'h-8 px-2 text-input sm:text-label',
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
      <span className="text-label font-medium text-soft">{label}</span>
      {children}
      {hint && <span className="text-label text-muted">{hint}</span>}
    </label>
  );
}

/*
 * The three form layouts that were classes in `app.css`, as class strings.
 *
 * Strings rather than components because a hundred and eleven call sites
 * already wrote `<div className="field">` around a label and a control, and
 * the change worth making is where the styling lives, not the shape of every
 * form. A component would have meant rewriting each `<div>…</div>` pair by
 * hand; a string is the same element with its rules moved into the code that
 * `check:tokens` reads.
 *
 * The label rule stays a descendant rule (`[&_label]`), at the specificity
 * `.field label` had — one class and one element. That is deliberate: a
 * `check-row` label inside a field used to lose its 13px to `.field label`'s
 * 12.5, and it still does, so nothing on screen moves. The sizes are the scale's
 * nearest steps: 13px was `text-body` already, 12.5 is `text-label`.
 */

/** A caption and its control, stacked, with the space under them decided once. */
export const formField = 'flex flex-col gap-[5px] mb-3 [&_label]:text-label [&_label]:font-[550] [&_label]:text-soft';

/**
 * Two or three fields side by side, stacked once there is no room for that.
 * `auto-fit` measures the container, not the window: these rows sit in dialogs
 * as well as on screens, and a 420px sheet and a 620px form should not have to
 * agree about what narrow means. `items-start`, because one of a pair usually
 * has a hint under it, and centring would drop its partner's label half a line.
 */
export const formRow = 'grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-2.5 items-start';

/**
 * A checkbox with a label and a line of explanation under it. The label and
 * its explanation are one stacked block beside the box, so the explanation
 * lines up under the label rather than under the box; a checkbox in its 24px
 * `select-box` keeps its row direction and its width.
 */
// `check-row` draws nothing any more; the walkthrough finds a row by it.
export const checkRow = 'check-row flex cursor-pointer items-start gap-[9px] py-[7px] text-body '
  + '[&_input]:mt-0.5 [&_input]:flex-none '
  + '[&>span]:flex [&>span]:min-w-0 [&>span]:flex-col [&>span]:gap-px '
  + '[&>.select-box]:min-w-6 [&>.select-box]:flex-row';
