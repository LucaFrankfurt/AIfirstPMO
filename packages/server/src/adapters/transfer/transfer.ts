/**
 * A project as a document, and back again.
 *
 * This is the format for moving work between instances — and for reading it
 * with your own eyes, which is the part a database file cannot do. It is
 * deliberately *not* the backup format: `kolibri backup` copies the database
 * because a backup has to be exact, while this is a portable description that
 * survives a schema that has moved on.
 *
 * Importing never trusts an id. Everything is written under a fresh id and the
 * references between rows are rewritten as they go, so a document can be
 * imported twice into the same workspace and produce two independent projects
 * rather than one corrupted one.
 */
import { COLLECTIONS, type EntityName } from '@kolibri/shared';
import { all, get, run, tx, type Row } from '../../kernel/platform/db/index.ts';
import { badRequest, notFound } from '../../kernel/platform/http.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { createProject, serverClock } from '../../kernel/write-path/bootstrap.ts';
import { writeEntity } from '../../kernel/write-path/repo.ts';
import { activeKind as activeStorageKind } from '../../kernel/files/storage.ts';

export const FORMAT = 'kolibri.project/1';

export interface ProjectDoc {
  format: string;
  exported_at: string;
  /** What the instance called itself, for the person reading the file. */
  source?: { workspace?: string; url?: string };
  project: Record<string, unknown>;
  states: Record<string, unknown>[];
  /**
   * Work item types, which no longer exist. Read out of files exported before
   * they were removed and ignored — the format version has not changed, so an
   * older export still imports, minus a field nothing can hold any more.
   */
  types?: Record<string, unknown>[];
  labels: Record<string, unknown>[];
  fields: Record<string, unknown>[];
  cycles: Record<string, unknown>[];
  modules: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  field_values: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  pages: Record<string, unknown>[];
  templates: Record<string, unknown>[];
  automations: Record<string, unknown>[];
  time_entries: Record<string, unknown>[];
  /**
   * The plan as it was promised, which is the half of a Gantt chart that is
   * not recoverable from the tasks: they carry the dates they have now.
   */
  baselines?: Record<string, unknown>[];
  /**
   * What is attached, and to what.
   *
   * The rows only; the bytes live beside the document — in the archive when
   * the export is a `.zip`, and nowhere at all when it is bare JSON. An
   * attachment whose bytes this instance cannot find is dropped on import and
   * named in the report, because a paperclip that opens onto a 404 is worse
   * than an honest line saying the file did not come with the file.
   */
  attachments?: Record<string, unknown>[];
  /**
   * Every blob the document refers to — attached, inlined in a description or
   * a page, or sitting behind a cover image. Content-addressed, so this is a
   * set: the same picture pasted into forty tasks is listed once.
   */
  files?: FileRef[];
  /** Who was on the project, so a private one arrives private to the same people. */
  members?: Record<string, unknown>[];
  /**
   * Conversations tied to this project, and what was said in them.
   *
   * A **private** channel is left out on purpose: a project export is a
   * document somebody emails, and a private room's whole point is that being
   * able to see the project is not enough to be in it. Only the open ones
   * travel — see `docs/chat.md`.
   */
  channels?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
  /** Names for the ids that point outside the document, so an import can try. */
  people: { id: string; name: string; email: string }[];
}

/** Columns that mean nothing outside the instance they came from. */
const DROP = new Set(['seq', 'clocks', 'workspace_id', 'created_at', 'updated_at', 'deleted_at', 'next_number']);

const clean = (row: Row): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROP.has(key)) continue;
    out[key] = value;
  }
  // `created_at` is kept as a date rather than a millisecond count: a document
  // somebody may open in a text editor should not be full of epoch numbers.
  if (row.created_at) out.created_at_iso = new Date(Number(row.created_at)).toISOString();
  return out;
};

const live = (table: string, where: string, ...params: unknown[]): Row[] =>
  all<Row>(`SELECT * FROM ${table} WHERE ${where} AND deleted_at IS NULL`, ...params);

/* ---------------------------------------------------------------- the blobs */

/** One stored file, as the document describes it. The bytes are elsewhere. */
export interface FileRef {
  hash: string;
  name: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
}

/**
 * Every `/files/<hash>/<name>` in a string.
 *
 * An attachment is the obvious case and the smaller one. Most of the pictures
 * in a workspace are *inline* — pasted into a description, dropped into a page,
 * set as a cover — and they are ordinary markdown links to the same store. An
 * export that carried only the attachments would produce a project whose pages
 * are full of broken images, which is the kind of half-move somebody discovers
 * three weeks later.
 */
export function hashesIn(value: unknown): string[] {
  if (typeof value !== 'string' || !value.includes('/files/')) return [];
  return [...value.matchAll(/\/files\/([0-9a-f]{64})/g)].map((match) => match[1]);
}

/** The columns worth scanning: anything a person can paste a picture into. */
const TEXTUAL = ['description', 'content', 'body', 'url', 'thumb_url', 'cover_url', 'logo_url', 'avatar_url'];

export function collectHashes(rows: Iterable<Record<string, unknown>>, into = new Set<string>()): Set<string> {
  for (const row of rows) {
    for (const column of TEXTUAL) {
      for (const hash of hashesIn(row[column])) into.add(hash);
    }
  }
  return into;
}

/**
 * What this instance knows about those blobs.
 *
 * Read from `files` rather than from the attachment rows because that is where
 * the size and the dimensions are true — an attachment row records what was
 * uploaded, and the same bytes may have been uploaded twice under two names.
 */
export function describeFiles(hashes: Iterable<string>): FileRef[] {
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    const row = get<Row>(
      `SELECT hash, name, mime, size, width, height FROM files WHERE hash = ? ORDER BY created_at LIMIT 1`,
      hash,
    );
    if (!row) continue; // a link to bytes this instance never had
    out.push({
      hash: String(row.hash),
      name: String(row.name),
      mime: String(row.mime),
      size: Number(row.size ?? 0),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
    });
  }
  return out;
}

export interface ExportOptions {
  /**
   * Include the cycles and modules this project *shares* with others.
   *
   * True for a project on its own: without them a shared fortnight is missing
   * from the file and every task in it arrives with no cycle. False for a
   * project inside a workspace export, where the shared ones are carried once
   * at the top rather than copied into every project that runs them.
   */
  shared?: boolean;
}

export function exportProject(workspaceId: string, projectId: string, options: ExportOptions = {}): ProjectDoc {
  const shared = options.shared !== false;
  const project = get<Row>(`SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, projectId, workspaceId);
  if (!project) throw notFound('Project not found');

  const tasks = live('tasks', 'project_id = ?', projectId);
  const taskIds = new Set(tasks.map((task) => String(task.id)));
  // Open channels only. A private room travels with nobody in it or with a
  // membership list that means nothing on the other instance, and either way
  // exporting it hands its contents to whoever opens the file.
  const channels = live('channels', 'project_id = ? AND is_private = 0', projectId);
  const workspace = get<Row>(`SELECT name FROM workspaces WHERE id = ?`, workspaceId);

  const people = all<Row>(
    `SELECT u.id, u.name, u.email FROM users u
      JOIN workspace_members m ON m.user_id = u.id
     WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
    workspaceId,
  ).map((user) => ({ id: String(user.id), name: String(user.name), email: String(user.email) }));

  /* Everything hung off this project's tasks, pages and comments. Written as
     three `EXISTS` rather than three `IN` so the query stays sane on a project
     with thirty thousand tasks in it. */
  const attachments = live(
    'attachments',
    `(task_id IN (SELECT id FROM tasks WHERE project_id = ?1)
      OR page_id IN (SELECT id FROM pages WHERE project_id = ?1)
      OR comment_id IN (SELECT c.id FROM comments c
                         WHERE c.task_id IN (SELECT id FROM tasks WHERE project_id = ?1)
                            OR c.page_id IN (SELECT id FROM pages WHERE project_id = ?1)))`,
    projectId,
  );

  const doc: ProjectDoc = {
    format: FORMAT,
    exported_at: new Date().toISOString(),
    source: { workspace: String(workspace?.name ?? '') },
    project: clean(project),
    states: live('states', 'project_id = ?', projectId).map(clean),
    labels: live('labels', 'project_id = ?', projectId).map(clean),
    fields: live('custom_fields', 'project_id = ?', projectId).map(clean),
    /* This project's own cycles, plus any shared cycle that covers it or that
       its tasks are in. Without the second half a shared fortnight is dropped
       from the file and every task in it arrives at the far end with no cycle
       — silently, because a missing id maps to null rather than failing. A
       shared cycle lands as an ordinary cycle of the imported project, which
       is the truth there: the other projects that shared it are not in this
       file. `write` clears the list on the way in for the same reason. */
    cycles: [
      ...live('cycles', 'project_id = ?', projectId),
      ...(shared ? live(
        'cycles',
        `project_id IS NULL
           AND (EXISTS (SELECT 1 FROM json_each(cycles.projects) WHERE json_each.value = ?1)
                OR id IN (SELECT DISTINCT cycle_id FROM tasks WHERE project_id = ?1 AND cycle_id IS NOT NULL))`,
        projectId,
      ) : []),
    ].map(clean),
    /* Its own modules, plus any shared one that covers it or that its tasks
       are in — the same two halves as the cycles above, and dropped for the
       same silent reason if the second is missing. */
    modules: [
      ...live('modules', 'project_id = ?', projectId),
      ...(shared ? live(
        'modules',
        `project_id IS NULL
           AND (EXISTS (SELECT 1 FROM json_each(modules.projects) WHERE json_each.value = ?1)
                OR id IN (SELECT DISTINCT module_id FROM tasks WHERE project_id = ?1 AND module_id IS NOT NULL))`,
        projectId,
      ) : []),
    ].map(clean),
    tasks: tasks.map(clean),
    field_values: live('field_values', 'project_id = ?', projectId).map(clean),
    relations: live('task_relations', 'task_id IN (SELECT id FROM tasks WHERE project_id = ?)', projectId)
      .filter((relation) => taskIds.has(String(relation.related_task_id)))
      .map(clean),
    comments: live('comments', 'task_id IN (SELECT id FROM tasks WHERE project_id = ?) OR page_id IN (SELECT id FROM pages WHERE project_id = ?)', projectId, projectId).map(clean),
    pages: live('pages', 'project_id = ?', projectId).map(clean),
    templates: live('templates', 'project_id = ?', projectId).map(clean),
    automations: live('automations', 'project_id = ?', projectId).map(clean),
    time_entries: live('time_entries', 'project_id = ?', projectId).map(clean),
    baselines: live('baselines', 'project_id = ?', projectId).map(clean),
    channels: channels.map(clean),
    messages: channels.length
      ? live('messages', `channel_id IN (${channels.map(() => '?').join(', ')})`, ...channels.map((c) => c.id)).map(clean)
      : [],
    attachments: attachments.map(clean),
    members: live('project_members', 'project_id = ?', projectId).map(clean),
    people,
  };

  /* The blobs last, because the answer is "every file any of the above links
     to" and that is only knowable once the above exists. */
  const hashes = new Set<string>();
  collectHashes([doc.project], hashes);
  for (const section of [doc.tasks, doc.pages, doc.comments, doc.templates, doc.messages ?? [], doc.attachments ?? []]) {
    collectHashes(section, hashes);
  }
  doc.files = describeFiles(hashes);
  return doc;
}

export interface ImportOptions {
  /** Override the name in the document. */
  name?: string;
  key?: string;
  /** Match people by email and keep the assignment; otherwise nobody is assigned. */
  matchPeople?: boolean;
  /**
   * Merge into a project that already exists instead of making a new one.
   *
   * The two are genuinely different operations and the difference is worth
   * spelling out. A new project is a clean rewrite: nothing here can be
   * damaged by a bad file. A merge writes into work people are doing, so it
   * *reuses* rather than overwrites — a state, label, field, cycle or module
   * whose name is already in the project is the one the incoming rows land on,
   * with its own colour and order left exactly as the team set them.
   *
   * Tasks are matched on the identifier the document carries (`WEB-12`), which
   * is what makes re-importing an export of this project an update rather than
   * a second copy of it. A file from another tool has no such identifier, so
   * everything in it is added — importing it twice adds it twice, and that is
   * the honest behaviour rather than a guess at which two titles are the same
   * task.
   */
  intoProjectId?: string;
  /**
   * Hashes whose bytes are already in the store, from an archive unpacked
   * before this ran. Anything not here is looked up in `files` instead, so a
   * plain JSON import still keeps the attachments this instance happens to
   * hold — the same picture, uploaded once, is one blob for everybody.
   */
  restored?: Set<string>;
  /**
   * Ids the caller has already written, so this document can point at them.
   *
   * The workspace importer creates the shared cycles and modules once, before
   * any project, and hands the mapping down. Without it every project in the
   * file would create its own copy of the fortnight they all run.
   */
  seed?: Map<string, string>;
}

export interface ImportReport {
  project: Row;
  counts: Record<string, number>;
  /** Names from the document that no account here matched. */
  unmatched: string[];
  /** Tasks that landed on one already in the project rather than adding one. */
  updated: number;
  /** Files the document refers to whose bytes are nowhere on this instance. */
  missingFiles: string[];
  /**
   * Document id → the id it was written under. The workspace importer needs
   * it to reconnect what spans two projects and so belongs in neither
   * document: the project tree, a shared cycle, a task blocking one next door.
   */
  map: Map<string, string>;
}

/**
 * Read a document into this workspace as a new project — or into one that is
 * already there, when `intoProjectId` says so.
 *
 * Every row gets a fresh id. People are matched by email address, which is the
 * only identifier that means the same thing on two instances; anybody not found
 * is simply dropped from assignees and named in the report, because a task
 * assigned to somebody who does not exist here is a task nobody will do.
 */
export function importProject(workspaceId: string, actorId: string, doc: ProjectDoc, options: ImportOptions = {}): ImportReport {
  if (!doc || typeof doc !== 'object') throw badRequest('That is not a Kolibri project file');
  if (typeof doc.format !== 'string' || !doc.format.startsWith('kolibri.project/')) {
    throw badRequest('That file is not a Kolibri project export');
  }
  if (!doc.project || typeof doc.project !== 'object') throw badRequest('The file has no project in it');

  return tx(() => {
    const hlc = () => serverClock.now();
    const opts = () => ({ workspaceId, actorId, hlc: hlc(), system: true });
    const counts: Record<string, number> = {};
    const bump = (what: string, by = 1) => { counts[what] = (counts[what] ?? 0) + by; };

    /* ------------------------------------------------------------ people */

    const here = new Map(
      all<Row>(
        `SELECT u.id, lower(u.email) AS email FROM users u
          JOIN workspace_members m ON m.user_id = u.id
         WHERE m.workspace_id = ? AND m.deleted_at IS NULL`,
        workspaceId,
      ).map((user) => [String(user.email), String(user.id)]),
    );
    const person = new Map<string, string>();
    const unmatched: string[] = [];
    for (const entry of doc.people ?? []) {
      const match = options.matchPeople === false ? undefined : here.get(String(entry.email ?? '').toLowerCase());
      if (match) person.set(entry.id, match);
      else unmatched.push(entry.name || entry.email);
    }
    /** Ids that are people, mapped to whoever here is the same person. */
    const who = (id: unknown): string | null => (id ? person.get(String(id)) ?? null : null);
    const whoList = (raw: unknown): string[] => list(raw).map(who).filter(Boolean) as string[];

    /* ------------------------------------------------------- the project */

    const target = options.intoProjectId
      ? get<Row>(`SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, options.intoProjectId, workspaceId)
      : null;
    if (options.intoProjectId && !target) throw notFound('Project not found');
    const merging = !!target;

    const project = target ?? createProject(workspaceId, actorId, {
      name: String(options.name || doc.project.name || 'Imported project'),
      key: options.key || String(doc.project.key ?? ''),
      description: (doc.project.description as string) ?? undefined,
      icon: (doc.project.icon as string) ?? undefined,
      color: (doc.project.color as string) ?? undefined,
      visibility: doc.project.visibility === 'private' ? 'private' : 'public',
      withDefaults: false,
    });
    const projectId = String(project.id);

    const map = new Map<string, string>(options.seed ?? []);
    // The project itself is in the map, which the rows it contains rely on as
    // much as anything else does: a template targeting this project, and the
    // workspace importer putting the project tree back afterwards, both ask
    // the map what the document's project id became.
    if (doc.project.id) map.set(String(doc.project.id), projectId);
    const to = (id: unknown): string | null => (id ? map.get(String(id)) ?? null : null);

    /** Write one row from the document under a fresh id. */
    const write = (entity: EntityName, row: Record<string, unknown>, extra: Record<string, unknown>): string => {
      const id = uid();
      if (row.id) map.set(String(row.id), id);
      const { id: _drop, created_at_iso: _iso, ...rest } = row;
      const patch: Record<string, unknown> = { ...rest, ...extra, workspace_id: workspaceId, project_id: projectId };
      // `undefined` in an override means "let the server decide" — an identifier
      // belongs to the project allocating it, not to the file it came from.
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete patch[key];
      writeEntity(entity, id, patch, opts());
      bump(COLLECTIONS[entity]);
      return id;
    };

    /**
     * The same, except that on a merge a row whose name is already in the
     * project is *adopted* rather than duplicated.
     *
     * Adopted, not overwritten: somebody merging a file into a live project
     * wants its tasks, not its opinion about what colour "In Progress" is.
     */
    const byName = (table: string): Map<string, string> =>
      merging
        ? new Map(live(table, 'project_id = ?', projectId).map((row) => [String(row.name ?? '').trim().toLowerCase(), String(row.id)]))
        : new Map();

    const writeNamed = (entity: EntityName, existing: Map<string, string>, row: Record<string, unknown>, extra: Record<string, unknown>): string => {
      const match = existing.get(String(row.name ?? '').trim().toLowerCase());
      if (match) {
        if (row.id) map.set(String(row.id), match);
        return match;
      }
      const id = write(entity, row, extra);
      existing.set(String(row.name ?? '').trim().toLowerCase(), id);
      return id;
    };

    /* ------------------------------------------------------------- rows */

    const states = byName('states');
    for (const row of doc.states ?? []) writeNamed('state', states, row, {});
    const labels = byName('labels');
    for (const row of doc.labels ?? []) writeNamed('label', labels, row, {});
    const fields = byName('custom_fields');
    for (const row of doc.fields ?? []) writeNamed('field', fields, row, {});
    // `projects` is cleared: a cycle arriving into one project is that
    // project's, and carrying a list of ids from another instance would name
    // projects that do not exist here. The workspace importer puts the shared
    // ones back afterwards, once every project in the file exists.
    const cycles = byName('cycles');
    for (const row of doc.cycles ?? []) writeNamed('cycle', cycles, row, { projects: [] });
    // `projects` cleared for the same reason the cycles' is.
    const modules = byName('modules');
    for (const row of doc.modules ?? []) writeNamed('module', modules, row, { lead_id: who(row.lead_id), projects: [] });

    // Only on a fresh project. A merge that repointed the target's default
    // state would change where every *future* task lands, which is not
    // something importing a file should quietly decide.
    if (!merging && doc.project.default_state_id) {
      writeEntity('project', projectId, { default_state_id: to(doc.project.default_state_id) }, opts());
    }

    /* -------------------------------------------------------------- tasks */

    /** On a merge: what the project already has, by the identifier it carries. */
    const knownTasks = merging
      ? new Map(
        live('tasks', 'project_id = ?', projectId)
          .filter((row) => row.identifier)
          .map((row) => [String(row.identifier).toLowerCase(), String(row.id)]),
      )
      : new Map<string, string>();
    let updated = 0;

    // Parents before children, so a sub-task's new parent id already exists.
    for (const row of inTreeOrder(doc.tasks ?? [])) {
      const patch: Record<string, unknown> = {
        state_id: to(row.state_id),
        parent_id: to(row.parent_id),
        cycle_id: to(row.cycle_id),
        module_id: to(row.module_id),
        labels: list(row.labels).map(to).filter(Boolean),
        assignees: whoList(row.assignees),
        subscribers: whoList(row.subscribers),
        created_by: who(row.created_by) ?? actorId,
        // The identifier is this project's to allocate; the number comes with it.
        number: undefined,
        identifier: undefined,
      };
      const match = row.identifier ? knownTasks.get(String(row.identifier).toLowerCase()) : undefined;
      if (match) {
        // An update, so the row keeps its identifier, its number and its place
        // in whatever cycle the team has since put it in unless the file says
        // otherwise. Only what the document actually carries is written.
        const { id: _drop, created_at_iso: _iso, number: _n, identifier: _i, ...rest } = row;
        const merged: Record<string, unknown> = { ...rest, ...patch };
        for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
        writeEntity('task', match, merged, opts());
        map.set(String(row.id), match);
        updated++;
        continue;
      }
      const id = write('task', row, patch);
      if (row.identifier) knownTasks.set(String(row.identifier).toLowerCase(), id);
    }

    for (const row of inTreeOrder(doc.pages ?? [])) {
      write('page', row, {
        parent_id: to(row.parent_id),
        created_by: who(row.created_by) ?? actorId,
        watchers: whoList(row.watchers),
        labels: list(row.labels).map(to).filter(Boolean),
      });
    }

    for (const row of doc.relations ?? []) {
      const from = to(row.task_id);
      const target_ = to(row.related_task_id);
      if (!from || !target_) continue;
      write('relation', row, { task_id: from, related_task_id: target_ });
    }

    for (const row of doc.field_values ?? []) {
      const task = to(row.task_id);
      const field = to(row.field_id);
      if (!task || !field) continue;
      writeEntity('fieldValue', `${task}.${field}`, {
        workspace_id: workspaceId, project_id: projectId, task_id: task, field_id: field, value: row.value,
      }, opts());
      bump('field-values');
    }

    for (const row of doc.comments ?? []) {
      const task = to(row.task_id);
      const page = to(row.page_id);
      if (!task && !page) continue;
      write('comment', row, {
        task_id: task,
        page_id: page,
        parent_id: to(row.parent_id),
        author_id: who(row.author_id) ?? actorId,
        // Who reacted is a set of ids from another instance; the emoji survive,
        // the attribution does not.
        reactions: {},
      });
    }

    for (const row of doc.templates ?? []) {
      write('template', row, {
        assignees: whoList(row.assignees),
        labels: list(row.labels).map(to).filter(Boolean),
        target_project_id: to(row.target_project_id),
      });
    }
    for (const row of doc.automations ?? []) {
      write('automation', row, {
        trigger_state_id: to(row.trigger_state_id),
        template_id: to(row.template_id),
        recipients: remapRecipients(row.recipients, who),
      });
    }
    for (const row of doc.time_entries ?? []) {
      const user = who(row.user_id);
      if (!user) continue; // time belonging to nobody here is not time this instance can report on
      write('timeEntry', row, { task_id: to(row.task_id), user_id: user });
    }

    // Conversations, and what was said in them. Only open channels are ever in
    // the document, so there is no membership to translate — which is just as
    // well: a member list from another instance names people who may not exist
    // here, and guessing would be inventing a room's guest list.
    for (const row of doc.channels ?? []) {
      write('channel', row, {
        kind: 'channel',
        is_private: 0,
        members: [],
        created_by: who(row.created_by) ?? actorId,
        archived_at: undefined,
      });
    }
    for (const row of doc.messages ?? []) {
      const channel = to(row.channel_id);
      if (!channel) continue;
      write('message', row, {
        channel_id: channel,
        reply_to: to(row.reply_to),
        // An author this instance does not know becomes the importer, the same
        // rule comments already follow — and who reacted does not survive,
        // because those ids mean nothing here.
        author_id: who(row.author_id) ?? actorId,
        reactions: {},
      });
    }

    /* The plan as promised. Its `entries` are keyed by task id, so the keys
       are rewritten the way every other reference is; an entry for a task not
       in the file is dropped rather than left pointing at nothing. */
    for (const row of doc.baselines ?? []) {
      write('baseline', row, { entries: remapKeys(row.entries, to) });
    }

    /* -------------------------------------------------------- who is on it */

    // A private project that arrived with nobody on it is a project its own
    // team cannot open. Only people this instance knows, for the same reason
    // assignees are: a membership row for a stranger grants nothing to anybody.
    for (const row of doc.members ?? []) {
      const user = who(row.user_id);
      if (!user) continue;
      if (get(`SELECT id FROM project_members WHERE project_id = ? AND user_id = ?`, projectId, user)) continue;
      write('projectMember', row, { user_id: user });
    }

    /* ---------------------------------------------------------- the files */

    const missingFiles = linkFiles(workspaceId, actorId, doc, options.restored);

    for (const row of doc.attachments ?? []) {
      const task = to(row.task_id);
      const page = to(row.page_id);
      const comment = to(row.comment_id);
      if (!task && !page && !comment) continue;
      // The hash is the identity of the bytes, so a surviving attachment keeps
      // the same URL it had on the instance it came from. One that did not
      // survive is left out rather than written as a paperclip onto a 404.
      const [hash] = hashesIn(row.url);
      if (!hash || missingFiles.includes(hash)) continue;
      write('attachment', row, {
        task_id: task, page_id: page, comment_id: comment,
        uploaded_by: who(row.uploaded_by) ?? actorId,
        // A thumbnail whose bytes did not come is dropped on its own; the
        // attachment is still there and still opens.
        thumb_url: hashesIn(row.thumb_url).every((one) => !missingFiles.includes(one)) ? row.thumb_url : null,
      });
    }

    return {
      project: get<Row>(`SELECT * FROM projects WHERE id = ?`, projectId)!,
      counts,
      unmatched,
      updated,
      missingFiles: describeMissing(doc, missingFiles),
      map,
    };
  });
}

/**
 * Give this workspace a row for every blob the document refers to, and report
 * the ones nowhere on this instance.
 *
 * Storage is content-addressed, so "importing" a file that is already here is
 * a row, not a copy: the same picture in two workspaces is one blob and two
 * rows, which is what makes the permission check on `/files/:hash` — *is this
 * one of yours* — answerable at all.
 */
export function adoptFiles(
  workspaceId: string,
  actorId: string,
  wanted: Set<string>,
  described: Map<string, FileRef>,
  restored?: Set<string>,
): string[] {
  const missing: string[] = [];

  for (const hash of wanted) {
    if (get(`SELECT hash FROM files WHERE hash = ? AND workspace_id = ?`, hash, workspaceId)) continue;
    const said = described.get(hash);
    // Three cases, in the order they are cheapest to answer: this instance
    // already holds the bytes for somebody else, an archive has just unpacked
    // them, or nobody has them and the link is dead.
    const elsewhere = get<Row>(`SELECT * FROM files WHERE hash = ? LIMIT 1`, hash);
    const arrived = restored?.has(hash) ?? false;
    if (!elsewhere && !arrived) { missing.push(hash); continue; }
    run(
      `INSERT INTO files (hash, workspace_id, name, mime, size, width, height, storage, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hash, workspaceId,
      // The document's name where it has one — the same bytes may have been
      // uploaded here under a name that means nothing to whoever sent the file.
      String(said?.name ?? elsewhere?.name ?? hash.slice(0, 12)),
      String(said?.mime ?? elsewhere?.mime ?? 'application/octet-stream'),
      Number(elsewhere?.size ?? said?.size ?? 0),
      elsewhere?.width ?? said?.width ?? null,
      elsewhere?.height ?? said?.height ?? null,
      String(elsewhere?.storage ?? activeStorageKind), actorId, Date.now(),
    );
  }
  return missing;
}

/** Everything a project document links to, however it links to it. */
export function hashesOf(doc: ProjectDoc): Set<string> {
  const wanted = new Set<string>((doc.files ?? []).map((file) => file.hash));
  collectHashes([doc.project], wanted);
  for (const section of [doc.tasks, doc.pages, doc.comments, doc.templates, doc.messages ?? [], doc.attachments ?? []]) {
    collectHashes(section ?? [], wanted);
  }
  return wanted;
}

function linkFiles(workspaceId: string, actorId: string, doc: ProjectDoc, restored?: Set<string>): string[] {
  const wanted = hashesOf(doc);
  // A blob that arrived in the archive but that nothing in the document points
  // at is still this workspace's: it is what an inline image in a field this
  // version does not know about looks like.
  if (restored) for (const hash of restored) wanted.add(hash);
  return adoptFiles(workspaceId, actorId, wanted, new Map((doc.files ?? []).map((file) => [file.hash, file])), restored);
}

/** Missing hashes, as the names a person would recognise them by. */
function describeMissing(doc: ProjectDoc, hashes: string[]): string[] {
  const named = new Map((doc.files ?? []).map((file) => [file.hash, file.name]));
  return hashes.map((hash) => named.get(hash) ?? hash.slice(0, 12));
}

const list = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** A rule's recipients keep their *kind*; only the ids in them are rewritten. */
function remapRecipients(raw: unknown, who: (id: unknown) => string | null): unknown[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => {
      const recipient = entry as { kind?: string; ref?: string };
      if (recipient?.kind !== 'user') return recipient;
      const match = who(recipient.ref);
      return match ? { ...recipient, ref: match } : null;
    })
    .filter(Boolean) as unknown[];
}

/** A `{ id: value }` map whose *keys* are ids, rewritten to the new ones. */
function remapKeys(raw: unknown, to: (id: unknown) => string | null): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const mapped = to(key);
    if (mapped) out[mapped] = value;
  }
  return out;
}

/** Rows sorted so that every parent comes before its children. */
function inTreeOrder<T extends Record<string, unknown>>(rows: T[]): T[] {
  const known = new Set(rows.map((row) => String(row.id)));
  const byParent = new Map<string | null, T[]>();
  for (const row of rows) {
    const parent = row.parent_id && known.has(String(row.parent_id)) ? String(row.parent_id) : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(row);
  }
  const out: T[] = [];
  const walk = (parent: string | null): void => {
    for (const row of byParent.get(parent) ?? []) {
      out.push(row);
      walk(String(row.id));
    }
  };
  walk(null);
  return out;
}
