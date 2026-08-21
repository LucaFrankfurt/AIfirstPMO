/**
 * The address this instance answers to, in one place.
 *
 * Two things depend on knowing it and they must never disagree: the OAuth
 * metadata, whose `issuer` a client is required to check against the URL it
 * fetched the document from, and the `Secure` flag on the session cookie.
 *
 * They used to work it out separately, and both got it wrong in the same way —
 * by asking `x-forwarded-proto` and falling back to the socket, which is plain
 * HTTP behind every proxy. Behind one that forwards the host and not the
 * scheme, that published `http://the-real-domain` as the issuer (a hard refusal
 * for any OAuth client) and dropped `Secure` from the session cookie (a session
 * token that a browser will send over plain HTTP). One bug, two symptoms, two
 * copies of the same three lines.
 */
import { env } from '../env.ts';
import type { Ctx } from './http.ts';

/** Whether this host looks like one somebody is reaching without a proxy. */
function direct(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const port = /:(\d+)$/.exec(host)?.[1];
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost')) return true;
  // A port nobody would put in a public URL is a laptop or a container port.
  return !!port && port !== '443';
}

/**
 * `scheme://host`, as everybody else has to spell it.
 *
 * `KOLIBRI_PUBLIC_URL` settles it outright and is the right answer for any real
 * deployment. Failing that, the proxy's `x-forwarded-proto`, then the socket,
 * and failing all three: **assume TLS unless the host says otherwise.** A bare
 * hostname reached this process through something that terminated TLS; a host
 * carrying a port that is not 443 is a laptop or a container.
 */
export function publicOrigin(ctx: Ctx): string {
  if (env.publicUrl) return env.publicUrl;
  const host = (ctx.req.headers['x-forwarded-host'] as string) || ctx.req.headers.host || 'localhost';
  const forwarded = (ctx.req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
  const proto = forwarded
    || ((ctx.req.socket as { encrypted?: boolean }).encrypted ? 'https' : direct(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Whether this request is on a connection worth marking a cookie `Secure` for. */
export const overTls = (ctx: Ctx): boolean => publicOrigin(ctx).startsWith('https://');
