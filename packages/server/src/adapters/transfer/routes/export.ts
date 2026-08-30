/**
 * Getting the data out, and getting it back in.
 *
 * Four things live here, and they are one feature: a workspace as a document,
 * a task list as a spreadsheet, one person's own data, and the snapshots an
 * operator restores from. They are together because the promise is one
 * promise — *this is yours and you can take it with you* — and a promise kept
 * in four different files is one that gets half-kept.
 *
 * Every one of them is an ordinary authenticated request. Nothing here mints a
 * signed or public URL — a link that carries its own permission is a link that
 * outlives the reason it was made, and an export is the last thing that should.
 */
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { requireAuth, requireWorkspace, requireWrite } from '../../../kernel/identity/auth.ts';
import { readArchive, sendArchive, storeBlobs } from '../../../modules/planning/archive.ts';
import * as backups from '../../../modules/operations/backups.ts';
import * as rehydrate from '../../../modules/operations/rehydrate.ts';
import { badRequest, forbidden, notFound, readBody, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { exportPerson } from '../../../modules/time/personal.ts';
import { canSeeProject, serialize } from '../../../kernel/write-path/repo.ts';
import { tasksToCsv } from '../../../modules/work/tasks-csv.ts';
import { exportProject, importProject, type ProjectDoc } from '../transfer.ts';
import {
  detectWorkspaceDoc, exportWorkspace, importWorkspace, type WorkspaceDoc,
} from '../workspace-transfer.ts';
import { unzip, ZipWriter } from '../../../kernel/files/zip.ts';

/** A filename a browser will accept and a filesystem will keep. */
const safe = (value: string): string =>
  (value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'kolibri').slice(0, 60);

/** The local day, so a file downloaded at one in the morning is not dated yesterday. */
const today = (): string => {
  const at = new Date();
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

/**
 * An archive arrives as a raw body, so the content type is the only thing
 * saying what it is.
 *
 * Insisting on it also settles the cross-site question: the three types a
 * form can post without a preflight are exactly the three this refuses.
 */
async function readArchiveBody(ctx: Ctx): Promise<Buffer> {
  const declared = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (declared !== 'application/zip' && declared !== 'application/x-zip-compressed') {
    throw badRequest('Send the archive as application/zip');
  }
  const body = await readBody(ctx.req, env.maxImportBytes);
  if (!body.length) throw badRequest('That file is empty');
  return body;
}

/** Text and bytes both, since `send` only knows JSON. */
function sendRaw(ctx: Ctx, type: string, filename: string, body: Buffer): void {
  ctx.res.writeHead(200, {
    'content-type': type,
    'content-length': String(body.length),
    'content-disposition': `attachment; filename="${filename.replace(/[\r\n"\\]/g, '_')}"`,
    'cache-control': 'no-store',
  });
  ctx.res.end(body);
}

export function registerExportRoutes(router: Router): void {
  /* ------------------------------------------------- the whole workspace */

  /**
   * What an export would contain, before anybody waits for one.
   *
   * A workspace with ten years of screenshots in it is a large download, and
   * the moment to say so is before the click rather than during it.
   */
  router.get('/api/workspaces/:ws/export/preview', (ctx: Ctx) => {
    requireWorkspace(ctx, ctx.params.ws, 'admin');
    const doc = exportWorkspace(ctx.params.ws);
    return {
      workspace: doc.workspace.name,
      projects: doc.projects.length,
      tasks: doc.projects.reduce((sum, project) => sum + project.tasks.length, 0),
      pages: doc.pages.length + doc.projects.reduce((sum, project) => sum + project.pages.length, 0),
      people: doc.people.length,
      files: doc.files.length,
      /** Uncompressed, which is the number that decides whether to wait. */
      fileBytes: doc.files.reduce((sum, file) => sum + file.size, 0),
    };
  });

  /**
   * The workspace as one document — `?format=zip` to bring the files with it.
   *
   * Admin, because this is everything: the private projects included. A member
   * who can see three of eleven projects can export those three, one at a time,
   * which is the same data by a route that already checks.
   */
  router.get('/api/workspaces/:ws/export', async (ctx: Ctx) => {
    requireWorkspace(ctx, ctx.params.ws, 'admin');
    const doc = exportWorkspace(ctx.params.ws);
    const name = safe(String(doc.workspace.slug ?? doc.workspace.name ?? 'workspace'));
    if (ctx.query.get('format') !== 'zip') return doc;
    await sendArchive(ctx.res, `${name}-${today()}.kolibri.zip`, doc, String(doc.workspace.name ?? name));
    return undefined;
  });

  /**
   * A workspace document read back, as a new workspace.
   *
   * New, always — see `importWorkspace`. Which is also why this needs no more
   * permission than making one by hand does: nothing that already exists can
   * be touched by it.
   */
  router.post('/api/import/workspace', async (ctx: Ctx) => {
    const auth = requireWrite(ctx);
    const body = await readJson<{ document?: unknown; name?: string; match_people?: boolean }>(ctx, env.maxImportBytes);
    if (!detectWorkspaceDoc(body.document)) throw badRequest('That file is not a Kolibri workspace export');
    const report = importWorkspace(auth.userId, body.document as WorkspaceDoc, {
      name: body.name,
      matchPeople: body.match_people !== false,
    });
    return {
      workspace: { id: report.workspace.id, name: report.workspace.name, slug: report.workspace.slug },
      counts: report.counts,
      projects: report.projects,
      unmatched: report.unmatched,
      missingFiles: report.missingFiles,
    };
  });

  /**
   * The same, from a `.zip` — the document first, then the files.
   *
   * In that order, and only that order: reading the document is free and
   * decides both *what* this is and *who* may import it, and there is no
   * reason to have written a hundred megabytes of somebody's attachments to
   * disk before finding out the answer is no.
   *
   * The shape of the document says whether it is a workspace or a project, the
   * same way the importers already recognise the other tools' files. A project
   * archive needs `?workspace=` to say where it goes; a workspace archive
   * makes its own.
   */
  router.post('/api/import/archive', async (ctx: Ctx) => {
    const auth = requireWrite(ctx);
    const archive = await readArchiveBody(ctx);
    const { document, blobs, rejected } = readArchive(archive);
    const into = ctx.query.get('workspace');

    if (detectWorkspaceDoc(document)) {
      const restored = await storeBlobs(blobs, document);
      const report = importWorkspace(auth.userId, document as WorkspaceDoc, {
        name: ctx.query.get('name') ?? undefined,
        restored,
      });
      return {
        workspace: { id: report.workspace.id, name: report.workspace.name, slug: report.workspace.slug },
        counts: report.counts,
        projects: report.projects,
        unmatched: report.unmatched,
        missingFiles: report.missingFiles,
        rejected,
      };
    }

    if (!into) throw badRequest('That archive holds a project — say which workspace to put it in');
    requireWorkspace(ctx, into, 'member');
    const restored = await storeBlobs(blobs, document);
    const report = importProject(into, auth.userId, document as ProjectDoc, {
      name: ctx.query.get('name') ?? undefined,
      intoProjectId: ctx.query.get('project_id') ?? undefined,
      restored,
    });
    return {
      project: serialize('project', report.project),
      counts: report.counts,
      unmatched: report.unmatched,
      updated: report.updated,
      missingFiles: report.missingFiles,
      rejected,
    };
  });

  /* ------------------------------------------------------ one project, zipped */

  router.get('/api/workspaces/:ws/projects/:id/export.zip', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);
    const project = get<Row>(`SELECT id, key, name FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      ctx.params.id, ctx.params.ws);
    if (!project) throw notFound('Project not found');
    if (!canSeeProject(auth.userId, project.id)) throw forbidden('That project is private');

    const doc = exportProject(ctx.params.ws, String(project.id));
    await sendArchive(ctx.res, `${safe(String(project.key ?? project.name))}-${today()}.kolibri.zip`, doc, String(project.name));
    return undefined;
  });

  /* ------------------------------------------------------------------ CSV */

  /**
   * A task list as a spreadsheet.
   *
   * Scoped by the same parameters the list endpoint takes, so "export what I
   * am looking at" is the same query with a different `Accept`. Private
   * projects are filtered out here rather than in the SQL, because who can see
   * what is a question `canSeeProject` already answers and answering it twice
   * is how the two answers drift apart.
   */
  router.get('/api/workspaces/:ws/export/tasks.csv', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);

    const visible = all<Row>(`SELECT id FROM projects WHERE workspace_id = ? AND deleted_at IS NULL`, ctx.params.ws)
      .map((project) => String(project.id))
      .filter((id) => canSeeProject(auth.userId, id));

    const asked = ctx.query.get('project_id');
    const ids = asked ? visible.filter((id) => id === asked) : visible;
    if (asked && !ids.length) throw forbidden('That project is not one you can see');

    const where: string[] = [`t.project_id IN (${ids.map(() => '?').join(', ') || 'NULL'})`];
    const params: unknown[] = [...ids];
    for (const [param, column] of [['cycle_id', 't.cycle_id'], ['module_id', 't.module_id'], ['state_id', 't.state_id']] as const) {
      const value = ctx.query.get(param);
      if (value) { where.push(`${column} = ?`); params.push(value); }
    }
    const assignee = ctx.query.get('assignee');
    if (assignee) {
      where.push(`EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)`);
      params.push(assignee);
    }

    const delimiter = ctx.query.get('delimiter') === ';' ? ';' : ',';
    const csv = tasksToCsv(ctx.params.ws, where.join(' AND '), params, {
      delimiter,
      archived: ['1', 'true', 'yes'].includes((ctx.query.get('archived') ?? '').toLowerCase()),
    });
    const workspace = get<Row>(`SELECT slug FROM workspaces WHERE id = ?`, ctx.params.ws);
    sendRaw(ctx, 'text/csv; charset=utf-8', `${safe(String(workspace?.slug ?? 'tasks'))}-tasks-${today()}.csv`, Buffer.from(csv, 'utf8'));
    return undefined;
  });

  /* ---------------------------------------------------------- one person */

  /**
   * Everything this instance holds about whoever is asking.
   *
   * About *whoever is asking* and nobody else — there is no `:userId` here on
   * purpose. An admin who needs somebody else's data has the database.
   */
  router.get('/api/me/export', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const doc = exportPerson(auth.userId);
    if (ctx.query.get('download') === '1') {
      sendRaw(ctx, 'application/json; charset=utf-8', `my-kolibri-data-${today()}.json`, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`));
      return undefined;
    }
    return doc;
  });

  /* ----------------------------------------------------------- snapshots */

  /**
   * Backups are instance-wide — every workspace is in one — so being an admin
   * *of a workspace* is not enough to see them, let alone take one.
   */
  const requireInstanceAdmin = (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.isAdmin) throw forbidden('Only an instance administrator can do that');
    return auth;
  };

  router.get('/api/admin/backups', (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    return { ...backups.status(), snapshots: backups.snapshots().map(withoutPath) };
  });

  router.post('/api/admin/backups', async (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    if (!env.backup.dir) throw badRequest('No backup directory is configured — set KOLIBRI_BACKUP_DIR');
    const done = backups.take(env.backup.dir, { force: true });
    if (!done) throw badRequest('Could not take a snapshot');
    const pruned = backups.prune();
    let copied: number | null = null;
    if (env.backup.offsite) copied = (await backups.offsite(done.snapshot.name)).uploaded;
    return { snapshot: withoutPath(backups.checked(done.snapshot.name) ?? done.snapshot), pruned, copied };
  });

  router.post('/api/admin/backups/:name/verify', (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const snapshot = backups.checked(ctx.params.name);
    if (!snapshot) throw notFound('No such snapshot');
    return withoutPath(snapshot);
  });

  router.post('/api/admin/backups/:name/offsite', async (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    if (!backups.pathOf(ctx.params.name)) throw notFound('No such snapshot');
    return backups.offsite(ctx.params.name);
  });

  router.delete('/api/admin/backups/:name', (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const path = backups.pathOf(ctx.params.name);
    if (!path) throw notFound('No such snapshot');
    rmSync(path, { recursive: true, force: true });
    return { removed: ctx.params.name };
  });

  /**
   * What a snapshot holds, before anybody agrees to be replaced by it.
   *
   * A restore is the one destructive thing in this file, so the screen in
   * front of it should be able to say *what* is about to arrive — and, just as
   * importantly, what is about to go.
   */
  router.post('/api/admin/backups/:name/inspect', (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const path = backups.pathOf(ctx.params.name);
    if (!path) throw notFound('No such snapshot');
    return { name: ctx.params.name, ...rehydrate.inspect(path), replacing: here() };
  });

  /**
   * Put a snapshot back, into this instance, while it is running.
   *
   * The two shapes this takes are the two ways somebody arrives at needing it:
   * a snapshot that is already on the server (this route), and one they have
   * on their laptop from an instance that no longer exists (the next).
   */
  router.post('/api/admin/backups/:name/restore', async (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const path = backups.pathOf(ctx.params.name);
    if (!path) throw notFound('No such snapshot');
    return restoreFrom(path, ctx.params.name);
  });

  /**
   * The same, from a `.zip` — which is the file the panel beside this hands
   * out, so "download it there, upload it here" is the whole of moving an
   * instance to another machine.
   */
  router.post('/api/admin/restore', async (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const archive = await readArchiveBody(ctx);
    const staged = mkdtempSync(join(tmpdir(), 'kolibri-snapshot-'));
    try {
      const zip = unzip(archive);
      const database = zip.read('kolibri.sqlite');
      if (!database) throw badRequest('That .zip is not a Kolibri snapshot — it has no kolibri.sqlite in it');
      writeFileSync(join(staged, 'kolibri.sqlite'), database);
      const manifest = zip.read('manifest.json');
      if (manifest) writeFileSync(join(staged, 'manifest.json'), manifest);

      // The uploads are written out as they came, keyed by the same
      // content-addressed path the store uses, so `restoreUploads` finds them
      // by asking the restored `files` rows rather than by guessing.
      for (const name of zip.names()) {
        if (!name.startsWith('uploads/') || name.includes('..')) continue;
        const body = zip.read(name);
        if (!body) continue;
        const target = join(staged, name);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, body);
      }
      return await restoreFrom(staged, 'the uploaded snapshot');
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });

  /**
   * A snapshot as one file, so it can be taken off the machine.
   *
   * Zipped as it is read, because a snapshot with the uploads in it is the
   * biggest thing this server ever sends and holding it in memory first would
   * be the one request that kills the process.
   */
  router.get('/api/admin/backups/:name/download', async (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    const path = backups.pathOf(ctx.params.name);
    if (!path) throw notFound('No such snapshot');

    ctx.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="kolibri-${safe(ctx.params.name)}.zip"`,
      'cache-control': 'no-store',
    });
    const writer = new ZipWriter(ctx.res);
    for (const relative of files(path)) {
      await writer.add(relative, await read(join(path, relative)), statSync(join(path, relative)).mtime);
    }
    await writer.end();
    return undefined;
  });
}

const withoutPath = ({ path: _drop, ...rest }: backups.Snapshot) => rest;

/** What this instance holds now — the half of a restore nobody thinks about. */
const here = (): { users: number; workspaces: number; tasks: number; unused: boolean } => ({
  users: Number(get<Row>(`SELECT count(*) AS n FROM users`)?.n ?? 0),
  workspaces: Number(get<Row>(`SELECT count(*) AS n FROM workspaces WHERE deleted_at IS NULL`)?.n ?? 0),
  tasks: Number(get<Row>(`SELECT count(*) AS n FROM tasks WHERE deleted_at IS NULL`)?.n ?? 0),
  unused: rehydrate.isUnused(),
});

/**
 * The tables, then the blobs, then the report.
 *
 * In that order because the blobs are found *through* the tables: which file
 * has which content type is a restored row, not a guess from an extension.
 */
async function restoreFrom(dir: string, from: string): Promise<Record<string, unknown>> {
  const replacing = here();
  const report = rehydrate.rehydrate(dir);
  report.files = await rehydrate.restoreUploads(dir);
  return {
    ...report,
    from,
    replaced: report.replaced,
    // Said in the response because it is the next thing that happens to
    // whoever pressed the button: the sessions table was one of the tables
    // that got replaced, so this reply is the last one their cookie will be
    // accepted for.
    signedOut: true,
    was: replacing,
  };
}

/** Every file under a directory, as paths relative to it. */
function* files(root: string, base = ''): Generator<string> {
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* files(root, relative);
    else yield relative;
  }
}

const read = (path: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(path)
      .on('data', (chunk) => chunks.push(chunk as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
