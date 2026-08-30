/**
 * What a page's body and its history live by.
 *
 * The text is a CRDT, so both halves of two people editing at once survive the
 * merge; the snapshot is what makes the losing half findable afterwards.
 */

import { crdt, type CrdtState } from '@kolibri/shared';
import { get, type Row, run } from '../../../kernel/platform/db/index.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { type EntityRule } from '../../../kernel/write-path/repo.ts';

const safeCrdt = (value: unknown): CrdtState | null => {
  if (typeof value !== 'string') return (value ?? null) as CrdtState | null;
  try { return JSON.parse(value) as CrdtState; } catch { return null; }
};

/**
 * Page history: we store the *previous* revision whenever content changes, and
 * collapse edits by the same author inside a short window so a typing session
 * does not produce hundreds of versions.
 */
const VERSION_WINDOW_MS = 10 * 60 * 1000;

/**
 * Keep a page's text and its CRDT saying the same thing.
 *
 * Two directions, and which one applies is decided by what the writer sent:
 *
 * - A **`body`** means an editor that understands the CRDT. `content` is
 *   whatever the merged state reads as, and any `content` sent alongside is
 *   ignored — it was computed before the merge and is now out of date.
 * - A **`content`** on its own means somebody who does not: the API, MCP, an
 *   import, a rule. That is a replacement and it says so — the CRDT is rebuilt
 *   from the text, because a caller who sent a whole document meant the whole
 *   document, and quietly merging it into somebody's half-finished paragraph
 *   would be the surprising reading of it.
 */
function applyPageInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  if (values.body !== undefined && values.body !== null) {
    const text = crdt.textOf(safeCrdt(values.body));
    values.content = text;
    forced.content = text;
    return;
  }
  if (values.content !== undefined) {
    const state = crdt.fromText(String(values.content ?? ''), 'server');
    values.body = JSON.stringify(state);
    forced.body = state;
  } else if (existing && !existing.body && existing.content) {
    // A page written before any of this existed gets its CRDT the first time
    // anything else about it is touched, rather than on a migration that would
    // have to rewrite every row at once.
    values.body = JSON.stringify(crdt.fromText(String(existing.content), 'server'));
  }
}
function snapshotPage(before: Row, actorId: string): void {
  if (!before.content) return;
  const latest = get<Row>(
    `SELECT content, author_id, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    before.id,
  );
  if (latest?.content === before.content) return;
  if (latest && latest.author_id === actorId && Date.now() - Number(latest.created_at) < VERSION_WINDOW_MS) return;
  run(
    `INSERT INTO page_versions (id, page_id, content, title, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    uid(), before.id, before.content, before.title ?? '', actorId, Date.now(),
  );
}



export const pageRules = {
  entities: ['page'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'page' && !values.created_by) setForced('created_by', opts.actorId);
  },
  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'page') applyPageInvariants(values, existing, forced);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'page' && before && changed.content !== undefined) snapshotPage(before, opts.actorId);
  },
} satisfies EntityRule;
