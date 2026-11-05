/** Today as somebody's own calendar has it, not UTC's. */

const formats = new Map<string, Intl.DateTimeFormat | null>();

function formatFor(zone: string): Intl.DateTimeFormat | null {
  if (!formats.has(zone)) {
    try {
      formats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    } catch {
      formats.set(zone, null);
    }
  }
  return formats.get(zone) ?? null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` at `at` in an IANA zone; the runtime's own zone when none is given or it is unknown. */
export function todayIn(zone?: string | null, at: number = Date.now()): string {
  const format = zone ? formatFor(zone) : null;
  if (!format) {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
