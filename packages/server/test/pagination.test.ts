/**
 * Paging a pull.
 *
 * The client used to infer "there is more" from a page being exactly full.
 * That is right until a workspace has exactly one page of changes, and being
 * wrong there means a client stops syncing and never says so — which is why
 * this is worth the two thousand rows it takes to reproduce.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-pages-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { PullResponse } from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { run, nextSeq } = await import('../src/kernel/platform/db/index.ts');

const PAGE_SIZE = 2000;
let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let stateId = '';

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await api('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await api(`/api/workspaces/${workspaceId}/projects`, { name: 'Bulk', key: 'BLK' });
  projectId = project.id;
  stateId = (await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`))[0].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/** Straight into the table: two thousand HTTP round trips would test the wrong thing. */
function fillTasks(count: number): void {
  const now = Date.now();
  for (let index = 0; index < count; index++) {
    run(
      `INSERT INTO tasks (id, workspace_id, project_id, identifier, number, title, state_id, priority,
                          created_by, sort_order, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'none', NULL, 'V', ?, ?, ?, '{}')`,
      `bulk-${index}`, workspaceId, projectId, `BLK-${1000 + index}`, 1000 + index,
      `Bulk task ${index}`, stateId, now, now, nextSeq(),
    );
  }
}

describe('pulling more than fits in one page', () => {
  it('says so rather than leaving the client to guess', async () => {
    const quiet = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.equal(quiet.hasMore, false, 'a small workspace arrives in one page');

    fillTasks(PAGE_SIZE + 25);

    const first = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.equal(first.hasMore, true, 'the server truncated and admits it');
    assert.equal(first.changes.task?.length, PAGE_SIZE, 'exactly a page of the entity that overflowed');

    // Following the cursor drains the rest, and the last page says it is last.
    let cursor = first.cursor;
    let pages = 1;
    let seen = first.changes.task?.length ?? 0;
    let response = first;
    while (response.hasMore) {
      response = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${cursor}`);
      assert.ok(response.cursor > cursor, 'every page moves the cursor forward');
      cursor = response.cursor;
      seen += response.changes.task?.length ?? 0;
      pages++;
      assert.ok(pages < 10, 'and the loop terminates');
    }
    assert.equal(seen, PAGE_SIZE + 25, 'every row arrived exactly once');
  });

  it('does not claim more when a page is exactly full', async () => {
    // The case the old heuristic got wrong: a page that is full to the row and
    // has nothing behind it. The client would have asked again forever, or —
    // worse, depending on the guard — stopped early.
    const drained = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    let cursor = drained.cursor;
    let response = drained;
    while (response.hasMore) {
      response = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${cursor}`);
      cursor = response.cursor;
    }

    const nothingNew = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${cursor}`);
    assert.equal(nothingNew.hasMore, false);
    assert.equal(nothingNew.changes.task, undefined, 'and nothing is sent twice');
  });
});
