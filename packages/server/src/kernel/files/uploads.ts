/**
 * Putting bytes in the store, and hanging them off a task, page or comment.
 *
 * This is the whole of what it means to store a file here — content
 * addressing, the two separate questions below, the image dimensions, the
 * attachment row the interface reads — and it is a library rather than part of
 * a route because it has two callers: the upload endpoint and MCP's
 * `upload_attachment`. It used to live in `routes/files.ts`, which meant
 * `lib/mcp.ts` imported a route, and a library reaching up into a route makes
 * the route impossible to replace. See `docs/modules.md`.
 */
import { createHash } from 'node:crypto';
import { get, run, type Row } from '../platform/db/index.ts';
import { imageSize } from './imagesize.ts';
import { serverClock } from '../write-path/bootstrap.ts';
import { serialize, writeEntity } from '../write-path/repo.ts';
import * as storage from './storage.ts';
import { uid } from '../platform/ids.ts';

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
    /*
     * The third question, and it is the same shape as the two above.
     *
     * *Are these bytes stored* decides whether to write the blob; *does this
     * workspace have a row for them* decides whether to write the `files` row.
     * Neither answered *is this file already on this task*, so uploading the
     * same screenshot twice produced one blob, one `files` row and two
     * attachments — the same picture listed twice in the task's Files section.
     *
     * It reads as cosmetic and it lands where clients repeat: the task create
     * is an upsert on an id the caller chooses, so a retried report finds its
     * task, and then hangs a second copy of its screenshot on it. A client
     * that cared had to ask first, which is a request per report whose only
     * purpose was to work around this line.
     *
     * `checksum` and not `name`: two different files are often called
     * `screenshot.webp`, and the same file renamed is still the same file. It
     * is also the column a client cannot write, so this cannot be steered from
     * outside — the same property `canSeeFile` needs from it.
     *
     * `deleted_at IS NULL` is the part worth stating plainly. Detaching a file
     * and uploading it again has to produce a row; matching a tombstone would
     * make deletion permanent for those exact bytes, and "I removed it and now
     * it will not come back" is a worse bug than the duplicate this fixes.
     */
    const existing = get<Row>(
      `SELECT * FROM attachments
        WHERE workspace_id = ? AND checksum = ? AND deleted_at IS NULL
          AND task_id IS ? AND page_id IS ? AND comment_id IS ?`,
      input.workspaceId, hash,
      input.taskId ?? null, input.pageId ?? null, input.commentId ?? null,
    );
    if (existing) {
      return {
        url: String(existing.url ?? url), hash, name: String(existing.name ?? name),
        mime: input.mime, size: input.body.length, ...size,
        attachment: serialize('attachment', existing),
      };
    }

    const { row } = writeEntity('attachment', uid(), {
      workspace_id: input.workspaceId,
      task_id: input.taskId ?? null, page_id: input.pageId ?? null, comment_id: input.commentId ?? null,
      name, mime: input.mime, size: input.body.length, url,
      thumb_url: input.thumbUrl ?? null,
      width: size?.width ?? null, height: size?.height ?? null,
      uploaded_by: input.userId,
    }, { workspaceId: input.workspaceId, actorId: input.userId, hlc: serverClock.now() });
    /*
     * Which bytes this row is about, recorded where a client cannot reach it.
     *
     * `checksum` has been a column since the table was written and was never
     * filled in. It is what `canSeeFile` joins on to decide whether somebody
     * may fetch a blob, and that is exactly why it is written here with a
     * plain `UPDATE` rather than passed to `writeEntity` above: it is not a
     * registry field, so the write path drops it from anything a client sends,
     * and only this function — which is holding the bytes — can set it. Going
     * through the registry would make it forgeable, and a forgeable answer to
     * "may I have this file" is not an answer.
     */
    run(`UPDATE attachments SET checksum = ? WHERE id = ?`, hash, row.id);
    return { url, hash, name, mime: input.mime, size: input.body.length, ...size, attachment: serialize('attachment', row) };
  }

  return { url, hash, name, mime: input.mime, size: input.body.length, ...size };
}
