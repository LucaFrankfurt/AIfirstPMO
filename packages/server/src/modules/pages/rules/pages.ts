/**
 * What a page's body and its history live by.
 *
 * The text is a CRDT, so both halves of two people editing at once survive the
 * merge; the snapshot is what makes the losing half findable afterwards.
 */

import {
  crdt, defaultStatus, linkableTitle, PAGE_STATUS_KINDS, pageKey, renameLinks,
  type CrdtState, type EntityName, type PageFormat, type PageStatus, type PageStatusKind,
} from '@kolibri/shared';
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
 * Keep a page's text and its CRDT saying the same thing, and its format one of
 * the two things it may be.
 *
 * The format is folded to `markdown` rather than refused, and that is a
 * decision: `format` reaches here from an import, from MCP, from a `PATCH`
 * typed by hand and from a sync client three versions old, and the failure mode
 * of a rejected write is a page nobody can save. Markdown is the format that
 * renders anything safely — an HTML page read as markdown shows its tags, which
 * is ugly and honest — so an unknown value lands there.
 *
 * What is deliberately **not** here is sanitising. HTML is stored exactly as it
 * was typed and put through the allowlist at *render*, on every path, the way
 * markdown is escaped at render. Cleaning on write would look tidier and would
 * be worse in two ways: `content` has to keep saying what `body` says, so a
 * rewrite here would put the stored text and the CRDT permanently out of step —
 * and an editor whose source view silently loses the tag you are halfway
 * through typing is an editor people fight.
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
  if (values.format !== undefined) {
    const format: PageFormat = String(values.format) === 'html' ? 'html' : 'markdown';
    values.format = format;
    forced.format = format;
  }
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

/**
 * The rung a new page starts on, settled here rather than in the editor.
 *
 * Every door a page can arrive through — the editor, a template, an import,
 * `create_page` over MCP, plain REST — comes past this one, and a default that
 * lived in the client would be a default three of those five never applied.
 * Read from the workspace's own ladder, so a workspace that renamed, recoloured
 * or reordered its rungs gets what *it* calls a draft.
 *
 * Silent when the ladder is empty: a workspace may delete every status, and
 * `statusOf` already answers for a page that has none. Inventing a row here to
 * have something to point at would put back what somebody deleted on purpose.
 */
function startingStatus(workspaceId: string): string | null {
  const rows = all<Row>(
    `SELECT id, kind, sort_order FROM page_statuses
      WHERE workspace_id = ? AND deleted_at IS NULL`,
    workspaceId,
  );
  return defaultStatus(rows as unknown as PageStatus[])?.id ?? null;
}

/**
 * A rung has to be one of the three kinds, and a page has to point at a rung
 * of its own workspace.
 *
 * Both corrected rather than refused, which is the line `environmentRules`
 * already draws and for the same reason: an unknown kind is the shape of an
 * older client or a hand-written API call, and a status id from another
 * workspace is the shape of a copy-paste. Neither is somebody trying
 * something, and a 400 to a sync batch is a device that stops syncing.
 *
 * A status that simply no longer exists is left alone on purpose — `statusOf`
 * reads a dangling id as the draft, so deleting a rung does not have to walk
 * every page that stood on it.
 */
function settlePageStatus(entity: EntityName, values: Record<string, unknown>, forced: Record<string, unknown>, opts: WriteOpts): void {
  if (entity === 'pageStatus') {
    if (values.kind !== undefined && !PAGE_STATUS_KINDS.includes(values.kind as PageStatusKind)) {
      values.kind = 'draft';
      forced.kind = 'draft';
    }
    return;
  }
  if (values.status_id === undefined || !values.status_id) return;
  const status = get<Row>(
    `SELECT workspace_id FROM page_statuses WHERE id = ? AND deleted_at IS NULL`, values.status_id,
  );
  if (status && String(status.workspace_id) === String(opts.workspaceId)) return;
  values.status_id = null;
  forced.status_id = null;
}

export const pageRules = {
  entities: ['page', 'pageStatus'],
  defaults(entity, id, values, opts, setForced) {
    if (entity !== 'page') return;
    if (!values.created_by) setForced('created_by', opts.actorId);
    // `=== undefined` and not falsy: a client that deliberately sends `null`
    // is saying "no status", which a workspace with no ladder is entitled to
    // mean, and a default that overrode it would make that unsayable. This hook
    // is `applyCreateDefaults`, so there is no need to ask whether this is a
    // create — it is one.
    if (values.status_id === undefined) {
      const start = startingStatus(String(values.workspace_id ?? opts.workspaceId ?? ''));
      if (start) setForced('status_id', start);
    }
  },
  invariants(entity, id, values, existing, forced, opts) {
    settlePageStatus(entity, values, forced, opts);
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
