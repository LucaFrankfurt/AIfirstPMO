import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * A heading inside a screen, with the space around it decided once.
 *
 * Twenty-eight of these were an `<h3 className="section-h">` with a margin set
 * beside it — and the margins in that position were 20px, 22px and 24px, which
 * is three answers to a question nobody meant to ask three times. Now it is
 * one, and `tight` is for the first heading in a panel, where the space above
 * would sit against the edge.
 *
 * Worth knowing if these ever stop working: `mt-5` is a utility, and utilities
 * only beat `h1, h2, h3, h4 { margin: 0 }` in `app.css` because that file sits
 * in `@layer components`. See the note at the top of it.
 */
export function SectionHeading({ className, tight, ...props }: ComponentProps<'h3'> & { tight?: boolean }) {
  return <h3 className={cn('mb-2 text-sm font-semibold', tight ? 'mt-0' : 'mt-5', className)} {...props} />;
}
