/**
 * What a board on a canvas lives by.
 *
 * A board is a page's in every sense that matters for who may touch it: it
 * has no access setting of its own, and the four things here all follow from
 * that one fact.
 *
 * **A board is written onto a page the writer can see.** The pull filter and
 * the REST guard already keep a private page's boards away from everybody
 * else, but neither is asked when a row is *written* — a sync push from a
 * device carries rows straight to the write path. Without this a member could
 * add a board to a colleague's private canvas by guessing its id, and the
 * colleague would find it there.
 *
 * **The HTML is a merge.** `body` is a text CRDT and `content` is what it
 * reads as, derived here through the same function a page's body goes through.
 * The server stores the board exactly as written: it is never rendered by this
 * process, and the client only ever draws it inside a sandboxed frame.
 *
 * **Deleting a canvas takes its boards, and restoring it brings them back** —
 * the arrangement a meeting has with its agenda, for the same reason: a
 * canvas restored from the trash with no boards on it is a canvas whose work
 * is gone, which is the opposite of what the restore button promised.
 *
 * **Opening a canvas to more people sends them its boards.** A device only
 * pulls rows whose `seq` moved past its cursor, and a board that was private
 * when it was last written was skipped by everybody else's pull at the time.
 * When the page's `access` or project changes, every board on it is given a
 * fresh `seq`, so the people who may now see the page also get what is on it.
 */

import { all, get, nextSeq, run, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { canSeePage, type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';
import { settleCrdtText } from './pages.ts';

const BOARD_TEXT = { state: 'body', text: 'content' } as const;

/**
 * How small and how large a board's frame may be, in canvas pixels.
 *
 * The floor is a frame somebody can still grab; the ceiling is the largest
 * artboard the reference editors allow, and well past any screen.
 */
export const BOARD_SIZE = { min: 40, max: 8000 } as const;

/**
 * How far from the origin a board may stand. Far enough for any canvas a
 * person would build, and short of the numbers where a CSS transform stops
 * being exact.
 */
const REACH = 1_000_000;

const pageRow = (id: unknown): Row | undefined =>
  (id ? get<Row>(`SELECT id, workspace_id, deleted_at FROM pages WHERE id = ?`, String(id)) : undefined);

/** A board goes onto a page that is here, in this workspace, that the writer may see. */
function guardBoard(values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (existing && values.page_id === undefined) {
    if (!canSeePage(opts.actorId, String(existing.page_id))) throw forbidden('That canvas is private');
    return;
  }
  const page = pageRow(values.page_id ?? existing?.page_id);
  if (!page || page.deleted_at || String(page.workspace_id) !== String(opts.workspaceId)) {
    throw badRequest('That canvas is not here');
  }
  if (!canSeePage(opts.actorId, String(page.id))) throw forbidden('That canvas is private');
  // Moving a board to another canvas takes it out of this one too.
  if (existing && String(existing.page_id) !== String(page.id) && !canSeePage(opts.actorId, String(existing.page_id))) {
    throw forbidden('That canvas is private');
  }
}

/** A finite number within `low`..`high`, or `fallback` for anything that is not one. */
function clamp(raw: unknown, low: number, high: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

function applyBoardInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown): void => {
    if (values[field] === value) return;
    values[field] = value;
    forced[field] = value;
  };
  if (values.kind !== undefined) settle('kind', values.kind === 'note' ? 'note' : 'html');
  for (const field of ['x', 'y'] as const) {
    if (values[field] !== undefined) settle(field, clamp(values[field], -REACH, REACH, Number(existing?.[field] ?? 0)));
  }
  for (const field of ['w', 'h'] as const) {
    if (values[field] !== undefined) {
      settle(field, clamp(values[field], BOARD_SIZE.min, BOARD_SIZE.max, Number(existing?.[field] ?? (field === 'w' ? 960 : 640))));
    }
  }
  settleCrdtText(values, existing, forced, BOARD_TEXT);
}

const system = (opts: WriteOpts): WriteOpts => ({ ...opts, op: undefined, system: true, silent: true });

/**
 * A board's history: the text it had before each change, collapsed the way a
 * page's is.
 *
 * The same window and the same reason (`VERSION_WINDOW_MS` beside
 * `snapshotPage`): a design session is dozens of writes — every nudge in the
 * inspector is one — and a history with a row per nudge is a history nobody can
 * find yesterday's board in. One row per author per ten minutes keeps the board
 * as it was before each sitting.
 */
const BOARD_WINDOW_MS = 10 * 60 * 1000;

function snapshotBoard(before: Row, actorId: string): void {
  if (!before.content) return;
  const latest = get<Row>(
    `SELECT content, author_id, created_at FROM artboard_versions WHERE artboard_id = ? ORDER BY created_at DESC LIMIT 1`,
    String(before.id),
  );
  if (latest?.content === before.content) return;
  if (latest && latest.author_id === actorId && Date.now() - Number(latest.created_at) < BOARD_WINDOW_MS) return;
  run(
    `INSERT INTO artboard_versions (id, artboard_id, content, title, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    uid(), String(before.id), String(before.content), String(before.title ?? ''), actorId, Date.now(),
  );
}

/** Deleting a canvas takes every board on it. */
function tombstoneBoards(page: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM artboards WHERE page_id = ? AND deleted_at IS NULL`, String(page.id))) {
    writeEntity('artboard', String(row.id), {}, { ...system(opts), op: 'delete' });
  }
}

/**
 * Restoring a canvas brings back the boards that went with it, and only those:
 * one somebody deleted the week before is not part of what is being restored.
 */
function restoreBoards(page: Row, deletedAt: number, opts: WriteOpts): void {
  for (const row of all<Row>(
    `SELECT id FROM artboards WHERE page_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ?`,
    String(page.id), deletedAt,
  )) {
    writeEntity('artboard', String(row.id), {}, system(opts));
  }
}

/**
 * Give every board on a page its own fresh `seq`.
 *
 * One each rather than one for all: rows sharing a `seq` can be split by the
 * page-size cut in a pull, and the half after the cut would be skipped for
 * good.
 */
function restampBoards(page: Row): void {
  for (const row of all<Row>(`SELECT id FROM artboards WHERE page_id = ?`, String(page.id))) {
    run(`UPDATE artboards SET seq = ? WHERE id = ?`, nextSeq(), String(row.id));
  }
}

export const artboardRules = {
  // `page` too: what happens to a canvas happens to its boards.
  entities: ['artboard', 'page'],
  defaults(entity, id, values, opts, setForced) {
    if (entity !== 'artboard') return;
    if (!values.created_by) setForced('created_by', opts.actorId);
    if (!values.kind) setForced('kind', 'html');
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'artboard') guardBoard(values, existing, opts);
  },
  invariants(entity, id, values, existing, forced) {
    if (entity === 'artboard') applyBoardInvariants(values, existing, forced);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'artboard') {
      if (before && changed.content !== undefined) snapshotBoard(before, opts.actorId);
      return;
    }
    if (entity !== 'page' || !before) return;
    if (row.deleted_at && !before.deleted_at) tombstoneBoards(row, opts);
    if (!row.deleted_at && before.deleted_at) restoreBoards(row, Number(before.deleted_at), opts);
    if (changed.access !== undefined || changed.project_id !== undefined) restampBoards(row);
  },
} satisfies EntityRule;
