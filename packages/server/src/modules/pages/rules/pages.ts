/**
 * What a page's body and its history live by.
 *
 * The text is a CRDT, so both halves of two people editing at once survive the
 * merge; the snapshot is what makes the losing half findable afterwards.
 */

import {
  crdt, defaultStatus, LABEL_SCOPES, linkableTitle, orderKey, PAGE_STATUS_KINDS, pageKey, renameLinks, supersededStatus,
  type CrdtState, type EntityName, type LabelScope, type PageFormat, type PageStatus, type PageStatusKind,
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
 * the four things it may be.
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
 *   import, a rule. That is a replacement and it says so — the CRDT is written
 *   to read as the text, because a caller who sent a whole document meant the
 *   whole document, and quietly merging it into somebody's half-finished
 *   paragraph would be the surprising reading of it. `replacementBody` below
 *   is where that is done, and why it is a replacement *of* the old state
 *   rather than a new one beside it.
 */
function applyPageInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  if (values.format !== undefined) {
    // `canvas` and `board` keep their boards in rows of their own, so the text
    // columns of such a page carry on being an ordinary (and usually empty)
    // markdown text.
    const raw = String(values.format);
    const format: PageFormat = raw === 'html' || raw === 'canvas' || raw === 'board' ? raw : 'markdown';
    values.format = format;
    forced.format = format;
  }
  // A yes or a no, whatever arrived: the assistant asks `= 1`, and a `true`
  // or a `"1"` stored as written would be a page marked in one place only.
  if (values.public_knowledge !== undefined) {
    const marked = values.public_knowledge === true || Number(values.public_knowledge) === 1 ? 1 : 0;
    if (marked !== values.public_knowledge) {
      values.public_knowledge = marked;
      forced.public_knowledge = marked;
    }
  }
  settleCrdtText(values, existing, forced, PAGE_TEXT);
}

/**
 * Which column holds a CRDT and which holds what it reads as.
 *
 * A page is the first pair and an agenda point's notes are the second. The
 * rule between the two columns is the same for both, and it is subtle enough
 * — see `replacementBody` — that a second copy of it would be the copy that
 * drifts.
 */
export interface CrdtText {
  state: string;
  text: string;
}

const PAGE_TEXT: CrdtText = { state: 'body', text: 'content' };

/**
 * Keep a text column and the CRDT under it saying the same thing.
 *
 * The two directions described above `applyPageInvariants`, for any pair of
 * columns: a state that arrived decides the text, and a text that arrived on
 * its own replaces the state.
 */
export function settleCrdtText(
  values: Record<string, unknown>,
  existing: Row | undefined,
  forced: Record<string, unknown>,
  columns: CrdtText,
): void {
  const { state, text } = columns;
  if (values[state] !== undefined && values[state] !== null) {
    const derived = crdt.textOf(safeCrdt(values[state]));
    values[text] = derived;
    forced[text] = derived;
    return;
  }
  if (values[text] !== undefined) {
    const next = replacementBody(existing, String(values[text] ?? ''), columns);
    values[state] = JSON.stringify(next);
    forced[state] = next;
  } else if (existing && !existing[state] && existing[text]) {
    // A row written before any of this existed gets its CRDT the first time
    // anything else about it is touched, rather than on a migration that would
    // have to rewrite every row at once.
    values[state] = JSON.stringify(seedBody(String(existing[text])));
  }
}
/**
 * The state a page has when its text arrives with no CRDT behind it.
 *
 * `'server'` is a *shared* agent name on purpose: a device that has the text
 * but not yet the state seeds itself the same way (`pages/collab.ts`), and two
 * replicas that independently seed the same text have to agree about it
 * character for character or the first merge invents a document neither of
 * them has.
 */
const seedBody = (text: string): CrdtState => crdt.fromText(text, 'server');

/**
 * The state for a whole document that replaces whatever is there.
 *
 * This is `crdt.edit` rather than `crdt.fromText`, and the difference is a bug
 * that reached a reader. `fromText` mints the identities `server:0, server:1,
 * …` every time it is called, so two rebuilds of the same page named *the same
 * characters* and gave them different letters — and `crdt.merge` keeps the one
 * it already has, because an identity it has already seen is by definition not
 * news. The server was therefore right, and every device that had seen the
 * earlier text went on holding it for ever: the page read correctly everywhere
 * it is rendered from `content`, and the editor — the one screen that reads the
 * CRDT — opened on the old draft. Nothing in the merge could notice, since
 * "this id means a different letter on your side" is not a state the model
 * admits.
 *
 * Editing the existing state instead says what a replacement actually means:
 * what went is tombstoned, what arrived gets clocks nobody has used, and a
 * replica merging the two lands on the text that was written. The common
 * prefix and suffix are kept, so the usual one-line edit over MCP stays a
 * one-line edit rather than a whole new document.
 */
function replacementBody(existing: Row | undefined, text: string, columns: CrdtText = PAGE_TEXT): CrdtState {
  const before = safeCrdt(existing?.[columns.state])
    // A page with text and no state yet: the replacement has to supersede the
    // seed, because that is what any device holding the page already has.
    ?? (existing?.[columns.text] ? seedBody(String(existing[columns.text])) : null);
  return before ? crdt.edit(before, text, 'server') : seedBody(text);
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
 * Keep what a page says now as a version with a name — "V5", "as approved".
 *
 * The other half of `snapshotPage`, and the half people asked for by working
 * around its absence: with only the automatic snapshots, the way to say "this
 * is version 5" was to copy the page and type `V5` into the copy's title. Then
 * every `[[link]]` kept pointing at version 4, because a link resolves by
 * title, and the wiki on the first real instance held six prices side by side.
 * A named version is the same page with a marker in its history, so the links
 * keep landing on the current text and the old one is still one click away.
 *
 * Stores the *current* text, where `snapshotPage` stores the previous one: a
 * name is said about what is on the screen. The next automatic snapshot
 * compares against this row and skips itself when nothing changed, so naming
 * a version never doubles it.
 */
export function nameVersion(page: Row, actorId: string, name: string, note: string | null, id: string = uid()): string {
  run(
    `INSERT INTO page_versions (id, page_id, content, title, author_id, created_at, name, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, page.id, String(page.content ?? ''), String(page.title ?? ''), actorId, Date.now(), name, note,
  );
  return id;
}

/**
 * A page's history as a list: every named version, and the newest hundred the
 * server kept on its own.
 *
 * The hundred was the whole list, and a busy page's first versions fell off
 * it. A named one never does — somebody said it mattered — so the two are
 * asked for separately and drawn as one, newest first.
 */
export function listVersions(pageId: string): Row[] {
  return all<Row>(
    `SELECT id, title, author_id, created_at, length(content) AS size, name, note FROM page_versions
      WHERE page_id = ?1
        AND (name IS NOT NULL
             OR id IN (SELECT id FROM page_versions WHERE page_id = ?1 AND name IS NULL ORDER BY created_at DESC LIMIT 100))
      ORDER BY created_at DESC`,
    pageId,
  );
}

/**
 * A key after every sibling under `parentId`, so a new page lands at the bottom.
 *
 * Every door a page arrives through comes past `defaults` below, and that is
 * where this is used. It was the MCP tools' own helper, used only when a page
 * was *moved*: a page *created* over MCP, filed as meeting minutes or posted to
 * REST without a key got the column's default `V` — and on the first real wiki
 * 57 of 77 pages carried it, 41 of them side by side at the top level, drawn in
 * whatever order each device's store happened to hold them.
 */
export function lastPageOrder(workspaceId: string, parentId: string | null): string {
  const last = get<Row>(
    `SELECT sort_order FROM pages
      WHERE workspace_id = ? AND deleted_at IS NULL
        AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}
      ORDER BY sort_order DESC LIMIT 1`,
    ...(parentId ? [workspaceId, parentId] : [workspaceId]),
  );
  return orderKey((last?.sort_order as string | null) ?? null, null);
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

/** A yes or a no, however it arrived — see `public_knowledge` above. */
function settleFlag(field: string, values: Record<string, unknown>, forced: Record<string, unknown>): void {
  if (values[field] === undefined) return;
  const flag = values[field] === true || Number(values[field]) === 1 ? 1 : 0;
  if (flag !== values[field]) {
    values[field] = flag;
    forced[field] = flag;
  }
}

/**
 * The page's type and its successor point inside its own workspace, or at
 * nothing.
 *
 * Corrected rather than refused, for the reason `settlePageStatus` gives: a
 * foreign id is a copy-paste or a transfer, and a 400 to a sync batch is a
 * device that stops syncing. `guardReferences` cannot do this for them — it
 * knows columns by name, and neither of these names its table.
 *
 * A page replaced by itself is folded to nothing as well: it is the one value
 * that would make `isSuperseded` true with nowhere to send the reader.
 */
function settlePageLinks(id: string, values: Record<string, unknown>, forced: Record<string, unknown>, opts: WriteOpts): void {
  if (values.type_id) {
    const type = get<Row>(`SELECT workspace_id FROM page_types WHERE id = ? AND deleted_at IS NULL`, values.type_id);
    if (!type || String(type.workspace_id) !== String(opts.workspaceId)) {
      values.type_id = null;
      forced.type_id = null;
    }
  }
  if (values.superseded_by) {
    const successor = get<Row>(`SELECT workspace_id FROM pages WHERE id = ?`, values.superseded_by);
    if (values.superseded_by === id || (successor && String(successor.workspace_id) !== String(opts.workspaceId))) {
      values.superseded_by = null;
      forced.superseded_by = null;
    }
  }
}

/**
 * Saying what replaced a page puts it on the `superseded` rung, from any door —
 * and taking that back takes it off again.
 *
 * Only when the write did not also say where the page stands — a client that
 * sends both has decided — and only when the ladder has such a rung. A
 * workspace without one still gets the pointer, and `isSuperseded` reads that
 * alone; inventing a rung here would put back one somebody deleted.
 *
 * The way back was missing at first, and review found it from both ends:
 * clearing "replaced by" left the page on the superseded rung, so it went on
 * saying it was replaced, with nothing left to say by what — struck through
 * in the tree and kept from the support assistant. Now a page whose successor
 * is cleared while it stands on that rung goes to the draft, which is what a
 * page nobody has said anything new about is.
 */
function followSuccessor(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>, opts: WriteOpts): void {
  if (values.superseded_by === undefined || values.status_id !== undefined) return;
  const named = !!values.superseded_by;
  if (!named && !existing?.superseded_by) return;
  const rungs = all<Row>(
    `SELECT id, kind, sort_order FROM page_statuses WHERE workspace_id = ? AND deleted_at IS NULL`,
    String(opts.workspaceId ?? existing?.workspace_id ?? ''),
  ) as unknown as PageStatus[];
  const current = rungs.find((rung) => rung.id === existing?.status_id);
  const target = named
    ? (current?.kind === 'superseded' ? undefined : supersededStatus(rungs))
    : (current?.kind === 'superseded' ? defaultStatus(rungs) : undefined);
  if (!target) return;
  values.status_id = target.id;
  forced.status_id = target.id;
}

/**
 * What "Final" was said about, kept beside the page.
 *
 * A rung is a claim about a text, and the text kept moving under it: on the
 * first real wiki a pricing paper stood on "Final" after three newer pricing
 * models had overtaken it, and nothing on the page could say so. Now reaching
 * a `final` rung cuts a named version of the text as it stands, and every
 * later edit records whether the text still matches it — `settled_drift`,
 * which the page draws as "changed since Final" with the difference one click
 * away. Leaving the rung clears both: a page that no longer claims to be
 * finished has nothing to drift from.
 *
 * Deliberately not a demotion. A typo fixed in a finished handbook is not a
 * draft, and a status that fell back on every keystroke would teach people to
 * stop using the top rung at all. The reader is told; the rung stays.
 *
 * The version row itself is written in `effects`, after the page row exists —
 * its id is minted here so the page and its version name each other in the
 * same write, and `effects` recognises a cut as an id no version has yet.
 */
function settleFinal(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const moved = values.status_id !== undefined && values.status_id !== (existing?.status_id ?? null);
  if (moved) {
    const rung = values.status_id
      ? get<Row>(`SELECT kind FROM page_statuses WHERE id = ? AND deleted_at IS NULL`, values.status_id)
      : undefined;
    if (rung?.kind === 'final') {
      const version = uid();
      values.settled_version_id = version;
      values.settled_drift = 0;
      forced.settled_version_id = version;
      forced.settled_drift = 0;
      return;
    }
    if (existing?.settled_version_id) {
      values.settled_version_id = null;
      values.settled_drift = 0;
      forced.settled_version_id = null;
      forced.settled_drift = 0;
    }
    return;
  }
  // The text moved under a rung that is still final: does it still say what was settled?
  if (values.content === undefined || !existing?.settled_version_id) return;
  const settled = get<Row>(`SELECT content FROM page_versions WHERE id = ?`, existing.settled_version_id);
  if (!settled) return;
  const drift = String(values.content ?? '') === String(settled.content ?? '') ? 0 : 1;
  if (drift !== Number(existing.settled_drift ?? 0)) {
    values.settled_drift = drift;
    forced.settled_drift = drift;
  }
}

/**
 * A label's scope is one of three words, whatever arrived.
 *
 * Folded rather than refused, like a rung's kind: the column is NOT NULL, so a
 * `null` from a hand-written PATCH or an older client was a raw constraint
 * error and a sync batch the device could not get past. Here because the
 * column exists for pages' sake — a rule may speak for another module's entity.
 */
function settleLabelScope(values: Record<string, unknown>, forced: Record<string, unknown>): void {
  if (values.applies_to === undefined) return;
  if (LABEL_SCOPES.includes(values.applies_to as LabelScope)) return;
  values.applies_to = 'all';
  forced.applies_to = 'all';
}

export const pageRules = {
  entities: ['page', 'pageStatus', 'pageType', 'label'],
  defaults(entity, id, values, opts, setForced) {
    if (entity !== 'page') return;
    if (!values.created_by) setForced('created_by', opts.actorId);
    // At the bottom of its siblings, from every door — see `lastPageOrder`.
    if (values.sort_order === undefined || values.sort_order === null || values.sort_order === '') {
      setForced('sort_order', lastPageOrder(
        String(values.workspace_id ?? opts.workspaceId ?? ''),
        (values.parent_id as string | null | undefined) ?? null,
      ));
    }
    // `=== undefined` and not falsy: a client that deliberately sends `null`
    // is saying "no status", which a workspace with no ladder is entitled to
    // mean, and a default that overrode it would make that unsayable. This hook
    // is `applyCreateDefaults`, so there is no need to ask whether this is a
    // create — it is one.
    // Not for a page created already replaced — an import of history, an
    // assistant filing last year's model with `replaced_by`: the rung is
    // `followSuccessor`'s to choose, and a draft put here first would read as
    // the writer having chosen it.
    if (values.status_id === undefined && !values.superseded_by) {
      const start = startingStatus(String(values.workspace_id ?? opts.workspaceId ?? ''));
      if (start) setForced('status_id', start);
    }
  },
  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'label') {
      settleLabelScope(values, forced);
      return;
    }
    if (entity === 'pageType') return;
    settlePageStatus(entity, values, forced, opts);
    if (entity !== 'page') return;
    applyPageInvariants(values, existing, forced);
    settleFlag('pinned', values, forced);
    settleFlag('series', values, forced);
    settlePageLinks(id, values, forced, opts);
    followSuccessor(values, existing, forced, opts);
    // Last: it reads the rung `followSuccessor` may have chosen and the text
    // `applyPageInvariants` derived from the CRDT.
    settleFinal(values, existing, forced);
  },
  effects(entity, row, before, changed, opts) {
    if (entity !== 'page') return;
    // The text as it was, first: the cut below is newer, and the snapshot's
    // own collapsing would otherwise read it as this author's latest version
    // and skip the text that came before it.
    if (before && changed.content !== undefined) snapshotPage(before, opts.actorId);
    // The version "Final" was said about, now that there is a page row to read
    // it from: the id `settleFinal` minted in this write, which no version has
    // yet. The transfers clear the column rather than carry it, because an id
    // from another workspace names a version of another page.
    const cut = typeof changed.settled_version_id === 'string' ? changed.settled_version_id : null;
    if (cut && !get<Row>(`SELECT 1 AS hit FROM page_versions WHERE id = ?`, cut)) {
      const rung = get<Row>(`SELECT name FROM page_statuses WHERE id = ?`, row.status_id);
      nameVersion(row, opts.actorId, String(rung?.name ?? 'Final'), null, cut);
    }
    if (!before) return;
    // After the snapshot, so the page's own history records the rename against
    // the text as it was — and never on a system write; see `followRename`.
    if (changed.title !== undefined && !opts.system) {
      followRename(row, String(before.title ?? ''), String(row.title ?? ''), opts);
    }
  },
} satisfies EntityRule;
