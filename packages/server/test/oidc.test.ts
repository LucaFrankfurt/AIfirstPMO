/**
 * Single sign-on.
 *
 * Driven against a real identity provider — a small one, running in this
 * process, signing real RS256 tokens with a real JWKS. Mocking the verifier
 * would test that the mock agrees with itself; the point of every check here
 * is that a *forged* token is refused, and a forgery has to be built to prove
 * that.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-oidc-${process.pid}`;

import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

/* -------------------------------------------------- the identity provider */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

let issuer = '';
/** What the provider will say about the next person to sign in. */
let identity: Record<string, unknown> = { sub: 'user-1', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace' };
let lastAuthorize: URL | null = null;
const codes = new Map<string, { nonce: string; challenge: string }>();

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function signToken(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header });
  const body = b64(payload);
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const claimsFor = (nonce: string, overrides: Record<string, unknown> = {}) => ({
  iss: issuer,
  aud: 'kolibri-test',
  sub: 'user-1',
  nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  ...identity,
  ...overrides,
});

const provider = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', issuer);
  const send = (body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  if (url.pathname === '/.well-known/openid-configuration') {
    return send({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  }
  if (url.pathname === '/jwks') return send({ keys: [jwk] });

  if (url.pathname === '/authorize') {
    lastAuthorize = url;
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '' });
    // Straight back to Kolibri, as a provider would after the person consents.
    response.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` }).end();
    return;
  }

  if (url.pathname === '/token') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const record = codes.get(form.get('code') ?? '');
      if (!record) return send({ error: 'invalid_grant' }, 400);
      codes.delete(form.get('code') ?? '');

      // PKCE, checked for real: the verifier must hash to the challenge sent
      // at the start, or this is somebody else replaying the code.
      const verifier = form.get('code_verifier') ?? '';
      const hashed = createHash('sha256').update(verifier).digest('base64url');
      if (hashed !== record.challenge) return send({ error: 'invalid_grant' }, 400);
      if (form.get('client_secret') !== 'shh') return send({ error: 'invalid_client' }, 401);

      return send({ id_token: signToken(claimsFor(record.nonce)), token_type: 'Bearer' });
    });
    return;
  }
  send({ error: 'not_found' }, 404);
});

/* --------------------------------------------------------------- Kolibri */

let base = '';
let server: any;
let oidc: typeof import('../src/adapters/oauth/oidc.ts');

before(async () => {
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  // The env is read at module load, so it is set before Kolibri is imported.
  process.env.KOLIBRI_OIDC_ISSUER = issuer;
  process.env.KOLIBRI_OIDC_CLIENT_ID = 'kolibri-test';
  process.env.KOLIBRI_OIDC_CLIENT_SECRET = 'shh';

  ({ server } = await import('../src/index.ts'));
  oidc = await import('../src/adapters/oauth/oidc.ts');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KOLIBRI_PUBLIC_URL = base;
});

after(() => {
  server.close();
  provider.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/** Walk the whole flow the way a browser would, following redirects by hand. */
async function signIn(): Promise<{ status: number; location: string; cookie: string }> {
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location')!, { redirect: 'manual' });
  return {
    status: callback.status,
    location: callback.headers.get('location') ?? '',
    cookie: (callback.headers.get('set-cookie') ?? '').split(';')[0],
  };
}

describe('signing in through a provider', () => {
  it('makes an account the first time and reuses it after', async () => {
    const first = await signIn();
    assert.equal(first.status, 302);
    assert.equal(first.location, '/', 'and lands in the app rather than on an error');
    assert.ok(first.cookie.startsWith('kolibri_session='), 'with a Kolibri session of its own');

    const session: any = await (await fetch(`${base}/api/session`, { headers: { cookie: first.cookie } })).json();
    assert.equal(session.user.email, 'ada@example.com');
    assert.equal(session.workspaces.length, 1, 'and a workspace to work in');

    const second = await signIn();
    const again: any = await (await fetch(`${base}/api/session`, { headers: { cookie: second.cookie } })).json();
    assert.equal(again.user.id, session.user.id, 'the same person, not a second account');
  });

  it('asks for PKCE and a nonce, and never puts a token in a URL', async () => {
    await signIn();
    assert.ok(lastAuthorize, 'the provider was actually visited');
    assert.equal(lastAuthorize!.searchParams.get('response_type'), 'code', 'not implicit');
    assert.equal(lastAuthorize!.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(lastAuthorize!.searchParams.get('code_challenge'));
    assert.ok(lastAuthorize!.searchParams.get('nonce'));
    assert.ok(lastAuthorize!.searchParams.get('state'));
  });

  it('cannot sign in with a password, because that account has none', async () => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: '' }),
    });
    assert.equal(response.status, 401);
  });
});

describe('refusing a token that is not right', () => {
  const document = () => oidc.discover();

  it('refuses one signed by somebody else', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
    const body = b64(claimsFor('n'));
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(other.privateKey).toString('base64url');
    const found = await document();
    await assert.rejects(() => oidc.verifyIdToken(found, `${head}.${body}.${signature}`, 'n'), /signature/i);
  });

  it('refuses `alg: none`, the oldest forgery there is', async () => {
    const found = await document();
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claimsFor('n'))}.`;
    await assert.rejects(() => oidc.verifyIdToken(found, token, 'n'), /algorithm|JWT/i);
  });

  it('refuses one issued for a different client', async () => {
    const found = await document();
    await assert.rejects(
      () => oidc.verifyIdToken(found, signToken(claimsFor('n', { aud: 'somebody-else' })), 'n'),
      /different client/i,
    );
  });

  it('refuses one from a different issuer', async () => {
    const found = await document();
    await assert.rejects(
      () => oidc.verifyIdToken(found, signToken(claimsFor('n', { iss: 'https://evil.example' })), 'n'),
      /different issuer/i,
    );
  });

  it('refuses an expired one', async () => {
    const found = await document();
    const expired = claimsFor('n', { exp: Math.floor(Date.now() / 1000) - 60 });
    await assert.rejects(() => oidc.verifyIdToken(found, signToken(expired), 'n'), /expired/i);
  });

  it('refuses one answering a different sign-in attempt', async () => {
    const found = await document();
    await assert.rejects(
      () => oidc.verifyIdToken(found, signToken(claimsFor('their-nonce')), 'my-nonce'),
      /different sign-in/i,
    );
  });

  it('refuses an email the provider has not verified', () => {
    // Otherwise anybody who can set their own address at the provider can take
    // over an existing Kolibri account by claiming its email.
    assert.throws(() => oidc.emailFrom({ email: 'ada@example.com', email_verified: false } as never), /not verified/i);
    assert.equal(oidc.emailFrom({ email: 'Ada@Example.com', email_verified: true } as never), 'ada@example.com');
    assert.equal(oidc.emailFrom({ email: 'a@b.c' } as never), 'a@b.c', 'a provider that omits the flag is trusted');
  });
});

describe('the state parameter', () => {
  it('is used once', async () => {
    const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const target = authorize.headers.get('location')!;

    const first = await fetch(target, { redirect: 'manual' });
    assert.equal(first.headers.get('location'), '/');

    // Replaying the exact callback URL must not produce a second session.
    const replay = await fetch(target, { redirect: 'manual' });
    assert.match(replay.headers.get('location') ?? '', /sso_error/);
    assert.equal((replay.headers.get('set-cookie') ?? '').includes('kolibri_session='), false);
  });

  it('sends somebody back into the app, never off the instance', () => {
    assert.equal(oidc.startFlow('/projects/abc').next, '/projects/abc');
    assert.equal(oidc.startFlow('https://evil.example').next, '/', 'an absolute URL is not a destination');
    assert.equal(oidc.startFlow('//evil.example').next, '/', 'nor a protocol-relative one');
  });
});

describe('an instance that is single sign-on only', () => {
  it('closes the password door for good', async () => {
    const { env } = await import('../src/kernel/platform/env.ts');
    env.oidc.only = true;
    try {
      const config: any = await (await fetch(`${base}/api/config`)).json();
      assert.equal(config.sso.only, true, 'and says so, so the form is not even drawn');

      const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });

      // Accounts made through the provider carry no password, but accounts
      // from before the switch do — and that password must stop working too.
      const login = await post('/api/auth/login', { email: 'ada@example.com', password: 'hunter2hunter2' });
      assert.equal(login.status, 403, 'a password is not a way in any more');

      const register = await post('/api/auth/register', { email: 'new@example.com', password: 'hunter2hunter2' });
      assert.equal(register.status, 403, 'and nobody can make one to get around it');

      assert.equal((await signIn()).status, 302, 'while the provider still lets people in');
    } finally {
      env.oidc.only = false;
    }
  });
});

describe('groups from the token', () => {
  it('reads an array, a space-separated string, and a nested path', async () => {
    const { groupsFrom } = oidc;
    assert.deepEqual(groupsFrom({ groups: ['admins', 'eng'] } as any, 'groups'), ['admins', 'eng']);
    assert.deepEqual(groupsFrom({ groups: 'admins eng' } as any, 'groups'), ['admins', 'eng'],
      'a provider that sends one string means a list, not a group with a space in it');
    assert.deepEqual(groupsFrom({ groups: 'admins,eng' } as any, 'groups'), ['admins', 'eng']);
    assert.deepEqual(
      groupsFrom({ resource_access: { kolibri: { roles: ['ops'] } } } as any, 'resource_access.kolibri.roles'),
      ['ops'],
      'Keycloak puts them three levels down and is not going to move them for us',
    );
    assert.deepEqual(groupsFrom({} as any, 'groups'), [], 'a token that says nothing says nothing');
    assert.deepEqual(groupsFrom({ groups: 42 } as any, 'groups'), [], 'and neither does a number');
  });

  it('takes the highest role of every group somebody is in', () => {
    const map = oidc.parseRoleMap('admins=admin, engineering=member, contractors=guest');
    assert.equal(oidc.roleFor(['engineering', 'admins'], map), 'admin',
      'access is the union of what somebody has been given');
    assert.equal(oidc.roleFor(['ADMINS'], map), 'admin', 'group names are compared case-insensitively');
    assert.equal(oidc.roleFor(['nobody-knows'], map), null, 'an unmapped group asks for nothing');
    assert.equal(oidc.roleFor(['admins'], new Map()), null, 'and with no map, nothing is asked at all');
  });

  it('skips a pair somebody typed wrong rather than inventing a role', () => {
    const map = oidc.parseRoleMap('admins=admin, broken, eng=wizard, =member, spare=');
    assert.deepEqual([...map], [['admins', 'admin']]);
  });
});

describe('a role the directory decides', () => {
  before(async () => {
    const { env } = await import('../src/kernel/platform/env.ts');
    env.oidc.roleMap = 'kolibri-admins=admin, kolibri-users=member';
    env.oidc.groupsClaim = 'groups';
  });

  after(async () => {
    const { env } = await import('../src/kernel/platform/env.ts');
    env.oidc.roleMap = '';
    identity = { sub: 'user-1', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace' };
  });

  const roleOf = async (email: string) => {
    const { get } = await import('../src/kernel/platform/db/index.ts');
    return get<any>(
      `SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE u.email = ? AND m.deleted_at IS NULL LIMIT 1`,
      email,
    )?.role;
  };

  it('promotes somebody the provider says is an admin', async () => {
    identity = { sub: 'lin', email: 'lin@example.com', email_verified: true, name: 'Lin', groups: ['kolibri-users'] };
    assert.equal((await signIn()).status, 302);
    assert.equal(await roleOf('lin@example.com'), 'member');

    identity = { ...identity, groups: ['kolibri-users', 'kolibri-admins'] };
    await signIn();
    assert.equal(await roleOf('lin@example.com'), 'admin', 'a group added in the directory is access added here');
  });

  it('joins the workspace that is already here instead of starting a private one', async () => {
    const { all, get } = await import('../src/kernel/platform/db/index.ts');
    const workspaces = all<any>(`SELECT id FROM workspaces WHERE deleted_at IS NULL`);
    assert.equal(workspaces.length, 1, 'one instance, one workspace — which is the case this handles');

    const lin = get<any>(`SELECT id FROM users WHERE email = 'lin@example.com'`);
    const membership = get<any>(
      `SELECT workspace_id FROM workspace_members WHERE user_id = ? AND deleted_at IS NULL`, lin.id,
    );
    assert.equal(
      membership.workspace_id, workspaces[0].id,
      'a company directory pointed at one workspace means that workspace, not one empty one per colleague',
    );
  });

  it('demotes when the group is taken away, or the map is decoration', async () => {
    identity = { sub: 'lin', email: 'lin@example.com', email_verified: true, name: 'Lin', groups: ['kolibri-users'] };
    await signIn();
    assert.equal(await roleOf('lin@example.com'), 'member');
  });

  it('never demotes the last owner of a workspace, whatever the directory says', async () => {
    // Ada made the instance and owns her workspace alone.
    identity = { sub: 'user-1', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace', groups: ['kolibri-users'] };
    await signIn();
    assert.equal(await roleOf('ada@example.com'), 'owner', 'a misspelt group costs an afternoon, not the instance');
  });

  it('refuses somebody in no mapped group when the default is none', async () => {
    const { env } = await import('../src/kernel/platform/env.ts');
    env.oidc.defaultRole = 'none';
    try {
      identity = { sub: 'mallory', email: 'mallory@example.com', email_verified: true, name: 'Mallory', groups: ['some-other-app'] };
      const result = await signIn();
      assert.equal(result.status, 302);
      assert.match(result.location, /sso_error/, 'sent back with a reason rather than let in');
      assert.equal(await roleOf('mallory@example.com'), undefined, 'and no account was made');
    } finally {
      env.oidc.defaultRole = 'member';
    }
  });
});
