/**
 * Intake: reports from people with no account.
 *
 * This is the only unauthenticated *write* in the app, so the tests are mostly
 * about what it refuses — and about the design decision underneath it: what a
 * stranger's form writes is an `intake` row, never a task. Spam never reaches
 * the board, because nothing reaches the board until a member says so.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-intake-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { all, get } = await import('../src/db/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let token = '';

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

/** A stranger: no cookie, a form post, exactly like a browser. */
const report = (fields: Record<string, string>) => fetch(`${base}/s/${token}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual',
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  projectId = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Support', key: 'SUP' })).id;
  const share = await ok(`/api/workspaces/${workspaceId}/shares`, {
    kind: 'intake', project_id: projectId, name: 'Report a problem',
  });
  token = share.token;
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the form', () => {
  it('opens for anybody, with no session and no script', async () => {
    const page = await (await fetch(`${base}/s/${token}`)).text();
    assert.match(page, /<form method="post"/, 'a plain form: the person reporting a bug is the one whose browser is odd');
    assert.equal(page.includes('<script'), false);
    assert.match(page, /name="title"/);
  });
});

describe('a report', () => {
  it('becomes a row waiting for somebody, and not a task', async () => {
    resetRateLimits();
    const response = await report({
      title: 'The export button does nothing',
      body: 'I click it and the page just sits there.',
      reporter: 'Grace', email: 'grace@example.com',
    });
    assert.equal(response.status, 303, 'a redirect, so a refresh does not send it twice');

    const row = get<any>(`SELECT * FROM intakes WHERE project_id = ?`, projectId);
    assert.equal(row.title, 'The export button does nothing');
    assert.equal(row.status, 'new');
    assert.equal(row.reporter, 'Grace');
    assert.equal(
      all(`SELECT id FROM tasks WHERE project_id = ?`, projectId).length, 0,
      'nothing from outside lands on the board on its own',
    );
  });

  it('tells somebody, because a queue nobody hears about is a queue nobody reads', () => {
    const notice = get<any>(`SELECT * FROM notifications WHERE kind = 'intake'`);
    assert.ok(notice, 'the owner was told');
    assert.match(notice.body, /export button/);
  });

  it('is refused without a title, which is the one thing a report needs', async () => {
    resetRateLimits();
    const response = await report({ title: '   ', body: 'lots of detail, no subject' });
    assert.equal(response.status, 400);
  });

  it('is answered politely when a robot fills in the hidden field, and written nowhere', async () => {
    resetRateLimits();
    const before = all(`SELECT id FROM intakes`).length;
    const response = await report({ title: 'Buy cheap watches', company: 'Watches Ltd' });
    assert.equal(response.status, 200, 'telling a robot it was caught only teaches whoever wrote it');
    assert.equal(all(`SELECT id FROM intakes`).length, before);
  });

  it('runs out of patience before it runs out of database', async () => {
    resetRateLimits();
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await report({ title: `Report ${i}` })).status);
    assert.ok(codes.includes(429), `expected a refusal somewhere in ${codes.join(', ')}`);
  });

  it('is not taken by a link that shares a page instead', async () => {
    resetRateLimits();
    const page = await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, title: 'Notes', content: 'x' });
    const readOnly = await ok(`/api/workspaces/${workspaceId}/shares`, { kind: 'page', page_id: page.id, name: 'Notes' });
    const response = await fetch(`${base}/s/${readOnly.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=sneaky',
    });
    assert.equal(response.status, 404);
  });
});

describe('triage', () => {
  it('turns a report into a task, and says who it came from', async () => {
    resetRateLimits();
    await report({ title: 'Search finds nothing', body: 'Typing anything gives an empty list.', reporter: 'Lin' });
    const waiting = get<any>(`SELECT * FROM intakes WHERE title = 'Search finds nothing'`);

    const result = await ok(`/api/intakes/${waiting.id}/accept`, { title: 'Fix search on the docs site' });
    assert.equal(result.task.title, 'Fix search on the docs site', 'the title is the team’s words, not the reporter’s');
    assert.match(result.task.description, /Typing anything gives an empty list/);
    assert.match(result.task.description, /reported by Lin/, 'and the credit survives');
    assert.equal(result.intake.status, 'accepted');
    assert.equal(result.intake.task_id, result.task.id);
  });

  it('refuses to be done twice, so two people triaging do not make two tasks', async () => {
    const done = get<any>(`SELECT * FROM intakes WHERE status = 'accepted' LIMIT 1`);
    const response = await fetch(`${base}/api/intakes/${done.id}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
    });
    assert.equal(response.status, 400);
  });

  it('keeps a declined report, marked, rather than deleting it', async () => {
    resetRateLimits();
    await report({ title: 'Please add blockchain' });
    const waiting = get<any>(`SELECT * FROM intakes WHERE title = 'Please add blockchain'`);
    const result = await ok(`/api/intakes/${waiting.id}/decline`, {});
    assert.equal(result.intake.status, 'declined');
    assert.ok(
      get(`SELECT id FROM intakes WHERE id = ?`, waiting.id),
      'still there, so nobody triages the same thing twice',
    );
  });

  it('is refused to somebody who is not in the workspace', async () => {
    resetRateLimits();
    await report({ title: 'Not yours to triage' });
    const waiting = get<any>(`SELECT * FROM intakes WHERE title = 'Not yours to triage'`);
    const outsider = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mallory@example.com', name: 'Mallory', password: 'correct horse battery' }),
    });
    const theirs = outsider.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/intakes/${waiting.id}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: theirs }, body: '{}',
    });
    assert.ok(response.status === 403 || response.status === 404, `expected a refusal, got ${response.status}`);
  });
});
