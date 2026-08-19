/**
 * Web Push, without a library and without an encryption stack.
 *
 * The usual way to send a push carries an encrypted payload, which means
 * ECDH against the browser's key, HKDF, AES-128-GCM and a padding scheme —
 * several hundred lines of cryptography to deliver a sentence the app can
 * already fetch for itself.
 *
 * So this sends a push with **no payload at all**, which the spec allows. The
 * service worker wakes, asks `/api/notifications` what is new — same origin,
 * same session, same authorisation as everything else — and shows that. The
 * result is the same notification with none of the crypto, and one fewer place
 * where somebody's message sits encrypted on a third party's server.
 *
 * What is still needed is VAPID: a signed claim that this server is the one
 * that asked to be allowed to push. That is an ES256 JWT, which `node:crypto`
 * signs directly.
 */
import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { all, get, run, type Row } from '../db/index.ts';
import { DATA_DIR, env } from '../env.ts';
import { uid } from './ids.ts';

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

export interface Keys {
  /** The uncompressed P-256 point, base64url — what the browser is given. */
  publicKey: string;
  privateKeyPem: string;
}

let cached: Keys | null = null;

/**
 * The instance's VAPID key pair.
 *
 * Generated once and kept in the data directory beside the session secret,
 * because it identifies this server to the push services: regenerating it
 * silently invalidates every subscription anybody has made.
 */
export function keys(): Keys {
  if (cached) return cached;

  const path = join(DATA_DIR, 'vapid.json');
  if (env.push.publicKey && env.push.privateKey) {
    cached = { publicKey: env.push.publicKey, privateKeyPem: env.push.privateKey };
    return cached;
  }
  if (existsSync(path)) {
    try {
      cached = JSON.parse(readFileSync(path, 'utf8')) as Keys;
      return cached;
    } catch {
      // A corrupt file is replaced rather than crashing the boot; the cost is
      // that everyone re-subscribes, which the app does on its own.
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  // The last 65 bytes of an SPKI P-256 key are the uncompressed point, which is
  // the form `applicationServerKey` wants.
  cached = {
    publicKey: b64url(Buffer.from(raw.subarray(raw.length - 65))),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cached), { mode: 0o600 });
  return cached;
}

/** Only for the tests, which need a second instance to be a second instance. */
export const forgetKeys = (): void => { cached = null; };

/**
 * The VAPID `Authorization` header for one push service.
 *
 * The audience is the *origin* of the endpoint, not the endpoint itself: one
 * token is good for every subscription at the same service, and naming the full
 * URL would tell that service which of its own endpoints we are about to use
 * before we use it.
 */
export function authorization(endpoint: string): string {
  const { publicKey, privateKeyPem } = keys();
  const audience = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    // Twelve hours: long enough that a token is not minted per push, short
    // enough that a leaked one is worth nothing by tomorrow.
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.push.subject || env.publicUrl || 'mailto:admin@localhost',
  })));

  const signature = createSign('SHA256')
    .update(`${header}.${claims}`)
    .sign({ key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

/* ----------------------------------------------------------- subscriptions */

export interface Subscription {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}

/**
 * A real push endpoint is always https. Loopback is allowed too, so that a
 * local instance — and this project's own tests — can talk to a service on the
 * same machine without pretending to have a certificate.
 */
const plausible = (endpoint: string): boolean =>
  endpoint.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/)/.test(endpoint);

export function subscribe(userId: string, subscription: Subscription): void {
  if (!subscription?.endpoint || !plausible(subscription.endpoint)) return;
  const existing = get<Row>(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, subscription.endpoint);
  if (existing) {
    // The same endpoint arriving again is the same device saying so; it is
    // moved to whoever is signed in now rather than duplicated.
    run(`UPDATE push_subscriptions SET user_id = ?, last_error = NULL, failures = 0 WHERE id = ?`, userId, existing.id);
    return;
  }
  run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    uid(), userId, subscription.endpoint,
    subscription.keys?.p256dh ?? null, subscription.keys?.auth ?? null, Date.now(),
  );
}

export const unsubscribe = (endpoint: string): void => {
  run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
};

export const subscriptionsFor = (userId: string): Row[] =>
  all<Row>(`SELECT * FROM push_subscriptions WHERE user_id = ?`, userId);

/* ------------------------------------------------------------- the sending */

const TIMEOUT_MS = 5_000;
/** After this many refusals in a row the endpoint is treated as gone. */
const GIVE_UP = 5;

/**
 * Wake this person's devices.
 *
 * Fire-and-forget, like the webhooks: a push service that is slow must not slow
 * down whoever wrote the comment. A 404 or 410 means the browser threw the
 * subscription away, and the row goes with it — that is the documented way a
 * push service says "this one is over".
 */
export function notifyDevices(userId: string): void {
  if (!env.push.enabled) return;
  for (const row of subscriptionsFor(userId)) void deliver(row);
}

async function deliver(row: Row): Promise<void> {
  const endpoint = String(row.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: authorization(endpoint),
        // No body, so no content encoding — the worker fetches what to say.
        ttl: '86400',
        urgency: 'normal',
      },
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) {
      unsubscribe(endpoint);
      return;
    }
    if (!response.ok) {
      fail(row, `HTTP ${response.status}`);
      return;
    }
    run(`UPDATE push_subscriptions SET failures = 0, last_error = NULL, last_sent_at = ? WHERE id = ?`, Date.now(), row.id);
  } catch (error) {
    fail(row, error instanceof Error ? error.message.slice(0, 200) : 'failed');
  } finally {
    clearTimeout(timer);
  }
}

function fail(row: Row, message: string): void {
  const failures = Number(row.failures ?? 0) + 1;
  if (failures >= GIVE_UP) {
    unsubscribe(String(row.endpoint));
    return;
  }
  run(`UPDATE push_subscriptions SET failures = ?, last_error = ? WHERE id = ?`, failures, message, row.id);
}
