/**
 * A mailbox credential that expires, and the port that renews it.
 *
 * Gmail and Microsoft 365 both accept a password over IMAP and both make it
 * awkward on purpose: two-factor turns it into an app password, which an admin
 * has to generate per inbox, and an organisation that disables app passwords by
 * policy cannot connect at all. The answer both of them intend is
 * `AUTHENTICATE XOAUTH2` — the command is one line, and everything else is
 * this file: which provider minted the token, when it goes stale, and getting
 * the next one without asking a person.
 *
 * The **dance itself is not here**. Talking to `oauth2.googleapis.com` is
 * outbound HTTP to a named third party, which in this codebase is an adapter —
 * the same reason `ai-review` asks for a model rather than calling one and
 * `poll.ts` asks for a fetcher rather than opening a socket. So this declares
 * `registerMailAuthProvider` and `adapters/oauth` fills it.
 *
 * What stays here is the part that is about *this* product: where the secret
 * lives, when it is refreshed, and what happens when the provider says no.
 *
 * Two decisions worth stating:
 *
 * **The refresh token is stored where the password was.** One column, sealed
 * the same way, because to everything that touches that row they are the same
 * thing — the credential that outlives a session and must never be read back
 * out. `kind` tells them apart at the two places it matters.
 *
 * **The access token is cached, not fetched per poll.** A token endpoint hit
 * every five minutes per mailbox is four mailboxes' worth of pointless traffic
 * an hour and a rate limit somebody will meet on a bad day. The provider
 * already says when the token expires; that is what the expiry column is for.
 */
import { get, run, type Row } from '../../kernel/platform/db/index.ts';
import { seal, unseal } from '../../kernel/platform/seal.ts';

/** The purpose these credentials are sealed under. See `seal.ts`. */
export const PURPOSE = 'mailbox';

/** What a provider hands back, whether from a code or from a refresh. */
export interface TokenSet {
  accessToken: string;
  /**
   * Absent on a refresh at some providers, which reuse the one they issued.
   * A caller that overwrote the stored token with `undefined` would sign the
   * mailbox out an hour later, so the store keeps what it has.
   */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * One provider Kolibri can get a mailbox token from.
 *
 * `configured` rather than a boolean field: whether Google can be offered
 * depends on an instance setting an admin may change while the process is
 * running, so it is a question asked each time rather than an answer captured
 * at registration.
 */
export interface MailAuthProvider {
  /** `google` / `microsoft`, as stored on the credential row. */
  name: string;
  /** What to call it on screen. */
  label: string;
  configured(): boolean;
  /** Where to send somebody. `login` pre-fills the account picker. */
  authorizeUrl(input: { state: string; verifier: string; redirectUri: string; login: string }): string;
  exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
}

const providers = new Map<string, MailAuthProvider>();

/** @port a provider that can mint a mailbox token */
export function registerMailAuthProvider(provider: MailAuthProvider): void {
  providers.set(provider.name, provider);
}

/** Every provider this instance could actually use, for the settings screen. */
export const availableProviders = (): MailAuthProvider[] =>
  [...providers.values()].filter((provider) => provider.configured());

export function providerNamed(name: string): MailAuthProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`No mail OAuth provider called "${name}"`);
  if (!provider.configured()) throw new Error(`${provider.label} is not configured on this server`);
  return provider;
}

/* ------------------------------------------------------------------ store */

export interface StoredCredential {
  kind: 'password' | 'oauth';
  provider: string;
  /** The password, or the refresh token. Null when the seal will not open. */
  secret: string | null;
  accessToken: string | null;
  expiresAt: number | null;
}

export function storedCredential(mailboxId: string): StoredCredential | null {
  const row = get<Row>(`SELECT * FROM mailbox_credentials WHERE mailbox_id = ?`, mailboxId);
  if (!row) return null;
  return {
    kind: row.kind === 'oauth' ? 'oauth' : 'password',
    provider: String(row.provider ?? ''),
    secret: unseal(PURPOSE, String(row.secret)),
    accessToken: row.access_token ? unseal(PURPOSE, String(row.access_token)) : null,
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
  };
}

/** Store what a provider just handed over, keeping a refresh token it did not repeat. */
export function storeTokens(mailboxId: string, provider: string, tokens: TokenSet, byUserId: string): void {
  const existing = storedCredential(mailboxId);
  const refresh = tokens.refreshToken
    ?? (existing?.kind === 'oauth' ? existing.secret : null)
    ?? '';
  if (!refresh) {
    // Google only issues a refresh token on the first consent, and only when
    // asked with `prompt=consent`. Without one this mailbox works for an hour
    // and then stops with nothing to renew, which is a failure worth refusing
    // at the point it can still be explained.
    throw new Error('The provider returned no refresh token — reconnect and grant offline access');
  }
  run(
    `INSERT INTO mailbox_credentials (mailbox_id, secret, kind, provider, access_token, expires_at, updated_at, updated_by)
     VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?)
     ON CONFLICT (mailbox_id) DO UPDATE SET
       secret = excluded.secret, kind = 'oauth', provider = excluded.provider,
       access_token = excluded.access_token, expires_at = excluded.expires_at,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    mailboxId, seal(PURPOSE, refresh), provider,
    seal(PURPOSE, tokens.accessToken), tokens.expiresAt, Date.now(), byUserId,
  );
}

/**
 * How long before expiry a token counts as stale.
 *
 * A first pass over a large folder holds one connection for minutes, and a
 * token that expires halfway through is a batch lost to an error that reads
 * like a wrong password. A minute of slack costs one extra refresh a day.
 */
const SLACK_MS = 60_000;

/**
 * A usable access token for this mailbox, refreshing if it has gone stale.
 *
 * Returns null rather than throwing when there is no OAuth credential at all —
 * that is a password mailbox, and the caller's next question is the password.
 * A *failed refresh* does throw, because the difference between "not an OAuth
 * mailbox" and "the consent was revoked" is exactly what the settings screen
 * needs to say.
 */
export async function accessTokenFor(mailboxId: string): Promise<string | null> {
  const stored = storedCredential(mailboxId);
  if (!stored || stored.kind !== 'oauth') return null;
  if (stored.accessToken && stored.expiresAt && stored.expiresAt - SLACK_MS > Date.now()) {
    return stored.accessToken;
  }
  if (!stored.secret) {
    // The seal would not open: the instance secret changed, or a backup was
    // restored without the `.secret` file beside it. Nothing to renew with.
    throw new Error('The stored credential cannot be read on this instance — reconnect the mailbox');
  }
  const provider = providerNamed(stored.provider);
  const tokens = await provider.refresh(stored.secret);
  run(
    `UPDATE mailbox_credentials SET access_token = ?, expires_at = ?, secret = ?, updated_at = ? WHERE mailbox_id = ?`,
    seal(PURPOSE, tokens.accessToken), tokens.expiresAt,
    seal(PURPOSE, tokens.refreshToken ?? stored.secret), Date.now(), mailboxId,
  );
  return tokens.accessToken;
}
