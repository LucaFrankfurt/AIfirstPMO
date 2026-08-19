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
import { all, get, tx, type Row } from '../db/index.ts';
import { badRequest, notFound } from './http.ts';
import { uid } from './ids.ts';
import { createProject, serverClock } from './bootstrap.ts';
import { writeEntity } from './repo.ts';

export const FORMAT = 'kolibri.project/1';

export interface ProjectDoc {
  format: string;
  exported_at: string;
  /** What the instance called itself, for the person reading the file. */
  source?: { workspace?: string; url?: string };
  project: Record<string, unknown>;
  states: Record<string, unknown>[];
  types: Record<string, unknown>[];
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

export function exportProject(workspaceId: string, projectId: string): ProjectDoc {
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

  return {
    format: FORMAT,
    exported_at: new Date().toISOString(),
    source: { workspace: String(workspace?.name ?? '') },
    project: clean(project),
    states: live('states', 'project_id = ?', projectId).map(clean),
    types: live('task_types', 'project_id = ?', projectId).map(clean),
    labels: live('labels', 'project_id = ?', projectId).map(clean),
    fields: live('custom_fields', 'project_id = ?', projectId).map(clean),
    cycles: live('cycles', 'project_id = ?', projectId).map(clean),
    modules: live('modules', 'project_id = ?', projectId).map(clean),
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
    channels: channels.map(clean),
    messages: channels.length
      ? live('messages', `channel_id IN (${channels.map(() => '?').join(', ')})`, ...channels.map((c) => c.id)).map(clean)
      : [],
    people,
  };
}

export interface ImportOptions {
  /** Override the name in the document. */
  name?: string;
  key?: string;
  /** Match people by email and keep the assignment; otherwise nobody is assigned. */
  matchPeople?: boolean;
}

export interface ImportReport {
  project: Row;
  counts: Record<string, number>;
  /** Names from the document that no account here matched. */
  unmatched: string[];
}

/**
 * Read a document into this workspace as a new project.
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

    /* ------------------------------------------------------------- rows */

    const project = createProject(workspaceId, actorId, {
      name: String(options.name || doc.project.name || 'Imported project'),
      key: options.key || String(doc.project.key ?? ''),
      description: (doc.project.description as string) ?? undefined,
      icon: (doc.project.icon as string) ?? undefined,
      color: (doc.project.color as string) ?? undefined,
      visibility: doc.project.visibility === 'private' ? 'private' : 'public',
      withDefaults: false,
    });
    const projectId = String(project.id);

    const map = new Map<string, string>();
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

    for (const row of doc.states ?? []) write('state', row, {});
    for (const row of doc.types ?? []) write('taskType', row, {});
    for (const row of doc.labels ?? []) write('label', row, {});
    for (const row of doc.fields ?? []) write('field', row, {});
    for (const row of doc.cycles ?? []) write('cycle', row, {});
    for (const row of doc.modules ?? []) write('module', row, { lead_id: who(row.lead_id) });

    if (doc.project.default_state_id) {
      writeEntity('project', projectId, { default_state_id: to(doc.project.default_state_id) }, opts());
    }

    // Parents before children, so a sub-task's new parent id already exists.
    for (const row of inTreeOrder(doc.tasks ?? [])) {
      write('task', row, {
        state_id: to(row.state_id),
        type_id: to(row.type_id),
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
      });
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
      const target = to(row.related_task_id);
      if (!from || !target) continue;
      write('relation', row, { task_id: from, related_task_id: target });
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

    return { project: get<Row>(`SELECT * FROM projects WHERE id = ?`, projectId)!, counts, unmatched };
  });
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
