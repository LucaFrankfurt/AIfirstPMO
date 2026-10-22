import { type AttachmentSubject, isAttachmentSubject } from '@kolibri/shared';
import { all, type Row } from '../../platform/db/index.ts';
import { env } from '../../platform/env.ts';
import { requireAuth, requireWorkspace } from '../../identity/auth.ts';
import { badRequest, decodeParam, forbidden, notFound, readBody, type Ctx, type Router } from '../../platform/http.ts';
import { contentDisposition, disposition } from '../mime.ts';
import * as storage from '../storage.ts';
import { canSeeFile, canSeeSubject } from '../../write-path/repo.ts';
import { safeName, storeFile } from '../uploads.ts';

/**
 * Which one thing this upload is being hung on, out of the query string.
 *
 * `task_id`, `page_id` and `comment_id` are the three spellings this route has
 * always taken and every client in the wild sends; `subject` and `subject_id`
 * are the pair that says everything else — a decision, a budget, a component.
 * Both forms arrive here and leave as one `{ kind, id }`, which is what an
 * attachment row actually holds.
 *
 * Two of anything is a refusal rather than a precedence rule. A request naming
 * both a task and a page is a client that has made a mistake, and picking the
 * first would file the file somewhere the caller did not ask for and then
 * report success — the worst of the three available answers.
 */
function subjectFrom(query: URLSearchParams): { kind: AttachmentSubject; id: string } | null {
  const named: [AttachmentSubject, string | null][] = [
    ['task', query.get('task_id')],
    ['page', query.get('page_id')],
    ['comment', query.get('comment_id')],
  ];
  const found = named.filter(([, id]) => !!id).map(([kind, id]) => ({ kind, id: String(id) }));

  const id = query.get('subject_id');
  if (id) {
    const kind = query.get('subject');
    if (!isAttachmentSubject(kind)) {
      throw badRequest(`\`subject\` is ${kind ? `not something a file can be attached to: ${kind}` : 'missing'}`);
    }
    found.push({ kind, id });
  }

  if (found.length > 1) throw badRequest('An upload hangs on one thing, and this names several');
  return found[0] ?? null;
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
    const name = decodeParam(String(ctx.req.headers['x-filename'] ?? 'upload'), 'x-filename');
    /*
     * Whose task, page or decision it is, asked before a byte is read.
     *
     * This route used to check workspace membership and nothing else, so a
     * member could file a screenshot into a private project they are not on —
     * where the people who *are* on it would then read it as theirs. The write
     * path refuses it too — `guardAttachmentWrite` in `work.ts`, which every
     * door including a sync push comes through, and which `storeFile` below
     * therefore also runs. It is asked here as well so that the refusal lands
     * *before* `readBody`: saying no afterwards means having accepted
     * twenty-five megabytes in order to throw them away.
     *
     * An upload naming nothing stays allowed. That is the avatar, the workspace
     * logo and an image pasted into a chat message, and membership is the whole
     * of the rule those have ever had.
     */
    const subject = subjectFrom(ctx.query);
    if (subject && !canSeeSubject(auth.userId, subject.kind, subject.id)) {
      throw forbidden(`That ${subject.kind} is not yours`);
    }

    const body = await readBody(ctx.req, env.maxUploadBytes);
    if (!body.length) throw badRequest('Empty upload');

    return storeFile({
      workspaceId: ctx.params.ws,
      userId: auth.userId,
      name, mime, body,
      subject,
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
    // And the same question one floor down, which this route did not ask. The
    // workspace was the only gate here, so a member who could not open a
    // private project could still fetch the bytes of every screenshot hanging
    // off it — the row was refused and the file was not.
    if (!canSeeFile(auth.userId, ctx.params.hash)) throw forbidden('Not your project');

    const key = storage.keyFor(file.hash, file.mime);
    const backend = (file.storage ?? 'disk') as storage.StorageKind;
    const { inline, type } = disposition(String(file.mime));
    // Only the name in the URL is encoded. The stored one is the name itself, and
    // decoding it too made `100%.pdf` a 500 and `%41.pdf` into `A.pdf`.
    const filename = safeName(ctx.params['*'] ? decodeParam(ctx.params['*'], 'The file name') : String(file.name));

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
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', filename),
      // Content-addressed: the bytes behind a hash never change.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    result.stream.pipe(ctx.res);
    result.stream.on('error', () => ctx.res.destroy());
    return undefined;
  });

  /**
   * Everything this workspace holds — filtered by the same rule as the bytes.
   *
   * Without that filter this listing was the way around the fix above: it
   * hands out the name and the hash of every file, and a URL is a hash with a
   * name on the end. Closing one door and leaving the key beside the other is
   * not closing a door.
   */
  router.get('/api/workspaces/:ws/files', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);
    return all<Row>(
      `SELECT hash, name, mime, size, width, height, storage, created_at, created_by FROM files
        WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      ctx.params.ws, Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500),
    )
      .filter((row) => canSeeFile(auth.userId, String(row.hash)))
      .map((row) => ({ ...row, url: `/files/${row.hash}/${encodeURIComponent(row.name)}` }));
  });
}
