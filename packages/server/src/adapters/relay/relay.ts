/**
 * The relay: a phone's token in, a wake to Apple or Google out.
 *
 * Run by whoever publishes the app, because only they hold the credentials
 * Apple and Google sign the app's pushes with — see `adapters/push/app.ts` for
 * why a self-hosted server cannot. Any Kolibri may call it, so it takes no
 * account and keeps no list: there is nothing it could check a caller against
 * that a caller could not also run.
 *
 * What stops it being useful to anybody else is what it will say. It sends one
 * fixed sentence, "New activity", in one of three languages, and opens the app
 * on its inbox. Somebody holding a stranger's token can make that phone say
 * that, and no more often than the limits below allow — which is less than the
 * sender already can by sending the phone's owner a comment.
 *
 * It keeps nothing. No token is written down; the limits are counters in
 * memory, and a restart forgets them.
 *
 *   POST /v1/wake   { devices: [{ platform, token }], locale } → { gone: [token] }
 *   GET  /health    which platforms this relay can reach
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Sender } from './sender.ts';
import { wakeWords } from './words.ts';

export interface RelayOptions {
  android?: Sender | null;
  ios?: Sender | null;
  /** Read the caller's address from `X-Forwarded-For` — only behind a proxy that sets it. */
  trustProxy?: boolean;
}

/*
 * The limits, each one a reason rather than a budget.
 *
 * A server gathers a person's notifications for two seconds before it wakes
 * their phones, so a phone woken more than six times in a minute is being
 * woken by something other than its server. One server asking 600 times a
 * minute is ten wakes a second for a minute — an instance far bigger than any
 * this has met — and is still nowhere near what it costs Apple or Google to
 * notice us. A wake carries at most 20 phones, which is one person with more
 * devices than anybody has.
 */
const PER_TOKEN_PER_MINUTE = 6;
const PER_CALLER_PER_MINUTE = 600;
const MAX_DEVICES = 20;
const MAX_BODY = 64 * 1024;

/** The shape a token has on both platforms, and the bound the server keeps too. */
const TOKEN = /^[\x21-\x7e]{16,4096}$/;

class Window {
  private counts = new Map<string, number>();
  private started = Date.now();

  /** True if this key may go once more in the current minute. */
  allow(key: string, limit: number): boolean {
    if (Date.now() - this.started >= 60_000) {
      this.counts.clear();
      this.started = Date.now();
    }
    const used = this.counts.get(key) ?? 0;
    if (used >= limit) return false;
    this.counts.set(key, used + 1);
    return true;
  }
}

const reply = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * The body, or null past the limit.
 *
 * Past it the rest is drained and dropped rather than the socket torn down
 * mid-upload: a reset is all a caller would see of that, where a 413 says what
 * was wrong. The reply that follows closes the connection, so a caller that
 * keeps sending is not kept company for long.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createRelay(options: RelayOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const senders: Record<string, Sender | null | undefined> = { android: options.android, ios: options.ios };
  const callers = new Window();
  const phones = new Window();

  const callerOf = (req: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  };

  async function wake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!callers.allow(callerOf(req), PER_CALLER_PER_MINUTE)) {
      reply(res, 429, { error: 'too_many_requests' });
      return;
    }
    const text = await readBody(req);
    if (text === null) {
      res.setHeader('connection', 'close');
      reply(res, 413, { error: 'too_large' });
      return;
    }
    let body: { devices?: unknown; locale?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      reply(res, 400, { error: 'not_json' });
      return;
    }
    const devices = Array.isArray(body.devices) ? body.devices : null;
    if (!devices || devices.length > MAX_DEVICES) {
      reply(res, 400, { error: 'devices', message: `devices is a list of at most ${MAX_DEVICES}` });
      return;
    }
    const words = wakeWords(body.locale);
    const gone: string[] = [];
    await Promise.all(devices.map(async (device: unknown) => {
      const { platform, token } = (device ?? {}) as { platform?: unknown; token?: unknown };
      if (typeof token !== 'string' || !TOKEN.test(token) || typeof platform !== 'string') return;
      const sender = senders[platform];
      if (!sender || !phones.allow(token, PER_TOKEN_PER_MINUTE)) return;
      if (await sender.send(token, words) === 'gone') gone.push(token);
    }));
    reply(res, 200, { gone });
  }

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/v1/wake') {
      wake(req, res).catch((problem) => {
        console.error('[relay] a wake failed:', problem);
        if (!res.headersSent) reply(res, 500, { error: 'failed' });
      });
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      reply(res, 200, { ok: true, android: !!senders.android, ios: !!senders.ios });
      return;
    }
    reply(res, 404, { error: 'not_found' });
  };
}
