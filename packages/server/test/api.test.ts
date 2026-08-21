/**
 * End-to-end API test. Boots the real server against a throwaway database and
 * drives it over HTTP the same way the browser client does.
 *
 * Run with: npm test
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = process.env.KOLIBRI_TEST_DIR ?? `/tmp/kolibri-test-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Clock, orderKey, type PullResponse, type PushResponse } from '@kolibri/shared';

// Imported dynamically: static imports are hoisted above the env setup above,
// and the server reads its data directory at module load.
const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';
const clock = new Clock('test');

interface Options {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  raw?: Buffer;
}

async function api<T = any>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !options.token) headers.cookie = cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw ? 'POST' : 'GET'),
    headers,
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

/** How many mention notifications one person is holding, counted as them. */
async function countMentions(workspace: string, email: string, password: string): Promise<number> {
  const caller = cookie;
  cookie = '';
  await api('/api/auth/login', { body: { email, password } });
  const notifications = await api<any[]>(`/api/workspaces/${workspace}/notifications`);
  cookie = caller;
  return notifications.filter((n) => n.kind === 'mention').length;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('kolibri api', () => {
  let workspaceId = '';
  let projectId = '';
  let taskId = '';
  let stateIds: Record<string, string> = {};
  let apiToken = '';

  it('registers the first user and bootstraps a workspace', async () => {
    const session = await api('/api/auth/register', {
      body: { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' },
    });
    assert.equal(session.user.email, 'ada@example.com');
    assert.equal(session.workspaces.length, 1);
    assert.equal(session.workspaces[0].role, 'owner');
    workspaceId = session.workspaces[0].id;
  });

  it('rejects a bad password', async () => {
    await assert.rejects(() => api('/api/auth/login', { body: { email: 'ada@example.com', password: 'nope' } }), /401/);
  });

  it('creates a project with default states', async () => {
    const project = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Website relaunch', key: 'WEB' },
    });
    projectId = project.id;
    assert.equal(project.key, 'WEB');

    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    assert.equal(states.length, 6);
    stateIds = Object.fromEntries(states.map((s: any) => [s.name, s.id]));
    assert.ok(stateIds['In Progress']);
  });

  it('creates tasks with running identifiers', async () => {
    const first = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'Design the landing page', priority: 'high' },
    });
    const second = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'Wire up analytics' },
    });
    taskId = first.id;
    assert.equal(first.identifier, 'WEB-1');
    assert.equal(second.identifier, 'WEB-2');
    assert.equal(first.priority, 'high');
    assert.deepEqual(first.assignees, []);
  });

  it('sets completed_at when a task enters a done state', async () => {
    const updated = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { state_id: stateIds.Done } });
    assert.ok(updated.completed_at, 'completed_at should be stamped');
    const reopened = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { state_id: stateIds.Todo } });
    assert.equal(reopened.completed_at, null);
  });

  it('finds tasks through full-text search', async () => {
    const { results } = await api(`/api/workspaces/${workspaceId}/search?q=landing`);
    assert.ok(results.some((hit: any) => hit.id === taskId), 'search should find the task');
  });

  it('pulls a full snapshot and then only deltas', async () => {
    const snapshot = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.ok(snapshot.changes.task?.length === 2);
    assert.ok(snapshot.changes.project?.length === 2); // "Getting started" + "Website relaunch"
    assert.ok(snapshot.cursor > 0);

    await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Delta task' } });
    const delta = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${snapshot.cursor}`);
    assert.equal(delta.changes.task?.length, 1);
    assert.equal(delta.changes.task?.[0].title, 'Delta task');
  });

  it('accepts an offline mutation batch and is idempotent on retry', async () => {
    const id = crypto.randomUUID();
    const mutationId = crypto.randomUUID();
    const push = () => api<PushResponse>('/api/sync/push', {
      body: {
        workspaceId,
        clientId: 'test-client',
        mutations: [{
          id: mutationId,
          entity: 'task',
          entityId: id,
          op: 'upsert',
          patch: { workspace_id: workspaceId, project_id: projectId, title: 'Filed while offline', sort_order: orderKey(null, null) },
          hlc: clock.now(),
        }],
      },
    });

    const first = await push();
    assert.deepEqual(first.rejected, []);
    assert.equal(first.patched.task?.[0].identifier, 'WEB-4');

    const again = await push();
    assert.deepEqual(again.rejected, []);
    assert.equal(again.patched.task, undefined, 'a replayed mutation must not create a second task');

    const task = await api(`/api/tasks/${id}`);
    assert.equal(task.title, 'Filed while offline');
  });

  it('merges concurrent edits field by field', async () => {
    const older = clock.now();
    const newer = clock.now();

    // Two offline clients: one renamed the task, the other changed its priority.
    await api('/api/sync/push', {
      body: {
        workspaceId, clientId: 'client-b',
        mutations: [{ id: crypto.randomUUID(), entity: 'task', entityId: taskId, op: 'upsert', patch: { title: 'Renamed by B' }, hlc: newer }],
      },
    });
    await api('/api/sync/push', {
      body: {
        workspaceId, clientId: 'client-a',
        mutations: [{ id: crypto.randomUUID(), entity: 'task', entityId: taskId, op: 'upsert', patch: { title: 'Renamed by A', priority: 'urgent' }, hlc: older }],
      },
    });

    const task = await api(`/api/tasks/${taskId}`);
    assert.equal(task.title, 'Renamed by B', 'the newer stamp wins for title');
    assert.equal(task.priority, 'urgent', 'the untouched field still takes the older write');
  });

  it('stores uploads content-addressed and serves them back', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABirU3bAAAAG0lEQVR4nGP8//8/AzGAiShVowZTx2AKAAAA//8DAAKrAsfKF8p1AAAAAElFTkSuQmCC',
      'base64',
    );
    const upload = await api(`/api/workspaces/${workspaceId}/files?task_id=${taskId}`, {
      raw: png,
      headers: { 'content-type': 'image/png', 'x-filename': 'pixel.png' },
    });
    assert.equal(upload.width, 10);
    assert.equal(upload.height, 5);
    assert.ok(upload.attachment.id);

    const response = await fetch(`${base}${upload.url}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal((await response.arrayBuffer()).byteLength, png.length);

    const anonymous = await fetch(`${base}${upload.url}`);
    assert.equal(anonymous.status, 401, 'uploads must not be public');
  });

  it('keeps page history when the body changes', async () => {
    const page = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Runbook', content: '# Runbook\n\nfirst revision' },
    });
    await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { content: '# Runbook\n\nsecond revision' } });
    const versions = await api(`/api/pages/${page.id}/versions`);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].title, 'Runbook');
  });

  it('stores a saved view with every part of what it shows', async () => {
    // `show_done` was added after the first release. A column missing from the
    // entity registry is not an error anywhere — it is simply dropped on the
    // way in — so the interesting assertion is that it comes back at all.
    const view = await api(`/api/workspaces/${workspaceId}/views`, {
      body: {
        project_id: projectId,
        name: 'Mine, unfinished',
        layout: 'board',
        group_by: 'assignee',
        order_by: 'due_date',
        filters: { priority: ['urgent'] },
        show_done: 0,
        shared: 0,
      },
    });

    const [stored] = await api(`/api/workspaces/${workspaceId}/views`);
    assert.equal(stored.id, view.id);
    assert.equal(stored.show_done, 0, 'the column survived the registry');
    assert.equal(stored.shared, 0);
    assert.equal(stored.layout, 'board');
    assert.deepEqual(stored.filters, { priority: ['urgent'] }, 'filters are JSON, not a string');

    // Saving over a view has to be able to turn a flag back on. A patch that
    // treats 0 as "unset" would make a hidden-done view impossible to undo.
    await api(`/api/views/${view.id}`, { method: 'PATCH', body: { show_done: 1, shared: 1 } });
    const [updated] = await api(`/api/workspaces/${workspaceId}/views`);
    assert.equal(updated.show_done, 1);
    assert.equal(updated.shared, 1);
  });

  it('issues API tokens and speaks MCP', async () => {
    const created = await api('/api/tokens', { body: { name: 'mcp', workspaceId } });
    apiToken = created.token;
    assert.match(apiToken, /^kol_/);

    const listed = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const names = listed.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('create_task'));
    assert.ok(names.includes('project_status'));

    const call = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'Filed by an assistant', priority: 'urgent' } },
      },
    });
    assert.equal(call.result.structuredContent.identifier, 'WEB-5');

    const status = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_status', arguments: { project: 'WEB' } } },
    });
    assert.ok(status.result.structuredContent.by_state_group);

    const initialize = await api('/mcp', {
      token: apiToken,
      body: { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    });
    assert.equal(initialize.result.serverInfo.name, 'kolibri');
  });

  /**
   * Quick-add syntax over MCP, and the reason it is opt-in.
   *
   * A tool with a schema should mean what the schema says. An assistant that
   * writes "Discuss with @ada" as a `title` means those words — so `title` is
   * never parsed, and `quick_add` is there for the other case: relaying a line
   * a person actually typed.
   */
  it('reads a quick-add line when asked, and never parses an ordinary title', async () => {
    const quick = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'create_task', arguments: { quick_add: 'Redraw the empty state !urgent #WEB due:2026-12-24' } },
      },
    });
    const made = quick.result.structuredContent;
    assert.equal(made.title, 'Redraw the empty state', 'the tokens came out of the title');
    assert.equal(made.priority, 'urgent');
    assert.equal(made.due_date, '2026-12-24');
    assert.match(made.identifier, /^WEB-/, '#WEB chose the project, so `project` was not needed');

    // The same string as a title is left exactly as typed.
    const plain = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'Redraw the empty state !urgent #WEB due:2026-12-24' } },
      },
    });
    assert.equal(plain.result.structuredContent.title, 'Redraw the empty state !urgent #WEB due:2026-12-24');
    assert.equal(plain.result.structuredContent.priority, 'none');
    assert.equal(plain.result.structuredContent.due_date, null);
  });

  it('says which of the two is missing rather than filing a nameless task', async () => {
    const noProject = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'create_task', arguments: { quick_add: 'A task with nowhere to go' } },
      },
    });
    assert.match(JSON.stringify(noProject), /Which project/);

    const noTitle = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', quick_add: '!urgent' } },
      },
    });
    assert.match(JSON.stringify(noTitle), /needs a title/);
  });

  /**
   * The half of the transport that is not a POST.
   *
   * This is what made the same server work in Claude Code and fail on
   * claude.ai. A client may open the optional server-to-client stream with a
   * GET; this one has nothing to push, and the transport says to answer 405.
   * It answered 200 with the discovery JSON instead, so the client opened a
   * stream, read to the end of the content length, and reported the connection
   * as interrupted. Nothing in the POST path could catch that.
   */
  it('refuses the stream a stateless server cannot open, and says so with Allow', async () => {
    const stream = await fetch(`${base}/mcp`, {
      headers: { authorization: `Bearer ${apiToken}`, accept: 'text/event-stream' },
    });
    assert.equal(stream.status, 405);
    assert.equal(stream.headers.get('allow'), 'POST');

    // Same answer for the session teardown of a transport with no sessions —
    // 404 would say "wrong address" about an endpoint the client has been
    // talking to all along.
    const gone = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    assert.equal(gone.status, 405);
    assert.equal(gone.headers.get('allow'), 'POST');
  });

  it('still answers a plain GET with what this endpoint is', async () => {
    const described = await api('/mcp', { token: apiToken });
    assert.equal(described.transport, 'streamable-http');
    assert.ok(described.tools.includes('create_task'));
  });

  /**
   * Discovery has to survive the 405.
   *
   * A client with no credentials probing the endpoint — with any `Accept` —
   * must still get the 401 that carries `WWW-Authenticate`, because that header
   * is the whole of how a connector added at claude.ai finds the sign-in from
   * nothing but a URL. Returning 405 before checking the credentials would hide
   * it and leave the connector with no way in.
   */
  it('challenges an unauthenticated probe even when it asks for the stream', async () => {
    for (const accept of ['text/event-stream', 'application/json']) {
      const response = await fetch(`${base}/mcp`, { headers: { accept } });
      assert.equal(response.status, 401, accept);
      assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/, accept);
    }
  });

  it('gives a new project its kinds of work, and a new task the default one', async () => {
    const types = await api(`/api/workspaces/${workspaceId}/task-types?project_id=${projectId}`);
    assert.deepEqual(types.map((type: any) => type.name), ['Task', 'Bug', 'Feature']);
    assert.equal(types.filter((type: any) => type.is_default).length, 1, 'exactly one is the default');

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { body: { project_id: projectId, title: 'Typed by default' } });
    assert.equal(task.type_id, types.find((type: any) => type.is_default).id);

    // And an explicit type is kept rather than overwritten by the default.
    const bug = types.find((type: any) => type.name === 'Bug');
    const explicit = await api(`/api/workspaces/${workspaceId}/tasks`, {
      body: { project_id: projectId, title: 'A real bug', type_id: bug.id },
    });
    assert.equal(explicit.type_id, bug.id);
  });

  it('files and finds work by its kind over MCP', async () => {
    const filed = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 30, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'Crash on save', type: 'Bug' } },
      },
    });
    assert.equal(filed.result.structuredContent.type, 'Bug', 'the view says what kind it is');

    const bugs = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 31, method: 'tools/call',
        params: { name: 'list_tasks', arguments: { project: 'WEB', type: 'Bug' } },
      },
    });
    // `list_tasks` returns an array, which the dispatcher wraps as `result`.
    const titles = bugs.result.structuredContent.result.map((task: any) => task.title);
    assert.ok(titles.includes('Crash on save'));
    assert.ok(!titles.includes('Typed by default'), 'and only that kind');

    // A kind the project does not have is refused rather than invented: the
    // list of what a team calls its work is not something a tool should add to.
    const invented = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 32, method: 'tools/call',
        params: { name: 'update_task', arguments: { task: 'WEB-1', type: 'Epic' } },
      },
    });
    assert.ok(invented.error, 'an unknown kind is an error, not a new type');
  });

  it('refuses writes from a read-only token', async () => {
    const readOnly = await api('/api/tokens', { body: { name: 'ro', workspaceId, scopes: 'read' } });
    const result = await api('/mcp', {
      token: readOnly.token,
      body: {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'create_task', arguments: { project: 'WEB', title: 'should fail' } },
      },
    });
    assert.match(result.result?.content?.[0]?.text ?? result.error.message, /read-only/i);
  });

  it('notifies the person named in a comment', async () => {
    // Bob is invited further down; for the mention we need a second member now.
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    const adaCookie = cookie;

    cookie = '';
    await api('/api/auth/register', { body: { email: 'lin@example.com', name: 'Lin Clark', password: 'yet another pass' } });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    const linId = (await api('/api/session')).user.id;

    cookie = adaCookie;
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { task_id: taskId, body: 'Can you take a look at this, @lin?' },
    });

    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const notifications = await api(`/api/workspaces/${workspaceId}/notifications`);
    const mention = notifications.find((n: any) => n.kind === 'mention');
    assert.ok(mention, 'the mentioned user gets a notification');
    assert.equal(mention.user_id, linId);
    assert.match(mention.title, /mentioned/i);

    cookie = adaCookie;
  });

  it('tracks time spent, and adds it up', async () => {
    const first = await api(`/api/workspaces/${workspaceId}/time-entries`, {
      body: { task_id: taskId, project_id: projectId, minutes: 90, spent_on: '2026-08-17', note: 'pairing' },
    });
    assert.equal(first.minutes, 90);
    assert.equal(first.spent_on, '2026-08-17');

    // A running timer is a row with a start and no minutes yet, which is what
    // lets it survive a reload, a second device and being offline.
    const timer = await api(`/api/workspaces/${workspaceId}/time-entries`, {
      body: { task_id: taskId, project_id: projectId, minutes: 0, spent_on: '2026-08-18', started_at: 1_755_500_000_000 },
    });
    assert.equal(timer.started_at, 1_755_500_000_000);
    assert.equal(timer.minutes, 0);

    const stopped = await api(`/api/time-entries/${timer.id}`, {
      method: 'PATCH', body: { minutes: 25, started_at: null },
    });
    assert.equal(stopped.minutes, 25);
    assert.equal(stopped.started_at, null, 'stopping clears the clock rather than leaving it running');

    const entries = await api(`/api/workspaces/${workspaceId}/time-entries`);
    assert.equal(entries.reduce((sum: number, entry: any) => sum + entry.minutes, 0), 115);
  });

  it('refuses to log time into a workspace that has it switched off', async () => {
    // Off is the default. An assistant that recorded time nobody can see would
    // have done something worse than refuse: the row exists, the person who
    // asked believes it was kept, and no screen will ever show it.
    const refused = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 19, method: 'tools/call',
        params: { name: 'log_time', arguments: { task: 'WEB-1', amount: '1h' } },
      },
    });
    assert.ok(refused.error, 'switched off means refused');
    assert.match(refused.error.message, /switched off/i, 'and the message says where to switch it on');
  });

  it('logs time over MCP the way a person does over the form', async () => {
    await api(`/api/workspaces/${workspaceId}`, { method: 'PATCH', body: { features: { time: true } } });
    const logged = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 20, method: 'tools/call',
        params: { name: 'log_time', arguments: { task: 'WEB-1', amount: '1h30', note: 'review' } },
      },
    });
    assert.equal(logged.result.structuredContent.minutes, 90, 'the same shorthand the form takes');

    // A duration nobody can read must not become a silent zero-minute entry.
    const nonsense = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: { name: 'log_time', arguments: { task: 'WEB-1', amount: 'a while' } },
      },
    });
    assert.ok(nonsense.error, 'an unreadable amount is refused, not rounded to nothing');
    assert.match(nonsense.error.message, /duration/i, 'and the message says what was wrong');

    const listed = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 22, method: 'tools/call',
        params: { name: 'list_time', arguments: { task: 'WEB-1' } },
      },
    });
    // WEB-1 is the task the previous case logged 115 minutes against, so the
    // total is everybody's time on it, not just what this token just added.
    assert.equal(listed.result.structuredContent.total_minutes, 205);
    assert.ok(listed.result.structuredContent.entries.every((entry: any) => entry.task === 'WEB-1'));

    const mine = await api('/mcp', {
      token: apiToken,
      body: {
        jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: 'list_time', arguments: { task: 'WEB-1', from: '2026-08-18' } },
      },
    });
    assert.ok(
      mine.result.structuredContent.entries.every((entry: any) => entry.spent_on >= '2026-08-18'),
      'a date range narrows it',
    );
  });

  it('carries a conversation on a page, not only on a task', async () => {
    const adaCookie = cookie;
    const page = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Release checklist', content: 'Steps to follow before shipping.' },
    });

    // Lin joins the conversation first, so Ada has somebody to be told about.
    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const linCookie = cookie;
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { page_id: page.id, body: 'Should the database backup step come first?' },
    });

    cookie = adaCookie;
    const adaInbox = await api(`/api/workspaces/${workspaceId}/notifications`);
    const told = adaInbox.find((n: any) => n.page_id === page.id && n.kind === 'comment');
    assert.ok(told, 'the person who wrote the page hears about a comment on it');
    assert.match(told.title, /Release checklist/, 'and the title says which page');

    // Ada replies. Lin has spoken on this page, so Lin is part of its audience
    // now — a page has no assignees for the audience to be read from.
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { page_id: page.id, body: 'Yes — I will reorder it.' },
    });
    cookie = linCookie;
    const linInbox = await api(`/api/workspaces/${workspaceId}/notifications`);
    assert.ok(
      linInbox.some((n: any) => n.page_id === page.id && n.kind === 'comment'),
      'whoever has commented is part of the conversation from then on',
    );

    cookie = adaCookie;
  });

  it('notices a mention written into a page, and only says so once', async () => {
    const adaCookie = cookie;
    const page = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Onboarding', content: 'First draft.' },
    });
    const before = (await countMentions(workspaceId, 'lin@example.com', 'yet another pass'));

    cookie = adaCookie;
    await api(`/api/pages/${page.id}`, {
      method: 'PATCH', body: { content: 'First draft. @lin can you check the account section?' },
    });
    assert.equal(await countMentions(workspaceId, 'lin@example.com', 'yet another pass') - before, 1, 'a mention in a page body counts');

    // A page autosaves while you type, so every keystroke arrives as another
    // write with the same name in it. Being told once is the whole point.
    cookie = adaCookie;
    await api(`/api/pages/${page.id}`, {
      method: 'PATCH', body: { content: 'First draft. @lin can you check the account section? Thanks.' },
    });
    assert.equal(await countMentions(workspaceId, 'lin@example.com', 'yet another pass') - before, 1, 'editing around it says nothing new');

    cookie = adaCookie;
  });

  it('writes notifications in the recipient\'s language, not the actor\'s', async () => {
    const adaCookie = cookie;

    // Lin switches to German; Ada stays on English.
    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const me = await api('/api/me', { method: 'PATCH', body: { locale: 'de' } });
    assert.equal(me.user.locale, 'de');
    await assert.rejects(() => api('/api/me', { method: 'PATCH', body: { locale: 'klingon' } }), /400/);
    const linCookie = cookie;

    cookie = adaCookie;
    await api(`/api/workspaces/${workspaceId}/comments`, {
      body: { task_id: taskId, body: 'Zweiter Blick bitte, @lin' },
    });

    cookie = linCookie;
    const notifications = await api(`/api/workspaces/${workspaceId}/notifications`);
    const german = notifications.find((n: any) => n.kind === 'mention' && /erwähnt/.test(n.title));
    assert.ok(german, 'the German user gets a German notification title');

    cookie = adaCookie;
  });

  it('seeds a new project\'s workflow in the creator\'s language', async () => {
    const adaCookie = cookie;

    // Ada is on English, Lin switched to German a moment ago.
    const english = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name: 'English project', key: 'ENP' } });
    const englishStates = await api(`/api/workspaces/${workspaceId}/states?project_id=${english.id}`);
    assert.ok(englishStates.some((s: any) => s.name === 'In Progress'), 'English workflow for an English creator');

    cookie = '';
    await api('/api/auth/login', { body: { email: 'lin@example.com', password: 'yet another pass' } });
    const german = await api(`/api/workspaces/${workspaceId}/projects`, { body: { name: 'Deutsches Projekt', key: 'DEP' } });
    const germanStates = await api(`/api/workspaces/${workspaceId}/states?project_id=${german.id}`);
    assert.ok(germanStates.some((s: any) => s.name === 'In Arbeit'), 'German workflow for a German creator');
    assert.ok(germanStates.some((s: any) => s.name === 'Erledigt'));
    const germanLabels = await api(`/api/workspaces/${workspaceId}/labels?project_id=${german.id}`);
    assert.ok(germanLabels.some((l: any) => l.name === 'Dokumentation'), 'labels follow too');

    cookie = adaCookie;
  });

  it('hides private projects from non-members', async () => {
    cookie = '';
    await api('/api/auth/register', { body: { email: 'bob@example.com', name: 'Bob', password: 'another good pass' } });
    const bobCookie = cookie;

    cookie = '';
    await api('/api/auth/login', { body: { email: 'ada@example.com', password: 'correct horse battery' } });
    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    const secret = await api(`/api/workspaces/${workspaceId}/projects`, {
      body: { name: 'Secret plans', key: 'SEC', visibility: 'private' },
    });

    cookie = bobCookie;
    await api(`/api/invites/${invite.code}/accept`, { body: {} });
    const projects = await api(`/api/workspaces/${workspaceId}/projects`);
    assert.ok(!projects.some((p: any) => p.id === secret.id), 'Bob must not see the private project');

    const pull = await api<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=0`);
    assert.ok(!pull.changes.project?.some((p: any) => p.id === secret.id), 'sync must not leak private projects');
  });
});
