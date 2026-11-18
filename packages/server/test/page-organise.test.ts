/**
 * What a wiki needs beyond its tree, asked through the doors that were wrong.
 *
 * Measured on the first real wiki before any of this existed: 56 of 77 pages
 * at the top level, 57 sharing one sort key, a page whose parent was the
 * *text* "Product overview", version numbers and dates typed into titles, a
 * "Final" on a pricing paper three pricing models out of date, and the minutes
 * of one weekly filed under one title every week. Each describe block below is
 * one of those, asked through REST or MCP as a client would, not through the
 * functions — the functions were not where any of it went wrong.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-page-organise-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { all, get, run } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { untiePageOrder } = await import('../src/modules/pages/order.ts');
const { backfillPageStatuses, backfillPageTypes } = await import('../src/kernel/write-path/bootstrap.ts');
const { knowledgeOf } = await import('../src/modules/support/assistant.ts');

let base = '';
const cookies: Record<string, string> = {};

async function api<T = any>(who: string, path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  else if (cookies[who]) headers.cookie = cookies[who];
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const set = response.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

let rpc = 0;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await api('rpc', '/mcp', {
    token, body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`refused: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`refused: ${JSON.stringify(response.result.content)}`);
  return response.result.structuredContent;
}

let token = '';
let workspaceId = '';

const page = (body: Record<string, unknown>) => api('ada', `/api/workspaces/${workspaceId}/pages`, { body: { title: 'Doc', ...body } });
const patch = (id: string, body: Record<string, unknown>) => api('ada', `/api/pages/${id}`, { method: 'PATCH', body });
/** `list_pages` answers a list, which MCP carries as `{ result }`. */
const listPages = async () => (await tool('list_pages')).result as any[];
const rowOf = (id: string) => get<any>(`SELECT * FROM pages WHERE id = ?`, id);
const rung = (kind: string, ws = workspaceId) =>
  get<any>(`SELECT * FROM page_statuses WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL`, ws, kind);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetRateLimits();
  const registered = await api('ada', '/api/auth/register', {
    body: { email: 'ada@organise.test', name: 'Ada', password: 'a perfectly fine password' },
  });
  workspaceId = registered.workspaces[0].id;
  token = (await api('ada', '/api/tokens', { body: { name: 'ada', workspaceId } })).token;
  await api('ada', `/api/workspaces/${workspaceId}`, { method: 'PATCH', body: { features: { meetings: true } } });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a new page has a place among its siblings', () => {
  it('from REST, without saying one', async () => {
    const parent = await page({ title: 'Handbook' });
    const first = await page({ title: 'One', parent_id: parent.id });
    const second = await page({ title: 'Two', parent_id: parent.id });
    assert.ok(rowOf(first.id).sort_order < rowOf(second.id).sort_order, 'the second lands after the first');
  });

  it('from MCP, where every page used to arrive on `V`', async () => {
    const one = await tool('create_page', { title: 'MCP one' });
    const two = await tool('create_page', { title: 'MCP two' });
    assert.notEqual(rowOf(one.id).sort_order, rowOf(two.id).sort_order);
    assert.ok(rowOf(one.id).sort_order < rowOf(two.id).sort_order);
  });
});

describe('create_page takes its parent the way update_page does', () => {
  it('by title, stored as the id', async () => {
    const parent = await tool('create_page', { title: 'Product overview' });
    const child = await tool('create_page', { title: 'Preismodell', parent: 'Product overview' });
    assert.equal(rowOf(child.id).parent_id, parent.id, 'not the text "Product overview"');
  });

  it('refuses a parent that names nothing, rather than storing it', async () => {
    await assert.rejects(tool('create_page', { title: 'Lost', parent: 'No such page anywhere' }), /refused/);
    assert.equal(get<any>(`SELECT count(*) AS n FROM pages WHERE title = 'Lost'`).n, 0);
  });

  it('puts a sub-page in its parent\'s project unless told otherwise', async () => {
    await api('ada', `/api/workspaces/${workspaceId}/projects`, { body: { name: 'Billing', key: 'BIL' } });
    const parent = await tool('create_page', { title: 'Billing docs', project: 'BIL' });
    const child = await tool('create_page', { title: 'Dunning', parent: parent.id });
    const projectId = rowOf(parent.id).project_id;
    assert.ok(projectId, 'the parent is in the project');
    assert.equal(rowOf(child.id).project_id, projectId);
  });
});

describe('list_pages says where a page stands the way the app does', () => {
  it('a page that never had a rung stands on the draft, not on nothing', async () => {
    const made = await page({ title: 'Old page', status_id: null });
    assert.equal(rowOf(made.id).status_id, null);
    const listed = (await listPages()).find((one: any) => one.id === made.id);
    assert.equal(listed.status, rung('draft').name);
  });
});

describe('a final rung is a claim about a text', () => {
  it('reaching it keeps that text as a named version', async () => {
    const made = await page({ title: 'Pricing paper', content: 'Website 25 €' });
    await patch(made.id, { status_id: rung('final').id });
    const row = rowOf(made.id);
    assert.ok(row.settled_version_id, 'the page names the version');
    const version = get<any>(`SELECT * FROM page_versions WHERE id = ?`, row.settled_version_id);
    assert.equal(version.content, 'Website 25 €');
    assert.equal(version.name, rung('final').name);
    assert.equal(row.settled_drift, 0);
  });

  it('says when the text has moved since, and stops saying it when it moves back', async () => {
    const made = await page({ title: 'Pricing v2', content: 'Website 25 €' });
    await patch(made.id, { status_id: rung('final').id });
    await patch(made.id, { content: 'Website 29 €' });
    assert.equal(rowOf(made.id).settled_drift, 1);
    assert.equal(rowOf(made.id).status_id, rung('final').id, 'an edit is not a demotion');
    await patch(made.id, { content: 'Website 25 €' });
    assert.equal(rowOf(made.id).settled_drift, 0);
  });

  it('keeps the text from before, when the rung and the text change in one write', async () => {
    const made = await page({ title: 'One write', content: 'before' });
    await patch(made.id, { content: 'after', status_id: rung('final').id });
    const versions = all<any>(`SELECT content, name FROM page_versions WHERE page_id = ? ORDER BY created_at`, made.id);
    assert.deepEqual(versions.map((one: any) => one.content), ['before', 'after']);
    assert.equal(versions[1].name, rung('final').name);
  });

  it('leaving the rung clears the claim', async () => {
    const made = await page({ title: 'Back to draft', content: 'x' });
    await patch(made.id, { status_id: rung('final').id });
    await patch(made.id, { status_id: rung('draft').id });
    assert.equal(rowOf(made.id).settled_version_id, null);
  });

  it('is the server\'s to write, not a client\'s to claim', async () => {
    const made = await page({ title: 'Claimed', content: 'x' });
    await patch(made.id, { settled_version_id: 'made-up', settled_drift: 1 });
    assert.equal(rowOf(made.id).settled_version_id, null);
    assert.equal(rowOf(made.id).settled_drift, 0);
  });
});

describe('a named version', () => {
  it('is kept from REST, listed, and renamed', async () => {
    const made = await page({ title: 'Model', content: 'V5 prices' });
    const version = await api('ada', `/api/pages/${made.id}/versions`, { body: { name: 'V5', note: 'after release 2.0' } });
    assert.equal(version.name, 'V5');
    const listed = await api('ada', `/api/pages/${made.id}/versions`);
    assert.equal(listed[0].id, version.id);
    const renamed = await api('ada', `/api/pages/${made.id}/versions/${version.id}`, { method: 'PATCH', body: { name: 'V5.1' } });
    assert.equal(renamed.name, 'V5.1');
    assert.equal(renamed.note, 'after release 2.0', 'a rename leaves the note alone');
  });

  it('never falls off the end of the list', async () => {
    const made = await page({ title: 'Busy', content: 'first' });
    const named = await api('ada', `/api/pages/${made.id}/versions`, { body: { name: 'The first one' } });
    // Older than everything that follows, and followed by more automatic
    // snapshots than the list keeps.
    run(`UPDATE page_versions SET created_at = 1 WHERE id = ?`, named.id);
    for (let n = 0; n < 105; n++) {
      run(`INSERT INTO page_versions (id, page_id, content, title, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        `auto-${n}`, made.id, `text ${n}`, 'Busy', null, 1000 + n);
    }
    const listed = await api('ada', `/api/pages/${made.id}/versions`);
    assert.equal(listed.filter((one: any) => !one.name).length, 100);
    assert.ok(listed.some((one: any) => one.id === named.id), 'the named one is still there');
  });

  it('is kept over MCP too, and listed with which one was settled', async () => {
    const made = await tool('create_page', { title: 'Over MCP', content: 'text', status: 'final' });
    await tool('save_page_version', { page: made.id, name: 'Sent to the bank' });
    const history = await tool('list_page_versions', { page: made.id });
    assert.equal(history.changed_since_settled, false);
    assert.ok(history.versions.some((one: any) => one.name === 'Sent to the bank'));
    assert.equal(history.versions.filter((one: any) => one.settled).length, 1);
  });
});

describe('a page replaced by another', () => {
  it('moves to the superseded rung when its successor is named', async () => {
    const old = await page({ title: 'Preismodell v4' });
    const current = await page({ title: 'Preismodell' });
    await patch(old.id, { superseded_by: current.id });
    assert.equal(rowOf(old.id).status_id, rung('superseded').id);
  });

  it('over MCP, by title', async () => {
    const old = await tool('create_page', { title: 'Preistabelle v3' });
    await tool('update_page', { page: old.id, replaced_by: 'Preismodell' });
    const successor = get<any>(`SELECT id FROM pages WHERE title = 'Preismodell' AND workspace_id = ?`, workspaceId);
    assert.ok(successor);
    assert.equal(rowOf(old.id).superseded_by, successor.id);
    const listed = (await listPages()).find((one: any) => one.id === old.id);
    assert.equal(listed.superseded, true);
  });

  it('cannot be replaced by itself', async () => {
    const made = await page({ title: 'Self' });
    await patch(made.id, { superseded_by: made.id });
    assert.equal(rowOf(made.id).superseded_by, null);
  });

  it('is not read to a visitor, even while still marked as public knowledge', async () => {
    const old = await page({ title: 'Old prices', content: '25 €', public_knowledge: 1 });
    const current = await page({ title: 'New prices', content: '29 €', public_knowledge: 1 });
    await patch(old.id, { superseded_by: current.id });
    const read = knowledgeOf({ workspace_id: workspaceId, knowledge: JSON.stringify([old.id, current.id]) } as any);
    assert.deepEqual(read.map((one: any) => one.skipped), ['superseded', null]);
  });
});

describe('page types', () => {
  it('a workspace starts with some, in its own language', () => {
    const types = all<any>(`SELECT name FROM page_types WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId);
    assert.equal(types.length, 6);
    for (const type of types) assert.ok(!String(type.name).startsWith('seed.'), type.name);
  });

  it('a type from another workspace is cleared, not kept', async () => {
    const other = await api('ada', '/api/workspaces', { body: { name: 'Elsewhere' } });
    const theirs = get<any>(`SELECT id FROM page_types WHERE workspace_id = ?`, other.workspace.id);
    const made = await page({ title: 'Typed', type_id: theirs.id });
    assert.equal(rowOf(made.id).type_id, null);
  });

  it('is set over MCP by name, and reported by name', async () => {
    const name = get<any>(`SELECT name FROM page_types WHERE workspace_id = ? ORDER BY sort_order LIMIT 1`, workspaceId).name;
    const made = await tool('create_page', { title: 'A concept', type: name });
    const listed = (await listPages()).find((one: any) => one.id === made.id);
    assert.equal(listed.type, name);
    await assert.rejects(tool('update_page', { page: made.id, type: 'No such type' }), /refused/);
  });
});

describe('the backfills', () => {
  it('give an old ladder its fourth rung once, and not again after it is deleted', () => {
    const fourth = rung('superseded');
    run(`UPDATE page_statuses SET deleted_at = 1 WHERE id = ?`, fourth.id);
    backfillPageStatuses();
    assert.equal(rung('superseded'), undefined, 'a deleted rung stays deleted');
    // A ladder that never had one gets it.
    run(`DELETE FROM page_statuses WHERE id = ?`, fourth.id);
    backfillPageStatuses();
    assert.ok(rung('superseded'));
  });

  it('give an old workspace its types once', () => {
    run(`DELETE FROM page_types WHERE workspace_id = ?`, workspaceId);
    backfillPageTypes();
    const count = () => Number(get<any>(`SELECT count(*) AS n FROM page_types WHERE workspace_id = ?`, workspaceId).n);
    assert.equal(count(), 6);
    backfillPageTypes();
    assert.equal(count(), 6);
  });

  it('untie siblings that share a key, without making them look edited', async () => {
    const parent = await page({ title: 'Tied parent' });
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) ids.push((await page({ title, parent_id: parent.id })).id);
    for (const [at, id] of ids.entries()) {
      run(`UPDATE pages SET sort_order = 'V', created_at = ?, updated_at = ? WHERE id = ?`, 100 + at, 5000 + at, id);
    }
    assert.ok(untiePageOrder() >= 2);
    const rows = ids.map(rowOf);
    assert.equal(new Set(rows.map((row: any) => row.sort_order)).size, 3, 'three keys, not one');
    assert.ok(rows[0].sort_order < rows[1].sort_order && rows[1].sort_order < rows[2].sort_order, 'in the order they were made');
    assert.deepEqual(rows.map((row: any) => row.updated_at), [5000, 5001, 5002]);
    assert.equal(untiePageOrder(), 0, 'and a second start moves nothing');
  });
});

describe('a series of dated entries', () => {
  it('new_series_entry names the entry in one date format and hands down what makes it part of the series', async () => {
    const type = get<any>(`SELECT id FROM page_types WHERE workspace_id = ? ORDER BY sort_order LIMIT 1`, workspaceId);
    const series = await page({ title: 'Scorecard', series: 1, type_id: type.id, labels: [] });
    const entry = await tool('new_series_entry', { series: series.id, day: '2026-11-16' });
    assert.equal(entry.title, 'Scorecard · 2026-11-16');
    const row = rowOf(entry.id);
    assert.equal(row.parent_id, series.id);
    assert.equal(row.type_id, type.id);
    const again = await tool('new_series_entry', { series: series.id, day: '2026-11-16' });
    assert.equal(again.title, 'Scorecard · 2026-11-16 (2)', 'never a second page with one title');
  });

  it('refuses a page that is not a series', async () => {
    const plain = await page({ title: 'Plain' });
    await assert.rejects(tool('new_series_entry', { series: plain.id }), /not a series/);
  });

  it('files each meeting\'s minutes as a dated entry under one series page', async () => {
    const first = await tool('create_meeting', { title: 'Weekly', starts_at: '2026-11-04T10:00:00+01:00' });
    const second = await tool('create_meeting', { title: 'Weekly', starts_at: '2026-11-11T10:00:00+01:00' });
    const one = await tool('file_meeting_minutes', { meeting: first.id ?? first.meeting?.id });
    const two = await tool('file_meeting_minutes', { meeting: second.id ?? second.meeting?.id });
    const a = rowOf(one.page_id);
    const b = rowOf(two.page_id);
    assert.equal(a.parent_id, b.parent_id, 'one series');
    assert.equal(rowOf(a.parent_id).series, 1);
    assert.notEqual(a.title, b.title, 'two weeks, two titles');
    assert.match(a.title, /2026-11-04$/);
    assert.match(b.title, /2026-11-11$/);
  });
});

describe('a label kept for pages', () => {
  it('is not matched when a task is labelled by name', async () => {
    await tool('create_label', { name: 'Pricing', applies_to: 'pages' });
    const project = get<any>(`SELECT key FROM projects WHERE workspace_id = ? LIMIT 1`, workspaceId);
    const task = await tool('create_task', { project: project.key, title: 'Raise prices', labels: ['Pricing'] });
    const labels = JSON.parse(get<any>(`SELECT labels FROM tasks WHERE id = ?`, task.id ?? task.task?.id).labels);
    const scopes = labels.map((id: string) => get<any>(`SELECT applies_to FROM labels WHERE id = ?`, id).applies_to);
    assert.deepEqual(scopes, ['all'], 'a task label was made rather than the page one taken');
  });
});
