/**
 * The rules a task, a project and the things hung off them live by.
 *
 * `guardTransition` goes through the `guards` hook for the same reason chat's
 * three do: a column can name the roles allowed to receive work, which is a
 * permission check and is skipped for the server's own writes.
 */

import {
  ENTITIES, ENTITY_NAMES, LINK_COLUMNS, type EntityName, attachmentSubject, isAttachmentSubject, isDoneGroup,
  type ProjectVocabulary, relocate, soleLink,
} from '@kolibri/shared';
import { all, get, type Row, run } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import {
  canSeePage, canSeeSubject, canSeeTask, type EntityRule, isWorkspaceAdmin, parseIds, settleAuthored, wouldLoop,
  writeEntity, type WriteOpts,
} from '../../../kernel/write-path/repo.ts';

const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const ROLE_RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * Who may move a task into a column.
 *
 * A state can name the workspace roles allowed to receive work — "only a lead
 * marks something done". Empty means anybody who can write, which is every
 * column until somebody says otherwise. Checked here rather than in the
 * interface, because the interface is not the only way in: REST, MCP and a
 * phone that was offline all come through this function.
 *
 * Rules never apply to the server's own writes: an automation, an import or a
 * recurrence rolling a task forward is not a person moving a card.
 */
function guardTransition(stateId: string, opts: WriteOpts): void {
  const state = get<Row>(`SELECT name, allowed_roles FROM states WHERE id = ?`, stateId);
  if (!state) return;
  let allowed: string[] = [];
  try {
    const parsed = JSON.parse(String(state.allowed_roles ?? '[]'));
    if (Array.isArray(parsed)) allowed = parsed.map(String);
  } catch { /* a column with an unreadable rule is a column with no rule */ }
  if (!allowed.length) return;

  const role = get<Row>(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    opts.workspaceId, opts.actorId,
  )?.role as string | undefined;
  // A role that outranks every role named is allowed: naming "member" and
  // meaning "and not an owner" is not what anybody writes down.
  const bar = Math.min(...allowed.map((name) => ROLE_RANK[name] ?? 99));
  if (role && (allowed.includes(role) || (ROLE_RANK[role] ?? -1) >= bar)) return;

  throw forbidden(`Only ${allowed.join(' or ')} may move work into “${state.name}”`);
}
function applyTaskInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const stateId = (values.state_id ?? existing?.state_id) as string | undefined;
  if (values.state_id !== undefined && stateId) {
    const state = get<{ group_key: string }>(`SELECT group_key FROM states WHERE id = ?`, stateId);
    const done = isDoneGroup(state?.group_key);
    const wasDone = existing?.completed_at != null;
    if (done && !wasDone) {
      values.completed_at = Date.now();
      forced.completed_at = values.completed_at;
    } else if (!done && wasDone) {
      values.completed_at = null;
      forced.completed_at = null;
    }
  }
}
/**
 * What a project offers, read out of SQLite.
 *
 * The mirror image of the interface's own reader — the rule that consumes this
 * is one shared function, so the two cannot drift apart about what "the same
 * column in another project" means.
 */
function vocabularyOf(projectId: string): ProjectVocabulary {
  return {
    states: all<Row>(
      `SELECT id, group_key, sort_order FROM states WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), group_key: row.group_key as never, sort_order: String(row.sort_order ?? '') })),
    labels: all<Row>(
      `SELECT id, name FROM labels WHERE project_id = ? AND deleted_at IS NULL`, projectId,
    ).map((row) => ({ id: String(row.id), name: String(row.name ?? '') })),
    defaultStateId: asId(get<Row>(`SELECT default_state_id FROM projects WHERE id = ?`, projectId)?.default_state_id),
  };
}
/**
 * A field that is gone takes its answers with it.
 *
 * Tombstones rather than a `DELETE`, because every other device has those rows
 * too and only a tombstone tells them. Written through the same path, so they
 * get a sequence number and reach the clients on the next pull.
 */
function tombstoneValuesOf(field: Row, opts: WriteOpts): void {
  const values = all<Row>(`SELECT id FROM field_values WHERE field_id = ? AND deleted_at IS NULL`, field.id);
  for (const value of values) {
    writeEntity('fieldValue', String(value.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
}



/**
 * What a project contains, read from the registry rather than listed here.
 *
 * Every entity with a `project_id` belongs to the project that column names —
 * that is what the column means — so the cascade is derived rather than
 * enumerated, and an entity added later is carried without anybody
 * remembering to come back. The alternative was a list of twenty-five names
 * that would be twenty-four the first time somebody added one.
 *
 * `activity` is the one exception, and it is a real one: the log is the record
 * that the thing existed and who did what to it. A deletion that erased its
 * own history would be the one kind of deletion nobody could audit. It is not
 * a collection either — the registry already keeps it out of REST for the same
 * reason.
 */
const CONTAINED = ENTITY_NAMES.filter(
  (name) => name !== 'activity' && (ENTITIES[name].fields as readonly string[]).includes('project_id'),
);

/**
 * A deleted project takes its contents with it, and a restored one brings them
 * back.
 *
 * Nothing cascaded before, and the result was not a display problem. A task's
 * `project_id` is `NOT NULL`, so a task whose project is gone is structurally
 * an orphan: it stayed live in every list, in every report and on every synced
 * device, while `list_projects` and every project-scoped call refused the
 * project it named. `DOOM-1` sat in somebody's own work with no `DOOM` to open.
 *
 * The worse half was invisible. `purgeable()` collects rows with a
 * `deleted_at`, and those tasks had none — so emptying the trash removed the
 * project and left its contents behind **permanently**, unreachable and
 * un-purgeable, in every workspace where a project had ever been deleted.
 *
 * Tombstones rather than a `DELETE`, for the reason `docs/sync.md` gives and
 * `tombstoneValuesOf` above follows: every other device holds these rows and
 * only a tombstone tells it otherwise. `silent` keeps the live stream to one
 * nudge instead of one per row; the webhooks are deliberately *not* silenced,
 * because there is no `project.deleted` event a receiver could infer the rest
 * from, and a mirror that never hears about five hundred deleted tasks is a
 * mirror holding five hundred tasks that no longer exist.
 *
 * **Restoring takes back exactly what this deletion took.** Anything already
 * in the trash before the project went stays there, which is what
 * `deleted_at >= ` the project's own timestamp says: the cascade stamps its
 * rows in the same transaction, so they are at or after it, and a row somebody
 * deleted last week is before it. The one case it reads wrong is a row deleted
 * in the same millisecond as the project, which comes back with it — a
 * bounded, harmless mistake next to keeping a list of what was taken.
 */
function cascadeProject(project: Row, restoring: boolean, opts: WriteOpts): void {
  const write = (entity: EntityName, id: string) =>
    writeEntity(entity, id, {}, { ...opts, system: true, silent: true, ...(restoring ? {} : { op: 'delete' as const }) });

  for (const entity of CONTAINED) {
    const rows = restoring
      ? all<Row>(
        `SELECT id FROM ${ENTITIES[entity].table} WHERE project_id = ? AND deleted_at >= ?`,
        project.id, Number(project.deleted_at ?? 0),
      )
      : all<Row>(
        `SELECT id FROM ${ENTITIES[entity].table} WHERE project_id = ? AND deleted_at IS NULL`, project.id,
      );
    for (const row of rows) write(entity, String(row.id));
  }

  /* A project nests, so a container takes its children — and each child's own
     effect takes it from there, which is why this recurses without saying so.
     The tree cannot loop: `wouldLoop` refuses a parent that would make one. */
  const children = restoring
    ? all<Row>(`SELECT id FROM projects WHERE parent_id = ? AND deleted_at >= ?`, project.id, Number(project.deleted_at ?? 0))
    : all<Row>(`SELECT id FROM projects WHERE parent_id = ? AND deleted_at IS NULL`, project.id);
  for (const child of children) write('project', String(child.id));
}

/**
 * A task that changed projects, and everything on it that belonged to the old
 * one.
 *
 * The interface performs the move itself so the board reacts without a round
 * trip; this is the same rule applied where the interface is not the caller —
 * a `PATCH {project_id}` over REST, an MCP call, an import, an automation,
 * any of which would otherwise leave the row in a column its new board does
 * not have and wearing labels nothing can render.
 *
 * Each field is checked rather than overwritten, so a client that already did
 * the work is left alone and only what is actually wrong comes back `forced`.
 */
function settleProjectMove(
  values: Record<string, unknown>, existing: Row, forced: Record<string, unknown>,
): void {
  const destination = String(values.project_id);

  /**
   * A container holds projects, not tasks — so nothing may be moved into one.
   *
   * The rule itself is old: a project with tasks in it is refused the flag, a
   * few lines further down. The hole was the other direction. Nothing stopped
   * a `PATCH {project_id: <a container>}`, and the interface's own guard is in
   * `moveTaskToProject`, which REST, MCP, an import and an automation all go
   * around. A container renders a list of projects and no board at all, so the
   * task arrived somewhere with no screen that shows it.
   *
   * Refused the way the flag is, through `forced` rather than a throw: this
   * write may be one row of a batch from a device that has been away.
   */
  if (Number(get<Row>(`SELECT is_container FROM projects WHERE id = ?`, destination)?.is_container ?? 0) === 1) {
    values.project_id = existing.project_id;
    forced.project_id = values.project_id;
    return;
  }

  const landing = relocate(
    {
      state_id: asId(existing.state_id),
      labels: parseIds(existing.labels),
      cycle_id: asId(existing.cycle_id),
      module_id: asId(existing.module_id),
    },
    vocabularyOf(String(existing.project_id)),
    vocabularyOf(destination),
  );
  const effective = (field: string): unknown => (values[field] !== undefined ? values[field] : existing[field]);
  const belongs = (table: 'states' | 'labels', value: unknown): boolean =>
    typeof value === 'string' && !!get<Row>(
      `SELECT 1 AS found FROM ${table} WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
      value, destination,
    );

  /**
   * The same question for a cycle or a module, which are not one project's.
   *
   * Both may cover several projects or all of them, so `project_id = ?` is
   * the wrong test: a shared fortnight has no owner at all, so a task moved
   * from Web to Mobile *inside that fortnight* failed the check and was
   * silently dropped out of it. Nobody would have attributed that to the
   * move. `coversProject` is the rule in TypeScript; this is it in SQL.
   */
  const covers = (table: 'cycles' | 'modules', value: unknown): boolean =>
    typeof value === 'string' && !!get<Row>(
      `SELECT 1 AS found FROM ${table}
        WHERE id = ? AND deleted_at IS NULL
          AND ((json_array_length(projects) = 0 AND (project_id IS NULL OR project_id = ?))
               OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value = ?))`,
      value, destination, destination,
    );
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };

  if (!belongs('states', effective('state_id'))) settle('state_id', landing.state_id);
  if (parseIds(effective('labels')).some((label) => !belongs('labels', label))) {
    settle('labels', JSON.stringify(landing.labels));
  }
  // Cleared only when the destination really is outside them — a shared one
  // follows the task across, which is the whole point of it being shared.
  if (asId(effective('cycle_id')) && !covers('cycles', effective('cycle_id'))) settle('cycle_id', null);
  if (asId(effective('module_id')) && !covers('modules', effective('module_id'))) settle('module_id', null);
}

/**
 * The sub-tasks of a task that moved, which go where their parent went.
 *
 * A sub-task is not filed on its own: it is part of the piece of work above
 * it, and the only screen that lists it beside its siblings is that parent's.
 * Leaving the children behind splits one job across two boards — each child
 * still in the old project, each breadcrumb pointing at a parent that is no
 * longer there, and each child's state, labels and cycle still the old
 * project's while the parent's are the new one's.
 *
 * The whole sub-tree rather than the floor below, walked here rather than left
 * to each child's own effect to continue. A child that is *already* in the
 * destination needs no write, and no write means no effect — so recursing that
 * way would stop at it and leave its own children behind, which is the one
 * shape the client would have moved. `seen` is what makes a tree that arrived
 * looped from two offline devices terminate rather than spin; `descendants` in
 * `@kolibri/shared` is the same walk over a list, and the client calls that.
 *
 * Not `system`, because this *is* a change somebody made and each child's own
 * history should say so. `silent` for the reason the project cascade is: the
 * parent's own write publishes last, and one nudge is enough for a client to
 * pull the lot.
 */
function followParent(task: Row, opts: WriteOpts): void {
  const destination = String(task.project_id);
  const seen = new Set<string>([String(task.id)]);
  const queue = [String(task.id)];

  while (queue.length) {
    for (const child of all<Row>(`SELECT id, project_id FROM tasks WHERE parent_id = ? AND deleted_at IS NULL`, queue.shift())) {
      const id = String(child.id);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
      if (String(child.project_id) === destination) continue;
      writeEntity('task', id, { project_id: destination }, { ...opts, op: 'upsert', silent: true });
    }
  }
}

/**
 * Whether this person may change this comment.
 *
 * Written the day comments became editable, and the hole it closes predates
 * that: `body` was an ordinary synced field with no rule on it at all, so
 * `PATCH /api/comments/<id>` from any member who could see the task rewrote
 * a colleague's words under that colleague's name — and `DELETE` removed them.
 * Nothing in the interface offered it, which is exactly why it survived: the
 * screen only ever showed the pencil to the author, and the screen is not the
 * only way in. The matching rule for a message has been in `chat.ts` since
 * messages were editable, and this is deliberately the same shape.
 *
 * Three cases, because a comment has one a message does not:
 *
 * - **Your own.** Anything. That is what editing is.
 * - **Somebody else's.** A reaction and nothing else — your own name in a list
 *   beside their words is not a change to them. Anything alongside it is an
 *   edit, including the `deleted_at` a delete arrives as.
 * - **A guest's**, left through a public share link, with no account behind it.
 *   Nobody may rewrite it: there is no author to be, and putting words in an
 *   outsider's mouth under the name they typed is worse than either of the
 *   above. It still has to be removable — a share link is a door to strangers —
 *   so an admin or owner may delete it, and only delete it.
 */
function guardCommentWrite(values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (!existing) return;
  const reactingOnly = Object.keys(values).every((field) => field === 'reactions');
  const seen = existing.task_id
    ? canSeeTask(opts.actorId, String(existing.task_id))
    : canSeePage(opts.actorId, String(existing.page_id));

  if (existing.author_id) {
    if (existing.author_id === opts.actorId) return;
    if (!reactingOnly) throw forbidden('Only the author can change a comment');
    // The carve-out is checked rather than assumed: the row reached this
    // person's device through the pull filter or it did not, and a write
    // arriving for one that did not is not a reaction.
    if (!seen) throw forbidden('That comment is not yours to see');
    return;
  }

  const deletingOnly = Object.keys(values).every((field) => field === 'deleted_at');
  if (!seen) throw forbidden('That comment is not yours to see');
  if (reactingOnly) return;
  if (!deletingOnly) throw forbidden('A note left from outside cannot be rewritten');
  if (!isWorkspaceAdmin(String(existing.workspace_id), opts.actorId)) {
    throw forbidden('Only an admin can remove a note left from outside');
  }
}

/**
 * A comment is written once and then it is somebody's words.
 *
 * Which columns an edit may not touch, and nothing else: the stamping of
 * `edited_at`, the parsing of a fixed JSON column on the way back to the
 * client, and the reconciling of the reactions map are `settleAuthored` in the
 * kernel, shared with the one other entity that is somebody's words. Its
 * docblock says what the two copies cost.
 *
 * `anchor` is in the list on purpose: moving it would silently reattach
 * somebody else's remark to a sentence they never read.
 */
const COMMENT_FIXED = ['task_id', 'page_id', 'parent_id', 'author_id', 'guest_name', 'anchor'] as const;

/**
 * You cannot hang a file on something you cannot open.
 *
 * `storeFile` is not the only way an attachment row appears. A client may
 * `POST /api/workspaces/:ws/attachments` with any body the registry accepts,
 * and a phone that was offline pushes the same row through sync — so the upload
 * route checking the subject would leave two doors that do not. This is the
 * third door and the one they all go through.
 *
 * What it buys is not the bytes: those are `canSeeFile`'s business and are
 * content-addressed anyway. It is that a member cannot *file* something into a
 * project they are not on, where the people who are on it will read it as
 * theirs — and cannot move an existing attachment out of a task they may see
 * into one they may not, which is the half a create-only check would miss.
 *
 * An unnamed subject is allowed and is the loose case: `storeFile` writes an
 * avatar and a pasted image with no link at all. An unknown `subject_kind` is
 * refused by name rather than ignored, because a row this build cannot resolve
 * is invisible to every reader — it would be written, mirrored to nobody, and
 * shown nowhere, which looks exactly like the upload having failed.
 *
 * Skipped for `opts.system`, like every other guard: an import, a restore or a
 * project copy is the server moving its own rows and has already decided.
 */
function guardAttachmentWrite(
  values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts,
): void {
  if (values.subject_kind !== undefined && values.subject_kind !== null && !isAttachmentSubject(values.subject_kind)) {
    throw badRequest(`${String(values.subject_kind)} is not something a file can be attached to`);
  }
  // The row as it will be, not as it arrived: a patch that names no link at all
  // leaves the existing one standing, and that is the subject to ask about.
  const subject = attachmentSubject({ ...existing, ...values });
  if (!subject) return;
  /*
   * In this workspace, and then visible in it.
   *
   * Two questions, because the second does not imply the first: a private
   * project refuses a stranger, but a product belongs to its whole workspace,
   * so `canSeeSubject` alone would let somebody who is in two workspaces file a
   * row in one against a row in the other. Nothing would *see* that row — the
   * pull scopes the subject to the workspace too — which is the reason to
   * refuse it rather than to shrug: a row no reader can resolve looks exactly
   * like the upload having failed.
   */
  const row = get<Row>(`SELECT workspace_id FROM ${ENTITIES[subject.kind].table} WHERE id = ?`, subject.id);
  if (!row || row.workspace_id !== opts.workspaceId) {
    throw badRequest(`There is no ${subject.kind} ${subject.id} in this workspace`);
  }
  if (!canSeeSubject(opts.actorId, subject.kind, subject.id)) {
    throw forbidden(`That ${subject.kind} is not yours`);
  }
}

export const workRules = {
  entities: ['task', 'project', 'comment', 'attachment', 'view', 'field'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'task') {
      const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, values.project_id);
      if (!project) throw badRequest('task.project_id must reference an existing project');
      if (project.workspace_id !== opts.workspaceId) throw badRequest('project belongs to another workspace');
      if (values.number === undefined || values.identifier === undefined) {
        const number = Number(project.next_number ?? 1);
        run(`UPDATE projects SET next_number = ? WHERE id = ?`, number + 1, project.id);
        setForced('number', number);
        setForced('identifier', `${project.key}-${number}`);
      }
      if (!values.state_id) {
        const fallback = project.default_state_id
          ?? get<Row>(`SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, project.id)?.id;
        if (fallback) setForced('state_id', fallback);
      }
      if (!values.created_by) setForced('created_by', opts.actorId);
      if (!values.sort_order) setForced('sort_order', 'V');
      if (!values.subscribers) values.subscribers = JSON.stringify([opts.actorId]);
    }
    if (entity === 'comment' && !values.author_id) setForced('author_id', opts.actorId);
    if (entity === 'attachment' && !values.uploaded_by) setForced('uploaded_by', opts.actorId);
    if (entity === 'view' && !values.owner_id) setForced('owner_id', opts.actorId);
    if (entity === 'project') {
      if (!values.key) setForced('key', `P${id.slice(0, 4).toUpperCase()}`);
      if (!values.name) setForced('name', 'Untitled project');
    }
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'task' && values.state_id !== undefined) guardTransition(String(values.state_id), opts);
    if (entity === 'comment') guardCommentWrite(values, existing, opts);
    if (entity === 'attachment') guardAttachmentWrite(values, existing, opts);
  },
  invariants(entity, id, values, existing, forced, opts) {
    /**
     * Exactly one of the five link columns, every time.
     *
     * Two legal spellings of one attachment would mean the task's own Files
     * section misses it, the project export's three `EXISTS` miss it, and
     * `storeFile`'s de-duplication writes a second row for the same bytes. So
     * `soleLink` reduces whatever arrived to the single link
     * `attachmentSubject` reads — see `registry/attachments.ts`, which is the
     * only code that knows which kinds have a column of their own.
     *
     * Asked of the row **as it will be** and not of the write alone: a `PATCH`
     * that names only `subject_id` means "the same kind, a different id", and
     * reading the write on its own would see no kind and clear the link
     * altogether.
     *
     * Through `forced`, so a device that sent another spelling is told what was
     * written rather than going on believing its own copy.
     */
    if (entity === 'attachment' && LINK_COLUMNS.some((column) => values[column] !== undefined)) {
      const sole = soleLink({ ...existing, ...values });
      if (sole) {
        Object.assign(values, sole);
        Object.assign(forced, sole);
      }
    }
    /**
     * A sub-task cannot sit under itself, directly or at any remove.
     *
     * Nothing could build one until the parent became a field a person can set:
     * sub-tasks were only ever created *under* something. Now that it can be
     * chosen, `A → B → A` is two clicks away, and a tree that loops is not a tree
     * — the breadcrumb above the title walks it, and so does anything that ever
     * rolls a child up into its parent.
     *
     * Refused the way a project loop is: the old value comes back through
     * `forced` rather than thrown, because this write may be one row of a batch
     * from a device that has been away.
     */
    if (entity === 'task' && values.parent_id !== undefined && existing) {
      const wanted = values.parent_id as string | null;
      if (wanted === existing.id || wouldLoop('tasks', String(existing.id), wanted)) {
        values.parent_id = existing.parent_id ?? null;
        forced.parent_id = values.parent_id;
      }
    }
    /**
     * A task that changed projects. `settleProjectMove` is the whole of it —
     * extracted because this hook is long enough already, and because the rule
     * has a refusal in front of it now.
     */
    if (entity === 'task' && existing && typeof values.project_id === 'string'
        && values.project_id !== existing.project_id) {
      settleProjectMove(values, existing, forced);
    }
    // A project cannot sit under itself, directly or at any remove. Two devices
    // can each make a legal move that is a loop together, so this is checked on
    // write rather than trusted to the interface.
    if (entity === 'project' && values.parent_id !== undefined && existing) {
      if (wouldLoop('projects', String(existing.id), values.parent_id as string | null)) {
        values.parent_id = existing.parent_id ?? null;
        forced.parent_id = values.parent_id;
      }
    }
    /**
     * A container holds projects, not tasks — so one with tasks in it cannot
     * become a container.
     *
     * Refused rather than obeyed, because the alternative is a screen with no
     * board on it and work behind it that nobody can reach. `forced` is how the
     * client is told: the value it sent comes back changed, and the interface
     * says why. Turning a container back into an ordinary project is always
     * allowed — there is nothing to hide.
     */
    if (entity === 'project' && Number(values.is_container ?? 0) === 1 && existing) {
      const open = get<Row>(
        `SELECT 1 AS found FROM tasks WHERE project_id = ? AND deleted_at IS NULL LIMIT 1`,
        existing.id,
      );
      if (open) {
        values.is_container = existing.is_container ?? 0;
        forced.is_container = values.is_container;
      }
    }
    /**
     * One key, one project.
     *
     * A key is the prefix of every identifier a project mints, so two projects
     * holding `WEB` make `WEB-42` name two tasks — and the client resolving a
     * pasted identifier takes whichever it finds first. It became reachable when
     * the settings screen learned to change a key that until then could only be
     * chosen once.
     *
     * Refused the way a container is: the old value comes back through `forced`
     * rather than thrown, because this write may be one row in a sync push from a
     * device that has been offline, and one bad key should not take the batch
     * down with it. The screen checks as you type and says which project has it,
     * so the bounce is the backstop rather than the explanation.
     *
     * Upper-cased on the way in whatever was typed: `web` and `WEB` are one
     * prefix, and storing both would be storing the collision.
     */
    if (entity === 'project' && typeof values.key === 'string') {
      const wanted = values.key.trim().toUpperCase();
      // `existing` on an update, the incoming row on a create — this runs on both.
      const workspace = (existing?.workspace_id ?? values.workspace_id) as string | undefined;
      const taken = wanted && workspace ? get<Row>(
        `SELECT name FROM projects
          WHERE workspace_id = ? AND id != ? AND deleted_at IS NULL AND UPPER(key) = ?`,
        workspace, id, wanted,
      ) : undefined;
      const settled = !wanted || taken ? (existing?.key as string | undefined) ?? values.key : wanted;
      if (settled !== values.key) {
        values.key = settled;
        forced.key = settled;
      }
    }
    if (entity === 'task') applyTaskInvariants(values, existing, forced);
    if (entity === 'comment' && existing) settleAuthored('comment', values, existing, forced, opts, COMMENT_FIXED);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'field' && row.deleted_at && !before?.deleted_at) tombstoneValuesOf(row, opts);
    // A sub-task is filed where its parent is filed. The transition, not the
    // state, for the same reason the project cascade below reads `before`.
    if (entity === 'task' && before && !row.deleted_at && row.project_id !== before.project_id) {
      followParent(row, opts);
    }
    // The transition, not the state: an edit to an already-deleted project
    // must not cascade a second time, and `before` is the only thing that
    // knows which way this write went.
    if (entity === 'project' && before) {
      if (row.deleted_at && !before.deleted_at) cascadeProject(row, false, opts);
      else if (!row.deleted_at && before.deleted_at) cascadeProject(before, true, opts);
    }
  },
} satisfies EntityRule;
