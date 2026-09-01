/**
 * Getting a token for somebody else's mailbox.
 *
 * The third direction OAuth runs in here. `oidc.ts` is Kolibri as a *client*
 * asking an identity provider who somebody is; `routes/oauth.ts` is Kolibri as
 * a *server* granting an assistant access to itself. This is Kolibri as a
 * client again, but asking for something rather than for an identity: a token
 * that opens an IMAP session on Gmail or Microsoft 365.
 *
 * `modules/mail` owns when a token is renewed and where it is kept;
 * this owns the two conversations. Which is the split rule 5 asks for and also
 * the useful one — the endpoints, the scopes and the two providers' separate
 * opinions about refresh tokens are facts about somebody else's service, and
 * they change on their schedule rather than on this product's.
 *
 * Two provider quirks are load-bearing and neither is in any specification:
 *
 * **Google issues a refresh token once.** Only on the first consent, and only
 * when asked with `access_type=offline` *and* `prompt=consent`. Reconnect a
 * mailbox without the second and the exchange succeeds, returns an access
 * token, and hands back nothing to renew with — so the mailbox works for an
 * hour and then stops. `prompt=consent` on every start is the price of that not
 * happening, and it costs one extra click.
 *
 * **Microsoft needs the scope spelled with `offline_access`**, and refuses the
 * IMAP scope unless the app registration has it. A tenant that has not granted
 * `IMAP.AccessAsUser.All` fails at consent rather than at connect, which is the
 * better end to fail at and still surprises people.
 */
import { env } from '../../kernel/platform/env.ts';
import { registerMailAuthProvider, type MailAuthProvider, type TokenSet } from '../../modules/mail/oauth.ts';
import { challengeFor } from './oidc.ts';

/**
 * What a token endpoint answers with, in the parts anybody reads.
 *
 * `expires_in` is seconds from now, and both providers send it. A response
 * without one is treated as an hour, which is what both actually issue — a
 * missing expiry read as "never" would mean a token that is never renewed and
 * a mailbox that stops within the day.
 */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function post(url: string, body: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    // The provider's own words. `invalid_grant` means the consent was
    // withdrawn or the token was already used, and paraphrasing it into
    // "could not sign in" sends whoever is reading it to the wrong screen.
    throw new Error(payload.error_description ?? payload.error ?? `The provider refused (HTTP ${response.status})`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
  };
}

/* ---------------------------------------------------------------- Google */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

const google: MailAuthProvider = {
  name: 'google',
  label: 'Google',
  configured: () => !!(env.mailOAuth.google.clientId && env.mailOAuth.google.clientSecret),
  authorizeUrl: ({ state, verifier, redirectUri, login }) => `${GOOGLE_AUTH}?${new URLSearchParams({
    response_type: 'code',
    client_id: env.mailOAuth.google.clientId,
    redirect_uri: redirectUri,
    // Read-only IMAP and nothing else. `gmail.readonly` would also do it and
    // grants the REST API over the whole mailbox; this grants one protocol.
    scope: 'https://mail.google.com/',
    state,
    access_type: 'offline',
    // See the note at the top: without this a reconnect returns no refresh
    // token and the mailbox quietly stops working in an hour.
    prompt: 'consent',
    login_hint: login,
    // S256, not `plain`. The same rule the sign-in flow keeps, and
    // `challengeFor` is the same function — a second PKCE implementation in one
    // adapter would be one too many, and the weaker method is only ever there
    // because somebody could not hash.
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
  })}`,
  exchange: ({ code, verifier, redirectUri }) => post(GOOGLE_TOKEN, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.mailOAuth.google.clientId,
    client_secret: env.mailOAuth.google.clientSecret,
    code_verifier: verifier,
  }),
  refresh: (refreshToken) => post(GOOGLE_TOKEN, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.mailOAuth.google.clientId,
    client_secret: env.mailOAuth.google.clientSecret,
  }),
};

/* ------------------------------------------------------------- Microsoft */

const microsoftBase = (): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(env.mailOAuth.microsoft.tenant || 'common')}/oauth2/v2.0`;

/**
 * `offline_access` is what makes a refresh token appear, and the IMAP scope is
 * what makes the token open a mailbox. Neither is implied by the other, and a
 * registration missing the second fails at the consent screen.
 */
const MICROSOFT_SCOPE = 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All';

const microsoft: MailAuthProvider = {
  name: 'microsoft',
  label: 'Microsoft 365',
  configured: () => !!(env.mailOAuth.microsoft.clientId && env.mailOAuth.microsoft.clientSecret),
  authorizeUrl: ({ state, verifier, redirectUri, login }) => `${microsoftBase()}/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: env.mailOAuth.microsoft.clientId,
    redirect_uri: redirectUri,
    scope: MICROSOFT_SCOPE,
    state,
    login_hint: login,
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
  })}`,
  exchange: ({ code, verifier, redirectUri }) => post(`${microsoftBase()}/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.mailOAuth.microsoft.clientId,
    client_secret: env.mailOAuth.microsoft.clientSecret,
    scope: MICROSOFT_SCOPE,
    code_verifier: verifier,
  }),
  refresh: (refreshToken) => post(`${microsoftBase()}/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.mailOAuth.microsoft.clientId,
    client_secret: env.mailOAuth.microsoft.clientSecret,
    scope: MICROSOFT_SCOPE,
  }),
};

export function installMailAuthProviders(): void {
  registerMailAuthProvider(google);
  registerMailAuthProvider(microsoft);
}
