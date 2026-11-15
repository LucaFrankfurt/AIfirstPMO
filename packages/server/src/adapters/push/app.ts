/**
 * Waking the packaged app on a phone, through the relay.
 *
 * Web push could be sent from here because the browser's push services accept
 * anybody's VAPID key. Apple's and Google's do not: a notification for the app
 * in the stores has to be signed with the credentials of whoever published it
 * — an APNs key and a Firebase service account — and those cannot be handed to
 * every server that somebody installs. So a self-hosted server asks a relay
 * that holds them, the way Nextcloud, Mattermost and Rocket.Chat do it, and the
 * relay asks Apple or Google.
 *
 * **What crosses is the least that can wake a phone**: the token the app was
 * given by its platform, which platform, and the reader's language. Not the
 * notification, not who it is from, not which workspace or server — the relay
 * says "New activity in Kolibri" in that language and nothing else, and the app
 * opens on the inbox, which fetches the real thing from this server with this
 * person's session. That is option A in `docs/mobile.md`, chosen for a first
 * release because it puts no workspace content on a third party's disk; a
 * banner that says *what* happened needs native code on both platforms that
 * fetches it from here after the wake.
 *
 * A burst is one wake. A bulk edit that writes fifteen notifications for the
 * same person asks the relay once, a moment later, rather than fifteen times —
 * and the relay collapses whatever does arrive into one banner on the phone.
 */
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { send } from '../webhooks/outbound.ts';

export type Platform = 'ios' | 'android';
const PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android']);

/** Long enough to fold a burst into one wake, short enough to still feel live. */
const GATHER_MS = 2_000;
const TIMEOUT_MS = 5_000;

/** Whether this instance can wake the app at all: push on, and a relay named. */
export const appPushEnabled = (): boolean => env.push.enabled && !!env.push.relay;

/**
 * A token as Apple or Google issue one: printable, no spaces, and short.
 *
 * APNs tokens are 64 hex characters today and FCM tokens about 160, but
 * neither is promised; the bound is there so a row cannot be used to store
 * something else.
 */
const plausibleToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[\x21-\x7e]{16,4096}$/.test(token);

export const isPlatform = (value: unknown): value is Platform => typeof value === 'string' && PLATFORMS.has(value);

/**
 * Remember that this phone, signed in on this session, wants to be woken.
 *
 * The same token arriving again is the same phone: it moves to whoever is
 * signed in on it now rather than being kept twice — a phone handed from one
 * person to another must stop buzzing for the first.
 */
export function registerAppToken(userId: string, sessionId: string, platform: Platform, token: string): boolean {
  if (!plausibleToken(token) || !isPlatform(platform)) return false;
  const existing = get<Row>(`SELECT id FROM app_push_tokens WHERE token = ?`, token);
  if (existing) {
    run(
      `UPDATE app_push_tokens SET user_id = ?, session_id = ?, platform = ? WHERE id = ?`,
      userId, sessionId, platform, existing.id,
    );
  } else {
    run(
      `INSERT INTO app_push_tokens (id, user_id, session_id, platform, token, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      uid(), userId, sessionId, platform, token, Date.now(),
    );
  }
  return true;
}

/** This person's phone, no longer to be woken. Somebody else's token is left alone. */
export const forgetAppToken = (userId: string, token: string): void => {
  run(`DELETE FROM app_push_tokens WHERE token = ? AND user_id = ?`, token, userId);
};

/**
 * The phones that may be woken for this person: the ones whose session is
 * still alive.
 *
 * Rows whose session has ended are deleted on the way, rather than kept for a
 * session that cannot come back — a signed-out phone signs in again with a new
 * session, and registers again with it.
 */
export function appTokensFor(userId: string): { platform: Platform; token: string }[] {
  const now = Date.now();
  run(
    `DELETE FROM app_push_tokens WHERE user_id = ?
       AND session_id NOT IN (SELECT id FROM sessions WHERE user_id = ? AND expires_at > ?)`,
    userId, userId, now,
  );
  return all<{ platform: Platform; token: string }>(
    `SELECT platform, token FROM app_push_tokens WHERE user_id = ? ORDER BY created_at`, userId,
  );
}

/* ------------------------------------------------------------- the waking */

const gathering = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Wake this person's phones, once, shortly.
 *
 * Fire-and-forget like every other carrier: a relay that is slow or gone must
 * not slow down whoever wrote the comment, and nothing here can fail a write.
 */
export function wakeApp(userId: string): void {
  if (!appPushEnabled() || gathering.has(userId)) return;
  const timer = setTimeout(() => {
    gathering.delete(userId);
    deliver(userId).catch((error) => console.error('[push] waking the app for', userId, 'failed:', error));
  }, GATHER_MS);
  timer.unref?.();
  gathering.set(userId, timer);
}

/** For the tests: send what is gathered now rather than in two seconds. */
export async function flushAppWakes(): Promise<void> {
  const waiting = [...gathering.entries()];
  gathering.clear();
  for (const [userId, timer] of waiting) {
    clearTimeout(timer);
    await deliver(userId);
  }
}

async function deliver(userId: string): Promise<void> {
  const devices = appTokensFor(userId);
  if (!devices.length) return;
  const locale = String(get<Row>(`SELECT locale FROM users WHERE id = ?`, userId)?.locale ?? '') || 'en';
  const reply = await send(`${env.push.relay.replace(/\/+$/, '')}/v1/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ devices, locale }),
    timeoutMs: TIMEOUT_MS,
  });
  if (reply.status < 200 || reply.status >= 300) {
    console.error('[push] the relay answered', reply.status, reply.body.slice(0, 200));
    return;
  }
  const sentAt = Date.now();
  let gone: unknown = [];
  try {
    gone = (JSON.parse(reply.body) as { gone?: unknown }).gone ?? [];
  } catch {
    /* A relay that said yes and nothing else has still delivered. */
  }
  // Apple and Google are the only ones who know a token is over — the app was
  // deleted, the phone restored — and the relay passes on what they said.
  for (const token of Array.isArray(gone) ? gone : []) {
    if (typeof token === 'string') run(`DELETE FROM app_push_tokens WHERE token = ? AND user_id = ?`, token, userId);
  }
  run(`UPDATE app_push_tokens SET last_sent_at = ? WHERE user_id = ?`, sentAt, userId);
}
