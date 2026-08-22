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

/**
 * The whole moment, spelled out.
 *
 * "3 minutes ago" is the right thing to read and the wrong thing to rely on:
 * it is computed once at render and quietly goes stale, and it cannot answer
 * "was that before or after the deploy". This is what hangs off a hover.
 */
export function exactTime(timestamp?: number | null): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * When, in the width a list row can spare: a clock time for today, a date
 * before that. The unit carries the age, so no row has to say "yesterday".
 */
export function briefWhen(timestamp?: number | null): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(currentLocale(), { hour: 'numeric', minute: '2-digit' });
  }
  return shortDate(timestamp);
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

/**
 * The relative luminance of an `hsl(hue 62% l%)`, for the contrast maths below.
 *
 * Only the two numbers this file actually varies are parameters; saturation is
 * fixed, so this is a small function rather than a colour library.
 */
function luminance(hue: number, lightness: number): number {
  const l = lightness / 100;
  const chroma = 0.62 * Math.min(l, 1 - l);
  const at = (n: number): number => {
    const k = (n + hue / 30) % 12;
    const channel = l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return channel <= 0.03928 / 1 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * at(0) + 0.7152 * at(8) + 0.0722 * at(4);
}

/**
 * How dark this hue has to be for white initials to be readable on it.
 *
 * A fixed lightness cannot work: at 52% a blue avatar gave white 6.7:1 and a
 * yellow-green one gave 1.6 — the same number, wildly different results,
 * because lightness is not brightness. So the lightness is solved per hue for
 * 4.5:1 and capped at the old 52%, which leaves every avatar that already
 * worked exactly as it was and only darkens the ones that did not.
 */
function darkEnough(hue: number): number {
  let low = 5;
  let high = 52;
  // Sixteen halvings put this inside a hundredth of a percent, which is far
  // finer than the eye or the hex rounding that follows.
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    // 4.6, not 4.5: rounding the answer to a tenth of a percent moves it by a
    // hundredth or so, and solving for the floor exactly landed every avatar
    // on 4.48 — passing the maths and failing the check.
    if (1.05 / (luminance(hue, mid) + 0.05) >= 4.6) low = mid;
    else high = mid;
  }
  return low;
}

/** Stable colour derived from an id, so avatars stay recognisable. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% ${darkEnough(hue).toFixed(1)}%)`;
}

export const bytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const pluralize = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

