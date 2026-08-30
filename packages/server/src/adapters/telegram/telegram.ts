/**
 * Telegram as a notification channel.
 *
 * The bell, email and Web Push each answer a different question. The bell only
 * works while the app is open; email is slow on purpose, because a batched
 * digest is the only kind an inbox tolerates; Web Push needs a browser that
 * asked for permission and a service worker that survived. Telegram is the
 * one that reaches a phone in a second without any of that — which is exactly
 * why it must not be allowed to become a firehose. See `deliver` for the two
 * things that keep it civil.
 *
 * Two design choices worth stating, because both were the other way first:
 *
 * **Long polling, not a webhook.** A webhook is fewer moving parts, and it is
 * the wrong shape here: it requires a public HTTPS URL, which a self-hosted
 * instance behind NAT does not have. `getUpdates` works from anywhere that can
 * make an outbound request, which is the same thing this app already needs for
 * S3 and SMTP.
 *
 * **The person starts the conversation.** A bot cannot message a chat that has
 * never messaged it, so there is no version of this where an admin wires up
 * somebody else's notifications. Kolibri hands out a single-use code, the
 * person taps a link, and the chat id arrives with the update. That constraint
 * is Telegram's, and it happens to be the right consent model anyway.
 */
import { randomBytes } from 'node:crypto';
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import { isImportantFor } from '@kolibri/shared';
import { translate, localeOf, type ServerKey } from '../../kernel/i18n/i18n.ts';

export type TelegramPreference = 'all' | 'important' | 'none';

/**
 * Kinds somebody on "important only" still wants on their phone.
 *
 * The same definition email uses, plus the one thing an instant channel adds:
 * a chat message. Both live in `@kolibri/shared` so they cannot drift — an
 * earlier version of this comment claimed the two sets matched while they
 * quietly did not.
 */
const important = (kind: string): boolean => isImportantFor('instant', kind);

const TIMEOUT_MS = 15_000;

/** How long a link code is good for. Long enough to switch apps, no longer. */
export const LINK_TTL_MS = 15 * 60 * 1000;

export const isPreference = (value: unknown): value is TelegramPreference =>
  value === 'all' || value === 'important' || value === 'none';

/* ------------------------------------------------------------- the transport */

export interface TelegramError extends Error {
  /** Telegram's own code, when it gave one. 403 means the user blocked the bot. */
  status?: number;
  /** Seconds Telegram asked us to wait, from a 429. */
  retryAfter?: number;
}

/**
 * One Bot API call.
 *
 * Every failure becomes a thrown `TelegramError` carrying whatever Telegram
 * said, because the caller's decision — retry, give up, or unlink the account
 * entirely — depends on which failure it was.
 */
export async function call<T = any>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!env.telegram.botToken) throw new Error('no Telegram bot token is configured');
  const url = `${env.telegram.apiBase}/bot${env.telegram.botToken}/${method}`;
  // A long poll asks Telegram to hold the connection; the client timeout has to
  // outlast it or every poll would look like a network failure.
  const budget = method === 'getUpdates' ? (env.telegram.pollSeconds + 10) * 1000 : TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new Error(`Telegram answered ${response.status} with something that is not JSON`) as TelegramError;
      error.status = response.status;
      throw error;
    }
    if (!parsed?.ok) {
      const error = new Error(String(parsed?.description ?? `Telegram refused ${method}`)) as TelegramError;
      error.status = Number(parsed?.error_code ?? response.status);
      const retry = Number(parsed?.parameters?.retry_after);
      if (Number.isFinite(retry)) error.retryAfter = retry;
      throw error;
    }
    return parsed.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bot's own @name, needed to build the link somebody taps.
 *
 * Cached for the life of the process: it is a property of the token, and a
 * token that changes means a restart anyway.
 */
let botName: string | null = null;
export async function username(): Promise<string> {
  if (botName) return botName;
  const me = await call<{ username?: string }>('getMe');
  botName = String(me?.username ?? '');
  return botName;
}

/** Only for tests, which swap the token between cases. */
export const forgetBot = (): void => { botName = null; };

/* ------------------------------------------------------------------ linking */

/**
 * A code, and the deep link that carries it.
 *
 * Any code the same person had before is dropped: two live codes for one
 * account is one more than anybody needs, and the older one is a loose end.
 */
export async function startLink(userId: string): Promise<{ code: string; url: string; expiresAt: number }> {
  const name = await username();
  if (!name) throw new Error('the bot token is not answering to getMe');

  run(`DELETE FROM telegram_links WHERE user_id = ?`, userId);
  // Telegram's start payload allows A-Z a-z 0-9 _ and - only, so this is hex.
  const code = randomCode();
  const expiresAt = Date.now() + LINK_TTL_MS;
  run(
    `INSERT INTO telegram_links (code, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    code, userId, expiresAt, Date.now(),
  );
  return { code, url: `https://t.me/${name}?start=${code}`, expiresAt };
}

const randomCode = (): string => randomBytes(16).toString('hex');

/** Codes nobody used. Swept so the table does not become a log. */
export function expireLinks(now = Date.now()): number {
  const stale = all<Row>(`SELECT code FROM telegram_links WHERE expires_at < ?`, now);
  for (const row of stale) run(`DELETE FROM telegram_links WHERE code = ?`, row.code);
  return stale.length;
}

/** Forget the chat. The preference is left alone — it is a setting, not a link. */
export function unlink(userId: string): void {
  run(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL, updated_at = ? WHERE id = ?`,
    Date.now(), userId,
  );
  run(`DELETE FROM telegram_links WHERE user_id = ?`, userId);
}

export const linkedChat = (userId: string): string | null => {
  const row = get<Row>(`SELECT telegram_chat_id FROM users WHERE id = ? AND deleted_at IS NULL`, userId);
  return row?.telegram_chat_id ? String(row.telegram_chat_id) : null;
};

/* ------------------------------------------------------------------ delivery */

/** Telegram's own limit is a message per second per chat. Stay under it. */
const lastSentTo = new Map<string, number>();
const PER_CHAT_MS = 1_100;

/**
 * Send one notification to one person's chat.
 *
 * Returns what happened rather than throwing, because every caller wants to
 * record the outcome and none of them want a failed send to become a failed
 * write. The row is stamped either way: `telegram_sent_at` on success, an
 * incremented attempt count and the reason on failure.
 */
export async function deliverNotification(notificationId: string): Promise<'sent' | 'skipped' | 'failed'> {
  if (!env.telegramEnabled) return 'skipped';
  const row = get<Row>(
    `SELECT n.*, u.telegram_chat_id AS chat_id, u.telegram_prefs AS prefs
       FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.id = ? AND n.deleted_at IS NULL AND u.deleted_at IS NULL`,
    notificationId,
  );
  if (!row || row.telegram_sent_at) return 'skipped';

  const preference = (isPreference(row.prefs) ? row.prefs : 'all') as TelegramPreference;
  if (!row.chat_id || preference === 'none') return 'skipped';
  if (preference === 'important' && !important(String(row.kind))) return 'skipped';
  if (Number(row.telegram_attempts ?? 0) >= env.telegram.maxAttempts) return 'skipped';

  const chatId = String(row.chat_id);
  const gap = Date.now() - (lastSentTo.get(chatId) ?? 0);
  if (gap < PER_CHAT_MS) await new Promise((resolve) => setTimeout(resolve, PER_CHAT_MS - gap));

  try {
    await call('sendMessage', {
      chat_id: chatId,
      text: messageFor(row),
      // Markdown would need every title escaped; HTML needs three characters.
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    lastSentTo.set(chatId, Date.now());
    run(`UPDATE notifications SET telegram_sent_at = ?, telegram_error = NULL WHERE id = ?`, Date.now(), notificationId);
    return 'sent';
  } catch (error) {
    const failure = error as TelegramError;
    lastSentTo.set(chatId, Date.now());
    run(
      `UPDATE notifications SET telegram_attempts = telegram_attempts + 1, telegram_error = ? WHERE id = ?`,
      failure.message.slice(0, 500), notificationId,
    );
    // 403 is Telegram saying the person blocked the bot or deleted the chat.
    // Retrying that forever is how a queue fills up with something that will
    // never succeed, and the honest reading is that they revoked consent.
    if (failure.status === 403) unlink(String(row.user_id));
    return 'failed';
  }
}

/** What arrives on the phone. */
function messageFor(row: Row): string {
  const locale = localeOf(row.user_id);
  const url = deepLink(row);
  const lines = [`<b>${escape(String(row.title ?? ''))}</b>`];
  if (row.body) lines.push(escape(String(row.body).slice(0, 500)));
  if (url) lines.push(`<a href="${escape(url)}">${escape(translate(locale, 'telegram.open'))}</a>`);
  return lines.join('\n\n');
}

/** Where the notification points, if this instance knows its own address. */
function deepLink(row: Row): string | null {
  if (!env.publicUrl) return null;
  if (row.task_id) return `${env.publicUrl}/t/${row.task_id}`;
  if (row.page_id) return `${env.publicUrl}/pages/${row.page_id}`;
  if (row.channel_id) return `${env.publicUrl}/chat/${row.channel_id}`;
  if (row.project_id) return `${env.publicUrl}/projects/${row.project_id}`;
  return `${env.publicUrl}/inbox`;
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A message not tied to a notification row — the "does this work" button. */
export async function sendTest(userId: string): Promise<void> {
  const chatId = linkedChat(userId);
  if (!chatId) throw new Error('this account has no Telegram chat connected');
  const locale = localeOf(userId);
  await call('sendMessage', {
    chat_id: chatId,
    text: `<b>${escape(translate(locale, 'telegram.testTitle'))}</b>\n\n${escape(translate(locale, 'telegram.testBody'))}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * Notifications that were written while Telegram was unreachable.
 *
 * Bounded twice over: only the recent ones, and only until the attempt limit.
 * A notification nobody delivered in a day is not news any more, and retrying
 * it forever is how a channel becomes a source of confusion instead of one of
 * information.
 */
export async function retryPending(now = Date.now(), limit = 25): Promise<{ sent: number; failed: number }> {
  if (!env.telegramEnabled) return { sent: 0, failed: 0 };
  const pending = all<Row>(
    `SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.telegram_sent_at IS NULL
        AND n.telegram_attempts > 0
        AND n.telegram_attempts < ?
        AND n.deleted_at IS NULL
        AND u.telegram_chat_id IS NOT NULL
        AND u.telegram_prefs != 'none'
        AND n.created_at > ?
      ORDER BY n.created_at ASC LIMIT ?`,
    env.telegram.maxAttempts, now - 24 * 60 * 60 * 1000, limit,
  );
  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    const outcome = await deliverNotification(String(row.id));
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
  }
  return { sent, failed };
}

/* ------------------------------------------------------- the other direction */

interface Update {
  update_id: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
    from?: { id?: number | string };
  };
}

const cursor = (): number => Number(get<Row>(`SELECT offset FROM telegram_cursor WHERE id = 1`)?.offset ?? 0);

function setCursor(offset: number): void {
  run(
    `INSERT INTO telegram_cursor (id, offset, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at`,
    offset, Date.now(),
  );
}

/**
 * Handle whatever people sent the bot.
 *
 * Only two commands are understood, and neither takes anything on trust: the
 * code is what proves who is talking, and `/stop` can only ever disconnect the
 * chat it was sent from.
 */
export function handleUpdate(update: Update): 'linked' | 'unlinked' | 'ignored' {
  const chatId = update.message?.chat?.id;
  const text = String(update.message?.text ?? '').trim();
  if (chatId === undefined || chatId === null || !text) return 'ignored';

  if (/^\/stop\b/.test(text)) {
    const user = get<Row>(`SELECT id FROM users WHERE telegram_chat_id = ? AND deleted_at IS NULL`, String(chatId));
    if (!user) return 'ignored';
    unlink(String(user.id));
    void say(chatId, 'telegram.disconnected', String(user.id));
    return 'unlinked';
  }

  const start = /^\/start(?:\s+(\S+))?/.exec(text);
  if (!start) return 'ignored';
  const code = start[1];
  if (!code) {
    void say(chatId, 'telegram.needCode', null);
    return 'ignored';
  }

  const link = get<Row>(`SELECT * FROM telegram_links WHERE code = ?`, code);
  // Consumed whether or not it was still valid: a code that has been seen once
  // is spent, and leaving an expired one in the table only invites a retry.
  if (link) run(`DELETE FROM telegram_links WHERE code = ?`, code);
  if (!link || Number(link.expires_at) < Date.now()) {
    void say(chatId, 'telegram.codeExpired', null);
    return 'ignored';
  }

  // One chat, one account. Somebody re-linking from the same phone should
  // replace their old connection rather than end up shadowing it.
  run(
    `UPDATE users SET telegram_chat_id = NULL, telegram_linked_at = NULL WHERE telegram_chat_id = ?`,
    String(chatId),
  );
  run(
    `UPDATE users SET telegram_chat_id = ?, telegram_linked_at = ?, updated_at = ? WHERE id = ?`,
    String(chatId), Date.now(), Date.now(), link.user_id,
  );
  void say(chatId, 'telegram.connected', String(link.user_id));
  return 'linked';
}

/** A short reply to the chat, in the account's language where we know it. */
async function say(chatId: number | string, key: ServerKey, userId: string | null): Promise<void> {
  try {
    await call('sendMessage', {
      chat_id: String(chatId),
      text: translate(localeOf(userId), key),
      disable_web_page_preview: true,
    });
  } catch {
    // A confirmation that could not be delivered is not worth failing over;
    // the link itself is already made and the app shows it.
  }
}

/** One round of long polling. Exported so a test can drive it without a loop. */
export async function pollOnce(): Promise<number> {
  const updates = await call<Update[]>('getUpdates', {
    offset: cursor(),
    timeout: env.telegram.pollSeconds,
    allowed_updates: ['message'],
  });
  if (!Array.isArray(updates) || !updates.length) return 0;
  for (const update of updates) handleUpdate(update);
  // Acknowledging past the highest id is how `getUpdates` is told they are done.
  setCursor(Math.max(...updates.map((update) => Number(update.update_id) || 0)) + 1);
  return updates.length;
}

/* -------------------------------------------------------------- the worker */

let running = false;
let stopping = false;

/**
 * Poll until told to stop.
 *
 * A failed round backs off rather than spinning: Telegram being down, or the
 * network being out, is a condition that lasts longer than a millisecond, and
 * a tight retry loop against an API with rate limits makes it last longer.
 */
export function startTelegram(): void {
  if (running || !env.telegramEnabled) return;
  running = true;
  stopping = false;

  void (async () => {
    let backoffMs = 1_000;
    while (!stopping) {
      try {
        await pollOnce();
        backoffMs = 1_000;
      } catch (error) {
        if (stopping) break;
        const failure = error as TelegramError;
        const wait = failure.retryAfter ? failure.retryAfter * 1000 : backoffMs;
        console.warn(`[telegram] ${failure.message}; retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
    running = false;
    // A loop that was asked to stop and then un-asked — a token changed while
    // it was inside a 25-second long poll — starts again here rather than
    // leaving the instance quietly not polling. See `reloadTelegram`.
    if (!stopping && env.telegramEnabled) startTelegram();
  })();
}

export function stopTelegram(): void {
  stopping = true;
}

/**
 * Pick up a bot token that changed while the server was running.
 *
 * The cached `@name` goes, because it is a property of the token. The loop
 * itself usually does not have to: every call reads the token afresh, so a
 * poll already in flight simply uses the new one next time round. What does
 * have to happen is the two ends — no bot any more, so stop; a bot where there
 * was none, so start.
 */
export function reloadTelegram(): void {
  forgetBot();
  if (!env.telegramEnabled) {
    stopTelegram();
    return;
  }
  stopping = false;
  if (!running) startTelegram();
}

export const isRunning = (): boolean => running;
