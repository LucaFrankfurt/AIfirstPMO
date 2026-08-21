/**
 * Emptying the trash, on purpose or on a clock.
 *
 * The awkward part is that a delete here *is* a tombstone: the row keeps its
 * `deleted_at` and keeps syncing, which is the only way two devices ever agree
 * that something is gone. Simply dropping the row would leave every device that
 * already has it showing the thing in its own trash, with a button offering to
 * put it back — the deletion would come undone from the outside.
 *
 * So a purge does two things: it removes the row on the server, and it writes a
 * `purge` marker in its place. The marker syncs like everything else, and a
 * client that receives one deletes its copy of the row the marker names. The
 * markers are tiny and are kept, because they are the only remaining record
 * that the thing was ever here.
 *
 * What this cannot fix, and does not pretend to: a device that has been offline
 * since before the purge still has its copy. It will drop it the moment it
 * syncs. Until then, the bytes are on that device — which is true of anything
 * anybody has ever had a copy of.
 */
import { ENTITIES, ENTITY_NAMES, type EntityName } from '@kolibri/shared';
import { all, get, nextSeq, run, tx, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { uid } from './ids.ts';
import { keyFor, remove as removeBlob } from './storage.ts';

/**
 * What can be emptied.
 *
 * Not `purge` itself, for the obvious reason, and not `user` — a person is not
 * a workspace's to erase, and their row is what every `created_by` on every
 * remaining task points at.
 */
const PURGEABLE: EntityName[] = ENTITY_NAMES.filter((name) => name !== 'purge' && name !== 'user');

export interface Counts {
  /** Tombstones old enough to go, by entity. */
  entries: { entity: EntityName; count: number }[];
  total: number;
  /** Uploaded bytes that would be freed. */
  bytes: number;
}

const cutoffFor = (days: number, now: number): number => now - days * 86_400_000;

/** How much is waiting to go, at a given age. */
export function purgeable(workspaceId: string, before: number): Counts {
  const entries: { entity: EntityName; count: number }[] = [];
  let total = 0;
  for (const entity of PURGEABLE) {
    const table = ENTITIES[entity].table;
    const count = Number(get<Row>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      workspaceId, before,
    )?.n ?? 0);
    if (count) entries.push({ entity, count });
    total += count;
  }
  // What the *attachments* going hold, which is an upper bound rather than a
  // promise: uploads are content-addressed, so a blob two tasks share survives
  // one of them being purged. Overstating what will be freed is the safer of
  // the two ways to be wrong about a number in a confirmation dialog.
  const bytes = Number(get<Row>(
    `SELECT COALESCE(SUM(size), 0) AS n FROM attachments
      WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
    workspaceId, before,
  )?.n ?? 0);
  return { entries, total, bytes };
}

/**
 * The trail a purged row leaves elsewhere.
 *
 * The audit log records that somebody deleted a thing, and it quotes the thing
 * by name. Once the thing is destroyed on purpose, that quotation is the last
 * surviving copy of it — and a button whose whole promise is "gone" cannot
 * leave the title sitting in a list every admin can read. The verb, the actor
 * and the time are what an audit log is *for*, but they are worth less than the
 * promise, so the entries go with the row.
 *
 * Notifications go for the plainer reason that they are links: one pointing at
 * a task that no longer exists is an inbox row that opens on nothing.
 */
function forgetTrail(entity: EntityName, id: string): void {
  const column = entity === 'task' ? 'task_id' : entity === 'page' ? 'page_id' : entity === 'project' ? 'project_id' : null;
  if (!column) return;
  run(`DELETE FROM activities WHERE ${column} = ?`, id);
  if (column !== 'project_id') run(`DELETE FROM notifications WHERE ${column} = ?`, id);
}

export interface Emptied {
  purged: number;
  blobs: number;
  bytes: number;
}

/**
 * Every column a `/files/<hash>` URL can end up in.
 *
 * Written out rather than discovered, because guessing wrong in the direction
 * of "nothing points at this" deletes a picture somebody is still looking at.
 * A blob is only removed when *none* of these mention its hash, which means a
 * new place to paste an image is a line that has to be added here — that is the
 * intended cost.
 */
const REFERENCES: [table: string, column: string][] = [
  ['attachments', 'url'],
  ['attachments', 'thumb_url'],
  ['tasks', 'description'],
  ['pages', 'content'],
  ['projects', 'description'],
  ['cycles', 'description'],
  ['modules', 'description'],
  ['comments', 'body'],
  // A screenshot pasted into a conversation. Missing this line meant emptying
  // the trash took the picture while the message went on showing it — exactly
  // the failure the paragraph above warns about, in the first new paste target
  // added after it was written.
  ['messages', 'body'],
  ['templates', 'description'],
  ['users', 'avatar_url'],
];

/**
 * Delete the bytes nothing points at any more.
 *
 * Uploads are content-addressed, so one blob can be an attachment on two tasks
 * and an inline image in a page at the same time. Deleting one because *an*
 * attachment row went would take the picture out of the page as well, so the
 * question asked is the stricter one: does anything at all still name this
 * hash.
 */
export function reclaimFiles(workspaceId: string): { blobs: number; bytes: number } {
  const files = all<Row>(`SELECT hash, mime, size, storage FROM files WHERE workspace_id = ?`, workspaceId);
  let blobs = 0;
  let bytes = 0;

  for (const file of files) {
    const needle = `%/files/${file.hash}%`;
    const referenced = REFERENCES.some(([table, column]) =>
      !!get<Row>(`SELECT 1 AS found FROM ${table} WHERE ${column} LIKE ? LIMIT 1`, needle));
    if (referenced) continue;

    run(`DELETE FROM files WHERE hash = ? AND workspace_id = ?`, file.hash, workspaceId);
    // The blob is shared, so it only goes when the last row naming it does.
    if (get<Row>(`SELECT 1 FROM files WHERE hash = ? LIMIT 1`, file.hash)) continue;
    // Outside any transaction and never fatal: a blob that will not delete
    // leaves a file nobody points at, which `kolibri doctor` already counts.
    // Losing the row because a bucket was briefly unreachable is the worse
    // trade of the two.
    void removeBlob(keyFor(String(file.hash), String(file.mime ?? 'application/octet-stream')),
      String(file.storage ?? '') === 's3' ? 's3' : 'disk')
      .catch((error) => console.error('[trash] could not remove', file.hash, error));
    blobs++;
    bytes += Number(file.size ?? 0);
  }
  return { blobs, bytes };
}

/**
 * Remove every tombstone older than `before`, and leave a marker for each.
 *
 * One transaction: half an emptied trash is a workspace where some devices
 * forgot a thing and others did not.
 */
export function emptyTrash(
  workspaceId: string,
  reason: 'manual' | 'retention',
  before: number,
): Emptied {
  const now = Date.now();
  const purged = tx(() => {
    let count = 0;
    for (const entity of PURGEABLE) {
      const table = ENTITIES[entity].table;
      const doomed = all<Row>(
        `SELECT id FROM ${table} WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
        workspaceId, before,
      );
      for (const row of doomed) {
        run(`DELETE FROM ${table} WHERE id = ?`, row.id);
        run(`DELETE FROM search_index WHERE kind = ? AND ref_id = ?`, entity, row.id);
        forgetTrail(entity, String(row.id));
        run(
          `INSERT INTO purges (id, workspace_id, entity, row_id, reason, created_at, updated_at, seq, clocks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
          uid(), workspaceId, entity, String(row.id), reason, now, now, nextSeq(),
        );
        count++;
      }
    }
    return count;
  });

  // The bytes afterwards, once the rows that referred to them are actually gone.
  const { blobs, bytes } = reclaimFiles(workspaceId);
  return { purged, blobs, bytes };
}

/**
 * The clock's half: every workspace, once a day, if a retention window is set.
 *
 * Off by default. A default that quietly destroyed things after a month would
 * be a policy this project has no business choosing for somebody else's data.
 */
export function applyRetention(now = Date.now()): number {
  const days = env.trashDays;
  if (!days) return 0;
  const before = cutoffFor(days, now);
  let purged = 0;
  for (const workspace of all<Row>(`SELECT id FROM workspaces WHERE deleted_at IS NULL`)) {
    purged += emptyTrash(String(workspace.id), 'retention', before).purged;
  }
  return purged;
}
