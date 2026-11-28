/** An empty screen that says what to do next. */
import { type ReactNode } from 'react';
import type { GuideTarget } from '../../../modules/guide/guide';

export function Empty({
  emoji = '🌱', title, hint, action, guide,
}: {
  emoji?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** An empty screen is when an explanation is most wanted — offer the right one. */
  guide?: GuideTarget;
}) {
  return (
    // `empty` draws nothing; the walkthrough counts the guide links inside one.
    <div className="empty flex flex-col items-center gap-2 px-4 py-11 text-center text-muted">
      <div className="text-display leading-none" aria-hidden="true">{emoji}</div>
      <strong className="text-fg">{title}</strong>
      {hint && <span className="max-w-[340px]">{hint}</span>}
      {action}
      {guide && renderHint?.(guide)}
    </div>
  );
}

/**
 * How to draw the link into the guide, filled in by the guide.
 *
 * `Empty` wants to offer the right explanation and has no business knowing
 * where the guide keeps it — this file used to import `guideHref` and build the
 * link itself, which is the design system depending on a capability. It takes
 * the target and asks for a hint; `modules/guide/hint.tsx` says what one looks
 * like, and a build without the guide simply shows none.
 */
let renderHint: ((to: GuideTarget) => ReactNode) | null = null;

/** @port the link into the guide that `Empty` offers */
export function provideGuideHint(render: (to: GuideTarget) => ReactNode): void {
  renderHint = render;
}

