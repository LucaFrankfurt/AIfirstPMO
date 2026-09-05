/**
 * The wiki over MCP: the tree, and the web laid over it.
 *
 * Two things are worth running against a real database rather than reasoning
 * about. The link answers are SQL plus arithmetic over every page in the
 * workspace, and the interesting half of that is the clause that leaves out a
 * page the caller may not read — a backlink from a private page is a title and
 * a sentence from a document somebody was told nobody else could see, which is
 * a disclosure however small it looks.
 *
 * And a move is a refusal as much as a write. A page moved inside its own
 * subtree detaches the branch: nothing in SQLite stops it, every column still
 * type-checks, and the chapter is reachable only by URL afterwards.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = process.env.KOLIBRI_TEST_DIR ?? `/tmp/kolibri-wiki-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
let cookie = '';

async function api<T = any>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (cookie && !options.token) headers.cookie = cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${path}: ${payload?.message ?? text}`);
  return payload as T;
}

let rpcId = 0;
async function tool<T = any>(token: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await api('/mcp', {
    token,
    body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  return response.result.structuredContent as T;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the wiki over MCP', () => {
  let workspaceId = '';
  let token = '';
  const page: Record<string, string> = {};

  const make = async (title: string, content = '', parent?: string) => {
    const row = await api(`/api/workspaces/${workspaceId}/pages`, { body: { title, content, parent_id: parent ?? null } });
    page[title] = row.id;
    return row.id as string;
  };

  it('sets up a handbook that links to itself in both directions', async () => {
    resetRateLimits();
    const session = await api('/api/auth/register', {
      body: { email: 'wiki@kolibri.test', name: 'Wilma Kraus', password: 'a perfectly fine password' },
    });
    workspaceId = session.workspaces[0].id;
    token = (await api('/api/tokens', { body: { name: 'wiki', workspaceId } })).token;

    await make('Handbook', 'Start at [[Onboarding]], then read [[Expenses policy]].');
    await make('Onboarding', 'Back to [[handbook|the handbook]].', page.Handbook);
    await make('Tooling', 'Nothing links here.', page.Handbook);
  });

  it('answers what a page points at and what points back', async () => {
    const handbook = await tool(token, 'get_page', { page: 'Handbook' });
    assert.deepEqual(handbook.links_to, ['Onboarding']);
    assert.deepEqual(handbook.linked_from, ['Onboarding']);
    // A title somebody linked to before writing it: the wiki's own to-do list,
    // spelled as the author typed it rather than as the index folded it.
    assert.deepEqual(handbook.links_unwritten, ['Expenses policy']);

    const tooling = await tool(token, 'get_page', { page: 'Tooling' });
    assert.deepEqual(tooling.linked_from, []);
  });

  it('resolves a link whose case and alias differ from the title', async () => {
    const onboarding = await tool(token, 'get_page', { page: 'Onboarding' });
    assert.deepEqual(onboarding.links_to, ['Handbook'], '`[[handbook|the handbook]]` is the Handbook');
  });

  it('walks the tree one level at a time', async () => {
    const roots = await tool(token, 'list_pages', { parent: 'root' });
    assert.deepEqual(roots.result.map((row: any) => row.title), ['Handbook']);

    const children = await tool(token, 'list_pages', { parent: 'Handbook' });
    assert.deepEqual(children.result.map((row: any) => row.title).sort(), ['Onboarding', 'Tooling']);
  });

  it('moves a page under another one, and back to the top', async () => {
    const moved = await tool(token, 'update_page', { page: 'Tooling', parent: 'Onboarding' });
    assert.equal(moved.parent_id, page.Onboarding);
    assert.deepEqual(
      (await tool(token, 'list_pages', { parent: 'Onboarding' })).result.map((row: any) => row.title),
      ['Tooling'],
    );

    const back = await tool(token, 'update_page', { page: 'Tooling', parent: 'root' });
    assert.equal(back.parent_id, null);
  });

  it('refuses to move a page inside its own subtree', async () => {
    await assert.rejects(
      () => tool(token, 'update_page', { page: 'Handbook', parent: 'Onboarding' }),
      /cannot be moved inside itself/,
    );
    await assert.rejects(
      () => tool(token, 'update_page', { page: 'Handbook', parent: 'Handbook' }),
      /its own parent/,
    );
    // ...and the tree is exactly as it was, rather than half-moved.
    const handbook = await tool(token, 'get_page', { page: 'Handbook' });
    assert.equal(handbook.parent_id, null);
  });

  it('takes the links along when a page is renamed', async () => {
    const moved = await tool(token, 'update_page', { page: 'Tooling', title: 'Developer tooling' });
    assert.equal(moved.title, 'Developer tooling');
    assert.equal(moved.links_followed, undefined, 'nothing pointed at Tooling');

    await tool(token, 'update_page', { page: 'Handbook', append: 'And [[Developer tooling]].' });
    const renamed = await tool(token, 'update_page', { page: 'Developer tooling', title: 'Tooling we use' });
    assert.equal(renamed.links_followed, 1);

    const handbook = await tool(token, 'get_page', { page: 'Handbook' });
    assert.match(handbook.content, /\[\[Tooling we use\]\]/);
    assert.deepEqual(handbook.links_to.sort(), ['Onboarding', 'Tooling we use']);
  });

  it('refuses to write a link nobody could follow, and says the links stayed', async () => {
    const odd = await tool(token, 'update_page', { page: 'Tooling we use', title: 'Tools | toys' });
    assert.equal(odd.title, 'Tools | toys', 'the rename still happens');
    assert.equal(odd.links_followed, undefined, 'but a title with a pipe cannot be linked to');
    const handbook = await tool(token, 'get_page', { page: 'Handbook' });
    assert.match(handbook.content, /\[\[Tooling we use\]\]/, 'so the old link is left as it was');
    await tool(token, 'update_page', { page: 'Tools | toys', title: 'Tooling we use' });
  });

  it('follows the links for a plain REST rename too, and merges rather than replaces', async () => {
    /* The gap this closes: renaming used to be the interface's trick, so the
       same rename typed into curl left every link to the page pointing at a
       title nobody had. It is an invariant of the write path now, which is why
       this asserts it through the API the interface does not use. */
    const notes = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Runbook', content: 'Escalate per [[Incident drill]].' },
    });
    const drill = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Incident drill', content: 'Once a quarter.' },
    });

    await api(`/api/pages/${drill.id}`, { method: 'PATCH', body: { title: 'Fire drill' } });
    const after = await api(`/api/pages/${notes.id}`);
    assert.equal(after.content, 'Escalate per [[Fire drill]].');

    // ...and the rewrite went in as an edit to the page's CRDT, not as a fresh
    // one built from text. A body that had been replaced would carry only the
    // characters this write knew about.
    assert.ok(after.body, 'the linking page still has a body');
    const renamedAgain = await api(`/api/pages/${drill.id}`, { method: 'PATCH', body: { title: 'Fire drill' } });
    assert.equal(renamedAgain.title, 'Fire drill');
    assert.equal((await api(`/api/pages/${notes.id}`)).content, 'Escalate per [[Fire drill]].',
      'renaming to the name it already has changes nothing');
  });

  it('turns a link into an anchor when the page it names came with the share', async () => {
    const share = await api(`/api/workspaces/${workspaceId}/shares`, {
      body: { kind: 'page', page_id: page.Handbook },
    });
    const body = await (await fetch(`${base}/s/${share.token}`)).text();

    // `Onboarding` is a child, so it is in this document and the link goes to
    // its section. `Expenses policy` is nowhere, and a stranger gets the
    // brackets rather than a link that would ask them to sign in.
    assert.match(body, new RegExp(`<a class="md-page" href="#page-${page.Onboarding}">Onboarding</a>`));
    assert.match(body, new RegExp(`id="page-${page.Onboarding}"`), 'and the section it points at exists');
    assert.match(body, /\[\[Expenses policy\]\]/);
    assert.doesNotMatch(body, /href="\/pages\//, 'a shared document never links back into the app');
  });

  it('does not report a backlink from a page the caller may not read', async () => {
    resetRateLimits();
    const secret = await api(`/api/workspaces/${workspaceId}/pages`, {
      body: { title: 'Salary bands', content: 'See [[Handbook]] for the process.' },
    });
    await api(`/api/pages/${secret.id}`, { method: 'PATCH', body: { access: 'private' } });

    // Its author still sees it, which is what makes the next assertion mean
    // something rather than just "the query returns nothing".
    const mine = await tool(token, 'get_page', { page: 'Handbook' });
    assert.ok(mine.linked_from.includes('Salary bands'), 'the author of a private page sees their own link');

    const invite = await api(`/api/workspaces/${workspaceId}/invites`, { body: { role: 'member' } });
    resetRateLimits();
    cookie = '';
    await api('/api/auth/register', {
      body: { email: 'other@kolibri.test', name: 'Otto Berg', password: 'a perfectly fine password' },
    });
    await api(`/api/invites/${invite.code}/accept`, { body: {} });

    const theirToken = (await api('/api/tokens', { body: { name: 'theirs', workspaceId } })).token;
    const theirs = await tool(theirToken, 'get_page', { page: 'Handbook' });
    assert.ok(!theirs.linked_from.includes('Salary bands'), 'a private page must not name itself through a backlink');
    assert.ok(theirs.linked_from.includes('Onboarding'), 'and the readable ones are still there');
  });
});
