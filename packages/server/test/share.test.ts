/**
 * Public share links.
 *
 * The token in the URL is the whole of the authorisation, so the cases that
 * matter are about what an anonymous request can and cannot reach: the shared
 * thing and nothing else, only while the link is live, and never with a token
 * the caller chose.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-share-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let pageId = '';

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

/** Anonymous: no cookie, exactly as a stranger with a link. */
const open = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Shared', key: 'SH' });
  projectId = project.id;
  const page = await ok(`/api/workspaces/${workspaceId}/pages`, {
    project_id: projectId,
    title: 'Release notes',
    content: '# Release notes\n\nWe shipped **the thing**.\n\n'
      + '| Change | Ships |\n| --- | ---: |\n| the thing | 4.2 |\n\n'
      + '```mermaid\ngraph TD;\n  A-->B;\n```\n\n'
      + '<script>alert(1)</script>\n',
  });
  pageId = page.id;
  await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, parent_id: pageId, title: 'Known issues', content: 'None yet.' });
  resetRateLimits();
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const makeShare = (body: Record<string, unknown>) => ok(`/api/workspaces/${workspaceId}/shares`, body);

describe('a shared page', () => {
  let token = '';

  it('mints its own token and never takes the one it was handed', async () => {
    const share = await makeShare({
      kind: 'page', page_id: pageId, project_id: projectId, name: 'Release notes', token: 'chosen-by-me',
    });
    assert.notEqual(share.token, 'chosen-by-me', 'a share whose secret the caller picked is one somebody can guess');
    assert.ok(String(share.token).length >= 30, 'and it is long enough to be worth having');
    token = share.token;
  });

  it('reads without a session, brings its children, and escapes what was written in it', async () => {
    const response = await open(`/s/${token}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'an unshared document must not linger in a cache');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);

    const body = await response.text();
    assert.match(body, /Release notes/);
    assert.match(body, /<strong>the thing<\/strong>/, 'the markdown is rendered');
    assert.match(body, /Known issues/, 'and a shared page brings its tree');
    // The body opens with `# Release notes`, so the renderer does not bolt a
    // second copy of the title on top of it.
    assert.equal((body.match(/Release notes/g) ?? []).length, 2, 'once in the tab title, once in the document');
    assert.equal(body.includes('<script>alert(1)</script>'), false, 'nothing a person typed becomes markup');
  });

  /**
   * A shared page is rendered by the server into one document with no script in
   * it, which is a decision this file makes on purpose — so the two things a
   * page can hold that a script would otherwise draw are worth pinning down.
   */
  it('draws a table, and leaves a diagram as something readable', async () => {
    const body = await (await open(`/s/${token}`)).text();
    assert.match(body, /<table>/, 'a table is a table here too, not a row of pipes');
    assert.match(body, /<td style="text-align:right">4\.2<\/td>/, 'including the alignment it asked for');
    assert.match(body, /<pre class="md-mermaid">/);
    assert.match(body, /graph TD;/, 'a stranger with no script still gets the diagram as text');
  });

  it('gives a stranger nothing else', async () => {
    // The token opens one door. Everything else still needs a session.
    for (const path of [
      `/api/workspaces/${workspaceId}/tasks`,
      `/api/pages/${pageId}`,
      `/api/workspaces/${workspaceId}/shares`,
      '/api/session',
    ]) {
      const response = await open(path);
      assert.ok(response.status === 401 || response.status === 403, `${path} answered ${response.status}`);
    }
  });

  it('stops working when it is turned off', async () => {
    const share = get<any>(`SELECT id FROM shares WHERE token = ?`, token)!;
    await ok(`/api/shares/${share.id}`, undefined, 'DELETE');
    const response = await open(`/s/${token}`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /does not exist|turned off/i, 'and says so as a page, not as JSON');
  });

  it('stops working when it expires', async () => {
    const share = await makeShare({
      kind: 'page', page_id: pageId, project_id: projectId, name: 'Old', expires_at: Date.now() - 1000,
    });
    const response = await open(`/s/${share.token}`);
    assert.equal(response.status, 410, 'gone, which is what an expired link is');
  });

  it('counts how often it is opened, and not by whom', async () => {
    const share = await makeShare({ kind: 'page', page_id: pageId, project_id: projectId, name: 'Counted' });
    await open(`/s/${share.token}`);
    await open(`/s/${share.token}`);
    const row = get<any>(`SELECT views, last_seen_at FROM shares WHERE id = ?`, share.id)!;
    assert.equal(row.views, 2);
    assert.ok(row.last_seen_at);
    // There is deliberately no column for who opened it.
    const columns = get<any>(`SELECT * FROM shares WHERE id = ?`, share.id)!;
    assert.equal('opened_by' in columns, false);
  });
});

describe('a note on a shared page', () => {
  const note = (token: string, fields: Record<string, string>) => fetch(`${base}/s/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

  it('is refused by a link that did not ask for one', async () => {
    const quiet = await makeShare({ kind: 'page', page_id: pageId, name: 'Read only' });
    const response = await note(quiet.token, { note: 'Hello?' });
    assert.equal(response.status, 404, 'an unauthenticated write is opted into, never default');
  });

  it('lands in the page’s comments, marked as coming from outside', async () => {
    resetRateLimits();
    const open_ = await makeShare({ kind: 'page', page_id: pageId, name: 'Please review', allow_comments: 1 });
    const page = await (await fetch(`${base}/s/${open_.token}`)).text();
    assert.match(page, /Leave a note/);

    const response = await note(open_.token, { note: 'The second paragraph contradicts the first.', who: 'Lin' });
    assert.equal(response.status, 303);

    const comment = get<any>(`SELECT * FROM comments WHERE page_id = ? ORDER BY created_at DESC`, pageId);
    assert.match(comment.body, /contradicts/);
    assert.equal(comment.guest_name, 'Lin');
    assert.equal(comment.author_id, null, 'nobody here said it, and the row says so');
  });

  it('shows the stranger nothing of what anybody else said', async () => {
    resetRateLimits();
    const open_ = await makeShare({ kind: 'page', page_id: pageId, name: 'Please review', allow_comments: 1 });
    await ok(`/api/workspaces/${workspaceId}/comments`, {
      page_id: pageId, body: 'Internal: do not send this to the client yet.',
    });
    const page = await (await fetch(`${base}/s/${open_.token}`)).text();
    assert.equal(
      page.includes('do not send this to the client'), false,
      'a tickbox called “allow comments” is not consent to publishing the thread',
    );
  });

  it('tells the people a page comment always tells', async () => {
    const notice = get<any>(`SELECT * FROM notifications WHERE page_id = ? ORDER BY created_at DESC`, pageId);
    assert.match(notice.title, /Release notes/);
  });

  it('needs some words, and runs out of patience', async () => {
    resetRateLimits();
    const open_ = await makeShare({ kind: 'page', page_id: pageId, name: 'Please review', allow_comments: 1 });
    assert.equal((await note(open_.token, { note: '   ' })).status, 400);

    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await note(open_.token, { note: `Spam ${i}` })).status);
    assert.ok(codes.includes(429), `expected a refusal somewhere in ${codes.join(', ')}`);
  });
});

describe('a shared task list', () => {
  it('renders the tasks a view resolves to, and can leave the finished ones out', async () => {
    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Still to do' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Already done', state_id: done.id });

    const withDone = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Everything', include_done: 1 });
    const body = await (await open(`/s/${withDone.token}`)).text();
    assert.match(body, /Still to do/);
    assert.match(body, /Already done/);

    const openOnly = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Open work', include_done: 0 });
    const shorter = await (await open(`/s/${openOnly.token}`)).text();
    assert.match(shorter, /Still to do/);
    assert.equal(shorter.includes('Already done'), false);
  });

  it('honours the view’s own filters, which is the point of sharing a view', async () => {
    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const backlog = states[0];
    const other = states[1];
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'In the backlog', state_id: backlog.id });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Somewhere else', state_id: other.id });

    const view = await ok(`/api/workspaces/${workspaceId}/views`, {
      project_id: projectId, name: 'Backlog only', filters: { state: [backlog.id] },
    });
    const share = await makeShare({ kind: 'tasks', project_id: projectId, view_id: view.id, include_done: 1 });
    const body = await (await open(`/s/${share.token}`)).text();
    assert.match(body, /In the backlog/);
    assert.equal(body.includes('Somewhere else'), false, 'a shared link showing more than the view is a leak by another name');
  });

  /*
   * `tasksMatching` read the single-valued keys and the `not` lists, and
   * passed over `assignee` and `label` when they asked "is one of" — so a view
   * of one person's work, shared, showed a stranger the whole project. Found
   * while teaching the board's filter to say "nobody", which is the other half
   * of this: the empty answer has to mean the same thing here as on the board.
   */
  it('honours who is on a task and what it carries, "nobody" and "no label" included', async () => {
    const me = (await ok('/api/session')).user.id;
    const label = await ok(`/api/workspaces/${workspaceId}/labels`, { project_id: projectId, name: 'Hotfix' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, {
      project_id: projectId, title: 'Ada is on this', assignees: [me], labels: [label.id],
    });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Nobody is on this' });
    const shared = async (filters: Record<string, unknown>) => {
      const view = await ok(`/api/workspaces/${workspaceId}/views`, { project_id: projectId, name: 'People', filters });
      const share = await makeShare({ kind: 'tasks', project_id: projectId, view_id: view.id, include_done: 1 });
      const body = await (await open(`/s/${share.token}`)).text();
      return { ada: body.includes('Ada is on this'), nobody: body.includes('Nobody is on this') };
    };

    assert.deepEqual(await shared({ assignee: [me] }), { ada: true, nobody: false }, 'one person’s work, and only theirs');
    assert.deepEqual(await shared({ assignee: [''] }), { ada: false, nobody: true }, 'nobody on it');
    assert.deepEqual(await shared({ assignee: [me, ''] }), { ada: true, nobody: true }, 'mine, or nobody’s yet');
    assert.deepEqual(await shared({ not: { assignee: [''] } }), { ada: true, nobody: false }, 'somebody on it');
    assert.deepEqual(await shared({ label: [label.id] }), { ada: true, nobody: false });
    assert.deepEqual(await shared({ label: [''] }), { ada: false, nobody: true }, 'no label at all');
    assert.deepEqual(await shared({ not: { label: [label.id] } }), { ada: false, nobody: true });
  });

  /*
   * The rest of what a view can say. `group`, `due` and `text` were never
   * translated at all — measured: each of the four showed a task the view
   * leaves out — and `cycle = none` was translated into an `IN ('')` that a
   * `NULL` never matches, which showed *fewer*. The board's own function now
   * has the last word, so the two cannot drift apart again by one of them
   * learning a key the other has not.
   */
  describe('the rest of what a view can say', () => {
    const titles = ['Alpha started overdue', 'Beta unstarted today', 'Gamma no date', 'Delta next week', 'Epsilon in a sprint'];
    const utcDay = () => new Date().toISOString().slice(0, 10);
    const shift = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
    let project = '';

    before(async () => {
      project = (await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Filtered', key: 'FLT' })).id;
      const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${project}`);
      const started = states.find((state: any) => state.group_key === 'started');
      const unstarted = states.find((state: any) => state.group_key === 'unstarted');
      const sprint = await ok(`/api/workspaces/${workspaceId}/cycles`, {
        project_id: project, name: 'Sprint 1', start_date: '2026-09-01', end_date: '2026-09-14',
      });
      const make = (title: string, extra: Record<string, unknown>) =>
        ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project, title, state_id: unstarted.id, ...extra });
      await make(titles[0], { state_id: started.id, due_date: '2020-01-01' });
      await make(titles[1], { due_date: utcDay() });
      await make(titles[2], {});
      await make(titles[3], { due_date: shift(utcDay(), 3) });
      await make(titles[4], { cycle_id: sprint.id, due_date: shift(utcDay(), 30) });
    });

    /** Which of the five a shared view of `filters` shows, by first word. */
    const shown = async (filters: unknown): Promise<string[]> => {
      const view = await ok(`/api/workspaces/${workspaceId}/views`, { project_id: project, name: 'Slice', filters });
      const share = await makeShare({ kind: 'tasks', project_id: project, view_id: view.id, include_done: 1 });
      // A dozen links opened from one address in a few milliseconds is what
      // the limit is for; this file resets it the same way above.
      resetRateLimits();
      const response = await open(`/s/${share.token}`);
      assert.equal(response.status, 200);
      const body = await response.text();
      return titles.filter((title) => body.includes(title)).map((title) => title.split(' ')[0]);
    };

    it('reads a state group', async () => {
      assert.deepEqual(await shown({ group: ['started'] }), ['Alpha']);
    });

    it('reads the four due buckets', async () => {
      assert.deepEqual(await shown({ due: 'overdue' }), ['Alpha']);
      assert.deepEqual(await shown({ due: 'today' }), ['Beta']);
      assert.deepEqual(await shown({ due: 'week' }), ['Beta', 'Delta'], 'today through seven days, overdue left out');
      assert.deepEqual(await shown({ due: 'none' }), ['Gamma']);
    });

    it('reads the words the way the board does, an exclusion on its own included', async () => {
      assert.deepEqual(await shown({ text: 'alpha' }), ['Alpha']);
      assert.deepEqual(await shown({ text: '-alpha -beta' }), ['Gamma', 'Delta', 'Epsilon']);
    });

    it('reads `cycle = none` as no cycle, and its `not` as some cycle', async () => {
      assert.deepEqual(await shown({ cycle: [''] }), ['Alpha', 'Beta', 'Gamma', 'Delta']);
      assert.deepEqual(await shown({ not: { cycle: [''] } }), ['Epsilon']);
    });

    it('survives a view whose JSON is not the shape a view has', async () => {
      // Written through the API by anybody with a token; the page must not fall over on it.
      assert.deepEqual(await shown({ assignee: 'oops', not: 'x', due: 5, text: 7, state: [1, null] }), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    });

    it('reads "today" in the zone of whoever shared it', async () => {
      // A zone whose day is not UTC's right now, whenever this runs: UTC+14
      // is already tomorrow from 10:00 UTC on, UTC-11 still yesterday before 11:00.
      const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
      const there = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
      await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: project, title: 'Zeta due there today', due_date: there });
      await ok('/api/me', { timezone: zone }, 'PATCH');
      try {
        const view = await ok(`/api/workspaces/${workspaceId}/views`, { project_id: project, name: 'Today there', filters: { due: 'today' } });
        const share = await makeShare({ kind: 'tasks', project_id: project, view_id: view.id, include_done: 1 });
        resetRateLimits();
        const body = await (await open(`/s/${share.token}`)).text();
        assert.match(body, /Zeta due there today/);
        assert.notEqual(there, utcDay(), 'the zone was chosen to disagree with UTC');
        assert.equal(body.includes(titles[1]), false, 'due on the UTC day, which is not today there');
      } finally {
        await ok('/api/me', { timezone: null }, 'PATCH');
      }
    });
  });

  it('filters on a custom field, including the two questions a note can answer', async () => {
    const severity = await ok(`/api/workspaces/${workspaceId}/fields`, {
      project_id: projectId, name: 'Severity', kind: 'select', options: ['Low', 'High'],
    });
    const steps = await ok(`/api/workspaces/${workspaceId}/fields`, {
      project_id: projectId, name: 'Steps', kind: 'long_text',
    });
    const bad = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Severe and described' });
    const mild = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Mild and bare' });
    const answer = (task: any, field: any, value: string) => ok(`/api/workspaces/${workspaceId}/field-values`, {
      project_id: projectId, task_id: task.id, field_id: field.id, value,
    });
    await answer(bad, severity, 'High');
    await answer(bad, steps, 'Open it, then close it.');
    await answer(mild, severity, 'Low');

    const high = await ok(`/api/workspaces/${workspaceId}/views`, {
      project_id: projectId, name: 'Severe', filters: { field: { [severity.id]: ['High'] } },
    });
    const body = await (await open(`/s/${(await makeShare({ kind: 'tasks', project_id: projectId, view_id: high.id, include_done: 1 })).token}`)).text();
    assert.match(body, /Severe and described/);
    assert.equal(body.includes('Mild and bare'), false);

    const missing = await ok(`/api/workspaces/${workspaceId}/views`, {
      project_id: projectId, name: 'No steps', filters: { field: { [steps.id]: [''] } },
    });
    const bare = await (await open(`/s/${(await makeShare({ kind: 'tasks', project_id: projectId, view_id: missing.id, include_done: 1 })).token}`)).text();
    assert.match(bare, /Mild and bare/, 'which bugs are missing their steps is the question a note filter is for');
    assert.equal(bare.includes('Severe and described'), false);
  });

  it('shows nothing from a project it does not point at', async () => {
    const other = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Private matters', key: 'PM' });
    await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: other.id, title: 'Not for sharing' });

    const share = await makeShare({ kind: 'tasks', project_id: projectId, name: 'Open work' });
    const body = await (await open(`/s/${share.token}`)).text();
    assert.equal(body.includes('Not for sharing'), false);
  });
});
