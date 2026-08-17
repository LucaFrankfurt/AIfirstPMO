import { createHash } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth, requireWorkspace } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, readBody, type Ctx, type Router } from '../lib/http.ts';
import { imageSize } from '../lib/imagesize.ts';
import { serverClock } from '../lib/bootstrap.ts';
import { serialize, writeEntity } from '../lib/repo.ts';
import * as storage from '../lib/storage.ts';
import { uid } from '../lib/ids.ts';

/** Types we are willing to hand back with their original content type. */
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'application/pdf', 'text/plain', 'text/markdown', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg',
]);

const safeName = (raw: string): string =>
  (raw || 'file').replace(/[\r\n"\\/]/g, '_').replace(/\.\./g, '_').slice(0, 180);

export function registerFileRoutes(router: Router): void {
  /**
   * Raw-body upload: `POST /api/workspaces/:ws/files` with `content-type` and
   * `x-filename`. Deliberately not multipart — the browser client streams a
   * single blob, which keeps both sides tiny and makes retries trivial.
   */
  router.post('/api/workspaces/:ws/files', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');

    const mime = (ctx.req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
    const name = safeName(decodeURIComponent(String(ctx.req.headers['x-filename'] ?? 'upload')));
    const body = await readBody(ctx.req, env.maxUploadBytes);
    if (!body.length) throw badRequest('Empty upload');

    const hash = createHash('sha256').update(body).digest('hex');
    const key = storage.keyFor(hash, mime);
    const known = get<Row>(`SELECT hash, storage FROM files WHERE hash = ?`, hash);

    // Content-addressed: identical bytes are stored once, whatever the backend.
    if (!known || !(await storage.exists(key, known.storage))) {
      await storage.put(key, body, mime);
    }

    const size = imageSize(body, mime);
    if (!known) {
      run(
        `INSERT INTO files (hash, workspace_id, name, mime, size, width, height, storage, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        hash, ctx.params.ws, name, mime, body.length, size?.width ?? null, size?.height ?? null,
        storage.activeKind, auth.userId, Date.now(),
      );
    }

    const url = `/files/${hash}/${encodeURIComponent(name)}`;
    const taskId = ctx.query.get('task_id');
    const pageId = ctx.query.get('page_id');
    const commentId = ctx.query.get('comment_id');

    // Linking the blob to a task/page creates the attachment row that shows up
    // in the UI; a bare upload (e.g. an inline image) just returns the URL.
    if (taskId || pageId || commentId) {
      const { row } = writeEntity('attachment', uid(), {
        workspace_id: ctx.params.ws,
        task_id: taskId, page_id: pageId, comment_id: commentId,
        name, mime, size: body.length, url,
        thumb_url: ctx.query.get('thumb_url'),
        width: size?.width ?? null, height: size?.height ?? null,
        uploaded_by: auth.userId,
      }, { workspaceId: ctx.params.ws, actorId: auth.userId, hlc: serverClock.now() });
      return { url, hash, name, mime, size: body.length, ...size, attachment: serialize('attachment', row) };
    }

    return { url, hash, name, mime, size: body.length, ...size };
  });

  router.get('/files/:hash/*', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const file = get<Row>(`SELECT * FROM files WHERE hash = ?`, ctx.params.hash);
    if (!file) throw notFound('File not found');
    if (!auth.memberships.has(file.workspace_id)) throw forbidden('Not your workspace');

    const key = storage.keyFor(file.hash, file.mime);
    const backend = (file.storage ?? 'disk') as storage.StorageKind;
    const inline = INLINE_TYPES.has(file.mime);
    const filename = safeName(decodeURIComponent(ctx.params['*'] || file.name));

    // With an object store we hand out a short-lived signed URL instead of
    // proxying the bytes — the permission check above still gates who gets one.
    const direct = storage.directUrl(key, filename, backend);
    if (direct) {
      ctx.res.writeHead(302, { location: direct, 'cache-control': 'private, max-age=60' });
      ctx.res.end();
      return undefined;
    }

    const result = await storage.read(key, backend);
    if (!result) throw notFound('File contents are missing from storage');

    ctx.res.writeHead(200, {
      'content-type': inline ? file.mime : 'application/octet-stream',
      ...(result.size ? { 'content-length': String(result.size) } : {}),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      // Content-addressed: the bytes behind a hash never change.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    result.stream.pipe(ctx.res);
    result.stream.on('error', () => ctx.res.destroy());
    return undefined;
  });

  router.get('/api/workspaces/:ws/files', (ctx: Ctx) => {
    requireWorkspace(ctx, ctx.params.ws);
    return all<Row>(
      `SELECT hash, name, mime, size, width, height, storage, created_at, created_by FROM files
        WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      ctx.params.ws, Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500),
    ).map((row) => ({ ...row, url: `/files/${row.hash}/${encodeURIComponent(row.name)}` }));
  });
}
