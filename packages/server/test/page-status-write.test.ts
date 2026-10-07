/**
 * The status column, all the way through the server.
 *
 * `page-status.test.ts` beside this is arithmetic over a list and proves what
 * the words mean. This one is about the three things only the write path can
 * be asked, each of which is a way for the feature to be quietly wrong:
 *
 * - **A new workspace gets a ladder**, and a new page starts on its draft — by
 *   whichever door the page came in. A default that lived in the editor would
 *   be a default that the API, MCP, an import and a template never applied.
 * - **A rung has to be one of the three kinds.** Corrected rather than refused,
 *   which is the line `environmentRules` already draws: an unknown kind is the
 *   shape of an older client, not of somebody trying something, and a 400 to a
 *   sync batch is a device that stops syncing.
 * - **A status from another workspace is cleared**, for the same reason, and
 *   because the alternative is one workspace's page quietly standing on
 *   another's rung where neither screen would ever show it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-page-status-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { all, get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';

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

const makePage = (page: Record<string, unknown> = {}) =>
  ok(`/api/workspaces/${workspaceId}/pages`, { title: 'Doc', ...page });
const rowOf = (id: string) => get<any>(`SELECT * FROM pages WHERE id = ?`, id);
const rungs = (id = workspaceId) =>
  all<any>(`SELECT * FROM page_statuses WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order`, id);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a workspace gets a ladder', () => {
  it('has three rungs, in order, one of each kind', () => {
    assert.deepEqual(rungs().map((one: any) => one.kind), ['draft', 'review', 'final']);
  });

  it('names them in a language rather than in a key', () => {
    for (const one of rungs()) assert.ok(!String(one.name).startsWith('seed.'), one.name);
  });
});

describe('a new page starts on the draft', () => {
  it('whichever door it came in by', async () => {
    const page = await makePage();
    assert.equal(rowOf(page.id).status_id, rungs().find((one: any) => one.kind === 'draft').id);
  });

  it('and the write path says so to the client that asked', async () => {
    const page = await makePage();
    // Not merely in the row: the response is what a device writes into its own
    // mirror, and a status it never learns about is one the tree cannot draw.
    assert.ok(page.status_id, 'the created page came back with a status');
  });

  it('unless the writer said which rung', async () => {
    const final = rungs().find((one: any) => one.kind === 'final');
    const page = await makePage({ status_id: final.id });
    assert.equal(rowOf(page.id).status_id, final.id);
  });

  /**
   * A workspace is allowed to have no ladder, and a page is allowed to stand
   * on nothing. `null` has to survive, or "no status" becomes unsayable.
   */
  it('and takes an explicit nothing as an answer', async () => {
    const page = await makePage({ status_id: null });
    assert.equal(rowOf(page.id).status_id, null);
  });
});

describe('what the write path corrects rather than refuses', () => {
  it('folds an unknown kind to draft', async () => {
    const made = await ok(`/api/workspaces/${workspaceId}/page-statuses`, { name: 'Signed off', kind: 'approved' });
    assert.equal(get<any>(`SELECT kind FROM page_statuses WHERE id = ?`, made.id).kind, 'draft');
  });

  it('clears a rung that belongs to another workspace', async () => {
    const other = await ok('/api/workspaces', { name: 'Elsewhere' });
    const theirs = rungs(other.workspace.id)[0];
    assert.ok(theirs, 'the new workspace was seeded too');
    const page = await makePage({ status_id: theirs.id });
    assert.equal(rowOf(page.id).status_id, null);
  });

  it('clears a rung that does not exist at all', async () => {
    const page = await makePage({ status_id: 'no-such-rung' });
    assert.equal(rowOf(page.id).status_id, null);
  });
});

describe('deleting a rung', () => {
  /**
   * The pages stay where they are and read as drafts, which is what the
   * settings screen promises. Rewriting them would be a destructive operation
   * hiding inside a colour picker.
   */
  it('leaves the pages that stood on it alone', async () => {
    const review = rungs().find((one: any) => one.kind === 'review');
    const page = await makePage({ status_id: review.id });
    await ok(`/api/page-statuses/${review.id}`, undefined, 'DELETE');
    assert.equal(rowOf(page.id).status_id, review.id, 'the page still points at it');
    assert.ok(get<any>(`SELECT deleted_at FROM page_statuses WHERE id = ?`, review.id).deleted_at, 'and the rung is gone');
  });
});
