/**
 * Siblings that share a sort key, given keys of their own — once.
 *
 * Until the write path gave every new page a key after its siblings, a page
 * created over MCP, filed as minutes or posted to REST got the column's default
 * `V`. On the first real wiki that was 57 pages of 77, 41 of them side by side
 * at the top level. The tree now breaks ties the same way everywhere
 * (`comparePages`), which fixes what is *drawn*; this fixes what can be *done*
 * with it, because a drag between two equal keys has nowhere to land but after
 * the whole tied run. See `untie`.
 *
 * Idempotent by construction: `untie` moves nothing in a list with no ties,
 * so after the first start this reads the duplicates query and stops.
 */
import { untie } from '@kolibri/shared';
import { all, run, tx, type Row } from '../../kernel/platform/db/index.ts';
import { serverClock } from '../../kernel/write-path/bootstrap.ts';
import { writeEntity } from '../../kernel/write-path/repo.ts';

export function untiePageOrder(): number {
  const tied = all<Row>(
    `SELECT DISTINCT workspace_id, parent_id FROM pages
      WHERE deleted_at IS NULL
      GROUP BY workspace_id, parent_id, sort_order
     HAVING COUNT(*) > 1`,
  );
  let moved = 0;
  for (const group of tied) {
    const workspaceId = String(group.workspace_id);
    const parentId = (group.parent_id as string | null) ?? null;
    const siblings = all<Row>(
      `SELECT id, sort_order, created_at, updated_at FROM pages
        WHERE workspace_id = ? AND deleted_at IS NULL AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`,
      ...(parentId ? [workspaceId, parentId] : [workspaceId]),
    );
    const when = new Map(siblings.map((row) => [String(row.id), Number(row.updated_at)]));
    for (const patch of untie(siblings.map((row) => ({
      id: String(row.id), sort_order: String(row.sort_order ?? ''), created_at: Number(row.created_at ?? 0),
    })))) {
      tx(() => {
        // Through the write path, so the key is clocked and synced like any
        // other edit — and then `updated_at` put back. A new position is not an
        // edit anybody made, and without this every one of these pages would
        // open the wiki as "recently edited", just now, by nobody.
        writeEntity('page', patch.id, { sort_order: patch.sort_order }, {
          workspaceId, actorId: '', hlc: serverClock.now(), system: true, silent: true,
        });
        run(`UPDATE pages SET updated_at = ? WHERE id = ?`, when.get(patch.id) ?? Date.now(), patch.id);
      });
      moved++;
    }
  }
  return moved;
}
