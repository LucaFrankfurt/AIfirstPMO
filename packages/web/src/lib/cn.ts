import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, and let a caller's class win.
 *
 * `twMerge` is the half that matters: a component ships `px-3` and somebody
 * passes `px-6`, and without merging both end up in the attribute with the
 * winner decided by the order they happen to sit in the stylesheet. With it,
 * the later one wins, which is what anybody writing the call site expects.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
