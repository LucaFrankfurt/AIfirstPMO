import { all, get, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth, requireWorkspace } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, readBody, type Ctx, type Router } from '../lib/http.ts';
import { disposition } from '../lib/mime.ts';
import * as storage from '../lib/storage.ts';
import { safeName, storeFile } from '../lib/uploads.ts';

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
    const name = decodeURIComponent(String(ctx.req.headers['x-filename'] ?? 'upload'));
    const body = await readBody(ctx.req, env.maxUploadBytes);
    if (!body.length) throw badRequest('Empty upload');

    return storeFile({
      workspaceId: ctx.params.ws,
      userId: auth.userId,
      name, mime, body,
      taskId: ctx.query.get('task_id'),
      pageId: ctx.query.get('page_id'),
      commentId: ctx.query.get('comment_id'),
      thumbUrl: ctx.query.get('thumb_url'),
    });
  });

  router.get('/files/:hash/*', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    // A hash can belong to more than one workspace. The question is whether it
    // belongs to one of *yours*, not whether the first row happens to be.
    const rows = all<Row>(`SELECT * FROM files WHERE hash = ?`, ctx.params.hash);
    if (!rows.length) throw notFound('File not found');
    const file = rows.find((row) => auth.memberships.has(String(row.workspace_id)));
    if (!file) throw forbidden('Not your workspace');

    const key = storage.keyFor(file.hash, file.mime);
    const backend = (file.storage ?? 'disk') as storage.StorageKind;
    const { inline, type } = disposition(String(file.mime));
    const filename = safeName(decodeURIComponent(ctx.params['*'] || file.name));

    // With an object store we hand out a short-lived signed URL instead of
    // proxying the bytes — the permission check above still gates who gets one.
    const direct = storage.directUrl(key, filename, String(file.mime), backend);
    if (direct) {
      ctx.res.writeHead(302, { location: direct, 'cache-control': 'private, max-age=60' });
      ctx.res.end();
      return undefined;
    }

    const result = await storage.read(key, backend);
    if (!result) throw notFound('File contents are missing from storage');

    ctx.res.writeHead(200, {
      'content-type': type,
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
