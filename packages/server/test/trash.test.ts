/**
 * Emptying the trash.
 *
 * The interesting part is not the deleting — it is that a delete in this app is
 * a *tombstone*, and dropping the row would leave every device that has one
 * showing the thing in its own trash with a button offering to put it back. So
 * a purge leaves a marker behind, and these tests are mostly about the marker:
 * that it exists, that it syncs, and that it names what went.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-trash-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { emptyTrash, purgeable } = await import('../src/lib/trash.ts');
const { all, get } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

async function ok(path: string, body?: unknown, method?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  projectId = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Bin', key: 'BIN' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const makeTask = (title: string) => ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title });

describe('what is waiting in the trash', () => {
  it('counts the tombstones and nothing else', async () => {
    const kept = await makeTask('Still wanted');
    const gone = await makeTask('Deleted on purpose');
    await ok(`/api/tasks/${gone.id}`, undefined, 'DELETE');

    const counts = purgeable(workspaceId, Date.now());
    assert.equal(counts.total, 1, 'the live task is not in the trash');
    assert.equal(counts.entries.find((entry) => entry.entity === 'task')?.count, 1);
    assert.ok(get(`SELECT id FROM tasks WHERE id = ?`, kept.id), 'and it is still there');
  });

  it('leaves out anything younger than the window somebody asked about', async () => {
    // Everything deleted in this test file was deleted seconds ago, so a
    // thirty-day policy takes none of it — which is the whole point of one.
    const counts = purgeable(workspaceId, Date.now() - 30 * 86_400_000);
    assert.equal(counts.total, 0);
  });
});

describe('emptying it', () => {
  it('removes the row and leaves a marker naming what went', async () => {
    const doomed = await makeTask('Not long for this world');
    await ok(`/api/tasks/${doomed.id}`, undefined, 'DELETE');

    const done = emptyTrash(workspaceId, 'manual', Date.now());
    assert.ok(done.purged >= 1);
    assert.equal(get(`SELECT id FROM tasks WHERE id = ?`, doomed.id), undefined, 'the row is gone, not just marked');

    const marker = get<any>(`SELECT * FROM purges WHERE row_id = ?`, doomed.id);
    assert.ok(marker, 'and something remembers that it went');
    assert.equal(marker.entity, 'task');
    assert.equal(marker.reason, 'manual');
    assert.ok(Number(marker.seq) > 0, 'with a seq, so it reaches every device on the next pull');
  });

  it('sends the marker down the sync, which is how another device forgets it too', async () => {
    const doomed = await makeTask('Seen on two devices');
    await ok(`/api/tasks/${doomed.id}`, undefined, 'DELETE');
    // A device that has pulled everything so far, and is about to hear the news.
    const before = (await ok(`/api/sync/pull?workspace=${workspaceId}&since=0`)).cursor;

    emptyTrash(workspaceId, 'manual', Date.now());

    const after = await ok(`/api/sync/pull?workspace=${workspaceId}&since=${before}`);
    const purges = after.changes.purge ?? [];
    assert.ok(purges.some((purge: any) => purge.row_id === doomed.id && purge.entity === 'task'));
    assert.equal(
      (after.changes.task ?? []).some((task: any) => task.id === doomed.id), false,
      'and the task itself does not come down again — there is nothing left to send',
    );
  });

  it('takes the search index with it', async () => {
    const doomed = await makeTask('Findable until it is not');
    await ok(`/api/tasks/${doomed.id}`, undefined, 'DELETE');
    emptyTrash(workspaceId, 'manual', Date.now());
    assert.equal(all(`SELECT rowid FROM search_index WHERE ref_id = ?`, doomed.id).length, 0);
  });

  it('takes the audit entry that quoted it, because a button that says gone has to mean it', async () => {
    const doomed = await makeTask('Named in the log');
    await ok(`/api/tasks/${doomed.id}`, undefined, 'DELETE');
    assert.ok(
      all(`SELECT id FROM activities WHERE task_id = ?`, doomed.id).length > 0,
      'the deletion was recorded, as it should be',
    );

    emptyTrash(workspaceId, 'manual', Date.now());
    assert.equal(
      all(`SELECT id FROM activities WHERE task_id = ?`, doomed.id).length, 0,
      'and once the task is destroyed, the log is the last copy of its title',
    );
  });

  it('is refused to somebody who is not an admin here', async () => {
    const mine = cookie;
    const other = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', name: 'Grace', password: 'correct horse battery' }),
    });
    const theirCookie = other.headers.get('set-cookie')!.split(';')[0];

    const refused = await fetch(`${base}/api/workspaces/${workspaceId}/trash/empty`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: theirCookie },
      body: '{}',
    });
    assert.ok(refused.status === 403 || refused.status === 404, `expected a refusal, got ${refused.status}`);
    cookie = mine;
  });
});

describe('the bytes behind it', () => {
  it('keeps a picture the page still shows, and takes the one nothing points at', async () => {
    const upload = (bytes: string, name: string): Promise<any> => fetch(`${base}/api/workspaces/${workspaceId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': name, cookie },
      body: Buffer.from(bytes),
    }).then((response) => response.json());

    // Two uploads: one is only ever an attachment, the other is also pasted
    // into a page — which is what makes it content-addressed rather than owned.
    const lonely = await upload('lonely-bytes', 'lonely.png');
    const shared = await upload('shared-bytes', 'shared.png');
    const task = await makeTask('Has pictures');
    const attach = (file: any) => ok(`/api/workspaces/${workspaceId}/attachments`, {
      task_id: task.id, name: file.name, mime: 'image/png', size: 12, url: file.url,
    });
    const lonelyRow = await attach(lonely);
    const sharedRow = await attach(shared);
    await ok(`/api/workspaces/${workspaceId}/pages`, {
      project_id: projectId, title: 'Illustrated', content: `Look: ![](${shared.url})`,
    });

    await ok(`/api/attachments/${lonelyRow.id}`, undefined, 'DELETE');
    await ok(`/api/attachments/${sharedRow.id}`, undefined, 'DELETE');
    const done = emptyTrash(workspaceId, 'manual', Date.now());

    assert.equal(get(`SELECT hash FROM files WHERE hash = ?`, lonely.hash), undefined, 'nothing named it');
    assert.ok(get(`SELECT hash FROM files WHERE hash = ?`, shared.hash), 'the page still shows this one');
    assert.equal(done.blobs, 1);
  });
});

describe('a retention window', () => {
  it('is off unless somebody sets one, because a month is not this project’s decision', async () => {
    const { applyRetention } = await import('../src/lib/trash.ts');
    const doomed = await makeTask('Would go under a policy');
    await ok(`/api/tasks/${doomed.id}`, undefined, 'DELETE');
    assert.equal(applyRetention(), 0, 'nothing, with no window set');
    assert.ok(get(`SELECT id FROM tasks WHERE id = ?`, doomed.id), 'and the row is still recoverable');
  });
});
