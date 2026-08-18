import type { Priority } from '@kolibri/shared';
import { currentLocale } from './i18n';

export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  none: 'var(--fg-muted)',
};

export const isDone = (group?: string): boolean => group === 'completed' || group === 'cancelled';

/* -------------------------------------------------------------------- dates */

export const today = (): string => new Date().toISOString().slice(0, 10);

export function shortDate(value?: string | number | null): string {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function relativeTime(timestamp?: number | null): string {
  if (!timestamp) return '';
  const diff = timestamp - Date.now();
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000],
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return formatter.format(Math.round(diff / ms), unit);
  }
  return formatter.format(0, 'second');
}

export function dueClass(due?: string | null): string {
  if (!due) return '';
  const day = today();
  if (due < day) return 'due-overdue';
  if (due === day) return 'due-today';
  return '';
}

/* ------------------------------------------------------------------ people */

export function initials(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Stable pastel colour derived from an id, so avatars stay recognisable. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 52%)`;
}

export const bytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const pluralize = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

