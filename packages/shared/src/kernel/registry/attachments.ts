/**
 * What a file may be attached to, in one list.
 *
 * Attachments began as a column: `task_id` on the `attachments` table, and a
 * screenshot belonged to a task or to nothing. `page_id` and `comment_id` were
 * added the same way, and each time the *rule* about who may see the row had to
 * be written a fourth time — in the pull filter, in the REST guard, in
 * `canSeeFile`, and in MCP's `findAttachment`. Four copies of one question is
 * the shape every access bug in this repository has had, and a fifth column
 * would have been a fifth copy.
 *
 * So anything that is not one of those three is named here instead, and hangs
 * off a `subject_kind` / `subject_id` pair. One list, read by:
 *
 * - `canSeeSubject` in the server's `repo.ts` — the rule, once
 * - `filterFor` in `sync/routes/sync.ts` — the same rule in SQL, which asks
 *   the *subject's own* clause rather than a second one written for files
 * - the upload route, MCP, and the web's `Attachments` component
 *
 * Adding a kind is a line in `ATTACHMENT_SUBJECTS` and a rule in
 * `canSeeSubject`; `check:schema` and `attachments.test.ts` refuse one that has
 * a name here and no rule there.
 *
 * ## Why the three keep their own columns
 *
 * They are not a special case being preserved out of sentiment. Three reasons,
 * and the third is the one that decides it:
 *
 * - They are indexed and queried by the hot paths — a task's Files section, a
 *   page's, the export's three `EXISTS`.
 * - Every client's IndexedDB already holds rows shaped that way, and this is an
 *   offline-first application: renaming a column means every device shows no
 *   files until it has re-synced from zero.
 * - A row would otherwise have two legal spellings. `{task_id}` and
 *   `{subject_kind: 'task'}` would be the same attachment, would not compare
 *   equal, and the de-duplication in `storeFile` would miss one of them.
 *
 * `attachmentLink` is the only place that knows which of the two spellings a
 * kind uses, and `attachmentSubject` is the only place that reads it back. No
 * caller chooses.
 */

/**
 * Everything a file may hang off.
 *
 * A comment is here because an attachment can hang off one; it is not a thing
 * the interface offers a paperclip for, since a comment's own editor is how a
 * file gets onto it.
 */
export const ATTACHMENT_SUBJECTS = [
  'task',
  'page',
  'comment',
  'project',
  'decision',
  'cycle',
  'module',
  'kpi',
  'budget',
  'product',
  'component',
] as const;

export type AttachmentSubject = (typeof ATTACHMENT_SUBJECTS)[number];

/** The three with a column of their own. See the docblock above for why. */
const NAMED_COLUMN = {
  task: 'task_id',
  page: 'page_id',
  comment: 'comment_id',
} as const satisfies Partial<Record<AttachmentSubject, string>>;

/** The kinds stored in `subject_kind` — everything the three columns cannot say. */
export const GENERIC_SUBJECTS: readonly AttachmentSubject[] =
  ATTACHMENT_SUBJECTS.filter((kind) => !(kind in NAMED_COLUMN));

const SUBJECTS = new Set<string>(ATTACHMENT_SUBJECTS);

export const isAttachmentSubject = (kind: unknown): kind is AttachmentSubject =>
  typeof kind === 'string' && SUBJECTS.has(kind);

/** The columns that put an attachment on this subject. The only writer of either spelling. */
export function attachmentLink(kind: AttachmentSubject, id: string): Record<string, string> {
  const column = NAMED_COLUMN[kind as keyof typeof NAMED_COLUMN];
  return column ? { [column]: id } : { subject_kind: kind, subject_id: id };
}

/** The shape of a row this can read — whatever carries the five columns. */
export interface AttachmentLink {
  task_id?: string | null;
  page_id?: string | null;
  comment_id?: string | null;
  subject_kind?: string | null;
  subject_id?: string | null;
}

/**
 * What this attachment hangs on, whichever spelling says so. The only reader.
 *
 * `null` is a real answer and not a failure: bytes with no attachment row at
 * all are every avatar and workspace logo, and a row that has lost its subject
 * — an unknown `subject_kind` from a newer version, say — is treated as loose
 * rather than as belonging to something this build cannot name. The callers
 * that must refuse rather than shrug say so themselves; see `canSeeFile`.
 */
export function attachmentSubject(row: AttachmentLink): { kind: AttachmentSubject; id: string } | null {
  if (row.task_id) return { kind: 'task', id: String(row.task_id) };
  if (row.page_id) return { kind: 'page', id: String(row.page_id) };
  if (row.comment_id) return { kind: 'comment', id: String(row.comment_id) };
  if (row.subject_id && isAttachmentSubject(row.subject_kind)) {
    return { kind: row.subject_kind, id: String(row.subject_id) };
  }
  return null;
}

/** The five columns that can say where a file hangs. */
export const LINK_COLUMNS = ['task_id', 'page_id', 'comment_id', 'subject_kind', 'subject_id'] as const;

/**
 * The row's link columns as the one link `attachmentSubject` reads — or `null`
 * when they already say it.
 *
 * The write path runs every attachment through this, so "exactly one of the
 * five is set" is enforced rather than asserted. Two things it corrects, and
 * the second is the one that is easy to miss:
 *
 * - **A generic spelling of one of the three.** `subject_kind: 'task'` is a
 *   perfectly sensible thing to ask for and the ambiguity is ours, so it is
 *   written as `task_id` rather than refused.
 * - **A write that would leave two links set.** A `PATCH` adding
 *   `subject_kind: 'decision'` to a row that still has its `task_id` is a
 *   caller who said where to put the file and not where to take it from. The
 *   named column wins — which is what `attachmentSubject` above already answers
 *   for such a row, so the stored row ends up saying what every reader reads —
 *   and the stray pair is cleared. Moving a file is therefore the explicit
 *   write: `{task_id: null, subject_kind: 'decision', subject_id: …}`.
 *
 * Corrected rather than thrown, and reported back through `forced`, for the
 * reason the sub-task loop in `work.ts` is: this write may be one row of a
 * batch from a device that has been away, and a refusal wedges its outbox.
 *
 * A `subject_kind` this build cannot name resolves to no subject and so would
 * be *cleared* here, turning a row nothing can resolve into a loose file. That
 * is not the answer, and it is not this function's to give: guards run before
 * invariants, so `guardAttachmentWrite` has already refused it by name.
 */
export function soleLink(row: AttachmentLink): Record<string, string | null> | null {
  const subject = attachmentSubject(row);
  const canonical: Record<string, string | null> = subject ? attachmentLink(subject.kind, subject.id) : {};
  const patch: Record<string, string | null> = {};
  for (const column of LINK_COLUMNS) {
    const want = canonical[column] ?? null;
    const have = row[column] ?? null;
    if (want !== have) patch[column] = want;
  }
  return Object.keys(patch).length ? patch : null;
}
