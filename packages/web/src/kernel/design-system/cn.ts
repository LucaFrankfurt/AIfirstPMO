import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type steps `app.css` declares in `@theme static`, by name.
 *
 * `tailwind-merge` knows Tailwind's own sizes (`text-sm`, `text-lg`) and an
 * arbitrary length (`text-[12px]`), and files every other `text-*` under
 * *colour*. So until it is told otherwise, `text-label text-muted` is two
 * colours, the later wins, and the size is dropped without a word: the class
 * is simply missing from the element. That would have happened at every call
 * site that passes a size and a colour through `cn`, which is most of them.
 *
 * The list is here and in the stylesheet because neither can read the other.
 * `check:tokens` fails if they disagree, which is the only thing keeping a new
 * step from working in a plain `className` and vanishing inside `cn()`.
 */
export const TYPE_STEPS = ['caption', 'label', 'body', 'title', 'headline', 'display', 'input'] as const;

const merge = extendTailwindMerge({ extend: { theme: { text: [...TYPE_STEPS] } } });

/**
 * Join class names, and let a caller's class win.
 *
 * `twMerge` is the half that matters: a component ships `px-3` and somebody
 * passes `px-6`, and without merging both end up in the attribute with the
 * winner decided by the order they happen to sit in the stylesheet. With it,
 * the later one wins, which is what anybody writing the call site expects.
 */
export const cn = (...inputs: ClassValue[]): string => merge(clsx(inputs));
