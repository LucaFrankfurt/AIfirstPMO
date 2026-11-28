/** The two small marks a task carries everywhere it appears: its state and its priority. */
import type { Priority, StateGroup } from '@kolibri/shared';
import { isDoneGroup } from '@kolibri/shared';
import { PRIORITY_COLOR } from '../format';
import { priorityKey, useT } from '../../i18n/i18n';

export function StateDot({ group, color, size = 12 }: { group?: StateGroup | string; color?: string; size?: number }) {
  const cls = isDoneGroup(group) ? 'filled' : group === 'started' ? 'half' : '';
  return <span className={`state-dot ${cls}`} style={{ color: color ?? 'var(--fg-muted)', width: size, height: size }} />;
}

export function PriorityBars({ priority }: { priority: Priority }) {
  const t = useT();
  const level = { urgent: 3, high: 3, medium: 2, low: 1, none: 0 }[priority] ?? 0;
  return (
    <span className="priority-bars" style={{ color: PRIORITY_COLOR[priority] }} title={t(priorityKey(priority))}>
      {/* Urgent is a shape of its own, not just a redder "high" (UX-10). */}
      {priority === 'urgent' ? (
        <svg width="12" height="11" viewBox="0 0 12 11" aria-hidden="true">
          <rect width="12" height="11" rx="2.5" fill="currentColor" />
          <path d="M6 2.6v3.5M6 8.3v.01" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : [1, 2, 3].map((n) => <i key={n} className={n <= level ? 'on' : ''} />)}
    </span>
  );
}
