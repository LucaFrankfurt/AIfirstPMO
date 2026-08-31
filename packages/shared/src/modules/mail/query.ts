/**
 * What you can ask a pile of mail.
 *
 * One structure, two surfaces. An assistant calling `search_mail` passes named
 * arguments; a person typing into the box writes `from:stripe seit:2024-01
 * rechnung`. Both land here, on `MailFilter`, and the SQL is built once — the
 * same arrangement `parseQuery` and `Filters` have for tasks, and for the same
 * reason: two ways to say a thing that compile to two different queries will
 * disagree, and the day they do, only one of them is on screen.
 *
 * The terms are German as well as English, unprefixed, because the maintainer's
 * inbox is German and `von:` failing while `from:` works is the kind of detail
 * that makes a feature feel foreign in its own language. They are not a locale
 * setting: both are always accepted, since one inbox holds both languages and
 * nobody wants to switch a setting to search last quarter.
 */

export interface MailFilter {
  /** Free text, matched against subject and body. */
  text?: string;
  /** Sender address or name, substring, case-insensitive. */
  from?: string;
  /** Any recipient — To or Cc. */
  to?: string;
  /** Subject only. */
  subject?: string;
  /** ISO dates, inclusive. */
  since?: string;
  until?: string;
  /** Only messages that carry a file. */
  hasAttachment?: boolean;
  /** Attachment filename, substring. */
  filename?: string;
  /** Mailbox ids or addresses. Empty means every mailbox this person may read. */
  mailboxes?: string[];
  /** Unread only, as the mailbox reported it when it was last polled. */
  unread?: boolean;
}

/** Every prefix a term may carry, and the field it fills. */
const PREFIXES: Record<string, keyof MailFilter> = {
  from: 'from', von: 'from', absender: 'from', sender: 'from',
  to: 'to', an: 'to', empfaenger: 'to', 'empfänger': 'to',
  subject: 'subject', betreff: 'subject',
  since: 'since', seit: 'since', after: 'since', ab: 'since',
  until: 'until', bis: 'until', before: 'until', vor: 'until',
  file: 'filename', datei: 'filename', anhang: 'filename', attachment: 'filename',
  mailbox: 'mailboxes', postfach: 'mailboxes', in: 'mailboxes',
};

/** Bare words that are a flag rather than a term. */
const FLAGS: Record<string, (filter: MailFilter) => void> = {
  'has:attachment': (f) => { f.hasAttachment = true; },
  'hat:anhang': (f) => { f.hasAttachment = true; },
  'is:unread': (f) => { f.unread = true; },
  'ist:ungelesen': (f) => { f.unread = true; },
};

/**
 * A year or a month is a date too.
 *
 * `seit:2024` means the first of January and `bis:2024` means the thirty-first
 * of December, which is the only reading that makes both ends of a range behave
 * the way somebody typing a year expects. Getting this wrong is quiet: `since`
 * padded to `2024-01-01` and `until` padded the same way asks for one day.
 */
export function padDate(raw: string, end: boolean): string | undefined {
  const text = raw.trim();
  if (/^\d{4}$/.test(text)) return end ? `${text}-12-31` : `${text}-01-01`;
  if (/^\d{4}-\d{2}$/.test(text)) return end ? `${text}-${lastDay(text)}` : `${text}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // `31.12.2024`, because that is how a date is written in the inbox this is for.
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (german) return `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`;
  return undefined;
}

const lastDay = (yearMonth: string): string => {
  const [year, month] = yearMonth.split('-').map(Number);
  // Day zero of the next month is the last day of this one, and it knows about
  // February. `new Date(2024, 2, 0)` is the 29th; hard-coding 28 is a bug that
  // surfaces once every four years, in a quarter that is already annoying.
  return String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0');
};

/**
 * `from:stripe seit:2024-01 "invoice number"` -> a filter.
 *
 * Unknown prefixes are not an error, unlike in the task query language. There
 * the vocabulary is closed — a state either exists or does not — and a typo
 * silently filtering everything away is worse than a message. Here the corpus
 * is somebody else's prose: `re:` and `fwd:` and `http:` all appear in real
 * subject lines, and refusing to search for `http://x` because `http` is not a
 * field would be absurd. So an unknown prefix stays part of the free text.
 */
export function parseMailQuery(input: string): MailFilter {
  const filter: MailFilter = {};
  const free: string[] = [];
  for (const token of tokenise(input ?? '')) {
    const flag = FLAGS[token.toLowerCase()];
    if (flag) {
      flag(filter);
      continue;
    }
    const colon = token.indexOf(':');
    const key = colon > 0 ? PREFIXES[token.slice(0, colon).toLowerCase()] : undefined;
    if (!key) {
      free.push(unquote(token));
      continue;
    }
    const value = unquote(token.slice(colon + 1));
    if (!value) continue;
    if (key === 'mailboxes') (filter.mailboxes ??= []).push(value);
    else if (key === 'since' || key === 'until') {
      const date = padDate(value, key === 'until');
      if (date) filter[key] = date;
      else free.push(value);
    } else if (key !== 'hasAttachment' && key !== 'unread') filter[key] = value;
  }
  if (free.length) filter.text = free.join(' ');
  return filter;
}

/** Words, except that a quoted run is one word. */
function tokenise(input: string): string[] {
  return [...input.matchAll(/[^\s"]*"[^"]*"[^\s"]*|\S+/g)].map((m) => m[0]).filter(Boolean);
}

const unquote = (raw: string): string => raw.replace(/"/g, '').trim();
