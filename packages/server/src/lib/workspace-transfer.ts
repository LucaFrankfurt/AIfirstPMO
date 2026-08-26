/**
 * A whole workspace as a document, and back again.
 *
 * The project document next door is the right size for moving one project
 * between two instances. It is the wrong size for moving a *company*: half of
 * what a workspace is lives above any one project — its teams, who is in them,
 * the saved views everybody works from, the pages that belong to nobody's
 * project — and the other half is the wiring *between* projects, which by
 * definition is in neither of their documents. Export project by project and
 * what you get on the far side is a pile of unrelated projects: a flat list
 * where there was a tree, a fortnight duplicated six times, and every
 * dependency that crossed a project boundary quietly gone.
 *
 * So this carries the projects **as project documents** — the same function,
 * the same rewriting rules, the same tests — and adds the two things they
 * cannot hold: what is above them, and what runs between them.
 *
 * What it deliberately leaves behind, all for the same reason (an export is a
 * document somebody emails, and these are either secrets or somebody else's):
 *
 *   - **Passwords, sessions, API tokens, two-factor secrets.** Accounts are
 *     matched by email on the way in, never created with credentials.
 *   - **Share links.** The token *is* the authorisation. Carrying one would
 *     mint a working public link on the far instance for a page nobody there
 *     has agreed to publish.
 *   - **Private and direct conversations**, for the reason the project export
 *     already gives: being able to read the export is not being in the room.
 *   - **Notifications, read markers, push subscriptions.** One person's state
 *     about a workspace, not the workspace.
 *   - **Intake reports**, which carry the email addresses of people outside
 *     the workspace who filled in a form.
 */
import { all, get, run, tx, type Row } from '../db/index.ts';
import { badRequest, notFound } from './http.ts';
import { uid } from './ids.ts';
import { addMember, createWorkspace, serverClock } from './bootstrap.ts';
import { writeEntity } from './repo.ts';
import {
  adoptFiles, collectHashes, describeFiles, exportProject, hashesIn, importProject,
  type FileRef, type ProjectDoc,
} from './transfer.ts';

export const WORKSPACE_FORMAT = 'kolibri.workspace/1';

export interface WorkspaceDoc {
  format: string;
  exported_at: string;
  source?: { url?: string; kolibri?: string };
  workspace: Record<string, unknown>;
  /** Everyone in the workspace, with the role they hold. Matched by email. */
  people: { id: string; name: string; email: string; role: string }[];
  teams: Record<string, unknown>[];
  team_members: Record<string, unknown>[];
  /** Labels that belong to the workspace rather than to one project. */
  labels: Record<string, unknown>[];
  /** Cycles and modules several projects run. Carried once, here. */
  cycles: Record<string, unknown>[];
  modules: Record<string, unknown>[];
  /** Pages outside every project, and what was said on them. */
  pages: Record<string, unknown>[];
  page_comments: Record<string, unknown>[];
  /** The saved views everybody works from. */
  views: Record<string, unknown>[];
  /** Workspace-wide open conversations. */
  channels: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  projects: ProjectDoc[];
  /** What is true of no single project, and so is in no project's document. */
  links: {
    /** `project id → the project it sits under`. */
    parents: Record<string, string>;
    /** `project id → the team that owns it`. */
    teams: Record<string, string>;
    /** `project id → whoever leads it`. */
    leads: Record<string, string>;
    /** Dependencies between tasks in two different projects. */
    relations: Record<string, unknown>[];
  };
  attachments: Record<string, unknown>[];
  files: FileRef[];
}

/** Columns that mean nothing outside the instance they came from. */
const DROP = new Set(['seq', 'clocks', 'workspace_id', 'created_at', 'updated_at', 'deleted_at', 'next_number']);

const clean = (row: Row): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROP.has(key)) continue;
    out[key] = value;
  }
  if (row.created_at) out.created_at_iso = new Date(Number(row.created_at)).toISOString();
  return out;
};

const live = (table: string, where: string, ...params: unknown[]): Row[] =>
  all<Row>(`SELECT * FROM ${table} WHERE ${where} AND deleted_at IS NULL`, ...params);

export interface WorkspaceExportOptions {
  /** Only these projects. Everything above them still travels. */
  projectIds?: string[];
}

export function exportWorkspace(workspaceId: string, options: WorkspaceExportOptions = {}): WorkspaceDoc {
  const workspace = get<Row>(`SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL`, workspaceId);
  if (!workspace) throw notFound('Workspace not found');

  const wanted = options.projectIds?.length ? new Set(options.projectIds) : null;
  const projectRows = live('projects', 'workspace_id = ?', workspaceId)
    .filter((project) => !wanted || wanted.has(String(project.id)));
  const projectIds = new Set(projectRows.map((project) => String(project.id)));

  const people = all<Row>(
    `SELECT u.id, u.name, u.email, u.avatar_url, m.role FROM users u
       JOIN workspace_members m ON m.user_id = u.id
      WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND u.deleted_at IS NULL`,
    workspaceId,
  ).map((user) => ({
    id: String(user.id),
    name: String(user.name),
    email: String(user.email),
    role: String(user.role ?? 'member'),
  }));

  /* Pages outside every project. Their comments come too — a page's discussion
     is the page as far as anybody reading it later is concerned. */
  const pages = live('pages', 'workspace_id = ? AND project_id IS NULL', workspaceId);
  const pageIds = pages.map((page) => String(page.id));
  const pageComments = pageIds.length
    ? live('comments', `page_id IN (${pageIds.map(() => '?').join(', ')})`, ...pageIds)
    : [];

  /* Open, workspace-wide rooms only: a private one is left out for the reason
     the project export gives, and a direct conversation belongs to no
     workspace at all and so is not this workspace's to export. */
  const channels = live('channels', 'workspace_id = ? AND project_id IS NULL AND is_private = 0', workspaceId);
  const messages = channels.length
    ? live('messages', `channel_id IN (${channels.map(() => '?').join(', ')})`, ...channels.map((channel) => channel.id))
    : [];

  /* Attachments hung off the workspace-level pages and their comments. The
     projects' own are inside their own documents. */
  const attachments = pageIds.length
    ? live(
      'attachments',
      `page_id IN (${pageIds.map(() => '?').join(', ')})
        OR comment_id IN (SELECT id FROM comments WHERE page_id IN (${pageIds.map(() => '?').join(', ')}))`,
      ...pageIds, ...pageIds,
    )
    : [];

  /* Dependencies whose two ends are in two different projects. Neither
     project's document can hold one — `exportProject` drops it on purpose,
     because a link to a task that is not in the file is a link to nothing. */
  const crossRelations = all<Row>(
    `SELECT r.* FROM task_relations r
       JOIN tasks a ON a.id = r.task_id
       JOIN tasks b ON b.id = r.related_task_id
      WHERE r.workspace_id = ? AND r.deleted_at IS NULL
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.project_id <> b.project_id`,
    workspaceId,
  ).filter((relation) => {
    const from = get<Row>(`SELECT project_id FROM tasks WHERE id = ?`, relation.task_id);
    const to = get<Row>(`SELECT project_id FROM tasks WHERE id = ?`, relation.related_task_id);
    return projectIds.has(String(from?.project_id)) && projectIds.has(String(to?.project_id));
  });

  const links: WorkspaceDoc['links'] = { parents: {}, teams: {}, leads: {}, relations: crossRelations.map(clean) };
  for (const project of projectRows) {
    const id = String(project.id);
    if (project.parent_id && projectIds.has(String(project.parent_id))) links.parents[id] = String(project.parent_id);
    if (project.team_id) links.teams[id] = String(project.team_id);
    if (project.lead_id) links.leads[id] = String(project.lead_id);
  }

  const doc: WorkspaceDoc = {
    format: WORKSPACE_FORMAT,
    exported_at: new Date().toISOString(),
    source: { kolibri: '0.1.0' },
    workspace: clean(workspace),
    people,
    teams: live('teams', 'workspace_id = ?', workspaceId).map(clean),
    team_members: live('team_members', 'workspace_id = ?', workspaceId).map(clean),
    labels: live('labels', 'workspace_id = ? AND project_id IS NULL', workspaceId).map(clean),
    cycles: live('cycles', 'workspace_id = ? AND project_id IS NULL', workspaceId).map(clean),
    modules: live('modules', 'workspace_id = ? AND project_id IS NULL', workspaceId).map(clean),
    pages: pages.map(clean),
    page_comments: pageComments.map(clean),
    views: live('views', 'workspace_id = ?', workspaceId).map(clean),
    channels: channels.map(clean),
    messages: messages.map(clean),
    // `shared: false` — the cycles and modules several projects run are above,
    // carried once. Left true, every project that runs the same fortnight
    // would bring its own copy of it.
    projects: projectRows.map((project) => exportProject(workspaceId, String(project.id), { shared: false })),
    links,
    attachments: attachments.map(clean),
    files: [],
  };

  /* One list of blobs for the whole archive, so a picture used in two projects
     is packed once. Each project keeps its own list as well — a reader pulling
     one project out of the file still needs to know what it refers to. */
  const hashes = new Set<string>();
  collectHashes([doc.workspace], hashes);
  collectHashes(doc.pages, hashes);
  collectHashes(doc.page_comments, hashes);
  collectHashes(doc.messages, hashes);
  collectHashes(doc.attachments, hashes);
  for (const project of doc.projects) for (const file of project.files ?? []) hashes.add(file.hash);
  doc.files = describeFiles(hashes);

  return doc;
}

/* --------------------------------------------------------------- importing */

export interface WorkspaceImportOptions {
  /** Override the name in the document. */
  name?: string;
  /** Match people by email and keep their assignments and roles. */
  matchPeople?: boolean;
  /** Hashes whose bytes an archive already unpacked into the store. */
  restored?: Set<string>;
  /**
   * Bring people in as members of the new workspace.
   *
   * On by default, and only ever for accounts that already exist here: a
   * workspace whose people are not in it is one nobody but the importer can
   * open. Nobody is created and nobody is invited — that is a decision with an
   * email attached to it, and importing a file is not the moment to make it.
   */
  addMembers?: boolean;
}

export interface WorkspaceImportReport {
  workspace: Row;
  counts: Record<string, number>;
  /** Names in the document that no account here matched. */
  unmatched: string[];
  /** Files the document refers to whose bytes are nowhere on this instance. */
  missingFiles: string[];
  projects: { id: string; name: string; counts: Record<string, number> }[];
}

export function detectWorkspaceDoc(document: unknown): boolean {
  const doc = document as { format?: unknown } | null;
  return !!doc && typeof doc === 'object' && typeof doc.format === 'string' && doc.format.startsWith('kolibri.workspace/');
}

/**
 * Read a workspace document in, as a **new** workspace.
 *
 * New, always. Merging two workspaces is not an import, it is a migration with
 * a hundred decisions in it — which of two teams called "Design" is the real
 * one, what happens to the two saved views with the same name — and none of
 * those decisions belong to a file. A new workspace is the one outcome that
 * cannot damage anything already here, which is what makes it safe to try.
 */
export function importWorkspace(actorId: string, doc: WorkspaceDoc, options: WorkspaceImportOptions = {}): WorkspaceImportReport {
  if (!doc || typeof doc !== 'object') throw badRequest('That is not a Kolibri workspace file');
  if (!detectWorkspaceDoc(doc)) throw badRequest('That file is not a Kolibri workspace export');
  if (!doc.workspace || typeof doc.workspace !== 'object') throw badRequest('The file has no workspace in it');
  // One transaction for the whole file. Half a workspace — teams and no
  // projects, projects and nothing joining them — is worse than none, and a
  // file big enough to be worth this format is big enough to fail halfway.
  return tx(() => writeWorkspace(actorId, doc, options));
}

function writeWorkspace(actorId: string, doc: WorkspaceDoc, options: WorkspaceImportOptions): WorkspaceImportReport {
  const workspace = createWorkspace(
    String(options.name || doc.workspace.name || 'Imported workspace'),
    actorId,
    String(doc.workspace.slug ?? ''),
  );
  const workspaceId = String(workspace.id);

  /* The workspace's own settings — its feature switches and its logo.
     `createWorkspace` takes a name and a slug because that is all somebody
     typing into a form has; a document has the rest, and a workspace that
     arrives with time tracking switched back off is not the workspace that
     was exported. The logo is a `/files/<hash>` URL like any other picture,
     so it travels with the blobs and is adopted below. */
  const settings = typeof doc.workspace.settings === 'string'
    ? doc.workspace.settings
    : JSON.stringify(doc.workspace.settings ?? {});
  run(
    `UPDATE workspaces SET settings = ?, logo_url = ?, updated_at = ? WHERE id = ?`,
    settings, (doc.workspace.logo_url as string) ?? null, Date.now(), workspaceId,
  );
  const hlc = () => serverClock.now();
  const opts = () => ({ workspaceId, actorId, hlc: hlc(), system: true });

  const counts: Record<string, number> = {};
  const bump = (what: string, by = 1) => { counts[what] = (counts[what] ?? 0) + by; };

  /* --------------------------------------------------------------- people */

  const here = new Map(
    all<Row>(`SELECT id, lower(email) AS email FROM users WHERE deleted_at IS NULL`)
      .map((user) => [String(user.email), String(user.id)]),
  );
  const person = new Map<string, string>();
  const unmatched: string[] = [];
  for (const entry of doc.people ?? []) {
    const match = options.matchPeople === false ? undefined : here.get(String(entry.email ?? '').toLowerCase());
    if (match) person.set(entry.id, match);
    else unmatched.push(entry.name || entry.email);
  }
  const who = (id: unknown): string | null => (id ? person.get(String(id)) ?? null : null);

  if (options.addMembers !== false) {
    for (const entry of doc.people ?? []) {
      const user = who(entry.id);
      // Never the owner: whoever imported the file owns what they imported,
      // and a role in the file is a claim about a different instance.
      if (!user || user === actorId) continue;
      addMember(workspaceId, user, entry.role === 'owner' ? 'admin' : String(entry.role || 'member'));
      bump('members');
    }
  }

  /* ------------------------------------------- what sits above the projects */

  const map = new Map<string, string>();
  const to = (id: unknown): string | null => (id ? map.get(String(id)) ?? null : null);

  const write = (entity: Parameters<typeof writeEntity>[0], row: Record<string, unknown>, extra: Record<string, unknown>): string => {
    const id = uid();
    if (row.id) map.set(String(row.id), id);
    const { id: _drop, created_at_iso: _iso, ...rest } = row;
    const patch: Record<string, unknown> = { ...rest, ...extra, workspace_id: workspaceId };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete patch[key];
    writeEntity(entity, id, patch, opts());
    return id;
  };

  for (const row of doc.teams ?? []) { write('team', row, {}); bump('teams'); }
  for (const row of doc.team_members ?? []) {
    const team = to(row.team_id);
    const user = who(row.user_id);
    if (!team || !user) continue;
    write('teamMember', row, { team_id: team, user_id: user });
    bump('team-members');
  }
  for (const row of doc.labels ?? []) { write('label', row, { project_id: null }); bump('labels'); }
  // The shared ones, once. Their `projects` lists name projects that do not
  // exist yet, so they are filled in below once every project does.
  for (const row of doc.cycles ?? []) { write('cycle', row, { project_id: null, projects: [] }); bump('cycles'); }
  for (const row of doc.modules ?? []) {
    write('module', row, { project_id: null, projects: [], lead_id: who(row.lead_id) });
    bump('modules');
  }

  /* ------------------------------------------------------------- projects */

  const projects: WorkspaceImportReport['projects'] = [];
  const missingFiles = new Set<string>();

  for (const project of doc.projects ?? []) {
    const report = importProject(workspaceId, actorId, project, {
      matchPeople: options.matchPeople,
      restored: options.restored,
      // Everything written so far, so a task can point at the fortnight three
      // projects share rather than at a fourth copy of it.
      seed: map,
    });
    for (const [from, into] of report.map) map.set(from, into);
    for (const name of report.missingFiles) missingFiles.add(name);
    for (const [what, count] of Object.entries(report.counts)) bump(what, count);
    projects.push({ id: String(report.project.id), name: String(report.project.name), counts: report.counts });
  }

  /* --------------------------------------------- what runs between projects */

  for (const [from, parent] of Object.entries(doc.links?.parents ?? {})) {
    const child = to(from);
    const above = to(parent);
    if (child && above) writeEntity('project', child, { parent_id: above }, opts());
  }
  for (const [from, team] of Object.entries(doc.links?.teams ?? {})) {
    const project = to(from);
    const owner = to(team);
    if (project && owner) writeEntity('project', project, { team_id: owner }, opts());
  }
  for (const [from, lead] of Object.entries(doc.links?.leads ?? {})) {
    const project = to(from);
    const user = who(lead);
    if (project && user) writeEntity('project', project, { lead_id: user }, opts());
  }
  for (const row of doc.links?.relations ?? []) {
    const from = to(row.task_id);
    const target = to(row.related_task_id);
    if (!from || !target) continue;
    write('relation', row, { task_id: from, related_task_id: target });
    bump('relations');
  }
  // A shared cycle's list of projects, now that they all exist. An empty list
  // means *every* project, so one whose projects all resolved to nothing is
  // left empty only if it was empty to begin with.
  for (const row of doc.cycles ?? []) {
    const id = to(row.id);
    const named = jsonList(row.projects).map(to).filter(Boolean);
    if (id && named.length) writeEntity('cycle', id, { projects: named }, opts());
  }
  for (const row of doc.modules ?? []) {
    const id = to(row.id);
    const named = jsonList(row.projects).map(to).filter(Boolean);
    if (id && named.length) writeEntity('module', id, { projects: named }, opts());
  }

  /* ---------------------------------------------- the rest of the workspace */

  for (const row of inTreeOrder(doc.pages ?? [])) {
    write('page', row, {
      project_id: null,
      parent_id: to(row.parent_id),
      created_by: who(row.created_by) ?? actorId,
      watchers: jsonList(row.watchers).map(who).filter(Boolean),
      labels: jsonList(row.labels).map(to).filter(Boolean),
    });
    bump('pages');
  }
  for (const row of doc.page_comments ?? []) {
    const page = to(row.page_id);
    if (!page) continue;
    write('comment', row, {
      page_id: page, task_id: null, parent_id: to(row.parent_id),
      author_id: who(row.author_id) ?? actorId, reactions: {},
    });
    bump('comments');
  }
  for (const row of doc.views ?? []) {
    write('view', row, {
      project_id: to(row.project_id),
      team_id: to(row.team_id),
      owner_id: who(row.owner_id),
      // A filter is a bag of ids — states, labels, people, cycles. Rewriting
      // it by walking the JSON is the one approach that does not go stale
      // every time a new filter is added to the query language.
      filters: remapDeep(row.filters, (value) => map.get(value) ?? person.get(value) ?? null),
    });
    bump('views');
  }
  for (const row of doc.channels ?? []) {
    write('channel', row, {
      project_id: null, kind: 'channel', is_private: 0, members: [],
      created_by: who(row.created_by) ?? actorId, archived_at: undefined,
    });
    bump('channels');
  }
  for (const row of doc.messages ?? []) {
    const channel = to(row.channel_id);
    if (!channel) continue;
    write('message', row, {
      channel_id: channel, reply_to: to(row.reply_to),
      author_id: who(row.author_id) ?? actorId, reactions: {},
    });
    bump('messages');
  }
  /* The blobs the workspace's own pages and their comments point at. The
     projects' own were adopted by each project's import; this is what is left,
     and it is also what gives the *workspace* a row for a picture that arrived
     in the archive — without which the permission check on `/files/:hash`
     answers "not yours" about a file the workspace just imported. */
  const wanted = new Set<string>((doc.files ?? []).map((file) => file.hash));
  collectHashes([doc.workspace], wanted);
  for (const section of [doc.pages, doc.page_comments, doc.messages, doc.attachments]) collectHashes(section ?? [], wanted);
  if (options.restored) for (const hash of options.restored) wanted.add(hash);
  const missingHere = adoptFiles(
    workspaceId, actorId, wanted,
    new Map((doc.files ?? []).map((file) => [file.hash, file])),
    options.restored,
  );
  const named = new Map((doc.files ?? []).map((file) => [file.hash, file.name]));
  for (const hash of missingHere) missingFiles.add(named.get(hash) ?? hash.slice(0, 12));

  for (const row of doc.attachments ?? []) {
    const page = to(row.page_id);
    const comment = to(row.comment_id);
    if (!page && !comment) continue;
    const [hash] = hashesIn(row.url);
    if (!hash || missingHere.includes(hash)) continue;
    write('attachment', row, {
      page_id: page, comment_id: comment, task_id: null,
      uploaded_by: who(row.uploaded_by) ?? actorId,
    });
    bump('attachments');
  }

  return {
    workspace: get<Row>(`SELECT * FROM workspaces WHERE id = ?`, workspaceId)!,
    counts,
    unmatched,
    missingFiles: [...missingFiles],
    projects,
  };
}

const jsonList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Rewrite every id anywhere inside a value.
 *
 * Only exact matches are touched, and the ids are UUIDs — a string that is one
 * is one, and a string that is not cannot accidentally become one. Used on the
 * saved views' filters, which are a shape that is meant to keep growing.
 */
function remapDeep(raw: unknown, lookup: (value: string) => string | null): unknown {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return lookup(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = walk(inner);
      return out;
    }
    return value;
  };
  return walk(parsed);
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
