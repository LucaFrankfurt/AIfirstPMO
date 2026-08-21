/**
 * What one workspace may learn about another.
 *
 * "Public" on a project means *everyone in the workspace*, and the screen that
 * sets it says so. It has never meant everyone with an account on the instance,
 * and the difference matters most where a lookup takes an id rather than a
 * name: a name is scoped by whoever asked for it, an id is a claim about a row
 * anywhere in the database.
 *
 * These tests are written from the outside — a second account, a second
 * workspace, and an id it should not be able to do anything with.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-isolation-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';

interface Person {
  cookie: string;
  workspace: string;
  token: string;
}

async function call(path: string, options: { cookie?: string; token?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A whole separate account, with a workspace of its own and an MCP token. */
async function register(email: string): Promise<Person> {
  resetRateLimits();
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0], password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  const workspace = session.workspaces[0].id;
  const token = (await call('/api/tokens', { cookie, body: { name: 'mcp', workspaceId: workspace } })).body.token;
  return { cookie, workspace, token };
}

const mcp = (person: Person, name: string, args: Record<string, unknown>) =>
  call('/mcp', {
    token: person.token,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

let ada: Person;
let mallory: Person;
let taskId = '';
let projectId = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ada = await register('ada@example.com');
  mallory = await register('mallory@example.com');
  assert.notEqual(ada.workspace, mallory.workspace, 'two accounts, two workspaces, no overlap');

  // The most ordinary thing in the app: a project everyone in *Ada's*
  // workspace can see, with a task in it.
  projectId = (await call(`/api/workspaces/${ada.workspace}/projects`, {
    cookie: ada.cookie, body: { name: 'Ada internal', key: 'ADA', visibility: 'public' },
  })).body.id;
  taskId = (await call(`/api/workspaces/${ada.workspace}/tasks`, {
    cookie: ada.cookie, body: { project_id: projectId, title: 'Next quarter salaries' },
  })).body.id;
  assert.ok(taskId);
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a stranger holding an id', () => {
  it('cannot read the task through MCP', async () => {
    const { body } = await mcp(mallory, 'get_task', { task: taskId });
    assert.ok(body.result?.isError || body.error, `a stranger read it: ${JSON.stringify(body).slice(0, 200)}`);
  });

  it('cannot change it through MCP', async () => {
    const { body } = await mcp(mallory, 'update_task', { task: taskId, title: 'Owned' });
    assert.ok(body.result?.isError || body.error, 'a stranger wrote to it');

    const after = await call(`/api/tasks/${taskId}`, { cookie: ada.cookie });
    assert.equal(after.body.title, 'Next quarter salaries', 'the title survived');
  });

  it('cannot delete it through MCP', async () => {
    const { body } = await mcp(mallory, 'delete_task', { task: taskId });
    assert.ok(body.result?.isError || body.error, 'a stranger deleted it');
  });

  it('cannot comment on it through MCP', async () => {
    const { body } = await mcp(mallory, 'comment_task', { task: taskId, body: 'hello' });
    assert.ok(body.result?.isError || body.error, 'a stranger commented on it');
  });

  it('cannot read it over REST either', async () => {
    const { status } = await call(`/api/tasks/${taskId}`, { cookie: mallory.cookie });
    assert.ok(status === 403 || status === 404, `REST let a stranger in with ${status}`);
  });

  it('cannot pull it down through sync', async () => {
    const { body } = await call(`/api/sync/pull?workspace=${mallory.workspace}&since=0`, { cookie: mallory.cookie });
    const tasks = body.changes?.task ?? [];
    assert.equal(tasks.some((t: any) => t.id === taskId), false, 'sync handed over another workspace’s task');
  });

  it('cannot find it by searching their own workspace', async () => {
    const { body } = await call(`/api/workspaces/${mallory.workspace}/search?q=salaries`, { cookie: mallory.cookie });
    assert.equal((body.results ?? []).length, 0, 'search reached across workspaces');
  });

  /**
   * The guard underneath, on its own.
   *
   * Two layers stop this: the MCP lookup is scoped to the workspace, and
   * `canSeeProject` refuses a non-member. The tests above pass with either one
   * in place, which is what defence in depth means and also what makes it easy
   * to remove one by accident. This one asks the primitive directly, so the
   * layer that guards nineteen other callers cannot go quiet.
   */
  it('is refused by the visibility guard itself, whatever route asks it', async () => {
    const { canSeeProject } = await import('../src/lib/repo.ts');
    const { get } = await import('../src/db/index.ts');
    const adaId = get<{ id: string }>(`SELECT id FROM users WHERE email = 'ada@example.com'`)!.id;
    const malloryId = get<{ id: string }>(`SELECT id FROM users WHERE email = 'mallory@example.com'`)!.id;

    assert.equal(canSeeProject(adaId, projectId), true, 'the owner sees their own public project');
    assert.equal(canSeeProject(malloryId, projectId), false, '"public" means everyone in *that* workspace');
  });

  /**
   * Pointing at a row in a workspace you are not in.
   *
   * Found by asking what a *public share* renders, and following it back: a
   * shared page publishes its children, and nothing stopped a page in another
   * workspace from naming that page as its parent. Anyone with an account and a
   * page id could put their own text on a stranger's share link, under the
   * stranger's workspace name. The reference is refused at the write now, which
   * is where it was wrong.
   */
  it('cannot hang its own page off somebody else’s', async () => {
    const { body: victim, status: made } = await call(
      `/api/workspaces/${ada.workspace}/pages`,
      { cookie: ada.cookie, body: { title: 'Roadmap', content: 'ours' } },
    );
    assert.equal(made, 200, 'the owner made their page');

    const { status, body } = await call(
      `/api/workspaces/${mallory.workspace}/pages`,
      { cookie: mallory.cookie, body: { title: 'Injected', content: 'theirs', parent_id: victim.id } },
    );
    assert.equal(status, 400, 'a parent in another workspace was accepted');
    assert.match(String(body.message ?? ''), /another workspace/);
  });

  /** And the owner is still fine — a guard that refuses everybody is not a fix. */
  it('while the owner reads it perfectly well', async () => {
    const { body } = await mcp(ada, 'get_task', { task: taskId });
    assert.equal(body.result?.isError, undefined, JSON.stringify(body).slice(0, 200));
    assert.equal(body.result.structuredContent.title, 'Next quarter salaries');
  });
});
