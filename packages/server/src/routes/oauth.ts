/**
 * OAuth 2.1, just enough of it to be a connector.
 *
 * Claude Code and any other client that can hold a header is served by an API
 * token: paste `Authorization: Bearer kol_…` and you are done. Claude on the
 * web cannot do that — a connector added at claude.ai has nowhere to put a
 * header, and signs in instead. So this instance has to be an OAuth
 * authorization server as well as a resource server, and the client has to be
 * able to discover all of it from one URL, because that URL is the only thing
 * somebody pastes.
 *
 * Four requirements shape everything here:
 *
 * - **Discovery.** `/.well-known/oauth-protected-resource` says which
 *   authorization server guards `/mcp`; `/.well-known/oauth-authorization-server`
 *   says where to send somebody and where to redeem the code. A 401 from `/mcp`
 *   carries `WWW-Authenticate` pointing at the first, so a client that arrives
 *   with nothing still finds its way.
 * - **Dynamic registration.** A remote client has no way to exist here before
 *   somebody pastes the URL, and there is no admin in the loop to approve it.
 *   Registration is therefore open — and grants nothing at all.
 * - **PKCE, S256 only.** These clients are public and cannot keep a secret.
 *   The proof that whoever redeems a code is whoever asked for it is the
 *   verifier, so a request without a challenge is refused rather than
 *   downgraded.
 * - **A person in the middle.** Nothing is granted without somebody signed in
 *   here pressing Allow, on a page that names the client and what it may do.
 *
 * What comes out is an ordinary API token. That is deliberate: it appears in
 * Settings beside the hand-made ones and the same Revoke button stops it, so
 * there is one place to look and one thing to press.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { buildCsp } from '../lib/csp.ts';
import { authenticate, hashToken } from '../lib/auth.ts';
import { token, uid } from '../lib/ids.ts';
import { badRequest, HttpError, readJson, send, type Ctx, type Router } from '../lib/http.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';

/** How long a granted token lasts before the refresh token has to mint another. */
const ACCESS_TOKEN_MINUTES = 60;
const CODE_SECONDS = 60;

const origin = (ctx: Ctx): string => {
  if (env.publicUrl) return env.publicUrl;
  const proto = (ctx.req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim()
    || ((ctx.req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = (ctx.req.headers['x-forwarded-host'] as string) || ctx.req.headers.host || 'localhost';
  return `${proto}://${host}`;
};

/** The thing a token is for, in the one spelling everybody has to agree on. */
export const resourceUrl = (ctx: Ctx): string => `${origin(ctx)}/mcp`;

const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Render a page, and let its form reach where it has to.
 *
 * The instance sends `form-action 'self'` on everything, which is right for an
 * app that never posts anywhere else — and wrong for exactly this page. Pressing
 * Allow posts here and is then redirected to the client's callback, and a
 * browser checks `form-action` against the *redirect target* too: without the
 * client's origin named, Chrome refuses to send the form at all and the flow
 * stops on a page that looks fine. Which is how this was found, and why the
 * walkthrough clicks the button in a real browser rather than posting the form
 * with fetch.
 *
 * Only the origin of a redirect URI the client actually registered is added, so
 * this widens the policy by exactly the one address the consent is about.
 */
const html = (ctx: Ctx, status: number, body: string, formTarget?: string): void => {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (formTarget) {
    try {
      headers['content-security-policy'] = `${buildCsp(env.storage).replace("form-action 'self'", `form-action 'self' ${new URL(formTarget).origin}`)}`;
    } catch {
      /* not a URL we can widen for; the default policy stands */
    }
  }
  ctx.res.writeHead(status, headers);
  ctx.res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body}`);
};

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * A redirect URI is only allowed if the client registered it.
 *
 * Compared whole rather than by prefix. A prefix match is how an open redirect
 * gets built by accident: `https://claude.ai/` would also match a path somebody
 * else controls on the same host.
 */
const registered = (client: Row, uri: string): boolean => {
  try {
    return (JSON.parse(client.redirect_uris) as string[]).includes(uri);
  } catch {
    return false;
  }
};

const page = (title: string, body: string): string => `
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #f6f7f9; color: #14161a; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e8eaee; } .box { background: #171a20 !important; border-color: #2a2f39 !important; } .muted { color: #98a0ad !important; } }
  .box { width: min(420px, 100%); background: #fff; border: 1px solid #e3e6ec; border-radius: 14px; padding: 26px 22px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .muted { color: #667085; font-size: 13px; }
  ul { padding-inline-start: 18px; margin: 14px 0; font-size: 13.5px; }
  li { margin: 4px 0; }
  button, .btn { display: block; width: 100%; box-sizing: border-box; padding: 11px 14px; border-radius: 9px; font-size: 14px; font-weight: 550; cursor: pointer; text-align: center; text-decoration: none; }
  .primary { background: #5b5bd6; color: #fff; border: none; }
  .plain { background: none; border: 1px solid #d6dae2; color: inherit; margin-top: 8px; }
  code { font-family: ui-monospace, monospace; font-size: 12.5px; }
</style>
<div class="box">${body}</div>`;

export function registerOAuthRoutes(router: Router): void {
  /* ------------------------------------------------------------- discovery */

  /**
   * What guards `/mcp` (RFC 9728). Served at both the bare path and the one
   * with the resource's path appended, because clients differ on which they
   * ask for and a 404 here ends the flow before it starts.
   */
  const protectedResource = (ctx: Ctx) => ({
    resource: resourceUrl(ctx),
    authorization_servers: [origin(ctx)],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin(ctx)}/mcp`,
  });
  router.get('/.well-known/oauth-protected-resource', protectedResource);
  router.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const authorizationServer = (ctx: Ctx) => ({
    issuer: origin(ctx),
    authorization_endpoint: `${origin(ctx)}/oauth/authorize`,
    token_endpoint: `${origin(ctx)}/oauth/token`,
    registration_endpoint: `${origin(ctx)}/oauth/register`,
    revocation_endpoint: `${origin(ctx)}/oauth/revoke`,
    scopes_supported: ['read', 'write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 and nothing else. `plain` is a downgrade that a public client has no
    // reason to want, so it is not offered.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
  router.get('/.well-known/oauth-authorization-server', authorizationServer);
  router.get('/.well-known/oauth-authorization-server/mcp', authorizationServer);

  /* ---------------------------------------------------------- registration */

  router.post('/oauth/register', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.oauthClient, 'oauth-register'));
    const body = await readJson<ClientMetadata>(ctx);
    const uris = (body.redirect_uris ?? []).filter((uri) => typeof uri === 'string' && /^https:\/\//.test(uri));
    // `http://localhost` is allowed because that is where a desktop client's
    // loopback callback lives, and refusing it would rule out every editor.
    const local = (body.redirect_uris ?? []).filter((uri) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(uri));
    const all_ = [...uris, ...local];
    // RFC 7591's own code, not a generic one: a client that gets this back can
    // say which field it got wrong instead of "registration failed".
    if (!all_.length) {
      throw new HttpError(400, 'redirect_uris must contain at least one https or loopback URI', 'invalid_redirect_uri');
    }

    pruneClients();

    const id = `kc_${token(16)}`;
    run(
      `INSERT INTO oauth_clients (id, name, redirect_uris, uri, created_at) VALUES (?, ?, ?, ?, ?)`,
      id, String(body.client_name ?? 'An assistant').slice(0, 120), JSON.stringify(all_), body.client_uri ?? null, Date.now(),
    );
    /*
     * RFC 7591 asks for the client's *registered metadata* back, not just an
     * id: "the authorization server MUST return all registered metadata about
     * this client". This used to answer with six fields of its own invention
     * and silently drop everything the client had sent — its scope above all.
     *
     * A client that asks for a scope and is told nothing about scope has not
     * been told yes. Echoing what was accepted, and the values this server
     * substituted where it would not take what was asked for, is how the client
     * learns which of the two happened.
     */
    send(ctx.res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name ?? 'An assistant',
      redirect_uris: all_,
      // Substituted, not echoed: a public client with no secret, and the two
      // grants this server implements, whatever was asked for.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Every client registered here may ask for either, and the consent screen
      // decides what it actually gets. Saying so beats saying nothing.
      scope: 'read write',
      ...echoed(body),
    });
    return undefined;
  });

/** The registration fields this server understands well enough to repeat. */
interface ClientMetadata {
  client_name?: string;
  redirect_uris?: string[];
  client_uri?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  contacts?: string[];
  software_id?: string;
  software_version?: string;
}

/**
 * The descriptive fields, handed back exactly as they arrived.
 *
 * None of them mean anything to this server — they are how a client names
 * itself to the person on the consent screen — but leaving them out of the
 * response makes it look like they were refused. Only strings, and only the
 * ones asked for, so a registration cannot smuggle a value of another type
 * into the reply.
 */
function echoed(body: ClientMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri', 'software_id', 'software_version'] as const) {
    if (typeof body[key] === 'string') out[key] = body[key];
  }
  if (Array.isArray(body.contacts)) out.contacts = body.contacts.filter((c) => typeof c === 'string');
  return out;
}

/**
 * The real bound on registration, which is rows rather than requests.
 *
 * Anyone may register a client — that is what dynamic registration means — so
 * the table is writable by the internet and something has to stop it growing
 * forever. Rate limiting is the wrong tool: it cannot tell a busy Monday
 * morning from an attack, and set tight enough to matter it locks out the
 * people it is meant to serve.
 *
 * So the cap is on what is left behind. A registration that has never been
 * used to get a token is worth nothing to anybody: it is either abandoned or
 * it was never real. Keep the newest `UNUSED_CLIENTS` of those and drop the
 * rest, oldest first. A client that has actually signed somebody in is never
 * touched, however old it is.
 */
const UNUSED_CLIENTS = 200;

function pruneClients(): void {
  run(
    `DELETE FROM oauth_clients
      WHERE last_used_at IS NULL
        AND id NOT IN (
          SELECT id FROM oauth_clients WHERE last_used_at IS NULL ORDER BY created_at DESC LIMIT ?
        )`,
    UNUSED_CLIENTS,
  );
}

  /* ------------------------------------------------------------- authorize */

  /**
   * The consent screen.
   *
   * Rendered by the server rather than the app, because it has to work in a
   * popup a client opened, with no router and no build step in the way. It
   * needs somebody signed in: if the browser has no session, it says so and
   * sends them to sign in with a way back, rather than showing a form that will
   * fail when they press it.
   */
  router.get('/oauth/authorize', (ctx: Ctx) => {
    const q = ctx.query;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const client = get<Row>(`SELECT * FROM oauth_clients WHERE id = ?`, clientId);

    // Two errors cannot be reported by redirecting, because the redirect target
    // is exactly what is not trustworthy yet. They are shown to the person.
    if (!client) {
      html(ctx, 400, page('Unknown client', `<h1>Unknown client</h1><p class="muted">This instance has no record of the app that sent you here. Ask it to register again.</p>`));
      return undefined;
    }
    if (!registered(client, redirectUri)) {
      html(ctx, 400, page('Wrong redirect', `<h1>That redirect is not registered</h1><p class="muted">The app asked to be sent back to <code>${escape(redirectUri)}</code>, which is not one of the addresses it registered.</p>`));
      return undefined;
    }

    const state = q.get('state') ?? '';
    const back = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (state) url.searchParams.set('state', state);
      ctx.res.writeHead(302, { location: url.toString(), 'cache-control': 'no-store' });
      ctx.res.end();
    };

    if ((q.get('response_type') ?? '') !== 'code') return void back('unsupported_response_type', 'Only the authorization code flow is supported');
    if ((q.get('code_challenge_method') ?? '') !== 'S256' || !q.get('code_challenge')) {
      return void back('invalid_request', 'PKCE with S256 is required');
    }

    const auth = authenticate(ctx);
    const self = `${origin(ctx)}/oauth/authorize?${q.toString()}`;
    if (!auth) {
      html(ctx, 200, page('Sign in first', `
        <h1>Sign in to ${escape(hostOf(origin(ctx)))}</h1>
        <p class="muted">${escape(client.name || 'An assistant')} is asking for access to your workspace. Sign in here first, and you will come straight back to this page.</p>
        <a class="btn primary" href="/?next=${encodeURIComponent(self.replace(origin(ctx), ''))}" style="margin-top:16px">Sign in</a>`));
      return undefined;
    }

    const workspaces = all<Row>(
      `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.deleted_at IS NULL ORDER BY w.name`,
      auth.userId,
    );
    const user = get<Row>(`SELECT name, email FROM users WHERE id = ?`, auth.userId);
    const wants = (q.get('scope') ?? 'read write').split(/[\s,]+/).filter(Boolean);
    const write = wants.includes('write');

    html(ctx, 200, page(`Connect ${client.name || 'an assistant'}`, `
      <h1>${escape(client.name || 'An assistant')} wants access</h1>
      <p class="muted">Signed in as ${escape(String(user?.name ?? ''))} &lt;${escape(String(user?.email ?? ''))}&gt;</p>
      <ul>
        <li>Read your projects, tasks, pages and time</li>
        ${write ? '<li>Create and change tasks, pages and comments as you</li>' : '<li class="muted">No writing — this is a read-only connection</li>'}
        <li class="muted">Only what you can already see. Private projects you are not in stay invisible.</li>
      </ul>
      <form method="post" action="/oauth/authorize">
        ${[...q.entries()].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('')}
        ${workspaces.length > 1 ? `<label class="muted" for="ws">Workspace</label>
        <select id="ws" name="workspace_id" style="width:100%;padding:9px;border-radius:9px;margin:4px 0 14px;font-size:14px">
          ${workspaces.map((w) => `<option value="${escape(String(w.id))}">${escape(String(w.name))}</option>`).join('')}
        </select>` : `<input type="hidden" name="workspace_id" value="${escape(String(workspaces[0]?.id ?? ''))}">`}
        <button class="primary" type="submit" name="decision" value="allow">Allow</button>
        <button class="plain" type="submit" name="decision" value="deny">Cancel</button>
      </form>
      <p class="muted" style="margin-top:14px">You can revoke this at any time in Settings &rarr; API &amp; MCP.</p>`), redirectUri);
    return undefined;
  });

  router.post('/oauth/authorize', async (ctx: Ctx) => {
    const form = await readForm(ctx);
    const clientId = form.get('client_id') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const client = get<Row>(`SELECT * FROM oauth_clients WHERE id = ?`, clientId);
    if (!client || !registered(client, redirectUri)) throw badRequest('Unknown client or redirect');

    const state = form.get('state') ?? '';
    const url = new URL(redirectUri);
    if (state) url.searchParams.set('state', state);

    const auth = authenticate(ctx);
    if (!auth) throw badRequest('Sign in and try again');
    if (form.get('decision') !== 'allow') {
      url.searchParams.set('error', 'access_denied');
      ctx.res.writeHead(302, { location: url.toString(), 'cache-control': 'no-store' });
      ctx.res.end();
      return undefined;
    }

    const workspaceId = form.get('workspace_id') || null;
    if (workspaceId && !get(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`, workspaceId, auth.userId)) {
      throw badRequest('You are not in that workspace');
    }
    const wants = (form.get('scope') ?? 'read write').split(/[\s,]+/).filter(Boolean);
    const scopes = wants.includes('write') ? 'read,write' : 'read';

    const code = token(24);
    run(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, workspace_id, redirect_uri, challenge, scopes, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hashToken(code), clientId, auth.userId, workspaceId, redirectUri, form.get('code_challenge') ?? '',
      scopes, form.get('resource') ?? null, Date.now(), Date.now() + CODE_SECONDS * 1000,
    );
    run(`UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`, Date.now(), clientId);

    url.searchParams.set('code', code);
    ctx.res.writeHead(302, { location: url.toString(), 'cache-control': 'no-store' });
    ctx.res.end();
    return undefined;
  });

  /* ----------------------------------------------------------------- token */

  router.post('/oauth/token', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.login, 'oauth-token'));
    const form = await readForm(ctx);
    const grant = form.get('grant_type') ?? '';

    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const row = get<Row>(`SELECT * FROM api_tokens WHERE refresh_hash = ? AND revoked_at IS NULL`, hashToken(presented));
      if (!row) return void oauthError(ctx, 400, 'invalid_grant', 'That refresh token is not valid');
      // Rotated: the old refresh token stops working the moment it is used, so
      // a leaked copy is worth one race and then nothing.
      const issued = issue(String(row.user_id), row.workspace_id as string | null, String(row.scopes), String(row.client_id ?? ''), String(row.name));
      run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`, Date.now(), row.id);
      send(ctx.res, 200, issued, { 'cache-control': 'no-store' });
      return undefined;
    }

    if (grant !== 'authorization_code') return void oauthError(ctx, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');

    const code = form.get('code') ?? '';
    const row = get<Row>(`SELECT * FROM oauth_codes WHERE code_hash = ?`, hashToken(code));
    // Single use, whatever happens next: read it and delete it.
    if (row) run(`DELETE FROM oauth_codes WHERE code_hash = ?`, row.code_hash);
    if (!row || Number(row.expires_at) < Date.now()) return void oauthError(ctx, 400, 'invalid_grant', 'That code has expired or was already used');
    if (row.client_id !== (form.get('client_id') ?? '')) return void oauthError(ctx, 400, 'invalid_grant', 'That code belongs to another client');
    if (row.redirect_uri !== (form.get('redirect_uri') ?? '')) return void oauthError(ctx, 400, 'invalid_grant', 'The redirect does not match the one the code was issued for');
    if (!equal(s256(form.get('code_verifier') ?? ''), String(row.challenge))) {
      return void oauthError(ctx, 400, 'invalid_grant', 'The PKCE verifier does not match');
    }

    const client = get<Row>(`SELECT name FROM oauth_clients WHERE id = ?`, row.client_id);
    const issued = issue(String(row.user_id), row.workspace_id as string | null, String(row.scopes), String(row.client_id), String(client?.name ?? 'An assistant'));
    send(ctx.res, 200, issued, { 'cache-control': 'no-store' });
    return undefined;
  });

  router.post('/oauth/revoke', async (ctx: Ctx) => {
    const form = await readForm(ctx);
    const presented = hashToken(form.get('token') ?? '');
    run(`UPDATE api_tokens SET revoked_at = ? WHERE (token_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL`, Date.now(), presented, presented);
    // A revocation endpoint answers 200 either way; saying "no such token"
    // would turn it into a way to ask whether one exists.
    send(ctx.res, 200, {});
    return undefined;
  });
}

/** Mint the access token and the refresh token that replaces it. */
function issue(userId: string, workspaceId: string | null, scopes: string, clientId: string, clientName: string): Record<string, unknown> {
  const access = `kol_${token(24)}`;
  const refresh = `kor_${token(24)}`;
  const now = Date.now();
  const expires = now + ACCESS_TOKEN_MINUTES * 60_000;
  run(
    `INSERT INTO api_tokens (id, user_id, workspace_id, name, token_hash, prefix, scopes, client_id, refresh_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid(), userId, workspaceId, clientName, hashToken(access), access.slice(0, 12), scopes, clientId, hashToken(refresh), now, expires,
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_MINUTES * 60,
    refresh_token: refresh,
    scope: scopes.split(',').join(' '),
  };
}

const oauthError = (ctx: Ctx, status: number, error: string, description: string): void => {
  send(ctx.res, status, { error, error_description: description }, { 'cache-control': 'no-store' });
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Read a form body.
 *
 * The token endpoint takes `application/x-www-form-urlencoded` — that is what
 * OAuth says and what every client sends — and the consent form posts the same
 * way. JSON is accepted too, because some clients send it anyway and refusing
 * would be a puzzle rather than a rule.
 */
async function readForm(ctx: Ctx): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(ctx.req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) params.set(key, String(value));
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}
