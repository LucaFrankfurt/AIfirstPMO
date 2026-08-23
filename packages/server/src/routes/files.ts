import { createHash } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth, requireWorkspace } from '../lib/auth.ts';
import { badRequest, forbidden, notFound, readBody, type Ctx, type Router } from '../lib/http.ts';
import { disposition } from '../lib/mime.ts';
import { imageSize } from '../lib/imagesize.ts';
import { serverClock } from '../lib/bootstrap.ts';
import { serialize, writeEntity } from '../lib/repo.ts';
import * as storage from '../lib/storage.ts';
import { uid } from '../lib/ids.ts';

/** Types we are willing to hand back with their original content type. */
export const safeName = (raw: string): string =>
  (raw || 'file').replace(/[\r\n"\\/]/g, '_').replace(/\.\./g, '_').slice(0, 180);

export interface StoreFile {
  workspaceId: string;
  userId: string;
  name: string;
  mime: string;
  body: Buffer;
  /** Attach it to one of these; with none, the bytes are stored and only a URL comes back. */
  taskId?: string | null;
  pageId?: string | null;
  commentId?: string | null;
  thumbUrl?: string | null;
}

/**
 * Put bytes in the store, and optionally hang them off a task, page or comment.
 *
 * Lifted out of the HTTP handler so that MCP's `upload_attachment` is the same
 * code rather than a second one that agrees for now. Everything peculiar about
 * storing a file here — content addressing, the two separate questions below,
 * the image dimensions, the attachment row the interface reads — lives in this
 * function and nowhere else.
 *
 * The caller is responsible for saying who is asking: this checks nothing about
 * permissions, because its two callers check different things in different
 * ways and a function that half-checks is worse than one that says it does not.
 */
export async function storeFile(input: StoreFile): Promise<Record<string, unknown>> {
  const name = safeName(input.name);
  const hash = createHash('sha256').update(input.body).digest('hex');
  const key = storage.keyFor(hash, input.mime);

  // Two questions, and they used to be one. *Are these bytes already stored*
  // decides whether to write the blob; *does this workspace have a row for
  // them* decides whether to write the row. Answering only the first meant the
  // second workspace to upload a file got no row — and then a 403 reading back
  // what it had just sent.
  const stored = get<Row>(`SELECT storage FROM files WHERE hash = ? LIMIT 1`, hash);
  const mine = get<Row>(`SELECT hash FROM files WHERE hash = ? AND workspace_id = ?`, hash, input.workspaceId);

  // Content-addressed: identical bytes are stored once, whatever the backend.
  if (!stored || !(await storage.exists(key, stored.storage))) {
    await storage.put(key, input.body, input.mime);
  }

  const size = imageSize(input.body, input.mime);
  if (!mine) {
    run(
      `INSERT INTO files (hash, workspace_id, name, mime, size, width, height, storage, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hash, input.workspaceId, name, input.mime, input.body.length, size?.width ?? null, size?.height ?? null,
      storage.activeKind, input.userId, Date.now(),
    );
  }

  const url = `/files/${hash}/${encodeURIComponent(name)}`;

  // Linking the blob to a task/page creates the attachment row that shows up
  // in the UI; a bare upload (e.g. an inline image) just returns the URL.
  if (input.taskId || input.pageId || input.commentId) {
    const { row } = writeEntity('attachment', uid(), {
      workspace_id: input.workspaceId,
      task_id: input.taskId ?? null, page_id: input.pageId ?? null, comment_id: input.commentId ?? null,
      name, mime: input.mime, size: input.body.length, url,
      thumb_url: input.thumbUrl ?? null,
      width: size?.width ?? null, height: size?.height ?? null,
      uploaded_by: input.userId,
    }, { workspaceId: input.workspaceId, actorId: input.userId, hlc: serverClock.now() });
    return { url, hash, name, mime: input.mime, size: input.body.length, ...size, attachment: serialize('attachment', row) };
  }

  return { url, hash, name, mime: input.mime, size: input.body.length, ...size };
}

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
