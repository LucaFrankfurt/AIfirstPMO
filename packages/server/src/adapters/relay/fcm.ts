/**
 * Google's half: Firebase Cloud Messaging, HTTP v1, by hand.
 *
 * The Admin SDK is the usual way and it is a large dependency for two requests.
 * What it does here is mint an OAuth access token from the service account —
 * an RS256-signed JWT exchanged at Google's token endpoint, which `node:crypto`
 * signs directly — and post one message per phone. The access token lives an
 * hour and is kept for most of it.
 *
 * Android shows the notification itself when the app is in the background,
 * from the `notification` block: the app does not have to be running, and no
 * native code of ours runs to show it. `icon` names a drawable the app ships
 * (`ic_stat_kolibri`), because Android draws a status-bar icon from its alpha
 * alone and the launcher icon would arrive as a white square.
 */
import { createSign } from 'node:crypto';
import { b64url, shortToken, type Outcome, type Sender } from './sender.ts';
import { COLLAPSE, WAKE_URL, type Words } from './words.ts';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  /** Google's token endpoint; the service account file names it. */
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
/** Renewed this long before Google would refuse it, so no send meets an expired one. */
const EARLY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** A service account file as Google issues it, or the reason it is not one. */
export function readServiceAccount(text: string): ServiceAccount {
  const parsed = JSON.parse(text) as Partial<ServiceAccount>;
  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof parsed[field] !== 'string' || !parsed[field]) throw new Error(`the service account has no ${field}`);
  }
  return parsed as ServiceAccount;
}

export function fcmSender(account: ServiceAccount, options: { endpoint?: string } = {}): Sender {
  const endpoint = (options.endpoint ?? 'https://fcm.googleapis.com').replace(/\/+$/, '');
  const tokenUri = account.token_uri || GOOGLE_TOKEN;
  let access: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access && access.until > Date.now()) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key);
    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${head}.${claims}.${b64url(signature)}`,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
    if (!response.ok || !answer.access_token) throw new Error(`Google refused the service account (${response.status})`);
    access = { token: answer.access_token, until: Date.now() + (answer.expires_in ?? 3600) * 1000 - EARLY_MS };
    return access.token;
  }

  async function post(token: string, words: Words): Promise<Response> {
    return fetch(`${endpoint}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: words.title, body: words.body },
          data: { url: WAKE_URL },
          android: {
            collapse_key: COLLAPSE,
            // High, because the point is that somebody hears about it now —
            // and every one of these shows a notification, which is the
            // condition Android sets for being allowed to ask for it.
            priority: 'HIGH',
            ttl: '86400s',
            notification: { tag: COLLAPSE, icon: 'ic_stat_kolibri' },
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    async send(token: string, words: Words): Promise<Outcome> {
      try {
        let response = await post(token, words);
        // An access token Google stopped honouring early: one fresh try.
        if (response.status === 401) {
          access = null;
          response = await post(token, words);
        }
        if (response.ok) return 'sent';
        const error = await response.json().catch(() => ({})) as {
          error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
        };
        const code = error.error?.details?.find((detail) => detail.errorCode)?.errorCode ?? error.error?.status ?? '';
        // UNREGISTERED is the documented "this token is over". SENDER_ID_MISMATCH
        // is a token for some other Firebase project, which will never become
        // ours. An INVALID_ARGUMENT that names the token is a token that was
        // never one — the same answer, for the same reason.
        if (response.status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return 'gone';
        if (code === 'INVALID_ARGUMENT' && /registration token/i.test(error.error?.message ?? '')) return 'gone';
        console.error('[relay] FCM refused', shortToken(token), response.status, code);
        return 'failed';
      } catch (problem) {
        console.error('[relay] FCM unreachable for', shortToken(token), problem instanceof Error ? problem.message : problem);
        return 'failed';
      }
    },
  };
}
