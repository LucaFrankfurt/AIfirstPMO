/**
 * The maintenance commands, and — the point of the exercise — a rehearsed
 * restore.
 *
 * A backup procedure that has never been put back is a hope, not a backup. The
 * last case here takes a snapshot of one instance, restores it into an empty
 * one in a separate process, and asks that instance what it holds.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-maint-${process.pid}`;

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const maintenance = await import('../src/lib/maintenance.ts');
const { verify } = await import('../src/lib/restore.ts');
const { run, all, get } = await import('../src/db/index.ts');

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
const snapshot = `${process.env.KOLIBRI_DATA_DIR}-snapshot`;
const restored = `${process.env.KOLIBRI_DATA_DIR}-restored`;

async function ok(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Run the CLI the way an operator would, in its own process. */
function cli(args: string[], dataDir: string): string {
  return execFileSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
    env: { ...process.env, KOLIBRI_DATA_DIR: dataDir, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Maintenance', key: 'MNT' });
  projectId = project.id;
  for (const title of ['Feed the cat', 'Water the plants', 'Renew the certificate']) {
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title });
  }
  await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, title: 'Runbook', content: '# Runbook\n\nPull the lever.' });
});

after(() => {
  server.close();
  for (const dir of [process.env.KOLIBRI_DATA_DIR!, snapshot, restored]) rmSync(dir, { recursive: true, force: true });
});

describe('the doctor', () => {
  it('says a healthy database is healthy', () => {
    const findings = maintenance.check();
    const bad = findings.filter((f) => f.level !== 'ok');
    assert.deepEqual(bad, [], `nothing should be wrong with a fresh instance: ${JSON.stringify(bad)}`);
    assert.ok(maintenance.counts().tasks >= 3);
  });

  it('notices when the search index has drifted from the tables', () => {
    // Exactly what a crash between the row and its index entry leaves behind.
    const task = get<any>(`SELECT id FROM tasks LIMIT 1`)!;
    run(`DELETE FROM search_index WHERE kind = 'task' AND ref_id = ?`, task.id);
    run(`INSERT INTO search_index (kind, ref_id, workspace_id, project_id, title, body)
         VALUES ('task', 'ghost-of-a-task', ?, ?, 'Gone', '')`, workspaceId, projectId);

    const drift = maintenance.searchDrift();
    assert.equal(drift.missing, 1, 'the row with no index entry');
    assert.equal(drift.stale, 1, 'and the index entry with no row');

    const search = maintenance.check().find((f) => f.check === 'search')!;
    assert.equal(search.level, 'warn');
    assert.equal(search.fixable, true, 'and it says so, because it can be put right');
  });

  it('rebuilds the index, and the rebuilt index actually finds things', async () => {
    const indexed = maintenance.reindex();
    assert.ok(indexed >= 4, `every searchable row is back: ${indexed}`);
    assert.deepEqual(maintenance.searchDrift(), { missing: 0, stale: 0 });

    const { results } = await ok(`/api/workspaces/${workspaceId}/search?q=certificate`);
    assert.ok(results.some((r: any) => r.title.includes('Renew the certificate')), 'and search works through it');
  });

  it('reports a file whose bytes are gone', async () => {
    run(
      `INSERT INTO files (hash, workspace_id, name, mime, size, created_at, storage)
       VALUES ('deadbeef', ?, 'missing.png', 'image/png', 10, ?, 'disk')`,
      workspaceId, Date.now(),
    );
    const files = (await maintenance.checkStorage()).find((f) => f.check === 'files')!;
    assert.equal(files.level, 'fail', 'a download that 404s is not a warning');
    assert.match(files.detail, /deadbeef/);
    run(`DELETE FROM files WHERE hash = 'deadbeef'`);
  });

  it('prunes what the running server would have swept', () => {
    const old = Date.now() - 90 * 86_400_000;
    run(`INSERT INTO applied_mutations (id, workspace_id, applied_at) VALUES ('ancient', ?, ?)`, workspaceId, old);
    assert.equal(maintenance.prunable().mutations, 1);
    assert.equal(maintenance.prune().mutations, 1);
    assert.equal(all(`SELECT id FROM applied_mutations WHERE id = 'ancient'`).length, 0);
  });
});

describe('moving the files between backends', () => {
  it('leaves a row alone when its bytes cannot be read', async () => {
    run(
      `INSERT INTO files (hash, workspace_id, name, mime, size, created_at, storage)
       VALUES ('nobytes', ?, 'gone.png', 'image/png', 10, ?, 's3')`,
      workspaceId, Date.now(),
    );
    const result = await maintenance.moveFiles('disk');
    assert.deepEqual(result.failed, ['nobytes'], 'reported rather than swallowed');
    assert.equal(
      get<any>(`SELECT storage FROM files WHERE hash = 'nobytes'`)?.storage,
      's3',
      'and the row still says where it was, because that is still the truth',
    );

    // The other rows are on the backend already, so they are counted, not moved.
    assert.equal(result.moved, 0);
    run(`DELETE FROM files WHERE hash = 'nobytes'`);
  });

  it('counts what is stranded on a backend the instance no longer uses', () => {
    run(
      `INSERT INTO files (hash, workspace_id, name, mime, size, created_at, storage)
       VALUES ('elsewhere', ?, 'old.png', 'image/png', 10, ?, 's3')`,
      workspaceId, Date.now(),
    );
    assert.equal(maintenance.strandedFiles(), 1, 'this instance is on disk');
    run(`DELETE FROM files WHERE hash = 'elsewhere'`);
  });
});

describe('a backup', () => {
  it('is a consistent copy, and says what is in it', () => {
    const manifest = maintenance.backup(snapshot);
    assert.equal(manifest.uploads, 'included');
    assert.ok(manifest.counts.tasks >= 3);
    assert.ok(existsSync(join(snapshot, 'kolibri.sqlite')));
    assert.ok(existsSync(join(snapshot, 'manifest.json')));

    // Checked before it is trusted, which is the whole reason `verify` exists.
    const checked = verify(snapshot);
    assert.equal(checked.rows.tasks, manifest.counts.tasks);
  });

  it('refuses a snapshot that is not one, and one that is damaged', () => {
    assert.throws(() => verify('/tmp/definitely-not-a-snapshot'), /snapshot/i);

    const broken = `${snapshot}-broken`;
    rmSync(broken, { recursive: true, force: true });
    maintenance.backup(broken);
    // Overwrite the header SQLite identifies its own files by.
    const path = join(broken, 'kolibri.sqlite');
    const bytes = Buffer.from(readFileSync(path));
    bytes.write('not a database at all', 0);
    writeFileSync(path, bytes);
    assert.throws(() => verify(broken), /damaged|not a database|snapshot/i);
    rmSync(broken, { recursive: true, force: true });
  });
});

describe('a restore', () => {
  it('puts the snapshot into an empty instance, in its own process', () => {
    rmSync(restored, { recursive: true, force: true });

    const output = cli(['restore', snapshot], restored);
    assert.match(output, /Restored/);

    // The proof is not the exit code: it is the second process reading the
    // restored database and finding the rows that were put in the first.
    const report = JSON.parse(cli(['doctor', '--json'], restored));
    assert.equal(report.status, 'ok', `a restored instance is a healthy one: ${output}`);
    assert.ok(report.counts.tasks >= 3, 'with the tasks that were backed up');
    assert.ok(report.counts.pages >= 1, 'and the pages');
  });

  it('will not overwrite a database that is already there without being told to', () => {
    // The restore above left one in place, so this is the real second run.
    assert.throws(
      () => cli(['restore', snapshot], restored),
      /force/i,
      'the second restore of the day is the dangerous one',
    );

    const forced = cli(['restore', snapshot, '--force'], restored);
    assert.match(forced, /kept at/, 'and what was replaced is still on disk');
  });
});

describe('folding away deleted page text', () => {
  it('shrinks a page that has been rewritten, without changing what it says', async () => {
    const { compactPages } = await import('../src/lib/maintenance.ts');
    const { crdt } = await import('@kolibri/shared');
    const { get, run } = await import('../src/db/index.ts');
    const { uid } = await import('../src/lib/ids.ts');

    // A page written and rewritten several times: every draft is still in there,
    // which is exactly what lets a device that was away merge without
    // resurrecting anything.
    let state = crdt.fromText('the first draft, which was long and rambling and went on', 'ada');
    for (const text of ['a shorter second draft', 'the third', 'final: two words']) {
      state = crdt.edit(state, text, 'ada');
    }
    const id = uid();
    const now = Date.now();
    run(
      `INSERT INTO pages (id, workspace_id, title, content, body, created_at, updated_at, seq, clocks)
       VALUES (?, 'ws', 'Drafts', ?, ?, ?, ?, 0, '{}')`,
      id, crdt.textOf(state), JSON.stringify(state), now, now,
    );
    const before = String(get<any>(`SELECT body FROM pages WHERE id = ?`, id).body).length;

    const folded = compactPages();
    assert.ok(folded.pages >= 1);
    const after = String(get<any>(`SELECT body FROM pages WHERE id = ?`, id).body);
    assert.ok(after.length < before, `expected it to shrink from ${before}, got ${after.length}`);
    assert.equal(
      crdt.textOf(JSON.parse(after)), 'final: two words',
      'and the page still says exactly what it said',
    );
  });
});
