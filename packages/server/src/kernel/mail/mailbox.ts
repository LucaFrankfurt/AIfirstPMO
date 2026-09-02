/**
 * What a mail *source* is, and how a URL spells one.
 *
 * The inbound twin of `relay.ts`, and it exists for the same reason that one
 * does: `settings.ts` checks what somebody types into the mailbox screen, and
 * `env.ts` would have to parse `imaps://…` if an operator ever configures one
 * from the environment — both of which happen whether or not a socket is ever
 * opened, and neither of which should mean the kernel importing an adapter to
 * ask what a string looks like.
 *
 * So the shape is declared here and `adapters/imap` consumes it. Nothing in
 * this file opens anything, speaks IMAP, or knows that IMAP is what will be
 * spoken — a mailbox is a host, a port, an encryption and a login, and the
 * protocol is the transport's business.
 *
 * `SmtpEncryption` and `MailEncryption` are the same three words for the same
 * three guarantees, and they are deliberately one type. An earlier draft had a
 * separate `ImapEncryption` because the ports differ (993 and 143 rather than
 * 465 and 587), which is a difference in the *default* and not in the meaning —
 * and two identical unions is how a settings screen ends up with two dropdowns
 * that have to be kept in step by hand.
 */
import { defaultMailboxPort, type MailEncryption } from '@kolibri/shared';
import { isEmailAddress } from './address.ts';

/**
 * How the client proves who it is.
 *
 * A union rather than an optional token beside an optional password, because
 * the two are alternatives and nothing sensible happens when both are present.
 * Spelled this way the transport has to say which one it is holding, and the
 * check below can refuse *either* over an unencrypted connection — a bearer
 * token read off the wire is a mailbox for an hour, which is worse than a
 * password in every respect except how long it lasts.
 */
export type MailboxCredential =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; accessToken: string };

export interface MailboxConfig {
  host: string;
  port: number;
  encryption: MailEncryption;
  username: string;
  credential: MailboxCredential;
  /** Accept self-signed certificates — for an internal server on a private network. */
  allowInvalidCerts?: boolean;
  timeoutMs?: number;
}

export const isMailEncryption = (value: unknown): value is MailEncryption =>
  value === 'none' || value === 'starttls' || value === 'tls';

/**
 * `imaps://user:pass@host:993` / `imap://…?encryption=starttls` -> config.
 *
 * `imaps:` is implicit TLS. `imap:` means STARTTLS — required, not attempted,
 * exactly as `parseSmtpUrl` reads `smtp:`, and for the identical reason: a
 * server that does not advertise the upgrade is either misconfigured or not the
 * server it claims to be, and the next thing the client would otherwise do is
 * read out the password. `?encryption=none` is how a capture server on
 * localhost says so out loud.
 */
export function parseMailboxUrl(raw: string): MailboxConfig | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'imap:' && url.protocol !== 'imaps:') return null;
    const implicit = url.protocol === 'imaps:';
    const asked = url.searchParams.get('encryption');
    const encryption = isMailEncryption(asked) ? asked : implicit ? 'tls' : 'starttls';
    return {
      host: url.hostname,
      port: Number(url.port) || defaultMailboxPort(encryption),
      encryption,
      username: url.username ? decodeURIComponent(url.username) : '',
      // A URL can only ever spell a password. A token is minted, not typed,
      // and one pasted into a URL would be expired before it was useful.
      credential: { kind: 'password', password: url.password ? decodeURIComponent(url.password) : '' },
      allowInvalidCerts: url.searchParams.get('insecure') === 'true',
    };
  } catch {
    return null;
  }
}

/**
 * A host name as it was meant, from a host name as it was pasted.
 *
 * Hostnames are typed once and almost always by copying them out of a hosting
 * panel, which is how one arrived here reading `calendoora-de.netcup-mail.de`
 * and being refused for containing a space. It did contain one — the field
 * simply cannot show it. The old refusal then said "a host name has no spaces
 * in it" to somebody looking straight at a host name with no spaces in it,
 * which is the worst thing an error message can do: contradict the screen.
 *
 * So the invisible ones are removed rather than reported. Zero-width marks and
 * a byte-order mark carry no meaning in a host name and cannot be seen
 * anywhere, so they go wherever they sit; ordinary whitespace goes from the
 * ends, where it is equally invisible. `trim` covers the non-breaking space at
 * an end too, which is what a panel that pretty-prints its own output leaves
 * behind.
 *
 * A space in the *middle* is deliberately left alone. That one is visible, so
 * it is a typo somebody can see and fix, and silently deleting it would turn
 * "mail example com" into a host that resolves to something else entirely.
 */
export const cleanHost = (value: string): string => value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

/** What to call a character in a sentence somebody has to act on. */
export const nameOfCharacter = (character: string): string => {
  const point = `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
  if (character === ' ') return 'a space';
  if (character === '\u00a0') return `a non-breaking space (${point})`;
  if (/\s/.test(character)) return `whitespace (${point})`;
  return `"${character}" (${point})`;
};

/**
 * Is this something worth trying to connect to? A sentence if not.
 *
 * Shaped like the checks in `settings.ts` — `null` for fine, prose for wrong —
 * because it is called from the same kind of place: a form somebody is typing
 * into, where the useful output is the reason rather than a boolean.
 *
 * It refuses a password over an unencrypted connection, and does so here rather
 * than at the socket. The SMTP client refuses that too, at `sendMail`, and both
 * checks are worth having: this one is the sentence on the screen before
 * anything is stored, and that one is the guarantee for a configuration that
 * arrived some other way.
 */
export function checkMailbox(config: Partial<MailboxConfig> & { address?: string }): string | null {
  if (config.address !== undefined && !isEmailAddress(config.address)) {
    return 'That is not an email address';
  }
  const host = cleanHost(String(config.host ?? ''));
  if (!host) return 'A mailbox needs a host to connect to';
  const stray = host.match(/[^A-Za-z0-9.:_-]/);
  if (stray) return `A host name is letters, digits, dots and dashes — this one has ${nameOfCharacter(stray[0])} in it`;
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'A port is a number from 1 to 65535';
  if (!isMailEncryption(config.encryption)) return 'Encryption is tls, starttls or none';
  // Either kind of credential, not only a password. A bearer token on a
  // plaintext connection is a mailbox for whoever is listening, for as long as
  // the token lasts — the shorter life is the only way it is better.
  if (config.encryption === 'none' && hasSecret(config.credential)) {
    return 'Refusing to send a credential unencrypted — choose tls or starttls';
  }
  return null;
}

/** Is there anything here worth protecting? Both arms, in one place. */
export const hasSecret = (credential: MailboxCredential | undefined): boolean =>
  !!(credential && (credential.kind === 'password' ? credential.password : credential.accessToken));
