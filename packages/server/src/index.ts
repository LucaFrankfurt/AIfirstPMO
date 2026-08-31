import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { close, currentSeq, run } from './kernel/platform/db/index.ts';
import { env } from './kernel/platform/env.ts';
import { authenticate } from './kernel/identity/auth.ts';
import { startMailWorker, stopMailWorker } from './adapters/mail/mail.ts';
import { startScheduler, stopScheduler } from './modules/automation/scheduler.ts';
import { startTelegram, stopTelegram } from './adapters/telegram/telegram.ts';
import { provision } from './modules/operations/provision.ts';
import { installSettings } from './kernel/platform/settings.ts';
import { installEffects } from './wiring.ts';
import { buildCsp } from './kernel/platform/csp.ts';
import { HttpError, Router, send, type Ctx } from './kernel/platform/http.ts';
import { overTls } from './kernel/platform/origin.ts';
import { registerAiRoutes } from './modules/ai-review/routes/ai.ts';
import { registerAuthRoutes } from './kernel/identity/routes/auth.ts';
import { registerWorkspaceRoutes } from './kernel/identity/routes/workspaces.ts';
import { registerMailRoutes } from './adapters/mail/routes/mail.ts';
import { registerTelegramRoutes } from './adapters/telegram/routes/telegram.ts';
import { registerPushRoutes } from './adapters/push/routes/push.ts';
import { registerEntityRoutes } from './kernel/write-path/routes/entities.ts';
import { registerExportRoutes } from './adapters/transfer/routes/export.ts';
import { registerFileRoutes } from './kernel/files/routes/files.ts';
import { registerMcpRoutes } from './adapters/mcp/routes/mcp.ts';
import { registerOAuthRoutes } from './adapters/oauth/routes/oauth.ts';
import { registerSearchRoutes } from './kernel/search/routes/search.ts';
import { registerSettingsRoutes } from './kernel/platform/routes/settings.ts';
import { registerInboundRoutes } from './adapters/webhooks/routes/inbound.ts';
import { registerCalendarRoutes } from './adapters/calendar/routes/calendar.ts';
import { registerShareRoutes } from './adapters/share/routes/share.ts';
import { registerSyncRoutes } from './kernel/sync/routes/sync.ts';

// Before any route reads a setting: what an admin stored in the database wins
// over the environment, and `env` has been reading nothing until now.
installSettings();

// And before any route can write one: `repo` offers a hook rather than calling
// the rules engine by name, so somebody has to take it up. See `lib/wiring.ts`.
installEffects();

const router = new Router();

// Order matters: specific paths must be registered before the generic
// `/api/workspaces/:ws/:collection` CRUD routes.
registerAuthRoutes(router);
registerWorkspaceRoutes(router);
registerMailRoutes(router);
registerTelegramRoutes(router);
registerPushRoutes(router);
// Before `registerEntityRoutes`, which owns the generic `/api/:collection/:id`
// and would otherwise answer `DELETE /api/me/calendar` with "unknown
// collection me". Specific before generic, the way the auth routes above are.
registerCalendarRoutes(router);
// Also before the generic routes, for the same reason: `/api/instance/...` is
// not a collection called `instance`.
registerSettingsRoutes(router);
registerSyncRoutes(router);
registerSearchRoutes(router);
// Also before the generic routes: `/api/tasks/:id/review` is a thing that
// happens to a task, not a collection called `tasks` with a member `review`.
registerAiRoutes(router);
registerFileRoutes(router);
// Before the generic routes too: `/api/workspaces/:ws/export` is not a
// collection called "export", and `/api/import/archive` is not a row in one
// called "import".
registerExportRoutes(router);
registerOAuthRoutes(router);
registerMcpRoutes(router);
registerEntityRoutes(router);
registerShareRoutes(router);
registerInboundRoutes(router);

/**
 * `ready` turns true once provisioning finished (bucket reachable, owner
 * account created). The container is "healthy" as soon as it can answer, so a
 * slow object store shows up here rather than in a restart loop.
 */
let ready = false;

router.get('/api/health', () => ({
  status: 'ok',
  ready,
  seq: currentSeq(),
  uptime: Math.round(process.uptime()),
  storage: env.storage.kind,
  // 'off' | 'relay' | 'test-inbox' — a boolean would call a capture tool
  // "working", which is the confusion this avoids.
  mail: env.mailMode,
  // Named rather than a boolean, for the same reason `mail` is: which company
  // answers is the part an operator wants to see confirmed.
  ai: env.aiProvider,
}));

/* ------------------------------------------------------------ static files */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(env.webDir)) return false;
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\.]+)/, '');
  const candidate = resolve(join(env.webDir, relative));
  const isFile = candidate.startsWith(env.webDir) && existsSync(candidate) && statSync(candidate).isFile();
  const file = isFile ? candidate : join(env.webDir, 'index.html');
  if (!existsSync(file)) return false;

  const ext = extname(file);
  // Vite fingerprints assets, so everything under /assets can be cached hard.
  const immutable = isFile && relative.startsWith('assets/');
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': String(statSync(file).size),
  });
  createReadStream(file).pipe(res);
  return true;
}

/* -------------------------------------------------------------- the server */

const CSP = buildCsp(env.storage);

function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  // Only where there is TLS to insist on. Sent to a browser reaching a laptop
  // over http, this would lock that hostname to https for six months — which
  // for `localhost` is somebody's afternoon gone.
  //
  // No `includeSubDomains` and no `preload`: both are the operator's decision
  // about hosts this process knows nothing about, and both are hard to undo.
  if (secure) res.setHeader('strict-transport-security', 'max-age=15552000');
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  securityHeaders(res, overTls({ req, res, url, params: {}, query: url.searchParams, method: req.method ?? 'GET' }));
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      // `x-kolibri-client` is what a packaged app sends to be given a session
      // token; a preflight that does not list it fails the sign-in before it
      // is made, which is a CORS error in a WebView and no server log at all.
      'access-control-allow-headers': 'content-type,authorization,x-filename,x-kolibri-client,mcp-protocol-version',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  const match = router.match(req.method ?? 'GET', url.pathname);

  if (!match) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
    send(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
    return;
  }

  const ctx: Ctx = {
    req, res, url,
    params: match.params,
    query: url.searchParams,
    method: req.method ?? 'GET',
  };

  // The connector flow, and only that, leaves a trail. When a client on somebody
  // else's servers says "registration failed" there is otherwise nothing to look
  // at: the request either never arrived, or arrived and was refused for a
  // reason only this process knows. One line per step turns a guess into a fact,
  // and these are the only paths quiet enough to log every hit.
  if (TRACED.test(url.pathname)) traceStart(ctx);

  try {
    ctx.auth = authenticate(ctx) ?? undefined;
    const result = await match.handler(ctx);
    if (res.writableEnded || res.headersSent) return; // handler streamed its own response
    send(res, result === undefined ? 204 : 200, result ?? null);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.code ?? 'error', message: err.message });
      return;
    }
    log('error', `${req.method} ${url.pathname} failed`, err);
    send(res, 500, { error: 'internal_error', message: 'Something went wrong' });
  }
});

/**
 * The OAuth and MCP endpoints, which are the ones a stranger's software talks
 * to and the ones nobody can watch from the outside.
 */
const TRACED = /^\/(oauth\/|mcp$|\.well-known\/oauth)/;

/**
 * Log how it ended, once, whatever ends it.
 *
 * `finish` fires for a normal response, a streamed one and a connection that
 * died mid-flight, which is exactly the set of outcomes worth knowing about.
 * The user agent is included because "which client was this" is the first
 * question every time, and the response's `error` code is not visible here —
 * the status and the path have to carry it.
 */
function traceStart(ctx: Ctx): void {
  const agent = String(ctx.req.headers['user-agent'] ?? '').slice(0, 60);
  ctx.res.on('finish', () => {
    const status = ctx.res.statusCode;
    log(status >= 400 ? 'warn' : 'info', `${ctx.method} ${ctx.url.pathname} → ${status}${agent ? `  (${agent})` : ''}`);
  });
}

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
// SSE connections stay open for as long as the tab does.
server.requestTimeout = 0;

const LEVELS = ['debug', 'info', 'warn', 'error'];
function log(level: string, message: string, extra?: unknown): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(env.logLevel)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, extra ?? '');
  else console.log(line);
}

/** Housekeeping: expired sessions and the replay-protection log. */
function sweep(): void {
  const now = Date.now();
  run(`DELETE FROM sessions WHERE expires_at < ?`, now);
  run(`DELETE FROM applied_mutations WHERE applied_at < ?`, now - 30 * 86_400_000);
  run(`DELETE FROM email_queue WHERE sent_at IS NOT NULL AND sent_at < ?`, now - 30 * 86_400_000);
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.port, env.host, () => {
    log('info', `Kolibri listening on http://${env.host}:${env.port}`);
    log('info', `Database: ${env.dbFile}`);
    if (!existsSync(env.webDir)) log('warn', `Web build not found at ${env.webDir} — run "npm run build"`);
  });

  // Provisioning runs alongside the server: the object store may still be
  // starting in the same compose stack, and waiting for it should not make the
  // container look dead to an orchestrator.
  provision(log)
    .then(() => {
      ready = true;
      startMailWorker();
      startScheduler();
      startTelegram();
    })
    .catch(() => {
      log('error', 'Provisioning failed — exiting so the restart policy can try again');
      process.exit(1);
    });

  sweep();
  setInterval(sweep, 6 * 3600_000).unref();
}

const shutdown = (signal: string) => {
  log('info', `${signal} received, shutting down`);
  stopMailWorker();
  stopScheduler();
  stopTelegram();
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, router };
