/**
 * Putting a snapshot back into an instance that is still running.
 *
 * The test that matters is not "does it copy rows" — it is: take a snapshot,
 * carry on working, restore, and find the instance exactly as it was at the
 * moment of the snapshot. Everything since must be **gone**, because a restore
 * that leaves some of it behind has not restored anything, it has merged two
 * instances and told nobody.
 *
 * The second thing tested here is the case this exists for: an instance
 * deployed somewhere new, with nothing in it, becoming the old one.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-rehydrate-${process.pid}`;
process.env.KOLIBRI_BACKUP_DIR = `/tmp/kolibri-rehydrate-${process.pid}/backups`;

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { unzip } = await import('../src/lib/zip.ts');
const backups = await import('../src/lib/backups.ts');
const rehydrate = await import('../src/lib/rehydrate.ts');
const { all, get, pluck } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let snapshot = '';
let pictureHash = '';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

/** Sign in again, since a restore is a thing that signs everybody out. */
async function signIn(): Promise<void> {
  resetRateLimits();
  const response = await call('/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' }, 'POST', '');
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  await response.text();
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = await call('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  cookie = (owner.headers.get('set-cookie') ?? '').split(';')[0];
  workspaceId = ((await owner.json()) as any).workspaces[0].id;
  resetRateLimits();

  projectId = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Before', key: 'BEF' })).id;
  await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'A task from before the snapshot' });
  await ok(`/api/workspaces/${workspaceId}/pages`, { title: 'Handbook', content: 'How we worked before' });

  const upload = await fetch(`${base}/api/workspaces/${workspaceId}/files`, {
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

describe('a snapshot put back into a running instance', () => {
  it('is taken, and holds what is here', () => {
    const taken = backups.take(undefined, { force: true });
    assert.ok(taken);
    snapshot = taken!.snapshot.name;
    const held = rehydrate.inspect(taken!.snapshot.path);
    assert.equal(held.counts.users, 1);
    assert.ok(held.counts.tasks >= 1);
    assert.equal(held.uploads, 1, 'the picture is in the snapshot');
  });

  it('undoes everything done since', async () => {
    // Work that must not survive the restore.
    const after_ = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'After', key: 'AFT' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: after_.id, title: 'A task from after the snapshot' });
    assert.equal(Number(pluck<number>(`SELECT count(*) FROM projects WHERE deleted_at IS NULL`)), 3);

    const report = await ok(`/api/admin/backups/${snapshot}/restore`, {});
    assert.ok(report.rows.tasks >= 1);
    assert.ok(report.indexed >= 1, 'and the search index was rebuilt from what landed');

    await signIn();
    const projects = await ok(`/api/workspaces/${workspaceId}/projects`);
    assert.ok(projects.some((one: any) => one.name === 'Before'));
    assert.ok(!projects.some((one: any) => one.name === 'After'), 'the project made after the snapshot is gone');
    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks`);
    assert.ok(!tasks.some((one: any) => one.title.includes('after the snapshot')));
  });

  it('keeps a copy of what it replaced, so the wrong file is survivable', async () => {
    const report = await ok(`/api/admin/backups/${snapshot}/restore`, {});
    await signIn();
    assert.ok(report.replaced, 'the report names the copy it took of what was here');
    assert.notEqual(report.replaced, snapshot, 'and it is not the snapshot being restored');
    assert.ok(backups.pathOf(report.replaced), 'which is on disk and openable');
    assert.equal(backups.checked(report.replaced)?.intact, true);
  });

  it('leaves search able to find the restored rows', async () => {
    const found = await ok(`/api/workspaces/${workspaceId}/search?q=Handbook`);
    assert.ok(found.results.some((one: any) => one.title === 'Handbook'), JSON.stringify(found.results));
  });

  it('signs everybody out, which is what makes every device fetch again', async () => {
    await ok(`/api/admin/backups/${snapshot}/restore`, {});
    const stale = await call(`/api/workspaces/${workspaceId}/tasks`);
    assert.equal(stale.status, 401, 'the cookie from before the restore is not accepted');
    await signIn();
  });

  it('never writes to the snapshot it restored from', () => {
    const path = backups.pathOf(snapshot)!;
    for (const sibling of ['kolibri.sqlite-wal', 'kolibri.sqlite-shm', 'snapshot.sqlite']) {
      assert.ok(!existsSync(`${path}/${sibling}`), `${sibling} was left beside the backup`);
    }
  });

  it('refuses a database that is not a snapshot, without touching anything', async () => {
    const tasks = Number(pluck<number>(`SELECT count(*) FROM tasks WHERE deleted_at IS NULL`));
    assert.throws(() => rehydrate.rehydrate('/tmp'), /not a Kolibri snapshot/i);
    assert.equal(Number(pluck<number>(`SELECT count(*) FROM tasks WHERE deleted_at IS NULL`)), tasks);
  });
});

describe('a snapshot from an instance that no longer exists', () => {
  it('restores from an uploaded .zip, files and all', async () => {
    const download = await fetch(`${base}/api/admin/backups/${snapshot}/download`, { headers: { cookie } });
    const archive = Buffer.from(await download.arrayBuffer());
    assert.ok(unzip(archive).has('kolibri.sqlite'));

    // Wipe the blob from the store, so the restore has to put it back rather
    // than find it already there — which is the state a new machine is in.
    const storage = await import('../src/lib/storage.ts');
    const row = get<any>(`SELECT hash, mime FROM files WHERE hash = ?`, pictureHash);
    await storage.remove(storage.keyFor(String(row.hash), String(row.mime)));
    assert.equal(await storage.exists(storage.keyFor(String(row.hash), String(row.mime))), false);

    const response = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', cookie },
      body: archive,
    });
    const report = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.files.restored, 1, 'the picture came back out of the archive');

    await signIn();
    const served = await fetch(`${base}/files/${pictureHash}/pixel.png`, { headers: { cookie } });
    assert.equal(served.status, 200);
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(PIXEL), 'and the bytes are the bytes');
  });

  it('is not something an ordinary member can do', async () => {
    const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
    resetRateLimits();
    const joined = await call('/api/auth/register', {
      email: 'grace@example.com', name: 'Grace', password: 'correct horse battery', invite: invite.code,
    }, 'POST', '');
    const as = (joined.headers.get('set-cookie') ?? '').split(';')[0];
    await joined.text();
    resetRateLimits();

    const refused = await call(`/api/admin/backups/${snapshot}/restore`, {}, 'POST', as);
    assert.equal(refused.status, 403);
    const alsoRefused = await call('/api/admin/restore', {}, 'POST', as);
    assert.equal(alsoRefused.status, 403);
  });
});

describe('a snapshot older than the schema', () => {
  it('restores through the columns both sides have', async () => {
    const { db } = await import('../src/db/index.ts');
    const path = backups.pathOf(snapshot)!;
    // Age the snapshot: drop a column this build has, the way a snapshot taken
    // before that column existed would not have had it.
    const aged = new (await import('node:sqlite')).DatabaseSync(`${path}/kolibri.sqlite`);
    aged.exec(`ALTER TABLE tasks DROP COLUMN recurrence`);
    aged.close();

    const report = rehydrate.rehydrate(path, { safetyBackup: false });
    assert.ok(report.rows.tasks >= 1, 'the tasks still landed');
    // The dropped column takes its default rather than making the file unreadable.
    const task = get<any>(`SELECT recurrence FROM tasks LIMIT 1`);
    assert.equal(task.recurrence ?? null, null);
    assert.ok(db);
    await signIn();
  });

  it('names a table it no longer knows rather than failing over it', async () => {
    const path = backups.pathOf(snapshot)!;
    const aged = new (await import('node:sqlite')).DatabaseSync(`${path}/kolibri.sqlite`);
    aged.exec(`CREATE TABLE gadgets (id TEXT PRIMARY KEY)`);
    aged.close();

    const report = rehydrate.rehydrate(path, { safetyBackup: false });
    assert.deepEqual(report.ignored, ['gadgets']);
    await signIn();
    assert.ok(all<any>(`SELECT id FROM tasks`).length >= 1);
  });
});
