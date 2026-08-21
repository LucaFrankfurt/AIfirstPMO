/**
 * Signing in an assistant that cannot hold a header.
 *
 * Claude Code pastes an API token and is done. A connector added on the web has
 * nowhere to put one, so this instance has to be an OAuth authorization server
 * as well as a resource server — and the client has to find all of it starting
 * from the single URL somebody pasted.
 *
 * These tests walk that path in order, because the path *is* the feature: an
 * unauthenticated call to `/mcp`, the `WWW-Authenticate` it comes back with,
 * the two metadata documents, registering a client nobody has heard of,
 * somebody pressing Allow, the code, the token, and a tool call with it. Then
 * the refusals, which are the half that matters: a code is single use, a
 * verifier that does not match is not a verifier, and a redirect the client
 * never registered is not a redirect.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-oauth-${process.pid}`;

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let clientId = '';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const json = async (path: string, body?: unknown, method?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
};

const form = async (path: string, fields: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, location: response.headers.get('location') ?? '', body: parsed };
};

/** The query a client sends to the consent screen. */
const authorizeQuery = (over: Record<string, string> = {}) => new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'read write',
  state: 'abc123',
  resource: `${base}/mcp`,
  ...over,
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' }),
  });
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  workspaceId = ((await response.json()) as any).workspaces[0].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('finding the way in from nothing but a URL', () => {
  it('answers an unauthenticated MCP call with where to sign in', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
    const header = response.headers.get('www-authenticate') ?? '';
    assert.match(header, /^Bearer /);
    assert.match(header, /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/,
      'without this a client that arrives with nothing has nowhere to go');
  });

  it('says which authorization server guards the resource', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const { status, body } = await json(path);
      assert.equal(status, 200, `${path} has to answer — clients differ on which one they ask for`);
      assert.equal(body.resource, `${base}/mcp`);
      assert.deepEqual(body.authorization_servers, [base]);
    }
  });

  it('publishes the endpoints, and offers no way round PKCE', async () => {
    const { body } = await json('/.well-known/oauth-authorization-server');
    assert.equal(body.issuer, base);
    assert.equal(body.authorization_endpoint, `${base}/oauth/authorize`);
    assert.equal(body.token_endpoint, `${base}/oauth/token`);
    assert.equal(body.registration_endpoint, `${base}/oauth/register`);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256'], 'plain is a downgrade nobody here needs');
    assert.deepEqual(body.grant_types_supported, ['authorization_code', 'refresh_token']);
  });

  it('lets a client nobody has heard of register itself', async () => {
    resetRateLimits();
    const { status, body } = await json('/oauth/register', {
      client_name: 'Claude', redirect_uris: [REDIRECT],
    });
    assert.equal(status, 201);
    assert.ok(body.client_id, 'a remote client cannot exist here any other way');
    clientId = body.client_id;
  });

  /**
   * RFC 7591 §3.2.1: "the authorization server MUST return all registered
   * metadata about this client".
   *
   * This used to answer with six fields of its own invention and drop
   * everything the client sent — its `scope` above all. A client that asks for
   * a scope and is told nothing about scope has not been told yes, and a strict
   * one reads the silence as a refusal. The descriptive fields matter for a
   * duller reason: they are how a client names itself on the consent screen,
   * and leaving them out of the reply makes them look rejected.
   */
  it('hands back the metadata it registered, not just an id', async () => {
    resetRateLimits();
    const { status, body } = await json('/oauth/register', {
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      scope: 'claudeai',
      client_uri: 'https://claude.ai',
      logo_uri: 'https://claude.ai/icon.png',
      policy_uri: 'https://anthropic.com/legal/privacy',
      tos_uri: 'https://anthropic.com/legal/consumer-terms',
      software_id: 'claude-web',
      software_version: '1.0',
      contacts: ['support@anthropic.com'],
    });
    assert.equal(status, 201);

    // Echoed exactly: this server has no opinion about any of them.
    assert.equal(body.client_uri, 'https://claude.ai');
    assert.equal(body.logo_uri, 'https://claude.ai/icon.png');
    assert.equal(body.policy_uri, 'https://anthropic.com/legal/privacy');
    assert.equal(body.tos_uri, 'https://anthropic.com/legal/consumer-terms');
    assert.equal(body.software_id, 'claude-web');
    assert.equal(body.software_version, '1.0');
    assert.deepEqual(body.contacts, ['support@anthropic.com']);

    // Substituted, and said out loud: `claudeai` is not a scope this server
    // has, so it registers the two it does rather than staying silent.
    assert.equal(body.scope, 'read write');
    assert.equal(body.token_endpoint_auth_method, 'none');
    assert.ok(typeof body.client_id_issued_at === 'number');
  });

  it('does not let a registration smuggle a value of the wrong type into the reply', async () => {
    resetRateLimits();
    const { body } = await json('/oauth/register', {
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      logo_uri: { nested: 'object' },
      contacts: ['ok@example.com', 42],
    });
    assert.equal(body.logo_uri, undefined, 'only strings come back');
    assert.deepEqual(body.contacts, ['ok@example.com']);
  });

  it('refuses to register a redirect that is neither https nor loopback', async () => {
    const { status, body } = await json('/oauth/register', { client_name: 'Sketchy', redirect_uris: ['http://example.com/cb'] });
    assert.equal(status, 400);
    // RFC 7591's own code, so a client can say which field was wrong instead
    // of reporting "registration failed" and leaving nobody any the wiser.
    assert.equal(body.error, 'invalid_redirect_uri');
  });

  /**
   * The registration endpoint is not a login endpoint, and treating it as one
   * broke the connector.
   *
   * Claude on the web registers a fresh client for every connection, and all of
   * them arrive from a handful of shared egress addresses. The old allowance
   * was five per two minutes for the whole instance, so the fourth person to
   * connect was refused — and because a refusal cost a token too, retrying
   * drove the bucket to `-burst` and turned the promised two-minute wait into
   * twenty. The symptom was "registration with Kolibri's authorization service
   * failed", however many times you tried.
   */
  it('lets a plausible morning of connections through', async () => {
    resetRateLimits();
    let created = 0;
    for (let i = 0; i < 25; i++) {
      const { status } = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT] });
      if (status === 201) created++;
    }
    assert.equal(created, 25, 'twenty-five people connecting is not an attack');
  });

  it('keeps the wait it promises, however often it is asked', async () => {
    resetRateLimits();
    // Empty the bucket.
    let refusal: { status: number; body: any } | null = null;
    for (let i = 0; i < 40 && !refusal; i++) {
      const attempt = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT] });
      if (attempt.status === 429) refusal = attempt;
    }
    assert.ok(refusal, 'the limit still exists');

    // Ask ten more times. On a limit that deepens, this is what turned two
    // minutes into twenty; here it must leave the promise exactly where it was.
    for (let i = 0; i < 10; i++) await json('/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT] });

    const { rateLimitInternals } = await import('../src/lib/ratelimit.ts');
    const bucket = [...rateLimitInternals.buckets.entries()]
      .find(([key]) => key.startsWith('oauth-register:'))?.[1];
    assert.ok(bucket, 'the bucket is there to look at');
    assert.ok(bucket.tokens > -1, `hammering must not dig deeper, tokens were ${bucket.tokens}`);
  });

  /**
   * What actually bounds registration: rows, not requests.
   *
   * Anyone may register — that is what dynamic registration means — so the
   * table is writable by the internet. A registration that was never used to
   * get a token is worth nothing to anybody, so only the newest few hundred of
   * those are kept. One that has signed somebody in is never touched.
   */
  it('caps the registrations nobody ever used, and keeps the ones that worked', async () => {
    resetRateLimits();
    const { run, get } = await import('../src/db/index.ts');
    const count = (where: string) => get<{ n: number }>(`SELECT count(*) AS n FROM oauth_clients WHERE ${where}`)!.n;

    // Old enough to be at the front of the queue for pruning, so nothing this
    // file registered earlier is at risk. Three of them have signed somebody
    // in; those must survive being the oldest rows in the table.
    for (let i = 0; i < 260; i++) {
      run(
        `INSERT INTO oauth_clients (id, name, redirect_uris, uri, created_at, last_used_at) VALUES (?, 'filler', '[]', NULL, ?, ?)`,
        `kc_filler_${i}`, i, i < 3 ? 1 : null,
      );
    }
    assert.ok(count('last_used_at IS NULL') > 201, 'the cap is about to matter');

    const { status } = await json('/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT] });
    assert.equal(status, 201);

    assert.ok(count('last_used_at IS NULL') <= 201, `unused registrations are capped, found ${count('last_used_at IS NULL')}`);
    assert.equal(count(`id LIKE 'kc_filler_%' AND last_used_at IS NOT NULL`), 3,
      'a client that has actually signed somebody in is never pruned');
  });
});

describe('the consent screen', () => {
  it('asks somebody who is not signed in to sign in, with a way back', async () => {
    const was = cookie;
    cookie = '';
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery()}`, { redirect: 'manual' });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /next=%2Foauth%2Fauthorize/, 'a sign-in that forgets where you were going is a dead end');
    cookie = was;
  });

  it('names the client and what it may do', async () => {
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery()}`, { headers: { cookie }, redirect: 'manual' });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Claude/);
    assert.match(body, /Create and change tasks/, 'write access has to be said out loud');
    assert.match(body, /Allow/);
  });

  it('lets the form reach the client, which the instance-wide policy would not', async () => {
    // `form-action 'self'` is right for the app and wrong for exactly this
    // page: pressing Allow posts here and is then redirected to the client, and
    // a browser checks form-action against the redirect target too. Without the
    // client's origin named, Chrome refuses to send the form and the flow stops
    // on a page that looks perfectly fine. It did, until a real browser tried.
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery()}`, { headers: { cookie } });
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /form-action 'self' https:\/\/claude\.ai(;|$)/);
    assert.match(policy, /default-src 'self'/, 'and the rest of the policy is untouched');
  });

  it('does not widen the policy for a page with no form on it', async () => {
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery({ client_id: 'kc_nope' })}`, { headers: { cookie } });
    assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'$/);
  });

  it('says read-only when that is what was asked for', async () => {
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery({ scope: 'read' })}`, { headers: { cookie } });
    assert.match(await response.text(), /read-only/);
  });

  it('shows an unknown client the door rather than redirecting to it', async () => {
    const response = await fetch(`${base}/oauth/authorize?${authorizeQuery({ client_id: 'kc_nope' })}`, { headers: { cookie } });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Unknown client/);
  });

  it('refuses a redirect the client never registered — without redirecting to it', async () => {
    const response = await fetch(
      `${base}/oauth/authorize?${authorizeQuery({ redirect_uri: 'https://evil.example/steal' })}`,
      { headers: { cookie }, redirect: 'manual' },
    );
    assert.equal(response.status, 400, 'reporting this by redirect would be the open redirect itself');
    assert.equal(response.headers.get('location'), null);
  });

  it('refuses a request with no PKCE, by telling the client rather than the person', async () => {
    const query = authorizeQuery();
    query.delete('code_challenge');
    const response = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') ?? '', /error=invalid_request/);
  });
});

describe('the code, and the token it becomes', () => {
  let code = '';
  let refresh = '';

  it('hands back a code when somebody presses Allow', async () => {
    const { status, location } = await form('/oauth/authorize', {
      ...Object.fromEntries(authorizeQuery()), workspace_id: workspaceId, decision: 'allow',
    });
    assert.equal(status, 302);
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get('state'), 'abc123', 'state comes back or the client cannot match it up');
    code = url.searchParams.get('code') ?? '';
    assert.ok(code);
  });

  it('gives nothing to a verifier that does not match the challenge', async () => {
    const { status, body } = await form('/oauth/token', {
      grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT,
      code_verifier: 'not-the-verifier',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_grant');
  });

  it('...and that attempt burns the code, because a code is single use', async () => {
    const { status, body } = await form('/oauth/token', {
      grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_grant');
  });

  it('exchanges a fresh code for a token that works on /mcp', async () => {
    const granted = await form('/oauth/authorize', {
      ...Object.fromEntries(authorizeQuery()), workspace_id: workspaceId, decision: 'allow',
    });
    const fresh = new URL(granted.location).searchParams.get('code') ?? '';

    const { status, body } = await form('/oauth/token', {
      grant_type: 'authorization_code', code: fresh, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
    });
    assert.equal(status, 200);
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.scope, 'read write');
    assert.ok(body.expires_in > 0);
    refresh = body.refresh_token;

    const call = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(call.status, 200);
    const tools = ((await call.json()) as any).result.tools;
    assert.ok(tools.length > 10, 'the point of all of this is that the tools are reachable');
  });

  it('refreshes, and the old refresh token stops working when it does', async () => {
    const first = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    assert.equal(first.status, 200);
    assert.ok(first.body.access_token);
    assert.notEqual(first.body.refresh_token, refresh, 'rotated, so a leaked copy is worth one race');

    const again = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    assert.equal(again.status, 400);
  });

  it('appears in Settings as an ordinary token, and Revoke stops it', async () => {
    const granted = await form('/oauth/authorize', {
      ...Object.fromEntries(authorizeQuery()), workspace_id: workspaceId, decision: 'allow',
    });
    const { body } = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code: new URL(granted.location).searchParams.get('code') ?? '',
      client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
    });

    const tokens = (await json('/api/tokens')).body as any[];
    const mine = tokens.find((row) => row.prefix === body.access_token.slice(0, 12));
    assert.ok(mine, 'a connector is a token, and it is listed where tokens are listed');
    assert.equal(mine.name, 'Claude');

    await json(`/api/tokens/${mine.id}`, undefined, 'DELETE');
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(after.status, 401, 'one Revoke button, and it means it');
  });
});
