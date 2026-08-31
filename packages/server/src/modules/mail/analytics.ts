/**
 * What four inboxes look like from above.
 *
 * The second half of why mail belongs in a work OS rather than in a mail
 * client. A client answers "where is that message"; nothing answers "which
 * eleven suppliers do we actually pay", "did support@ get slower this quarter",
 * or "what arrives on a Sunday" — because those need every mailbox at once and
 * a query language, and a client has neither.
 *
 * Every figure here is counted from `mail_messages`, which is a copy of what
 * the poller has fetched so far. That makes all of them **honest about a window
 * and dishonest about the past**: a mailbox connected last week with
 * `sync_days: 30` can report a busy Tuesday and cannot report last year, and
 * saying so is the job of the caller rather than of the number. Every function
 * returns the window it actually covered, so an answer can carry it.
 */
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { domainOf } from '@kolibri/shared';

export interface StatsOptions {
  workspaceId: string;
  mailboxIds: string[];
  since?: string;
  until?: string;
}

interface Window {
  clause: string;
  params: unknown[];
}

function windowFor(options: StatsOptions): Window | null {
  if (!options.mailboxIds.length) return null;
  const where = [`workspace_id = ?`, `mailbox_id IN (${options.mailboxIds.map(() => '?').join(', ')})`];
  const params: unknown[] = [options.workspaceId, ...options.mailboxIds];
  const since = options.since ? Date.parse(`${options.since}T00:00:00Z`) : NaN;
  const until = options.until ? Date.parse(`${options.until}T23:59:59.999Z`) : NaN;
  if (Number.isFinite(since)) {
    where.push(`sent_at >= ?`);
    params.push(since);
  }
  if (Number.isFinite(until)) {
    where.push(`sent_at <= ?`);
    params.push(until);
  }
  return { clause: where.join(' AND '), params };
}

export interface MailStats {
  total: number;
  with_attachments: number;
  unread: number;
  /** What the data actually spans, which is not what was asked for. */
  covers: { from: string | null; to: string | null };
  per_mailbox: { mailbox: string; total: number; unread: number; with_attachments: number }[];
  per_month: { month: string; total: number }[];
  top_senders: { address: string; name: string; count: number }[];
  top_domains: { domain: string; count: number; senders: number }[];
  /** 0 is Sunday, matching `strftime('%w')`. */
  per_weekday: number[];
}

export function mailStats(options: StatsOptions): MailStats {
  const window = windowFor(options);
  const empty: MailStats = {
    total: 0, with_attachments: 0, unread: 0,
    covers: { from: null, to: null },
    per_mailbox: [], per_month: [], top_senders: [], top_domains: [], per_weekday: Array(7).fill(0),
  };
  if (!window) return empty;

  const totals = get<Row>(
    `SELECT count(*) AS total,
            sum(has_attachments) AS attached,
            sum(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unread,
            min(sent_at) AS first, max(sent_at) AS last
       FROM mail_messages WHERE ${window.clause}`,
    ...window.params,
  );
  if (!totals || !Number(totals.total)) return empty;

  const perMailbox = all<Row>(
    `SELECT b.address AS mailbox, count(*) AS total,
            sum(CASE WHEN m.seen = 0 THEN 1 ELSE 0 END) AS unread,
            sum(m.has_attachments) AS attached
       FROM mail_messages m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE ${window.clause.replace(/\b(workspace_id|mailbox_id|sent_at)\b/g, 'm.$1')}
      GROUP BY b.address ORDER BY total DESC`,
    ...window.params,
  );

  // Months are grouped in SQL, in UTC, and the choice matters enough to say:
  // a message sent at 00:30 Berlin time on the first of a month is 23:30 on the
  // last day of the previous one in UTC, so a monthly total here can differ by
  // a message or two from the same total in a mail client. The alternative is
  // storing a timezone per mailbox and grouping in it, which is a real feature
  // and not one this pretends to have.
  const perMonth = all<Row>(
    `SELECT strftime('%Y-%m', sent_at / 1000, 'unixepoch') AS month, count(*) AS total
       FROM mail_messages WHERE ${window.clause} GROUP BY month ORDER BY month`,
    ...window.params,
  );

  const senders = all<Row>(
    `SELECT from_address AS address, max(from_name) AS name, count(*) AS count
       FROM mail_messages WHERE ${window.clause} AND from_address <> ''
      GROUP BY from_address ORDER BY count DESC LIMIT 25`,
    ...window.params,
  );

  // Domains are rolled up here rather than in SQL because `substr` after the
  // last `@` is not something SQLite says in one expression, and because
  // `domainOf` already decides what a domain is for the whole product.
  const domains = new Map<string, { count: number; senders: Set<string> }>();
  for (const row of all<Row>(
    `SELECT from_address AS address, count(*) AS count FROM mail_messages
      WHERE ${window.clause} AND from_address <> '' GROUP BY from_address`,
    ...window.params,
  )) {
    const domain = domainOf(String(row.address));
    if (!domain) continue;
    const entry = domains.get(domain) ?? { count: 0, senders: new Set<string>() };
    entry.count += Number(row.count);
    entry.senders.add(String(row.address));
    domains.set(domain, entry);
  }

  const weekdays = Array(7).fill(0);
  for (const row of all<Row>(
    `SELECT strftime('%w', sent_at / 1000, 'unixepoch') AS day, count(*) AS total
       FROM mail_messages WHERE ${window.clause} GROUP BY day`,
    ...window.params,
  )) weekdays[Number(row.day)] = Number(row.total);

  return {
    total: Number(totals.total),
    with_attachments: Number(totals.attached ?? 0),
    unread: Number(totals.unread ?? 0),
    covers: { from: isoDay(totals.first), to: isoDay(totals.last) },
    per_mailbox: perMailbox.map((row) => ({
      mailbox: String(row.mailbox),
      total: Number(row.total),
      unread: Number(row.unread ?? 0),
      with_attachments: Number(row.attached ?? 0),
    })),
    per_month: perMonth.map((row) => ({ month: String(row.month), total: Number(row.total) })),
    top_senders: senders.map((row) => ({
      address: String(row.address),
      name: String(row.name ?? ''),
      count: Number(row.count),
    })),
    top_domains: [...domains.entries()]
      .map(([domain, entry]) => ({ domain, count: entry.count, senders: entry.senders.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    per_weekday: weekdays,
  };
}

const isoDay = (value: unknown): string | null =>
  (value ? new Date(Number(value)).toISOString().slice(0, 10) : null);

/**
 * How long a mailbox takes to answer.
 *
 * Measured between a message that arrived and the next message *in the same
 * thread from this mailbox's own address*, which is a real limitation and the
 * reason `replies` and `unanswered` are both reported: only mailboxes that poll
 * a Sent folder can measure this at all. A mailbox reading INBOX alone has the
 * questions and not the answers, and it says `replies: 0` rather than quietly
 * reporting the median of an empty set as zero minutes.
 */
export interface ResponseStats {
  measurable: boolean;
  replies: number;
  unanswered: number;
  median_minutes: number | null;
  slowest_minutes: number | null;
}

export function responseTimes(options: StatsOptions, mailboxAddresses: string[]): ResponseStats {
  const window = windowFor(options);
  if (!window) return { measurable: false, replies: 0, unanswered: 0, median_minutes: null, slowest_minutes: null };

  const ours = new Set(mailboxAddresses.map((one) => one.toLowerCase()));
  const rows = all<Row>(
    `SELECT thread_key, from_address, sent_at FROM mail_messages
      WHERE ${window.clause} AND thread_key <> '' ORDER BY thread_key, sent_at`,
    ...window.params,
  );

  const gaps: number[] = [];
  let unanswered = 0;
  let inbound: number | null = null;
  let thread = '';
  for (const row of rows) {
    if (String(row.thread_key) !== thread) {
      if (inbound !== null) unanswered += 1;
      thread = String(row.thread_key);
      inbound = null;
    }
    const mine = ours.has(String(row.from_address).toLowerCase());
    if (mine && inbound !== null) {
      gaps.push((Number(row.sent_at) - inbound) / 60_000);
      inbound = null;
    } else if (!mine && inbound === null) {
      inbound = Number(row.sent_at);
    }
  }
  if (inbound !== null) unanswered += 1;

  gaps.sort((a, b) => a - b);
  return {
    // A mailbox that has never sent anything cannot be measured, and the flag
    // says so rather than letting a caller read `median: null` as "instant".
    measurable: gaps.length > 0,
    replies: gaps.length,
    unanswered,
    // The median rather than the mean, because one thread that sat over
    // Christmas moves a mean by hours and a median not at all.
    median_minutes: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null,
    slowest_minutes: gaps.length ? Math.round(gaps[gaps.length - 1]) : null,
  };
}
