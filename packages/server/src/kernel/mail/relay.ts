/**
 * What a mail relay is, and how a URL spells one.
 *
 * The shape rather than the conversation: `env.ts` reads `KOLIBRI_SMTP_URL`
 * into these fields and `settings.ts` checks what somebody types into the
 * screen, both of which happen whether or not a relay is ever contacted — and
 * both of which used to reach into the SMTP client to ask, which is the kernel
 * importing an adapter to find out what a string looks like.
 *
 * So the shape is declared here and the transport consumes it, the same way
 * `storage` declares a `Backend` and S3 fills it. `adapters/mail` holds the
 * sockets, the RFC 5321 conversation and the retries; nothing in this module
 * opens anything.
 */

/**
 * How the connection is protected.
 *
 *   `tls`      — encrypted from the first byte. Port 465.
 *   `starttls` — a plaintext connection upgraded before anything is said. Port
 *                587. **Required, not attempted**: see below.
 *   `none`     — no encryption at all. Only ever right for a capture inbox on
 *                localhost; refused outright if credentials are set.
 *
 * This used to be a boolean named `secure`, where `false` meant "STARTTLS if
 * the relay offers it". That is the dangerous half of opportunistic TLS: a
 * relay that does not advertise STARTTLS — because it is having a bad day, or
 * because somebody is sitting in the middle stripping the capability out of its
 * EHLO reply — got a plaintext connection instead, and then `AUTH PLAIN` put
 * the account's password on the wire in base64, which is to say in the clear.
 * Nothing logged it and nothing failed. The mail went through, which is exactly
 * what makes it worth writing down.
 *
 * So the setting names the guarantee rather than the attempt, and `starttls`
 * aborts if the upgrade is not on offer.
 */
export type SmtpEncryption = 'none' | 'starttls' | 'tls';

export interface SmtpConfig {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  user?: string;
  pass?: string;
  /** Accept self-signed certificates — for an internal relay on a private network. */
  allowInvalidCerts?: boolean;
  timeoutMs?: number;
}

/**
 * `smtp://user:pass@host:587` / `smtps://…` -> config.
 *
 * `smtps:` is implicit TLS. `smtp:` means STARTTLS, which is what this scheme
 * has always been documented to mean here — the difference is that it is now
 * enforced rather than attempted.
 *
 * A capture inbox speaks neither, so `?encryption=none` says so out loud. It is
 * a query parameter rather than a third scheme because there is no third scheme
 * to spell it with, and because a URL that turns encryption off should have to
 * say the word.
 */
export function parseSmtpUrl(raw: string): SmtpConfig | null {
  try {
    const url = new URL(raw);
    const implicit = url.protocol === 'smtps:';
    const asked = url.searchParams.get('encryption');
    return {
      host: url.hostname,
      port: Number(url.port) || (implicit ? 465 : 587),
      encryption: isEncryption(asked) ? asked : implicit ? 'tls' : 'starttls',
      user: url.username ? decodeURIComponent(url.username) : undefined,
      pass: url.password ? decodeURIComponent(url.password) : undefined,
      allowInvalidCerts: url.searchParams.get('insecure') === 'true',
    };
  } catch {
    return null;
  }
}

export const isEncryption = (value: unknown): value is SmtpEncryption =>
  value === 'none' || value === 'starttls' || value === 'tls';
