/**
 * What stays on the device: the outbox and the mirror, across a 401, a
 * workspace switch and a pull that answers late.
 *
 * The real sync engine against a fake server, because each of these needs an
 * answer the real one will not give on cue — a 401, a pull held open.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { databaseNames, installBrowser, net, settle } from './browser.ts';

installBrowser();

interface Pull { changes?: Record<string, unknown[]>; cursor: number; hasMore?: boolean }

const server = {
  pulls: new Map<string, (since: number) => Pull | Promise<Pull>>(),
  /** A status to answer a push of this many bytes with, or 0 to take it. */
  refuse: (_bytes: number): number => 0,
  requests: [] as string[],
  pushes: [] as { workspaceId: string; ids: string[]; bytes: number; status: number }[],
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    if (!net.online) throw new TypeError('Failed to fetch');
    const url = new URL(String(input), 'http://device');
    server.requests.push(url.pathname + url.search);
    if (url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const answer = await (server.pulls.get(url.searchParams.get('workspace')!)?.(since) ?? { cursor: since });
      return json(200, { changes: answer.changes ?? {}, cursor: answer.cursor, hasMore: !!answer.hasMore, reset: since === 0 });
    }
    if (url.pathname === '/api/sync/push') {
      const text = String(init.body);
      const body = JSON.parse(text);
      const bytes = Buffer.byteLength(text);
      const status = server.refuse(bytes) || 200;
      server.pushes.push({ workspaceId: body.workspaceId, ids: body.mutations.map((m: { id: string }) => m.id), bytes, status });
      if (status !== 200) return json(status, { error: 'refused', message: status === 413 ? 'Payload too large' : 'No access' });
      return json(200, { accepted: body.mutations.map((m: { id: string }) => m.id), rejected: [], patched: {}, cursor: 0 });
    }
    return json(404, { error: 'not_found', message: 'Not found' });
  },
});

const store = await import('../src/kernel/sync/store');
const idb = await import('../src/kernel/sync/idb');
const sync = await import('../src/kernel/sync/sync');
const mutations = await import('../src/kernel/sync/mutations');

const project = (id: string, workspace: string, seq: number) => ({ id, workspace_id: workspace, name: id, seq });
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe('another workspace, in this tab or the next (WEB-02, WEB-04)', () => {
  it('is a database of its own, so a switch clears nothing', async () => {
    server.pulls.set('ws-A', (since) => (since === 0
      ? { changes: { project: [project('a1', 'ws-A', 1), project('a2', 'ws-A', 2)] }, cursor: 10 }
      : { cursor: since }));
    server.pulls.set('ws-B', (since) => (since === 0 ? { changes: { project: [project('b1', 'ws-B', 5)] }, cursor: 12 } : { cursor: since }));
    await sync.start('ws-A', 'ada');

    net.online = false;
    const typed = mutations.create('task', { project_id: 'a1', title: 'typed offline in A' });
    await settle(10);
    net.online = true;
    await sync.start('ws-B', 'ada');
    await settle(10);
    assert.deepEqual(ids(store.list('project')), ['b1'], 'B shows B');
    assert.equal(store.byId('task', typed), undefined, 'and nothing of A');

    // A's database, as a tab still open in A — or this one coming back — finds it.
    const a = idb.mirrorName('ada', 'ws-A');
    assert.deepEqual(ids(await idb.readAll('project', a)), ['a1', 'a2']);
    assert.equal((await idb.readAll(idb.OUTBOX, a)).length, 1, 'the change typed in A is still queued');
    assert.equal((await idb.getMeta('sync', a)).cursor, 10, 'and A keeps its own cursor');

    // A reload of that tab, offline: the old single database showed b1 here and had lost a1 and a2.
    net.online = false;
    store.reset();
    const tab = (await import(`${'../src/kernel/sync/sync.ts'}?tab=a`)) as typeof sync;
    await tab.start('ws-A', 'ada');
    await settle(10);
    assert.deepEqual(ids(store.list('project')), ['a1', 'a2']);
    assert.equal(store.byId('task', typed)?.title, 'typed offline in A');
    assert.equal(tab.getStatus().pending, 1);
    tab.stop();
    net.online = true;
  });

  it('takes over the mirror the device held before the split, queue included', async () => {
    await idb.putMany([
      { store: 'project', values: [project('l1', 'ws-L', 3)] },
      { store: idb.OUTBOX, values: [{ id: 'm-legacy', entity: 'project', entityId: 'l1', op: 'upsert', patch: { name: 'renamed' }, hlc: '0' }] },
    ], idb.DEVICE);
    await idb.setMeta('sync', { workspaceId: 'ws-L', cursor: 7 }, idb.DEVICE);

    net.online = false;
    await sync.start('ws-L', 'ada');
    await settle(10);
    assert.equal(store.byId('project', 'l1')?.name, 'l1');
    assert.equal(sync.getStatus().pending, 1, 'the unsent change came along');
    assert.equal((await idb.readAll(idb.OUTBOX, idb.DEVICE)).length, 0, 'and left the old place');
    net.online = true;
  });
});

describe('a pull still on the network when the workspace changes (WEB-03)', () => {
  it('is dropped, and the new workspace starts from its own cursor', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked!: () => void;
    const askedC = new Promise<void>((resolve) => { asked = resolve; });
    server.pulls.set('ws-C', async (since) => {
      if (since !== 0) return { cursor: since };
      asked();
      await held;
      return { changes: { project: [project('proj-C', 'ws-C', 4000)] }, cursor: 5000, hasMore: true };
    });
    server.pulls.set('ws-D', (since) => (since === 0 ? { changes: { project: [project('proj-D', 'ws-D', 150)] }, cursor: 200 } : { cursor: since }));
    server.requests.length = 0;

    const first = sync.start('ws-C', 'ada');
    await askedC;
    await sync.start('ws-D', 'ada');
    release();
    await first;
    await settle(10);

    const pulls = server.requests.filter((path) => path.startsWith('/api/sync/pull?workspace=ws-D'));
    assert.equal(pulls[0], '/api/sync/pull?workspace=ws-D&since=0', `D is pulled from its own beginning (${pulls})`);
    assert.equal((await idb.getMeta('sync', idb.mirrorName('ada', 'ws-D'))).cursor, 200, 'and keeps its own cursor, not 5000');
    assert.deepEqual(ids(store.listAll('project')), ['proj-D'], 'C’s late answer is not on screen');
    assert.deepEqual(ids(await idb.readAll('project', idb.mirrorName('ada', 'ws-D'))), ['proj-D'], 'nor on disk');
  });
});

describe('a session that ends while changes are queued (WEB-01)', () => {
  it('keeps the queue and the mirror, and sends the queue after signing in again', async () => {
    server.pulls.set('ws-G', (since) => (since === 0 ? { changes: { project: [project('proj-G', 'ws-G', 1)] }, cursor: 10 } : { cursor: since }));
    await sync.start('ws-G', 'ada');
    let signedOut = 0;
    window.addEventListener('kolibri:signed-out', () => { signedOut += 1; });

    server.refuse = () => 401;
    const typed = mutations.create('task', { project_id: 'proj-G', title: 'typed as the session ended' });
    await sync.flush();
    await settle(10);
    assert.equal(signedOut, 1, 'the app is told to ask for a sign-in');
    const mirror = idb.mirrorName('ada', 'ws-G');
    assert.deepEqual((await idb.readAll(idb.OUTBOX, mirror)).map((mutation) => mutation.entityId), [typed], 'the queue is still on disk');
    assert.deepEqual(ids(await idb.readAll('project', mirror)), ['proj-G'], 'and so is the mirror');

    server.refuse = () => 0;
    server.requests.length = 0;
    await sync.start('ws-G', 'ada');
    await settle(10);
    assert.ok(server.pushes.some((push) => push.status === 200 && push.workspaceId === 'ws-G'), 'sent once signed in again');
    assert.equal((await idb.readAll(idb.OUTBOX, mirror)).length, 0);
    assert.ok(server.requests.includes('/api/sync/pull?workspace=ws-G&since=0'),
      'and the workspace downloaded again, since the 401 may have been a restored server');
  });

  it('is cleared by signing out on purpose — this person’s copies, nobody else’s', async () => {
    await idb.put('project', { id: 'theirs' }, idb.mirrorName('lin', 'ws-G'));
    net.online = false;
    mutations.update('project', 'proj-G', { name: 'renamed offline' });
    await settle(10);
    assert.ok((await sync.unsentChanges('ada')) >= 1, 'what the confirmation counts');

    await sync.signOutLocal('ada');
    assert.deepEqual(databaseNames().filter((name) => name.startsWith('kolibri:ada:')), []);
    assert.ok(databaseNames().includes(idb.mirrorName('lin', 'ws-G')), 'another person’s copy stays');
    assert.equal(sync.getStatus().pending, 0);
    net.online = true;
  });
});
