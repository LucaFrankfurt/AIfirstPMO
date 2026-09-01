/**
 * One query over every mailbox somebody may read.
 *
 * The scenario this was built for is four shared inboxes and a question that
 * spans all of them — "everything from the Steuerberater in 2024, wherever it
 * landed" — which is exactly the question a mail client cannot answer, because
 * a mail client is pointed at one account at a time. Kolibri holds all four, so
 * the interesting query is the cross-mailbox one, and it is the default here:
 * omitting `mailboxes` searches every mailbox the caller may read rather than
 * none.
 *
 * Two things are load-bearing:
 *
 * **The visible-mailbox list is an argument, not a lookup.** Every caller
 * resolves it through `visibleMailboxes` and passes the ids in, so a reader
 * that forgets gets an empty `IN ()` and no rows. A query that defaults to
 * "all mailboxes in the workspace" and is then filtered would be one forgotten
 * `.filter` away from reading somebody's payroll inbox.
 *
 * **Text and structure are one query.** The words go to FTS5 and the sender,
 * dates and attachment flags go to SQL, joined rather than intersected in
 * JavaScript — because "the twelve most recent of four thousand hits" is a
 * question only the database can answer without reading four thousand rows.
 */
import { toMatchQuery } from '../../kernel/search/search.ts';
import { all, type Row } from '../../kernel/platform/db/index.ts';
import type { MailFilter } from '@kolibri/shared';

export interface MailHit extends Row {
  mailbox_address: string;
}

/** The largest page anybody may ask for, whatever they ask for. */
const MAX_LIMIT = 200;

export interface MailSearchOptions {
  workspaceId: string;
  /** Ids from `visibleMailboxes`. An empty list finds nothing, by construction. */
  mailboxIds: string[];
  filter: MailFilter;
  limit?: number;
  offset?: number;
  /** `date` is newest first; `relevance` needs a text term and falls back to date. */
  order?: 'date' | 'relevance';
}

/**
 * Which mailboxes this search actually covers.
 *
 * The filter may name some by id or by address; anything it names that the
 * caller cannot read is dropped rather than refused. Refusing would answer a
 * question nobody asked — whether a mailbox by that name exists — and "no
 * results in the mailboxes you can see" is both true and the same sentence
 * whether or not `admin@` is there.
 */
export function narrow(mailboxes: Row[], asked: readonly string[] | undefined): string[] {
  if (!asked?.length) return mailboxes.map((row) => String(row.id));
  const wanted = new Set(asked.map((one) => one.trim().toLowerCase()));
  return mailboxes
    .filter((row) => wanted.has(String(row.id).toLowerCase()) || wanted.has(String(row.address).toLowerCase()))
    .map((row) => String(row.id));
}

/**
 * Everything both readers need: the WHERE clause and its parameters.
 *
 * Extracted rather than written twice because the second copy was a count, and
 * a count whose filter has drifted from the list it counts is the one wrong
 * number nobody checks — the list looks right, and "412 results" is simply
 * believed. One clause, two projections.
 */
function conditions(options: Omit<MailSearchOptions, 'limit' | 'offset' | 'order'>): { clause: string; params: unknown[] } | null {
  const { workspaceId, mailboxIds, filter } = options;
  const where: string[] = [`m.workspace_id = ?`, `m.mailbox_id IN (${mailboxIds.map(() => '?').join(', ')})`];
  const params: unknown[] = [workspaceId, ...mailboxIds];

  // The text term goes through FTS5 as a subquery rather than a join, so the
  // structural filters below can still use their own indexes. `toMatchQuery` is
  // the kernel's — one place decides that "des rev" is two prefix terms, and
  // mail must not grow a second dialect of the same box.
  const match = filter.text ? toMatchQuery(filter.text) : '';
  // Text that survives tokenising as nothing at all — `"..."`, an emoji — is a
  // search for something, and finding everything would be the wrong answer.
  if (filter.text && !match) return null;
  if (match) {
    where.push(`m.id IN (SELECT message_id FROM mail_index WHERE mail_index MATCH ?)`);
    params.push(match);
  }

  // `from` and `to` are substrings rather than exact addresses. "Everything
  // from Stripe" is the question, and the address is `receipts+acct_1J@stripe.com`
  // — an exact match would need the whole thing, which is precisely what the
  // person asking does not have.
  if (filter.from) {
    where.push(`(lower(m.from_address) LIKE ? ESCAPE '\\' OR lower(m.from_name) LIKE ? ESCAPE '\\')`);
    params.push(like(filter.from), like(filter.from));
  }
  if (filter.to) {
    where.push(`(lower(m.to_addresses) LIKE ? ESCAPE '\\' OR lower(m.cc_addresses) LIKE ? ESCAPE '\\')`);
    params.push(like(filter.to), like(filter.to));
  }
  if (filter.subject) {
    where.push(`lower(m.subject) LIKE ? ESCAPE '\\'`);
    params.push(like(filter.subject));
  }
  // Dates are compared as epoch milliseconds, and `until` is the *end* of the
  // day it names. `bis:2024-12-31` meaning midnight would drop everything sent
  // on the last day of the year, which is a bad day to lose in this feature in
  // particular.
  const since = filter.since ? Date.parse(`${filter.since}T00:00:00Z`) : NaN;
  const until = filter.until ? Date.parse(`${filter.until}T23:59:59.999Z`) : NaN;
  if (Number.isFinite(since)) {
    where.push(`m.sent_at >= ?`);
    params.push(since);
  }
  if (Number.isFinite(until)) {
    where.push(`m.sent_at <= ?`);
    params.push(until);
  }
  if (filter.hasAttachment) where.push(`m.has_attachments = 1`);
  if (filter.unread) where.push(`m.seen = 0`);
  if (filter.filename) {
    where.push(`EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_id = m.id AND lower(a.filename) LIKE ? ESCAPE '\\')`);
    params.push(like(filter.filename));
  }
  return { clause: where.join(' AND '), params };
}

export function searchMail(options: MailSearchOptions): MailHit[] {
  if (!options.mailboxIds.length) return [];
  const built = conditions(options);
  if (!built) return [];
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), MAX_LIMIT);
  const offset = Math.max(Number(options.offset) || 0, 0);

  return all<MailHit>(
    `SELECT m.id, m.mailbox_id, m.folder, m.message_id, m.thread_key, m.subject,
            m.from_name, m.from_address, m.to_addresses, m.cc_addresses, m.sent_at,
            m.seen, m.has_attachments, m.size, m.snippet,
            b.address AS mailbox_address
       FROM mail_messages m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE ${built.clause}
      ORDER BY m.sent_at DESC
      LIMIT ? OFFSET ?`,
    ...built.params, limit, offset,
  );
}

/** How many a filter matches in total, for a result set that says "of 412". */
export function countMail(options: Omit<MailSearchOptions, 'limit' | 'offset' | 'order'>): number {
  if (!options.mailboxIds.length) return 0;
  const built = conditions(options);
  if (!built) return 0;
  return Number(all<Row>(
    `SELECT count(*) AS c FROM mail_messages m WHERE ${built.clause}`,
    ...built.params,
  )[0]?.c ?? 0);
}

const like = (value: string): string => `%${value.trim().toLowerCase().replace(/[%_]/g, (c) => `\\${c}`)}%`;

/**
 * A whole conversation, across every mailbox the caller may read.
 *
 * Across mailboxes on purpose. A thread that started in `info@` and was
 * forwarded to `admin@` is one conversation that a mail client shows as two,
 * and stitching it back together is most of what makes reading it here better
 * than reading it there.
 */
export function threadOf(workspaceId: string, mailboxIds: string[], threadKey: string): MailHit[] {
  if (!mailboxIds.length || !threadKey) return [];
  return all<MailHit>(
    `SELECT m.*, b.address AS mailbox_address
       FROM mail_messages m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.workspace_id = ? AND m.thread_key = ?
        AND m.mailbox_id IN (${mailboxIds.map(() => '?').join(', ')})
      ORDER BY m.sent_at`,
    workspaceId, threadKey, ...mailboxIds,
  );
}

/** One message in full, if it is in a mailbox the caller may read. */
export function readMessage(workspaceId: string, mailboxIds: string[], id: string): MailHit | undefined {
  if (!mailboxIds.length) return undefined;
  return all<MailHit>(
    `SELECT m.*, b.address AS mailbox_address
       FROM mail_messages m JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.workspace_id = ? AND m.id = ? AND m.mailbox_id IN (${mailboxIds.map(() => '?').join(', ')})`,
    workspaceId, id, ...mailboxIds,
  )[0];
}
