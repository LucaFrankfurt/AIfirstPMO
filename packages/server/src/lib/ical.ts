/**
 * Writing iCalendar, by hand, to RFC 5545.
 *
 * The format looks like a list of `KEY:value` lines and is not. Three details
 * decide whether a real client shows anything at all, and all three are the
 * kind that produce a calendar that is simply empty rather than an error:
 *
 *  - **Folding.** A content line longer than 75 *octets* must be broken, and
 *    continued with a leading space. Not 75 characters — octets — so a title
 *    with an umlaut in it folds earlier than one without, and a break in the
 *    middle of a multi-byte character produces a file some clients refuse.
 *  - **Escaping.** `\`, `;`, `,` and newlines are structural. A task called
 *    "Buy milk, eggs" ends the SUMMARY at the comma without it.
 *  - **CRLF.** Every line ends `\r\n`, including the last.
 *
 * All-day dates use `VALUE=DATE` and `DTEND` is **exclusive** — a task due on
 * the 4th ends on the 5th, or the client draws it on the 3rd.
 */

/** Fold at 75 octets, continuing with a space, without splitting a character. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // 75 on the first line, 74 on the rest — the continuation space is an octet.
    const room = out.length === 0 ? 75 : 74;
    let end = Math.min(start + room, bytes.length);
    // Never cut a UTF-8 sequence: continuation bytes are `10xxxxxx`.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n ');
}

/** The four characters that mean something to the format. */
const escape = (value: string): string => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

/** `2026-09-04` → `20260904`. */
const date = (value: string): string => value.slice(0, 10).replace(/-/g, '');

/** A UTC timestamp, which `DTSTAMP` must be. */
const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The day after, so an exclusive `DTEND` lands where a reader expects. */
function dayAfter(value: string): string {
  const at = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return date(at.toISOString());
}

export interface CalendarEntry {
  /** Stable for the life of the task: a client updates rather than duplicates. */
  uid: string;
  summary: string;
  description?: string | null;
  url?: string | null;
  /** `YYYY-MM-DD`. A task with only a due date starts on it. */
  start?: string | null;
  due: string;
  /** What the state group says. */
  status?: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED';
  /** `1` (high) to `9` (low), or nothing. */
  priority?: number;
  categories?: string[];
  updatedAt?: number;
}

export interface Calendar {
  name: string;
  entries: CalendarEntry[];
  /** `event` puts due dates in the calendar grid; `todo` is for a task list. */
  kind?: 'event' | 'todo';
  /** Passed in rather than read, so the output is testable. */
  now?: number;
}

/** Priority 1–9, the way RFC 5545 counts: 1 is the urgent end. */
export const ICAL_PRIORITY: Record<string, number> = {
  urgent: 1, high: 3, medium: 5, low: 7, none: 0,
};

/**
 * One calendar, as text.
 *
 * `VEVENT` by default because a subscribed calendar is nearly always read by
 * something that draws a grid — Google, Apple, Outlook, Thunderbird's calendar
 * — and those ignore `VTODO` entirely. `todo` is there for the other half:
 * Thunderbird's task list, DAVx5, anything that wants tasks as tasks. Emitting
 * both in one file is legal and produces every entry twice in the clients that
 * read both, which is worse than choosing.
 */
export function buildCalendar(calendar: Calendar): string {
  const now = calendar.now ?? Date.now();
  const todo = calendar.kind === 'todo';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kolibri//Kolibri//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(calendar.name)}`,
    // How often a client is asked to come back. Advisory, and widely ignored,
    // but the ones that honour it stop hammering the feed every minute.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const entry of calendar.entries) {
    lines.push(todo ? 'BEGIN:VTODO' : 'BEGIN:VEVENT');
    lines.push(`UID:${escape(entry.uid)}`);
    lines.push(`DTSTAMP:${stamp(now)}`);
    if (entry.updatedAt) lines.push(`LAST-MODIFIED:${stamp(entry.updatedAt)}`);

    if (todo) {
      if (entry.start) lines.push(`DTSTART;VALUE=DATE:${date(entry.start)}`);
      lines.push(`DUE;VALUE=DATE:${date(entry.due)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${date(entry.start || entry.due)}`);
      // Exclusive: a task due on the 4th ends on the 5th, or it is drawn on
      // the 3rd — which is the single most common way one of these is wrong.
      lines.push(`DTEND;VALUE=DATE:${dayAfter(entry.due)}`);
    }

    lines.push(`SUMMARY:${escape(entry.summary)}`);
    if (entry.description) lines.push(`DESCRIPTION:${escape(entry.description)}`);
    if (entry.url) lines.push(`URL:${escape(entry.url)}`);
    if (entry.status) lines.push(`STATUS:${entry.status}`);
    if (entry.priority) lines.push(`PRIORITY:${entry.priority}`);
    if (entry.categories?.length) lines.push(`CATEGORIES:${entry.categories.map(escape).join(',')}`);
    lines.push(todo ? 'END:VTODO' : 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // A trailing CRLF as well: the last line ends like every other one.
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
