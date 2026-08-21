/**
 * Requests this server makes because somebody asked it to.
 *
 * Two features hand a URL to the server and have it connect: an outgoing
 * webhook, whose address a workspace admin types in, and a Web Push
 * subscription, whose endpoint the browser supplies. Both are ordinary
 * features, and both are also the classic way to make a server reach places
 * the person on the other end cannot — the container next door, the database
 * on the private network, the cloud metadata service on 169.254.169.254 that
 * hands out credentials to anyone who asks from inside.
 *
 * So an address is resolved *before* anything is sent, every address the name
 * resolves to is checked, and the connection is then pinned to the address
 * that was checked. Pinning is the part that matters: without it a name can
 * answer with a public address for the check and a private one a moment later
 * for the connection, and the check was theatre.
 *
 * Redirects are followed by hand, three at most, with the same check at every
 * hop — a public URL that 302s to the metadata service is the same attack
 * wearing a hat.
 *
 * None of this is a judgement about private networks. A self-hosted instance
 * that legitimately posts to `http://n8n:5678` on its own docker network is a
 * normal thing to want, and `KOLIBRI_ALLOW_PRIVATE_WEBHOOKS=1` says so. The
 * default is the other way round because the person who has not thought about
 * it is the person this protects.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { env } from '../env.ts';

/** Refused before a packet was sent. Never a network error, always a policy one. */
export class BlockedAddress extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddress';
  }
}

/* ------------------------------------------------------------- the ranges */

const v4 = (address: string): number | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
};

/** `a.b.c.d/bits` as a test, written the way the RFCs write it. */
const within = (address: number, cidr: string): boolean => {
  const [base, bits] = cidr.split('/');
  const size = Number(bits);
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
  return (address & mask) >>> 0 === ((v4(base)! & mask) >>> 0);
};

/**
 * Everything that is not somewhere else on the internet.
 *
 * The obvious ones — loopback, the RFC 1918 ranges, link-local — plus the ones
 * that are easy to forget and just as reachable: carrier-grade NAT, the
 * benchmarking range, and the multicast and reserved blocks at the top.
 */
const RESERVED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

/** The eight groups of an IPv6 address, or null if it is not one. */
function v6(address: string): number[] | null {
  const plain = address.split('%')[0];
  const halves = plain.split('::');
  if (halves.length > 2) return null;

  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  const tail: number[] = [];
  let text = plain;
  if (embedded) {
    const packed = v4(embedded[1]);
    if (packed === null) return null;
    tail.push(packed >>> 16, packed & 0xffff);
    text = plain.slice(0, plain.length - embedded[1].length).replace(/:$/, ':');
  }

  const [left, right] = text.split('::');
  const read = (part: string): number[] | null => {
    if (!part || part === ':') return [];
    const groups: number[] = [];
    for (const piece of part.replace(/^:|:$/g, '').split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = read(left ?? '');
  const rest = right === undefined ? null : read(right);
  if (head === null || (right !== undefined && rest === null)) return null;

  const front = head;
  const back = [...(rest ?? []), ...tail];
  if (right === undefined) {
    const all = [...front, ...tail];
    return all.length === 8 ? all : null;
  }
  const gap = 8 - front.length - back.length;
  if (gap < 0) return null;
  return [...front, ...Array(gap).fill(0), ...back];
}

/**
 * Is this address somewhere the request has no business going?
 *
 * Exported because it is the whole of the policy and a test should be able to
 * say so directly, without a socket in the way.
 */
export function isReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const packed = v4(address);
    return packed === null || RESERVED_V4.some((range) => within(packed, range));
  }
  if (family !== 6) return true; // not an address at all: refuse it

  const groups = v6(address);
  if (!groups) return true;

  // The v4 hiding inside a v6: `::ffff:127.0.0.1` and NAT64 and 6to4 are all
  // ways of writing an IPv4 destination, and all of them reach it.
  const embeds =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff ? 6
      : groups[0] === 0x0064 && groups[1] === 0xff9b ? 6
        : groups[0] === 0x2002 ? 1
          : 0;
  if (embeds) {
    const packed = ((groups[embeds] << 16) | groups[embeds + 1]) >>> 0;
    return RESERVED_V4.some((range) => within(packed, range));
  }

  if (groups.every((group) => group === 0)) return true;                    // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                         // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                         // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true;                         // ff00::/8 multicast
  return false;
}

/* ------------------------------------------------------------- the request */

export interface Reply {
  status: number;
  /** At most 8 KiB, and only so a failure can say what came back. */
  body: string;
}

export interface Options {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_REDIRECTS = 3;
const MAX_BODY = 8 * 1024;

/**
 * Check a URL without connecting to it, and say what address it resolves to.
 *
 * Every address the name answers with has to pass, not just the first: a name
 * with one public A record and one private one is a name that reaches the
 * private one half the time.
 */
export async function resolveSafely(raw: string): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddress('Not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddress(`Only http and https are allowed, not ${url.protocol.replace(':', '')}`);
  }
  // Credentials in the URL are how a request gets talked into authenticating
  // to something it was never meant to reach.
  if (url.username || url.password) throw new BlockedAddress('A URL with credentials in it is not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (env.outbound.allowPrivate) {
    return { url, address: host, family: isIP(host) || 0 };
  }

  if (isIP(host)) {
    if (isReservedAddress(host)) throw new BlockedAddress(`${host} is not a public address`);
    return { url, address: host, family: isIP(host) };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedAddress(`${host} does not resolve`);
  }
  if (!answers.length) throw new BlockedAddress(`${host} does not resolve`);
  for (const answer of answers) {
    if (isReservedAddress(answer.address)) {
      throw new BlockedAddress(`${host} resolves to ${answer.address}, which is not a public address`);
    }
  }
  return { url, address: answers[0].address, family: answers[0].family };
}

/**
 * Send it, to an address that has already been checked.
 *
 * `node:http` rather than `fetch` for one reason: it takes a `lookup`, which is
 * how the socket is made to go to the address that passed the check instead of
 * asking DNS a second question and believing the second answer.
 */
export async function send(raw: string, options: Options = {}): Promise<Reply> {
  let target = raw;
  for (let hop = 0; ; hop++) {
    const { url, address, family } = await resolveSafely(target);
    const reply = await once(url, address, family, options, hop > 0);
    const location = reply.location;
    if (!location || hop >= MAX_REDIRECTS) {
      return { status: reply.status, body: reply.body };
    }
    try {
      target = new URL(location, url).toString();
    } catch {
      return { status: reply.status, body: reply.body };
    }
  }
}

interface Hop extends Reply {
  location?: string;
}

function once(
  url: URL,
  address: string,
  family: number,
  options: Options,
  redirected: boolean,
): Promise<Hop> {
  const secure = url.protocol === 'https:';
  const call = secure ? httpsRequest : httpRequest;
  // A redirect is followed with GET and no body, which is what every client
  // does with a 303 and the only shape that cannot be turned into "post my
  // payload somewhere else as well".
  const method = redirected ? 'GET' : (options.method ?? 'GET');
  const body = redirected ? undefined : options.body;

  return new Promise<Hop>((resolve, reject) => {
    const req = call({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        ...(redirected ? {} : options.headers ?? {}),
      },
      // The pin. `family` comes from the same answer the address did, so a
      // v6-only host is not asked to connect over v4.
      lookup: (_host: string, opts: unknown, callback: unknown) => {
        const done = callback as (error: Error | null, ...rest: unknown[]) => void;
        const wantsAll = !!(opts as { all?: boolean })?.all;
        const resolved = family === 6 || (!family && address.includes(':')) ? 6 : 4;
        if (wantsAll) done(null, [{ address, family: resolved }]);
        else done(null, address, resolved);
      },
      signal: options.signal,
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? res.headers.location : undefined;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= MAX_BODY) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status,
        body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY),
        location: location || undefined,
      }));
      res.on('error', reject);
    });

    req.setTimeout(options.timeoutMs ?? 5_000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
