/**
 * What a page's body and its history live by.
 *
 * The text is a CRDT, so both halves of two people editing at once survive the
 * merge; the snapshot is what makes the losing half findable afterwards.
 */

import { crdt, linkableTitle, pageKey, renameLinks, type CrdtState } from '@kolibri/shared';
import { all, get, type Row, run } from '../../../kernel/platform/db/index.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

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



/**
 * The pages whose `[[…]]` would move if this page were called something else.
 *
 * Separated from the write below because two callers want different things
 * from the same question: the effect wants the new text so it can write it,
 * and `update_page` wants the count so it can say what it did. One answer,
 * asked twice, rather than the loop written twice.
 *
 * A title holding `[`, `]` or `|` cannot be spelled inside a link at all, so
 * there is nothing to follow it with — the rename still happens and the links
 * stay where they are, which is the smaller of the two surprises.
 */
export function renameFollowers(
  pageId: string,
  workspaceId: string,
  was: string,
  next: string,
): { id: string; body: CrdtState | null; text: string }[] {
  const from = was.trim();
  const to = next.trim();
  if (!from || !to || pageKey(from) === pageKey(to) || !linkableTitle(to)) return [];
  const out: { id: string; body: CrdtState | null; text: string }[] = [];
  for (const row of all<Row>(
    `SELECT id, body, content FROM pages WHERE workspace_id = ? AND deleted_at IS NULL AND id <> ?`,
    workspaceId, pageId,
  )) {
    const content = String(row.content ?? '');
    const rewritten = renameLinks(content, from, to);
    if (rewritten === null || rewritten === content) continue;
    out.push({ id: String(row.id), body: safeCrdt(row.body), text: rewritten });
  }
  return out;
}

/**
 * Rename a page and keep the links to it pointing at it.
 *
 * In the write path rather than in each client, and that is the decision worth
 * stating. A wiki where renaming a page breaks every link to it is a wiki where
 * people stop renaming pages, and then stop linking to them — so "links follow
 * titles" is an invariant of the thing, not a convenience of one screen. Here
 * it holds for the interface, for MCP, for a `PATCH` typed into curl and for
 * whatever writes next.
 *
 * It is written as a **CRDT edit and not as `content`**, which is the whole
 * safety of it. A content write rebuilds the body from text, so renaming a page
 * while a colleague was mid-paragraph in a page that links to it would have
 * replaced their paragraph with the version this process happened to hold. An
 * edit against the stored state deletes only the characters it can see, and
 * theirs are not among them.
 *
 * The one place it does not run is a `system` write — a seed, an import, a
 * cascade. Those set titles in bulk on documents that already agree with each
 * other, and a rename each would be a quadratic rewrite of a workspace at the
 * moment it is being restored.
 */
function followRename(page: Row, was: string, next: string, opts: WriteOpts): void {
  const workspaceId = String(page.workspace_id ?? '');
  if (!workspaceId) return;
  for (const other of renameFollowers(String(page.id), workspaceId, was, next)) {
    writeEntity('page', other.id, {
      body: crdt.edit(other.body, other.text, 'server'),
    }, { ...opts, op: undefined, system: true, silent: true });
  }
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
    if (entity !== 'page' || !before) return;
    if (changed.content !== undefined) snapshotPage(before, opts.actorId);
    // After the snapshot, so the page's own history records the rename against
    // the text as it was — and never on a system write; see `followRename`.
    if (changed.title !== undefined && !opts.system) {
      followRename(row, String(before.title ?? ''), String(row.title ?? ''), opts);
    }
  },
} satisfies EntityRule;
