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
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

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
    const { canSeeProject } = await import('../src/kernel/write-path/repo.ts');
    const { get } = await import('../src/kernel/platform/db/index.ts');
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

/**
 * The nearer case, which is not a stranger at all.
 *
 * A page is the one row that can be private without its project being private:
 * `access: 'private'` means its author and nobody else, and the sync engine has
 * always applied that alongside the project rule. The history routes applied
 * neither — they checked the workspace and stopped — so a colleague with the
 * page id could read every revision of a page they cannot open. Version history
 * carries the text itself, which made it the better way in of the two.
 */
describe('a colleague who is not the author', () => {
  let colleague: { cookie: string };
  let secret = '';

  before(async () => {
    const { body: invite } = await call(`/api/workspaces/${ada.workspace}/invites`, {
      cookie: ada.cookie, body: { role: 'member' },
    });
    const joiner = await register('colleague@example.com');
    await call(`/api/invites/${invite.code}/accept`, { cookie: joiner.cookie, body: {} });
    colleague = joiner;

    const { body: page } = await call(`/api/workspaces/${ada.workspace}/pages`, {
      cookie: ada.cookie, body: { title: 'Pay review', content: 'the first draft', access: 'private' },
    });
    secret = page.id;
    // A second write, so there is a revision to ask for by id.
    await call(`/api/pages/${secret}`, {
      cookie: ada.cookie, method: 'PATCH', body: { content: 'the second draft' },
    });
  });

  it('reads the workspace it was invited to', async () => {
    const { status } = await call(`/api/workspaces/${ada.workspace}/pages`, { cookie: colleague.cookie });
    assert.equal(status, 200, 'they are a member — a guard that refuses everybody is not a fix');
  });

  it('cannot read the private page, its history, or a revision of it', async () => {
    const { body: versions } = await call(`/api/pages/${secret}/versions`, { cookie: ada.cookie });
    assert.equal(versions.length, 1, 'the author sees their own history');

    for (const path of [
      `/api/pages/${secret}`,
      `/api/pages/${secret}/versions`,
      `/api/pages/${secret}/versions/${versions[0].id}`,
      `/api/pages/${secret}/activity`,
    ]) {
      const { status } = await call(path, { cookie: colleague.cookie });
      assert.equal(status, 403, `${path} answered a page that is not theirs`);
    }
  });

  it('cannot restore a version of it either', async () => {
    const { body: versions } = await call(`/api/pages/${secret}/versions`, { cookie: ada.cookie });
    const { status } = await call(`/api/pages/${secret}/versions`, {
      cookie: colleague.cookie, body: { restore: versions[0].id },
    });
    assert.equal(status, 403, 'a write path is a read path with consequences');
  });
});

/**
 * A colleague who is in the workspace but not on the project.
 *
 * The task itself was always refused. Three rows hanging off it were not: a
 * comment, an attachment and a relation carry no `project_id`, so the guard
 * that asks "which project is this in" got `undefined`, handed `canSeeProject`
 * a null it answers `true` to, and refused nobody. The bytes behind an
 * attachment went the same way for a different reason — the file route asked
 * only about the workspace.
 *
 * Written from the outside, because that is the only place the difference
 * shows: every one of these is a plain request with a member's own cookie.
 */
describe('a colleague outside a private project', () => {
  let outsider: { cookie: string };
  let insider: { cookie: string };
  let privateProject = '';
  let privateTask = '';
  let publicTask = '';
  let comment = '';
  let relation = '';
  let attachment = '';
  let hash = '';

  /** The upload route takes a raw body, so it does not go through `call`. */
  const upload = async (cookie: string, ws: string, query: string, bytes: Buffer, name: string) => {
    const response = await fetch(`${base}/api/workspaces/${ws}/files?${query}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/webp', 'x-filename': name },
      body: new Uint8Array(bytes),
    });
    return { status: response.status, body: await response.json() as any };
  };

  before(async () => {
    const join = async (email: string) => {
      const { body: invite } = await call(`/api/workspaces/${ada.workspace}/invites`, {
        cookie: ada.cookie, body: { role: 'member' },
      });
      const person = await register(email);
      await call(`/api/invites/${invite.code}/accept`, { cookie: person.cookie, body: {} });
      return person;
    };
    outsider = await join('outsider@example.com');
    insider = await join('insider@example.com');

    privateProject = (await call(`/api/workspaces/${ada.workspace}/projects`, {
      cookie: ada.cookie, body: { name: 'Pay review', key: 'PAY', visibility: 'private' },
    })).body.id;
    // The insider is on the project; the outsider is only in the workspace.
    const { body: people } = await call(`/api/workspaces/${ada.workspace}/members`, { cookie: ada.cookie });
    const insiderId = people.find((person: any) => person.email === 'insider@example.com')?.user_id;
    assert.ok(insiderId, 'the insider has to be a member before they can be put on the project');
    await call(`/api/workspaces/${ada.workspace}/project-members`, {
      cookie: ada.cookie, body: { project_id: privateProject, user_id: insiderId },
    });

    privateTask = (await call(`/api/workspaces/${ada.workspace}/tasks`, {
      cookie: ada.cookie, body: { project_id: privateProject, title: 'Next quarter salaries' },
    })).body.id;
    publicTask = taskId;

    comment = (await call(`/api/workspaces/${ada.workspace}/comments`, {
      cookie: ada.cookie, body: { task_id: privateTask, body: 'the number is in the screenshot' },
    })).body.id;
    relation = (await call(`/api/workspaces/${ada.workspace}/relations`, {
      cookie: ada.cookie, body: { task_id: privateTask, related_task_id: publicTask, kind: 'relates_to' },
    })).body.id;

    const bytes = Buffer.from('RIFF....WEBPthese bytes are a payslip screenshot');
    const { body: stored } = await upload(ada.cookie, ada.workspace, `task_id=${privateTask}`, bytes, 'salaries.webp');
    attachment = stored.attachment.id;
    hash = stored.hash;
    assert.ok(attachment && hash, 'the upload has to have produced a row to test against');
  });

  it('is genuinely in the workspace', async () => {
    const { status } = await call(`/api/workspaces/${ada.workspace}/tasks`, { cookie: outsider.cookie });
    assert.equal(status, 200, 'a guard that refuses everybody is not a fix');
  });

  it('does not get the task, its comment, its attachment or its relation in a listing', async () => {
    for (const [collection, id] of [
      ['tasks', privateTask], ['comments', comment], ['attachments', attachment], ['relations', relation],
    ] as const) {
      const { body } = await call(`/api/workspaces/${ada.workspace}/${collection}`, { cookie: outsider.cookie });
      assert.equal(
        body.some((row: any) => row.id === id), false,
        `${collection} listed a row from a project they are not on`,
      );
    }
  });

  it('cannot read, patch or delete any of the three by id', async () => {
    for (const [collection, id] of [
      ['comments', comment], ['attachments', attachment], ['relations', relation],
    ] as const) {
      const read = await call(`/api/${collection}/${id}`, { cookie: outsider.cookie });
      assert.equal(read.status, 403, `GET /api/${collection}/:id answered a row that is not theirs`);

      const patch = await call(`/api/${collection}/${id}`, {
        cookie: outsider.cookie, method: 'PATCH', body: { name: 'renamed' },
      });
      assert.equal(patch.status, 403, `PATCH /api/${collection}/:id changed a row that is not theirs`);

      const remove = await call(`/api/${collection}/${id}`, { cookie: outsider.cookie, method: 'DELETE' });
      assert.equal(remove.status, 403, `DELETE /api/${collection}/:id removed a row that is not theirs`);
    }
  });

  it('cannot fetch the bytes, or find the hash to try', async () => {
    const bytes = await fetch(`${base}/files/${hash}/salaries.webp`, { headers: { cookie: outsider.cookie } });
    assert.equal(bytes.status, 403, 'the file route handed over a screenshot from a private project');

    const { body: listed } = await call(`/api/workspaces/${ada.workspace}/files`, { cookie: outsider.cookie });
    assert.equal(
      listed.some((row: any) => row.hash === hash), false,
      'the workspace file listing is the way around the check above',
    );
  });

  it('cannot reach it over MCP either', async () => {
    const token = (await call('/api/tokens', {
      cookie: outsider.cookie, body: { name: 'mcp', workspaceId: ada.workspace },
    })).body.token;
    const { body } = await call('/mcp', {
      token,
      body: {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_attachments', arguments: { task: privateTask, workspace_id: ada.workspace } },
      },
    });
    const text = JSON.stringify(body);
    assert.ok(!text.includes(hash), `list_attachments handed out a private project's file: ${text.slice(0, 300)}`);

    /*
     * And the tool that hands over the bytes, addressed both ways.
     *
     * `get_attachment` takes a `/files/…` URL as well as an attachment id, and
     * a URL is a hash with a name on the end — exactly the shape that got past
     * the file route once already. Knowing the id or the hash has to stay a
     * different thing from being allowed to have the file, or the listing above
     * refusing to name it is decoration.
     */
    for (const args of [{ attachment }, { file: `/files/${hash}/salaries.webp` }, { file: hash }]) {
      const { body: answer } = await call('/mcp', {
        token,
        body: {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'get_attachment', arguments: { ...args, workspace_id: ada.workspace } },
        },
      });
      assert.ok(answer.error, `get_attachment answered for ${JSON.stringify(args)} instead of refusing`);
      assert.ok(
        !JSON.stringify(answer).includes('UklGR'),
        'get_attachment handed over the bytes of a private project\'s screenshot',
      );
    }
  });

  it('still works for somebody who is on the project', async () => {
    const { status: readable } = await call(`/api/attachments/${attachment}`, { cookie: insider.cookie });
    assert.equal(readable, 200, 'a project member lost access — the fix refuses too much');

    const { body: comments } = await call(`/api/workspaces/${ada.workspace}/comments`, { cookie: insider.cookie });
    assert.ok(comments.some((row: any) => row.id === comment), 'a project member stopped seeing the comment');

    const bytes = await fetch(`${base}/files/${hash}/salaries.webp`, { headers: { cookie: insider.cookie } });
    assert.equal(bytes.status, 200, 'a project member cannot fetch the file they are allowed to see');

    // Over MCP too, which is the half a guard written for the file route does
    // not cover. A rule that refuses everybody is not a fix.
    const token = (await call('/api/tokens', {
      cookie: insider.cookie, body: { name: 'mcp', workspaceId: ada.workspace },
    })).body.token;
    const { body: answer } = await call('/mcp', {
      token,
      body: {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'get_attachment', arguments: { attachment, workspace_id: ada.workspace } },
      },
    });
    assert.ok(!answer.error, `a project member was refused their own file: ${JSON.stringify(answer.error)}`);
    assert.equal(answer.result.structuredContent.name, 'salaries.webp');
  });

  it('leaves a file nobody has attached alone', async () => {
    // An avatar, a workspace logo, an image pasted into a chat message: stored
    // with no attachment row, and there is no narrower rule for them than the
    // workspace. Requiring one would have made every avatar a 403.
    const bare = Buffer.from('RIFF....WEBPan avatar, attached to nothing');
    const { body: stored } = await upload(ada.cookie, ada.workspace, '', bare, 'avatar.webp');
    const response = await fetch(`${base}/files/${stored.hash}/avatar.webp`, {
      headers: { cookie: outsider.cookie },
    });
    assert.equal(response.status, 200, 'an unattached file stopped being the workspace’s');
  });

  it('cannot mint its way in with an attachment row of its own', async () => {
    // `url` is a registry field, so a member can write one. If reachability
    // were decided by the URL rather than by `checksum`, pointing a row on a
    // task they *can* see at a hash they cannot would be the whole exploit.
    const { status } = await call(`/api/workspaces/${ada.workspace}/attachments`, {
      cookie: outsider.cookie,
      body: { task_id: publicTask, name: 'borrowed.webp', url: `/files/${hash}/borrowed.webp` },
    });
    assert.equal(status, 200, 'writing the row is allowed — it is what it buys that must not be access');

    const bytes = await fetch(`${base}/files/${hash}/borrowed.webp`, { headers: { cookie: outsider.cookie } });
    assert.equal(bytes.status, 403, 'a hand-written attachment row bought access to somebody else’s file');
  });
});
