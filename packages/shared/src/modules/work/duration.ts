/**
 * Durations, in both directions.
 *
 * In `shared` rather than in the web app because the parser is the fiddly half
 * of time tracking — every format somebody might type has to mean the right
 * thing — and that is worth a test, which lives on the server side.
 */
/**
 * Minutes as people say them: `45m`, `2h`, `2h 30m`, `—` for nothing.
 *
 * Deliberately not decimal hours. "1.75h" is a number somebody has to convert
 * back before they can picture it, and the rounding argument that follows is
 * not worth the column width it saves.
 */
export function duration(minutes?: number | null): string {
  const total = Math.max(0, Math.round(minutes ?? 0));
  if (!total) return '—';
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * What somebody typed into a duration box, in minutes.
 *
 * Accepts `90`, `90m`, `1.5h`, `1h30`, `1h 30m` and `1:30`, because people type
 * all of those and a form that only takes one of them is a form people avoid.
 * Returns null when there is no number in it at all.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const clock = text.match(/^(\d+):([0-5]?\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  let minutes = 0;
  let matched = false;
  for (const [, value, unit] of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(h|m)?/g)) {
    if (value === undefined) continue;
    const amount = Number(value.replace(',', '.'));
    if (Number.isNaN(amount)) continue;
    matched = true;
    // A bare number is minutes — the unit people leave off is the small one.
    minutes += unit === 'h' ? amount * 60 : amount;
  }
  return matched ? Math.round(minutes) : null;
}
