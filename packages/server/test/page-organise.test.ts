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
const { emptyTrash } = await import('../src/modules/trash/trash.ts');
const { copyProject } = await import('../src/modules/planning/copy.ts');
const { exportWorkspace, importWorkspace } = await import('../src/adapters/transfer/workspace-transfer.ts');

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

/*
 * What review found, each asked again through the door it was found at.
 */
describe('what review found', () => {
  it('a read-only token can neither restore, name nor rename a version', async () => {
    const made = await page({ title: 'Guarded', content: 'text' });
    const kept = await api('ada', `/api/pages/${made.id}/versions`, { body: { name: 'Kept' } });
    const reader = (await api('ada', '/api/tokens', { body: { name: 'ro', workspaceId, scopes: 'read' } })).token;
    await assert.rejects(api('ro', `/api/pages/${made.id}/versions`, { token: reader, body: { name: 'Mine' } }), /403/);
    await assert.rejects(api('ro', `/api/pages/${made.id}/versions`, { token: reader, body: { restore: kept.id } }), /403/);
    await assert.rejects(api('ro', `/api/pages/${made.id}/versions/${kept.id}`, { token: reader, method: 'PATCH', body: { name: 'x' } }), /403/);
    assert.equal(get<any>(`SELECT name FROM page_versions WHERE id = ?`, kept.id).name, 'Kept');
  });

  it('a page created already replaced stands on the superseded rung, from REST and MCP', async () => {
    const current = await page({ title: 'Current model' });
    const viaRest = await page({ title: 'Last year\'s model', superseded_by: current.id });
    assert.equal(rowOf(viaRest.id).status_id, rung('superseded').id);
    const viaMcp = await tool('create_page', { title: 'Older model', replaced_by: current.id });
    assert.equal(rowOf(viaMcp.id).status_id, rung('superseded').id);
  });

  it('clearing the successor takes the page off the superseded rung', async () => {
    const current = await page({ title: 'Replacement' });
    const old = await page({ title: 'Replaced for a while' });
    await patch(old.id, { superseded_by: current.id });
    await tool('update_page', { page: old.id, replaced_by: '' });
    assert.equal(rowOf(old.id).superseded_by, null);
    assert.equal(rowOf(old.id).status_id, rung('draft').id);
    const listed = (await listPages()).find((one: any) => one.id === old.id);
    assert.equal(listed.superseded, false);
  });

  it('a deleted rung or type stays deleted after the trash is emptied', () => {
    const fourth = rung('superseded');
    run(`UPDATE page_statuses SET deleted_at = 1 WHERE id = ?`, fourth.id);
    run(`UPDATE page_types SET deleted_at = 1 WHERE workspace_id = ?`, workspaceId);
    emptyTrash(workspaceId, 'manual', Date.now());
    backfillPageStatuses();
    backfillPageTypes();
    assert.equal(rung('superseded'), undefined);
    assert.equal(Number(get<any>(`SELECT count(*) AS n FROM page_types WHERE workspace_id = ?`, workspaceId).n), 0);
    // Put back for the cases below, which read the ladder.
    run(`INSERT INTO page_statuses (id, workspace_id, name, kind, color, sort_order, created_at, updated_at)
         VALUES ('restored-superseded', ?, 'Superseded', 'superseded', '#a1a1aa', 'z', 1, 1)`, workspaceId);
  });

  it('an id of a label kept for pages is refused rather than made into a task label\'s name', async () => {
    const label = await tool('create_label', { name: 'Topic', applies_to: 'pages' });
    const project = get<any>(`SELECT key FROM projects WHERE workspace_id = ? LIMIT 1`, workspaceId);
    await assert.rejects(tool('create_task', { project: project.key, title: 'x', labels: [label.id] }), /kept for pages/);
    assert.equal(get<any>(`SELECT count(*) AS n FROM labels WHERE name = ?`, label.id).n, 0);
  });

  it('a label scope that is not one of the three is folded to all, not refused', async () => {
    const label = await api('ada', `/api/workspaces/${workspaceId}/labels`, { body: { name: 'Loose', applies_to: null } });
    assert.equal(get<any>(`SELECT applies_to FROM labels WHERE id = ?`, label.id).applies_to, 'all');
  });

  it('minutes are never filed under a private series, and stay readable by the workspace', async () => {
    const theirs = await page({ title: 'Meeting minutes: Board', series: 1, access: 'private' });
    const meeting = await tool('create_meeting', { title: 'Board', starts_at: '2026-11-02T09:00:00+01:00' });
    const filed = await tool('file_meeting_minutes', { meeting: meeting.id ?? meeting.meeting?.id });
    const entry = rowOf(filed.page_id);
    assert.notEqual(entry.parent_id, theirs.id);
    assert.equal(entry.access, 'workspace');
    assert.equal(rowOf(entry.parent_id).access, 'workspace');
  });

  it('the next minutes find the series through the last ones, even after it was renamed', async () => {
    const first = await tool('create_meeting', { title: 'Retro', starts_at: '2026-10-01T09:00:00+01:00' });
    const one = await tool('file_meeting_minutes', { meeting: first.id ?? first.meeting?.id });
    const series = rowOf(one.page_id).parent_id;
    await patch(series, { title: 'Retrospectives' });
    const second = await tool('create_meeting', { title: 'Retro', starts_at: '2026-10-15T09:00:00+01:00' });
    const two = await tool('file_meeting_minutes', { meeting: second.id ?? second.meeting?.id });
    assert.equal(rowOf(two.page_id).parent_id, series);
  });

  it('a copied project leaves the Final stamp behind and gives its top pages keys of their own', async () => {
    const project = get<any>(`SELECT id FROM projects WHERE workspace_id = ? AND key = 'BIL'`, workspaceId);
    const root = await page({ title: 'Billing root', project_id: project.id, content: 'x' });
    const successor = await page({ title: 'Billing new', project_id: project.id });
    await patch(root.id, { status_id: rung('final').id });
    const old = await page({ title: 'Billing old', project_id: project.id, superseded_by: successor.id });
    const report = copyProject(workspaceId, rowOf(root.id).created_by, project.id, { name: 'Billing copy', key: 'BIC', include: { pages: true } } as any);
    const copyId = (report as any).project?.id ?? (report as any).id;
    const copies = all<any>(`SELECT * FROM pages WHERE project_id = ?`, copyId);
    const byTitle = new Map(copies.map((row: any) => [row.title, row]));
    // Its own stamp — the copy arrives on Final, so a version of *its* text is
    // cut — and never the original's, which names another page's history.
    const stamp = byTitle.get('Billing root').settled_version_id;
    assert.notEqual(stamp, rowOf(root.id).settled_version_id);
    assert.equal(get<any>(`SELECT page_id FROM page_versions WHERE id = ?`, stamp)?.page_id, byTitle.get('Billing root').id);
    assert.equal(byTitle.get('Billing old').superseded_by, byTitle.get('Billing new').id, 'pointed at the copy of its successor');
    const originals = new Set(all<any>(`SELECT sort_order FROM pages WHERE workspace_id = ? AND parent_id IS NULL AND project_id = ?`, workspaceId, project.id)
      .map((row: any) => row.sort_order));
    for (const row of copies.filter((one: any) => !one.parent_id)) assert.ok(!originals.has(row.sort_order), `${row.title} shares a key with an original`);
    assert.ok(old.id);
  });

  it('a workspace export carries its page types, and the import matches them by name', async () => {
    const type = get<any>(`SELECT id, name FROM page_types WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, workspaceId)
      ?? (await api('ada', `/api/workspaces/${workspaceId}/page-types`, { body: { name: 'Konzept', color: '#123456' } }));
    const typed = await page({ title: 'Typed for the trip', type_id: type.id });
    const doc = exportWorkspace(workspaceId);
    assert.ok((doc.page_types ?? []).some((one: any) => one.id === type.id));
    const report = importWorkspace(rowOf(typed.id).created_by, doc);
    const arrived = get<any>(`SELECT type_id FROM pages WHERE workspace_id = ? AND title = 'Typed for the trip'`, report.workspace.id);
    const its = get<any>(`SELECT name FROM page_types WHERE id = ?`, arrived.type_id);
    assert.equal(its?.name, type.name);
    const names = all<any>(`SELECT name FROM page_types WHERE workspace_id = ? AND deleted_at IS NULL`, report.workspace.id).map((row: any) => row.name);
    assert.equal(names.length, new Set(names).size, 'no type twice');
  });

  it('a workspace import keeps the type of a page inside a project, too', async () => {
    const project = get<any>(`SELECT id FROM projects WHERE workspace_id = ? AND key = 'BIL'`, workspaceId);
    const type = await api('ada', `/api/workspaces/${workspaceId}/page-types`, { body: { name: 'Runbook for the trip', color: '#123456' } });
    const typed = await page({ title: 'Project page with a type', project_id: project.id, type_id: type.id });
    const report = importWorkspace(rowOf(typed.id).created_by, exportWorkspace(workspaceId));
    const arrived = get<any>(`SELECT type_id FROM pages WHERE workspace_id = ? AND title = 'Project page with a type'`, report.workspace.id);
    assert.equal(get<any>(`SELECT name FROM page_types WHERE id = ?`, arrived.type_id)?.name, 'Runbook for the trip');
  });

  it('a copied page that was replaced while on Final stays on Final, its stamp with it', async () => {
    const project = get<any>(`SELECT id FROM projects WHERE workspace_id = ? AND key = 'BIL'`, workspaceId);
    const next = await page({ title: 'Kept final, successor', project_id: project.id });
    const kept = await page({ title: 'Kept final', project_id: project.id, content: 'still true' });
    await patch(kept.id, { status_id: rung('final').id });
    await patch(kept.id, { superseded_by: next.id, status_id: rung('final').id });
    assert.equal(rowOf(kept.id).status_id, rung('final').id);
    const report = copyProject(workspaceId, rowOf(kept.id).created_by, project.id, { name: 'Billing copy two', key: 'BIT', include: { pages: true } } as any);
    const copy = get<any>(`SELECT * FROM pages WHERE project_id = ? AND title = 'Kept final'`, (report as any).project.id);
    assert.equal(copy.status_id, rung('final').id);
    assert.ok(copy.settled_version_id, 'the copy keeps a stamp of its own');
  });

  it('minutes are not filed under a series in a private project', async () => {
    const secret = await api('ada', `/api/workspaces/${workspaceId}/projects`, { body: { name: 'Board room', key: 'BRD', visibility: 'private' } });
    const secretId = secret.id ?? secret.project?.id ?? get<any>(`SELECT id FROM projects WHERE key = 'BRD' AND workspace_id = ?`, workspaceId).id;
    run(`UPDATE projects SET visibility = 'private' WHERE id = ?`, secretId);
    const hidden = await page({ title: 'Meeting minutes: Strategy', series: 1, project_id: secretId });
    const meeting = await tool('create_meeting', { title: 'Strategy', starts_at: '2026-11-03T09:00:00+01:00' });
    const filed = await tool('file_meeting_minutes', { meeting: meeting.id ?? meeting.meeting?.id });
    const entry = rowOf(filed.page_id);
    assert.notEqual(entry.parent_id, hidden.id);
    assert.equal(entry.project_id, null);
  });
});

