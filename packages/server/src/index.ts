import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { close, currentSeq, run } from './db/index.ts';
import { env } from './env.ts';
import { authenticate } from './lib/auth.ts';
import { startMailWorker, stopMailWorker } from './lib/mail.ts';
import { provision } from './lib/provision.ts';
import { HttpError, Router, send, type Ctx } from './lib/http.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerEntityRoutes } from './routes/entities.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerSyncRoutes } from './routes/sync.ts';

const router = new Router();

// Order matters: specific paths must be registered before the generic
// `/api/workspaces/:ws/:collection` CRUD routes.
registerAuthRoutes(router);
registerSyncRoutes(router);
registerSearchRoutes(router);
registerFileRoutes(router);
registerMcpRoutes(router);
registerEntityRoutes(router);

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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-filename,mcp-protocol-version',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, router };
