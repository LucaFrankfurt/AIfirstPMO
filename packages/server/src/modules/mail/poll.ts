/**
 * Keeping the copy up to date, and the one thing this module will not do.
 *
 * It will not open a socket. `modules/mail` is a capability and an IMAP client
 * is an adapter, so this declares the shape of a fetcher and `adapters/imap`
 * registers one through `wiring.ts` — the same arrangement `storage` has with
 * `s3`, and the reason rule 5 exists: a capability that reached for the
 * transport would make "swap IMAP for JMAP" a change to the product rather than
 * a change to an adapter.
 *
 * What is here instead is the schedule and the bookkeeping, which is the part
 * with the decisions in it:
 *
 * **Polling, not IDLE.** IMAP can hold a connection open and be told about new
 * mail the moment it arrives, and this does not: it asks every few minutes. The
 * reason is the same one that made Telegram long-poll rather than take a
 * webhook — a self-hosted instance behind NAT with a laptop lid that closes
 * cannot keep four TLS connections alive for a week, and a feature that works
 * only on a server with an uptime is not the feature this product ships. Mail
 * two minutes late is mail.
 *
 * **One mailbox at a time.** Four inboxes on one provider polled in parallel is
 * four simultaneous logins from one address, which is what a rate limiter is
 * for and what an account lock looks like from the other side. They go round
 * one after another; the whole cycle is measured in seconds either way.
 *
 * **A failure backs off and stays visible.** `last_error` and `last_status` are
 * on the mailbox row and the settings screen shows them, because the failure
 * this feature actually has is a password that changed three weeks ago and a
 * search that has quietly been answering from a stale copy since.
 */
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';
import type { MailboxConfig } from '../../kernel/mail/mailbox.ts';
import { credentialsFor, foldersOf } from './mailboxes.ts';
import { countMessages, highestUid, storeMessage, type FetchedMessage } from './store.ts';

/** What a transport has to be able to do. Read-only, and deliberately small. */
export interface MailFetcher {
  /**
   * Everything in `folder` above `sinceUid`, oldest first, at most `limit`.
   *
   * `sinceUid` of 0 means the first pass, which `sinceDays` bounds instead —
   * a ten-year mailbox fetched in full on a first connection is a long night
   * and, more to the point, one that cannot be interrupted usefully.
   */
  fetch(config: MailboxConfig, folder: string, options: {
    sinceUid: number;
    sinceDays: number;
    limit: number;
  }): Promise<FetchedMessage[]>;
  /** The bytes of one attachment, fetched on demand rather than stored. */
  fetchPart(config: MailboxConfig, folder: string, uid: number, part: string): Promise<Buffer>;
  /** Sign in and hang up, for the Test button. Throws with a sentence if it cannot. */
  check(config: MailboxConfig): Promise<void>;
}

let fetcher: MailFetcher | null = null;

/** @port a transport that can read a mailbox */
export function registerMailFetcher(transport: MailFetcher): void {
  fetcher = transport;
}

/**
 * The registered transport, or a refusal that names the wiring.
 *
 * Throwing rather than quietly doing nothing, for the reason `storage` throws:
 * a mailbox configured, enabled, and silently never polled is a feature that
 * looks switched on and is not, and the person who notices is the one who went
 * looking for an invoice that was never fetched.
 */
export function mailFetcher(): MailFetcher {
  if (!fetcher) throw new Error('mail: no transport registered — see wiring.ts');
  return fetcher;
}

export const hasMailFetcher = (): boolean => fetcher !== null;

/**
 * How many messages one folder may contribute to one pass.
 *
 * A first pass over a decade of `info@` is a hundred thousand messages, and
 * doing it in one go means a transaction that never commits and a restart that
 * throws all of it away. Five hundred at a time means the first pass takes
 * several rounds and every round is durable — the mailbox fills up visibly,
 * and an interruption costs one batch.
 */
const BATCH = 500;

/** How often a healthy mailbox is asked. */
const INTERVAL_MS = 5 * 60_000;

/**
 * How long a failing one waits, by consecutive failure.
 *
 * Capped at an hour rather than growing without bound: the common failure is a
 * password that needs changing, and a mailbox that has backed off to once a day
 * stays broken for a day after somebody fixes it — which reads as "the fix did
 * not work" and gets fixed again.
 */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface PollResult {
  mailbox: string;
  fetched: number;
  error?: string;
}

/**
 * One mailbox, one pass over each of its folders.
 *
 * Exported and not only called by the timer, because it is also what the "Sync
 * now" button and the tests call — and a scheduled job that cannot be run by
 * hand is a job nobody can debug.
 */
export async function pollMailbox(row: Row): Promise<PollResult> {
  const address = String(row.address);
  const config = credentialsFor(row);
  if (!config) {
    fail(row, 'No password stored for this mailbox');
    return { mailbox: address, fetched: 0, error: 'No password stored for this mailbox' };
  }

  let fetched = 0;
  try {
    for (const folder of foldersOf(row)) {
      const messages = await mailFetcher().fetch(config, folder, {
        sinceUid: highestUid(String(row.id), folder),
        sinceDays: Number(row.sync_days ?? 365),
        limit: BATCH,
      });
      for (const message of messages) {
        if (storeMessage(String(row.workspace_id), String(row.id), folder, message)) fetched += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(row, message);
    return { mailbox: address, fetched, error: message };
  }

  run(
    `UPDATE mailboxes SET last_sync_at = ?, last_error = NULL, last_status = 'ok', message_count = ?, updated_at = ? WHERE id = ?`,
    Date.now(), countMessages(String(row.id)), Date.now(), row.id,
  );
  return { mailbox: address, fetched };
}

/**
 * Record a failure on the row, where the screen can see it.
 *
 * `last_sync_at` is deliberately *not* touched. It means "when this copy was
 * last known good", and a failing mailbox whose timestamp keeps advancing is
 * one that looks fresh while going stale — which is the exact confusion this
 * whole column exists to prevent.
 */
function fail(row: Row, message: string): void {
  run(
    `UPDATE mailboxes SET last_error = ?, last_status = 'failing', updated_at = ? WHERE id = ?`,
    message.slice(0, 500), Date.now(), row.id,
  );
}

/* ------------------------------------------------------------------ worker */

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** Consecutive failures per mailbox, for the backoff. Memory only: a restart is a retry. */
const failures = new Map<string, number>();

/** Which mailboxes are due, cheapest question first. */
function due(): Row[] {
  const now = Date.now();
  return all<Row>(`SELECT * FROM mailboxes WHERE deleted_at IS NULL AND enabled = 1`).filter((row) => {
    const last = Number(row.last_sync_at ?? 0);
    const misses = failures.get(String(row.id)) ?? 0;
    const wait = misses ? BACKOFF_MS[Math.min(misses - 1, BACKOFF_MS.length - 1)] : INTERVAL_MS;
    // A mailbox that has failed and never succeeded has `last_sync_at` of null,
    // so `last` is 0 and it is due immediately on the first pass — after which
    // the backoff has a count to work from. The alternative, treating null as
    // "just polled", would leave a freshly added mailbox idle for five minutes
    // and make the Add dialog look broken.
    return now - last >= wait;
  });
}

async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const row of due()) {
      const result = await pollMailbox(row);
      if (result.error) failures.set(String(row.id), (failures.get(String(row.id)) ?? 0) + 1);
      else failures.delete(String(row.id));
    }
  } finally {
    running = false;
  }
}

/**
 * Start asking. Idempotent, and a no-op when no transport is registered.
 *
 * The no-op matters for the seed script and the tests, which boot the same
 * wiring without an IMAP client and should not spend their run throwing.
 */
export function startMailPoller(everyMs = 60_000): void {
  if (timer || !hasMailFetcher()) return;
  // Every minute, deciding per mailbox — rather than a timer per mailbox, which
  // is four timers to cancel and four to keep in step with a row somebody just
  // edited. The frequent tick is cheap: `due()` is one indexed read.
  timer = setInterval(() => { void sweep(); }, everyMs);
  timer.unref?.();
}

export function stopMailPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
  failures.clear();
}

/** For a test that wants one pass and no timer. */
export const pollOnce = sweep;

/** The one mailbox a "Sync now" press names, if it is there and enabled. */
export function pollById(id: string): Promise<PollResult> {
  const row = get<Row>(`SELECT * FROM mailboxes WHERE id = ? AND deleted_at IS NULL`, id);
  if (!row) throw new Error('No such mailbox');
  failures.delete(id);
  return pollMailbox(row);
}
