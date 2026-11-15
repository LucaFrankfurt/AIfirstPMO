/**
 * Apple's half: the APNs provider API, over HTTP/2, by hand.
 *
 * Token-based authentication: one `.p8` key from the developer account signs
 * an ES256 JWT that names the team, and that JWT is good for every app the team
 * has. `node:crypto` signs it and `node:http2` carries it — APNs speaks nothing
 * but HTTP/2, which is the one reason this is not `fetch`.
 *
 * **Which of Apple's two services.** A build from Xcode is given a token by the
 * sandbox; a TestFlight or App Store build by production; and a token says
 * nothing about which it came from. So production is asked first — that is
 * where the users are — and a `BadDeviceToken` there is asked again of the
 * sandbox before the token is called gone. A development phone costs one extra
 * request; nobody's development phone is silently never woken.
 *
 * Apple refuses a provider token older than an hour and complains about one
 * renewed more often than every twenty minutes, so it is renewed at fifty.
 */
import { createSign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import { b64url, shortToken, type Outcome, type Sender } from './sender.ts';
import { COLLAPSE, WAKE_URL, type Words } from './words.ts';

export interface ApnsKey {
  /** The ten-character id Apple shows beside the key. */
  keyId: string;
  teamId: string;
  /** The `.p8` file's contents: a PKCS#8 PEM. */
  key: string;
  /** The app's bundle identifier. */
  topic: string;
}

const RENEW_MS = 50 * 60_000;
const TIMEOUT_MS = 10_000;

interface Reply { status: number; reason: string }

export function apnsSender(
  credentials: ApnsKey,
  options: { production?: string; sandbox?: string } = {},
): Sender {
  const hosts = {
    production: options.production ?? 'https://api.push.apple.com',
    sandbox: options.sandbox ?? 'https://api.sandbox.push.apple.com',
  };
  const sessions = new Map<string, ClientHttp2Session>();
  let provider: { token: string; at: number } | null = null;

  function providerToken(): string {
    if (provider && Date.now() - provider.at < RENEW_MS) return provider.token;
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
    const claims = b64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(Date.now() / 1000) }));
    const signature = createSign('SHA256')
      .update(`${head}.${claims}`)
      .sign({ key: credentials.key, dsaEncoding: 'ieee-p1363' });
    provider = { token: `${head}.${claims}.${b64url(signature)}`, at: Date.now() };
    return provider.token;
  }

  /** One connection per host, kept open: Apple asks providers not to reconnect per push. */
  function session(origin: string): ClientHttp2Session {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const fresh = connect(origin);
    fresh.on('error', () => sessions.delete(origin));
    fresh.on('goaway', () => sessions.delete(origin));
    fresh.on('close', () => sessions.delete(origin));
    fresh.unref();
    sessions.set(origin, fresh);
    return fresh;
  }

  function request(origin: string, token: string, words: Words): Promise<Reply> {
    const body = JSON.stringify({
      aps: { alert: { title: words.title, body: words.body }, sound: 'default', 'thread-id': COLLAPSE },
      url: WAKE_URL,
    });
    return new Promise((resolve, reject) => {
      const stream = session(origin).request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(token)}`,
        authorization: `bearer ${providerToken()}`,
        'apns-topic': credentials.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': COLLAPSE,
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 86_400),
        'content-type': 'application/json',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      stream.setTimeout(TIMEOUT_MS, () => stream.close());
      stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('close', () => {
        if (!status) {
          reject(new Error('APNs closed the stream without answering'));
          return;
        }
        let reason = '';
        try {
          reason = String((JSON.parse(Buffer.concat(chunks).toString() || '{}') as { reason?: string }).reason ?? '');
        } catch {
          /* An answer with no body is a 200. */
        }
        resolve({ status, reason });
      });
      stream.end(body);
    });
  }

  async function ask(origin: string, token: string, words: Words): Promise<Reply> {
    let reply = await request(origin, token, words);
    // Renewed on our side at fifty minutes, so this is a clock that disagrees
    // with Apple's. One fresh token and one more try.
    if (reply.status === 403 && reply.reason === 'ExpiredProviderToken') {
      provider = null;
      reply = await request(origin, token, words);
    }
    return reply;
  }

  return {
    async send(token: string, words: Words): Promise<Outcome> {
      try {
        let reply = await ask(hosts.production, token, words);
        if (reply.status === 400 && reply.reason === 'BadDeviceToken') reply = await ask(hosts.sandbox, token, words);
        if (reply.status === 200) return 'sent';
        // 410 is Apple saying the app is gone from that phone. A token still
        // bad on both services, or one issued to some other app, will never be
        // one this relay can use.
        if (reply.status === 410 || reply.reason === 'BadDeviceToken' || reply.reason === 'DeviceTokenNotForTopic') return 'gone';
        console.error('[relay] APNs refused', shortToken(token), reply.status, reply.reason);
        return 'failed';
      } catch (problem) {
        console.error('[relay] APNs unreachable for', shortToken(token), problem instanceof Error ? problem.message : problem);
        return 'failed';
      }
    },
    close(): void {
      for (const open of sessions.values()) open.close();
      sessions.clear();
    },
  };
}
