/**
 * Putting a fetched message down, once.
 *
 * The whole file exists to make a poll idempotent. A mailbox is polled every
 * few minutes forever, a poll can die halfway through — the process restarts,
 * the server times out, somebody redeploys — and the next one must not produce
 * a second copy of what the first one stored. IMAP gives that away for free if
 * you take it: a UID is stable within a folder and never reused, so
 * `(mailbox_id, folder, uid)` is the row's identity and the insert is an upsert
 * on it.
 *
 * The alternative, keying on `Message-ID`, looks tidier and is wrong twice
 * over. Some senders emit the same one for a whole campaign, so it is not
 * unique; and the same message legitimately arrives in `support@` *and* in
 * `info@` when somebody was in Cc, which is two rows that a search should
 * report as two — the answer to "who was this sent to" is different in each.
 */
import { uid as newId } from '../../kernel/platform/ids.ts';
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';

/** What a transport hands back, having done whatever it does. */
export interface FetchedMessage {
  uid: number;
  messageId: string;
  /** The `References`/`In-Reply-To` chain, oldest first. */
  references: string[];
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  /** Epoch milliseconds, from the `Date` header or the server's internal date. */
  sentAt: number;
  seen: boolean;
  size: number;
  /** Plain text, already decoded and with any HTML flattened. */
  body: string;
  attachments: { filename: string; mime: string; size: number; part: string }[];
}

/**
 * How much of the body to keep for a result list.
 *
 * A search returns a hundred hits and each needs a line under it. Two hundred
 * characters is about that line at any width, and reading the column costs
 * nothing next to reading a hundred full bodies.
 */
const SNIPPET = 200;

/**
 * Store one message and index it. Returns true if it was new.
 *
 * Both halves are inside the same statement pair on purpose: an FTS row without
 * a message is a search hit that 404s, and a message without an FTS row is a
 * message that cannot be found — which is the failure that hides, because
 * nothing about the mailbox looks wrong until somebody searches for the one
 * thing they know is in there.
 */
export function storeMessage(workspaceId: string, mailboxId: string, folder: string, message: FetchedMessage): boolean {
  const existing = get<Row>(
    `SELECT id FROM mail_messages WHERE mailbox_id = ? AND folder = ? AND uid = ?`,
    mailboxId, folder, message.uid,
  );
  const id = existing ? String(existing.id) : newId();
  const snippet = message.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET);
  const filenames = message.attachments.map((one) => one.filename).filter(Boolean);

  if (existing) {
    // Re-fetched, which happens when a folder is re-scanned after an error.
    // Only the flags can have changed — a message's own bytes are immutable —
    // so this is a flag update rather than a rewrite, and the index is left
    // alone because none of what it holds moved.
    run(`UPDATE mail_messages SET seen = ?, fetched_at = ? WHERE id = ?`, message.seen ? 1 : 0, Date.now(), id);
    return false;
  }

  run(
    `INSERT INTO mail_messages (
       id, workspace_id, mailbox_id, folder, uid, message_id, thread_key, subject,
       from_name, from_address, to_addresses, cc_addresses, sent_at, seen,
       has_attachments, size, snippet, body, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, workspaceId, mailboxId, folder, message.uid, message.messageId,
    threadKey(message), message.subject, message.fromName, message.fromAddress,
    JSON.stringify(message.to), JSON.stringify(message.cc), message.sentAt,
    message.seen ? 1 : 0, message.attachments.length ? 1 : 0, message.size,
    snippet, message.body, Date.now(),
  );

  for (const attachment of message.attachments) {
    run(
      `INSERT INTO mail_attachments (id, message_id, mailbox_id, filename, mime, size, part) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(), id, mailboxId, attachment.filename, attachment.mime, attachment.size, attachment.part,
    );
  }

  run(
    `INSERT INTO mail_index (message_id, mailbox_id, workspace_id, subject, correspondents, body, filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, mailboxId, workspaceId, message.subject,
    // Names as well as addresses, because "did Anna ever send us that" is how
    // the question is actually asked, and the address in the header is
    // `a.weber@steuerkanzlei-mueller.de`.
    [message.fromName, message.fromAddress, ...message.to, ...message.cc].filter(Boolean).join(' '),
    message.body, filenames.join(' '),
  );
  return true;
}

/**
 * What ties a reply to what it answers.
 *
 * The first entry in `References` is the message that started the conversation,
 * which is the one thing every well-behaved client agrees on — better than
 * `In-Reply-To`, which points one step back and gives a chain rather than a
 * key, and far better than the subject line, which is the same for six
 * different threads called "Rechnung".
 *
 * A message that started a conversation has no references and is its own key.
 * One that has neither — no `References` and no `Message-ID`, which some
 * scripts and most spam manage — gets its own row id later, and is a thread of
 * one. That is honest: nothing links it to anything.
 */
export function threadKey(message: FetchedMessage): string {
  return message.references[0] || message.messageId || '';
}

/** The highest UID stored for a folder — where the next poll starts. */
export function highestUid(mailboxId: string, folder: string): number {
  const row = get<Row>(`SELECT max(uid) AS top FROM mail_messages WHERE mailbox_id = ? AND folder = ?`, mailboxId, folder);
  return Number(row?.top ?? 0);
}

/**
 * Everything a mailbox holds, gone.
 *
 * Called when a mailbox is disconnected, and it is the reason the settings
 * screen says what it says: turning the *feature* off hides the screens and
 * keeps the rows, which is what every other switch here does, but disconnecting
 * a mailbox throws the copy away. Somebody who connected the wrong inbox needs
 * a way to make that true again, and "the rows are still there but hidden" is
 * not it.
 *
 * The FTS row goes with it. An index entry pointing at a message that no longer
 * exists is a search result that 404s, and it would survive every other kind of
 * cleanup because nothing joins the two tables in the ordinary direction.
 */
export function forgetMailbox(mailboxId: string): number {
  const count = Number(get<Row>(`SELECT count(*) AS c FROM mail_messages WHERE mailbox_id = ?`, mailboxId)?.c ?? 0);
  run(`DELETE FROM mail_index WHERE mailbox_id = ?`, mailboxId);
  run(`DELETE FROM mail_attachments WHERE mailbox_id = ?`, mailboxId);
  run(`DELETE FROM mail_messages WHERE mailbox_id = ?`, mailboxId);
  return count;
}

/** How many messages a mailbox holds, for the row the settings screen shows. */
export const countMessages = (mailboxId: string): number =>
  Number(get<Row>(`SELECT count(*) AS c FROM mail_messages WHERE mailbox_id = ?`, mailboxId)?.c ?? 0);

/** The attachments of a set of messages, in one query rather than one each. */
export function attachmentsOf(messageIds: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  if (!messageIds.length) return out;
  const rows = all<Row>(
    `SELECT * FROM mail_attachments WHERE message_id IN (${messageIds.map(() => '?').join(', ')}) ORDER BY filename`,
    ...messageIds,
  );
  for (const row of rows) {
    const key = String(row.message_id);
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}
