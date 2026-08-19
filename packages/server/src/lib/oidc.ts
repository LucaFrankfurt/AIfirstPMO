/**
 * Single sign-on over OpenID Connect.
 *
 * The authorization-code flow with PKCE, written against the specification
 * rather than pulled in, for the same reason as the rest of this codebase: it
 * is the door, and a door should be readable.
 *
 * What is deliberately *not* here:
 *
 *   - **No refresh tokens.** Kolibri issues its own session the moment the
 *     provider says who you are; after that the provider is not consulted
 *     again until the session expires. Keeping a refresh token would mean
 *     storing a long-lived credential for every user to solve a problem this
 *     design does not have.
 *   - **No implicit or hybrid flow.** Both put tokens in a URL.
 *   - **No SAML.** A different protocol, an XML signature stack, and a much
 *     bigger surface; if somebody needs it they need a proxy in front.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { env } from '../env.ts';

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface Claims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  picture?: string;
}

export const enabled = (): boolean => !!(env.oidc.issuer && env.oidc.clientId && env.oidc.clientSecret);

/* ------------------------------------------------------------- discovery */

let cached: { at: number; document: Discovery } | null = null;
const DISCOVERY_TTL = 3_600_000;

/** The provider's own description of itself, cached for an hour. */
export async function discover(fetcher: typeof fetch = fetch): Promise<Discovery> {
  if (cached && Date.now() - cached.at < DISCOVERY_TTL) return cached.document;
  const base = env.oidc.issuer.replace(/\/$/, '');
  const response = await fetcher(`${base}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`The identity provider did not answer discovery (HTTP ${response.status})`);
  const document = (await response.json()) as Discovery;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!document[field]) throw new Error(`The provider's discovery document has no ${field}`);
  }
  cached = { at: Date.now(), document };
  return document;
}

/** Tests and a changed configuration both need this. */
export const forgetDiscovery = (): void => { cached = null; };

/* ------------------------------------------------------------------ PKCE */

export interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  /** Where to go once it works. Only ever a path on this instance. */
  next: string;
  created_at: number;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

export function startFlow(next = '/'): Pending {
  return {
    state: base64url(randomBytes(24)),
    nonce: base64url(randomBytes(24)),
    verifier: base64url(randomBytes(48)),
    // An open redirect is the classic mistake here: only a path on this
    // instance is ever accepted, never a full URL somebody handed us.
    next: next.startsWith('/') && !next.startsWith('//') ? next : '/',
    created_at: Date.now(),
  };
}

export const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest());

export function authorizeUrl(document: Discovery, pending: Pending, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.oidc.clientId,
    redirect_uri: redirectUri,
    scope: env.oidc.scope,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: challengeFor(pending.verifier),
    code_challenge_method: 'S256',
  });
  return `${document.authorization_endpoint}?${params}`;
}

/* ------------------------------------------------------- token + claims */

export async function exchangeCode(
  document: Discovery,
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id_token: string; access_token?: string }> {
  const response = await fetcher(document.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.oidc.clientId,
      client_secret: env.oidc.clientSecret,
      code_verifier: verifier,
    }).toString(),
  });
  const payload = (await response.json()) as { id_token?: string; access_token?: string; error?: string };
  if (!response.ok || !payload.id_token) {
    throw new Error(`The provider refused the code${payload.error ? `: ${payload.error}` : ''}`);
  }
  return { id_token: payload.id_token, access_token: payload.access_token };
}

interface Jwk { kty: string; kid?: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string }

/**
 * Verify the ID token and return its claims.
 *
 * Every check the specification asks for, in one place: the signature against
 * the provider's published key, then issuer, audience, expiry and the nonce
 * this browser started with. Skipping any one of them turns "signed in as
 * Ada" into "signed in as whoever asked".
 */
export async function verifyIdToken(
  document: Discovery,
  token: string,
  nonce: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Claims> {
  const [headerPart, payloadPart, signaturePart] = String(token).split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('The ID token is not a JWT');

  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { alg: string; kid?: string };
  const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Claims;

  // `alg: none` and HMAC-signed tokens are the two classic forgeries; only
  // asymmetric signatures the provider published a key for are accepted.
  const algorithms: Record<string, string> = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512', ES256: 'sha256' };
  if (!algorithms[header.alg]) throw new Error(`The ID token uses an unsupported algorithm (${header.alg})`);

  const { keys } = (await (await fetcher(document.jwks_uri)).json()) as { keys: Jwk[] };
  const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
  if (!candidates.length) throw new Error('The provider published no key matching this token');

  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, 'base64url');
  const valid = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return verifySignature(
        header.alg.startsWith('ES') ? 'sha256' : algorithms[header.alg],
        signed,
        header.alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key,
        signature,
      );
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error('The ID token signature does not check out');

  if (claims.iss !== document.issuer) throw new Error('The ID token came from a different issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(env.oidc.clientId)) throw new Error('The ID token was issued for a different client');
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('The ID token has expired');
  if (nonce && claims.nonce !== nonce) throw new Error('The ID token answers a different sign-in attempt');
  if (!claims.sub) throw new Error('The ID token identifies nobody');

  return claims;
}

/**
 * The email to match a Kolibri account on.
 *
 * An unverified email from the provider is refused: matching on it would let
 * anybody who can set their own address at the provider take over an existing
 * account here. Providers that omit `email_verified` entirely are trusted,
 * because several do and refusing them would mean refusing them all.
 */
export function emailFrom(claims: Claims): string {
  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email) throw new Error('The provider did not say which email address this is');
  if (claims.email_verified === false) throw new Error('The provider has not verified that email address');
  return email;
}

export const nameFrom = (claims: Claims): string =>
  String(claims.name || claims.preferred_username || claims.email || 'Someone').slice(0, 120);
