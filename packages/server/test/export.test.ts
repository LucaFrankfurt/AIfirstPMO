/**
 * Getting everything out, and getting it back in.
 *
 * The project round trip is tested next door. What is tested here is
 * everything that one cannot reach: the workspace above the projects, the
 * wiring between them, the bytes behind the attachments, and the snapshots an
 * operator restores from.
 *
 * The shape of each test is the same and is the only shape worth trusting —
 * export, import, then look for the same *thing* on the other side rather than
 * for the same JSON.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-export-${process.pid}`;
process.env.KOLIBRI_BACKUP_DIR = `/tmp/kolibri-export-${process.pid}/backups`;
process.env.KOLIBRI_BACKUP_KEEP = '2';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { zip, unzip, crc32 } = await import('../src/lib/zip.ts');
const { writeCsv, parseCsv } = await import('@kolibri/shared');
const backups = await import('../src/lib/backups.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let ada = '';
let grace = '';
/** `alpha` sits above `beta`; a task in each, one blocking the other. */
let alpha = '';
let beta = '';
let alphaTask = '';
let betaTask = '';
let sharedCycle = '';
let pictureHash = '';

async function call(path: string, body?: unknown, method?: string, as = cookie) {
  return fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { cookie: as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(path: string, body?: unknown, method?: string, as = cookie): Promise<any> {
  const response = await call(path, body, method, as);
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A one-pixel PNG, so there is something real to attach. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = await call('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  cookie = (owner.headers.get('set-cookie') ?? '').split(';')[0];
  const session = (await owner.json()) as any;
  workspaceId = session.workspaces[0].id;
  ada = session.user.id;

  const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
  resetRateLimits();
  const second = await call('/api/auth/register', {
    email: 'grace@example.com', name: 'Grace', password: 'correct horse battery', invite: invite.code,
  });
  grace = ((await second.json()) as any).user.id;
  resetRateLimits();

  alpha = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Alpha', key: 'ALPHA' })).id;
  beta = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Beta', key: 'BETA', parentId: alpha })).id;
  // The API does not take a parent on create everywhere, so make it explicit.
  await ok(`/api/projects/${beta}`, { parent_id: alpha }, 'PATCH');

  const team = await ok(`/api/workspaces/${workspaceId}/teams`, { name: 'Platform', key: 'PLAT' });
  await ok(`/api/projects/${alpha}`, { team_id: team.id }, 'PATCH');

  sharedCycle = (await ok(`/api/workspaces/${workspaceId}/cycles`, {
    name: 'Sprint 1', projects: [alpha, beta], starts_on: '2026-01-05', ends_on: '2026-01-16',
  })).id;

  const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${alpha}`);
  alphaTask = (await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: alpha, title: 'Lay the foundation', state_id: states[0].id, cycle_id: sharedCycle,
    assignees: [ada, grace], due_date: '2026-03-01', estimate: 3,
  })).id;
  betaTask = (await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: beta, title: 'Put the roof on', cycle_id: sharedCycle,
  })).id;
  await ok(`/api/workspaces/${workspaceId}/relations`, {
    task_id: alphaTask, related_task_id: betaTask, kind: 'blocks',
  });

  // A page outside every project, and a workspace-wide saved view.
  await ok(`/api/workspaces/${workspaceId}/pages`, { title: 'Handbook', content: 'How we work' });
  await ok(`/api/workspaces/${workspaceId}/views`, { name: 'Everything due', layout: 'list', filters: { assignee: [ada] } });

  // A real attachment, so the bytes have somewhere to travel from.
  const upload = await fetch(`${base}/api/workspaces/${workspaceId}/files?task_id=${alphaTask}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': 'pixel.png', cookie },
    body: PIXEL,
  });
  pictureHash = ((await upload.json()) as any).hash;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- ZIP */

describe('the archive format', () => {
  it('round trips names, bytes and an empty file', async () => {
    const files = [
      { name: 'kolibri.json', body: Buffer.from('{"hello":"wörld"}') },
      { name: 'files/ab/pixel.png', body: PIXEL },
      { name: 'empty', body: Buffer.alloc(0) },
    ];
    const read = unzip(await zip(files));
    assert.deepEqual(read.names().sort(), ['empty', 'files/ab/pixel.png', 'kolibri.json']);
    for (const file of files) assert.ok(read.read(file.name)!.equals(file.body), file.name);
  });

  it('computes the checksum every unpacker will check', () => {
    // The known CRC-32 of "hello", so a broken table is caught here rather
    // than by somebody's unzip refusing the file.
    assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  });

  it('refuses bytes that do not match their checksum', async () => {
    const archive = await zip([{ name: 'a.txt', body: Buffer.from('the original') }]);
    // Flip a byte in the compressed data, past the local header and the name.
    const damaged = Buffer.from(archive);
    damaged[40] = damaged[40] ^ 0xff;
    assert.throws(() => unzip(damaged).read('a.txt'), /corrupt|checksum|incorrect|invalid/i);
  });

  it('says what is not a ZIP rather than guessing', () => {
    assert.throws(() => unzip(Buffer.from('this is a JSON file, actually')), /not a ZIP/i);
  });
});

/* ------------------------------------------------------------- workspace */

describe('a workspace as a document', () => {
  it('says what it would contain before anybody waits for it', async () => {
    const preview = await ok(`/api/workspaces/${workspaceId}/export/preview`);
    const projects = await ok(`/api/workspaces/${workspaceId}/projects`);
    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks`);
    assert.equal(preview.projects, projects.length, 'every project, including the starter one');
    assert.equal(preview.tasks, tasks.length);
    assert.equal(preview.files, 1);
    assert.ok(preview.fileBytes > 0);
  });

  it('carries the projects, the people and what is above both', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/export`);
    const projects = await ok(`/api/workspaces/${workspaceId}/projects`);
    assert.equal(doc.format, 'kolibri.workspace/1');
    assert.equal(doc.projects.length, projects.length);
    assert.ok(doc.projects.some((one: any) => one.project.name === 'Alpha'));
    assert.ok(doc.projects.some((one: any) => one.project.name === 'Beta'));
    assert.equal(doc.teams.length, 1);
    assert.equal(doc.people.length, 2);
    assert.equal(doc.pages.length, 1, 'the page outside every project');
    assert.equal(doc.views.length, 1);
    // The shared cycle is carried once at the top, not copied into both.
    assert.equal(doc.cycles.length, 1);
    for (const project of doc.projects) assert.equal(project.cycles.length, 0);
    assert.equal(doc.links.relations.length, 1, 'the dependency that crosses two projects');
    assert.ok(doc.links.parents[beta] === alpha, 'the project tree');
  });

  it('reads back as a new workspace with the wiring intact', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/export`);
    const report = await ok('/api/import/workspace', { document: doc, name: 'Copy' });
    const copy = report.workspace.id;
    assert.notEqual(copy, workspaceId);
    assert.equal(report.projects.length, doc.projects.length);

    const projects = await ok(`/api/workspaces/${copy}/projects`);
    const newAlpha = projects.find((p: any) => p.name === 'Alpha');
    const newBeta = projects.find((p: any) => p.name === 'Beta');
    assert.equal(newBeta.parent_id, newAlpha.id, 'the tree is a tree on the other side');
    assert.ok(newAlpha.team_id, 'and the team that owns it came too');

    const cycles = await ok(`/api/workspaces/${copy}/cycles`);
    assert.equal(cycles.length, 1, 'one shared cycle, not one per project');
    assert.deepEqual([...cycles[0].projects].sort(), [newAlpha.id, newBeta.id].sort());

    const tasks = await ok(`/api/workspaces/${copy}/tasks`);
    assert.equal(tasks.length, 2);
    for (const task of tasks) assert.equal(task.cycle_id, cycles[0].id, 'both in the same fortnight');

    const relations = await ok(`/api/workspaces/${copy}/relations`);
    assert.equal(relations.length, 1, 'the dependency across two projects survived');
    const from = tasks.find((t: any) => t.id === relations[0].task_id);
    const to = tasks.find((t: any) => t.id === relations[0].related_task_id);
    assert.notEqual(from.project_id, to.project_id, 'and still crosses them');
  });

  it('never points back at the workspace it came from', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/export`);
    const report = await ok('/api/import/workspace', { document: doc, name: 'Second copy' });
    const copy = report.workspace.id;
    for (const collection of ['tasks', 'projects', 'cycles', 'views', 'pages']) {
      for (const row of await ok(`/api/workspaces/${copy}/${collection}`)) {
        assert.doesNotMatch(JSON.stringify(row), new RegExp(workspaceId), `${collection} still names the old workspace`);
      }
    }
  });

  it('is admin-only, because it holds the private projects too', async () => {
    const graceLogin = await call('/api/auth/login', { email: 'grace@example.com', password: 'correct horse battery' });
    resetRateLimits();
    const as = (graceLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const refused = await call(`/api/workspaces/${workspaceId}/export`, undefined, 'GET', as);
    assert.equal(refused.status, 403);
  });
});

/* ------------------------------------------------------------ the files */

describe('the files an export refers to', () => {
  it('are listed in the document', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/projects/${alpha}/export`);
    assert.equal(doc.files.length, 1);
    assert.equal(doc.files[0].hash, pictureHash);
    assert.equal(doc.attachments.length, 1);
  });

  it('travel in a .zip, and the bytes still hash to what the document says', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/projects/${alpha}/export.zip`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /zip/);
    const archive = unzip(Buffer.from(await response.arrayBuffer()));
    const doc = JSON.parse(archive.read('kolibri.json')!.toString('utf8'));
    assert.equal(doc.files.length, 1);
    const bytes = archive.read(`files/${pictureHash}.png`);
    assert.ok(bytes, 'the blob is in the archive');
    assert.equal(createHash('sha256').update(bytes!).digest('hex'), pictureHash);
    assert.ok(archive.read('README.txt'), 'and a note saying what this is');
  });

  it('come back attached when the archive is imported', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/projects/${alpha}/export.zip`, { headers: { cookie } });
    const archive = Buffer.from(await response.arrayBuffer());
    const imported = await fetch(`${base}/api/import/archive?workspace=${workspaceId}&name=Alpha+from+a+zip`, {
      method: 'POST', headers: { 'content-type': 'application/zip', cookie }, body: archive,
    });
    const report = (await imported.json()) as any;
    assert.equal(imported.status, 200, JSON.stringify(report));
    assert.deepEqual(report.missingFiles, []);
    assert.deepEqual(report.rejected, []);
    const landed = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${report.project.id}`);
    const attachments = await ok(`/api/workspaces/${workspaceId}/attachments`);
    const mine = attachments.filter((row: any) => landed.some((task: any) => task.id === row.task_id));
    assert.equal(mine.length, 1, 'the paperclip is on the imported task');
    assert.match(String(mine[0].url), new RegExp(pictureHash), 'and points at the same bytes');
  });

  it('are named, not counted, when the bytes are nowhere to be found', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/projects/${alpha}/export`);
    // A document describing a file this instance has never seen: JSON alone
    // carries no bytes, which is the whole reason the .zip exists.
    const invented = 'f'.repeat(64);
    doc.files = [{ hash: invented, name: 'missing-diagram.png', mime: 'image/png', size: 10 }];
    doc.attachments = [{
      id: 'a1', task_id: doc.tasks[0].id, name: 'missing-diagram.png', mime: 'image/png',
      size: 10, url: `/files/${invented}/missing-diagram.png`,
    }];
    const report = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Alpha without its pictures' });
    assert.deepEqual(report.missingFiles, ['missing-diagram.png']);
    const landed = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${report.project.id}`);
    const attachments = await ok(`/api/workspaces/${workspaceId}/attachments`);
    const mine = attachments.filter((row: any) => landed.some((task: any) => task.id === row.task_id));
    assert.equal(mine.length, 0, 'no paperclip pointing at a 404');
  });

  it('refuses bytes filed under somebody else’s hash', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/projects/${alpha}/export`);
    const lie = 'a'.repeat(64);
    const archive = await zip([
      { name: 'kolibri.json', body: Buffer.from(JSON.stringify(doc)) },
      { name: `files/${lie}.png`, body: Buffer.from('not what the name claims') },
    ]);
    const response = await fetch(`${base}/api/import/archive?workspace=${workspaceId}&name=Liar`, {
      method: 'POST', headers: { 'content-type': 'application/zip', cookie }, body: archive,
    });
    const report = (await response.json()) as any;
    assert.deepEqual(report.rejected, [`files/${lie}.png`]);
  });
});

/* ---------------------------------------------------------------- merge */

describe('importing into a project that already exists', () => {
  it('adds the tasks and reuses the states rather than duplicating them', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/projects/${alpha}/export`);
    const before = await ok(`/api/workspaces/${workspaceId}/states?project_id=${beta}`);
    const beforeTasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${beta}`);

    const report = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, project_id: beta });
    assert.equal(report.project.id, beta, 'it went into the project it was told to');

    const after = await ok(`/api/workspaces/${workspaceId}/states?project_id=${beta}`);
    assert.equal(after.length, before.length, 'the same workflow, not two of each column');
    const afterTasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${beta}`);
    assert.equal(afterTasks.length, beforeTasks.length + doc.tasks.length);
  });

  it('updates a task it has seen before instead of adding a second one', async () => {
    const doc = await ok(`/api/workspaces/${workspaceId}/projects/${alpha}/export`);
    doc.tasks = doc.tasks.map((task: any) => ({ ...task, title: `${task.title} (revised)` }));
    const before = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${alpha}`);

    const report = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, project_id: alpha });
    assert.equal(report.updated, doc.tasks.length, 'every one landed on the task it came from');

    const after = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${alpha}`);
    assert.equal(after.length, before.length, 'and none of them arrived twice');
    assert.ok(after.every((task: any) => task.title.endsWith('(revised)')));
  });
});

/* ------------------------------------------------------------------ CSV */

describe('a task list as a spreadsheet', () => {
  it('writes the columns the importer reads back', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/export/tasks.csv?project_id=${alpha}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
    const table = parseCsv(await response.text());
    const row = table.rows.find((one: any) => one.Title.startsWith('Lay the foundation'));
    assert.ok(row, 'the task is in the file');
    assert.match(row!.Key, /^ALPHA-/);
    assert.equal(row!['Due date'], '2026-03-01');
    assert.equal(row!.Estimate, '3');
    // Both assignees, because a task can be on two people and a spreadsheet
    // that shows one of them is a spreadsheet that quietly loses the other.
    assert.match(row!.Assignee, /Ada/);
    assert.match(row!.Assignee, /Grace/);
  });

  it('neutralises a cell a spreadsheet would run', () => {
    const csv = writeCsv(['Title'], [['=HYPERLINK("http://evil","click")']]);
    assert.match(csv, /'=HYPERLINK/, 'shown as text, not executed');
    assert.equal(parseCsv(csv).rows[0].Title, '\'=HYPERLINK("http://evil","click")');
  });

  it('writes semicolons for the Excel that only splits on those', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/export/tasks.csv?delimiter=%3B`, { headers: { cookie } });
    const text = await response.text();
    assert.match(text.split('\r\n')[0], /Key;Title;/);
  });

  it('round trips: export a project, import the CSV, get the tasks back', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/export/tasks.csv?project_id=${alpha}`, { headers: { cookie } });
    const csv = await response.text();
    const fresh = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'From a spreadsheet', key: 'SHEET' });
    const result = await ok(`/api/workspaces/${workspaceId}/import`, { project_id: fresh.id, csv, dry_run: false });
    assert.ok(result.created > 0);
    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${fresh.id}`);
    assert.ok(tasks.some((task: any) => task.title.startsWith('Lay the foundation')));
    const landed = tasks.find((task: any) => task.title.startsWith('Lay the foundation'));
    assert.equal(landed.assignees.length, 2, 'both people came back');
  });
});

/* --------------------------------------------------------------- a person */

describe('one person’s own data', () => {
  it('has their work in it', async () => {
    const doc = await ok('/api/me/export');
    assert.equal(doc.format, 'kolibri.person/1');
    assert.equal(doc.account.email, 'ada@example.com');
    assert.ok(doc.workspaces.length >= 1);
    assert.ok(doc.tasks.assigned.some((task: any) => task.title.startsWith('Lay the foundation')));
    assert.ok(doc.devices.length >= 1, 'the devices signed in');
  });

  it('has none of their secrets in it', async () => {
    const text = JSON.stringify(await ok('/api/me/export'));
    for (const secret of ['password_hash', 'totp_secret', 'recovery_codes', 'token_hash', 'calendar_token']) {
      assert.doesNotMatch(text, new RegExp(secret), `${secret} must not be handed back`);
    }
    assert.doesNotMatch(text, /scrypt\$/, 'nor the hash itself under another name');
  });

  it('is about whoever asked and nobody else', async () => {
    const graceLogin = await call('/api/auth/login', { email: 'grace@example.com', password: 'correct horse battery' });
    resetRateLimits();
    const as = (graceLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const doc = await ok('/api/me/export', undefined, 'GET', as);
    assert.equal(doc.account.email, 'grace@example.com');
  });
});

/* -------------------------------------------------------------- backups */

describe('snapshots that take themselves', () => {
  it('takes one, and refuses to take a second for the same day by accident', () => {
    const first = backups.take();
    assert.ok(first, 'the first one is taken');
    assert.ok(existsSync(`${first!.snapshot.path}/kolibri.sqlite`));
    assert.equal(backups.take(), null, 'the day is already covered');
    assert.ok(backups.take(undefined, { force: true }), 'unless somebody asks on purpose');
  });

  it('opens what it wrote', () => {
    const list = backups.snapshots();
    assert.ok(list.length >= 1);
    const checked = backups.checked(list[0].name);
    assert.equal(checked?.intact, true, checked?.problem);
    assert.ok((checked?.counts.tasks ?? 0) > 0, 'and the tasks are in it');
  });

  it('keeps the number it was told to keep', () => {
    // Three days, so the retention of two has something to remove.
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      backups.take(undefined, { now: new Date(`${day}T04:00:00Z`) });
    }
    const removed = backups.prune(undefined, 2);
    assert.ok(removed.length >= 1);
    assert.equal(backups.snapshots().length, 2);
    // Newest first, so what survives is what somebody would actually want.
    assert.deepEqual(backups.snapshots().map((one) => one.name), [...backups.snapshots().map((one) => one.name)].sort().reverse());
  });

  it('will not follow a name out of its own directory', () => {
    assert.equal(backups.pathOf('../../etc'), null);
    assert.equal(backups.pathOf('not-a-date'), null);
  });

  it('is not something an ordinary member can see', async () => {
    const graceLogin = await call('/api/auth/login', { email: 'grace@example.com', password: 'correct horse battery' });
    resetRateLimits();
    const as = (graceLogin.headers.get('set-cookie') ?? '').split(';')[0];
    const refused = await call('/api/admin/backups', undefined, 'GET', as);
    assert.equal(refused.status, 403);
  });

  it('lists them for an instance administrator, and hands one over as a .zip', async () => {
    const status = await ok('/api/admin/backups');
    assert.equal(status.enabled, true);
    assert.ok(status.snapshots.length >= 1);
    assert.equal(status.snapshots[0].path, undefined, 'a path on the server is not the browser’s business');

    const response = await fetch(`${base}/api/admin/backups/${status.snapshots[0].name}/download`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const archive = unzip(Buffer.from(await response.arrayBuffer()));
    assert.ok(archive.has('kolibri.sqlite'));
    assert.ok(archive.has('manifest.json'));
  });
});
