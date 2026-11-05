// Real sync engine against a fake server: 401, workspace switch, late pull, oversized queue.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crdt } from '@kolibri/shared';
import { databaseNames, installBrowser, net, settle } from './browser.ts';

installBrowser();

interface Pull { changes?: Record<string, unknown[]>; cursor: number; hasMore?: boolean }

const server = {
  pulls: new Map<string, (since: number) => Pull | Promise<Pull>>(),
  /** A status to answer a push of this many bytes with, or 0 to take it. */
  refuse: (_bytes: number): number => 0,
  /** A reason and status to reject one mutation of a push with, or null to take it. */
  reject: (_mutation: { entity: string }): { reason: string; status: number } | null => null,
  requests: [] as string[],
  pushes: [] as { workspaceId: string; ids: string[]; bytes: number; status: number }[],
  /** A status every request is answered with, or 0 when the server is up. */
  down: 0,
  /** Pushes wait for this before answering. */
  hold: null as Promise<void> | null,
  inFlight: 0,
  maxInFlight: 0,
  /** Sync requests sent without a signal, so nothing could ever time them out. */
  unbounded: 0,
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
    if (url.pathname.startsWith('/api/sync/') && !init.signal) server.unbounded += 1;
    if (server.down) return json(server.down, { error: 'unavailable', message: 'Service unavailable' });
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
      server.inFlight += 1;
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      await server.hold;
      server.inFlight -= 1;
      server.pushes.push({ workspaceId: body.workspaceId, ids: body.mutations.map((m: { id: string }) => m.id), bytes, status });
      if (status !== 200) return json(status, { error: 'refused', message: status === 413 ? 'Payload too large' : 'No access' });
      const answers = body.mutations.map((m: { id: string; entity: string }) => ({ id: m.id, no: server.reject(m) }));
      return json(200, {
        accepted: answers.filter((a: any) => !a.no).map((a: any) => a.id),
        rejected: answers.filter((a: any) => a.no).map((a: any) => ({ id: a.id, ...a.no })),
        patched: {},
        cursor: 0,
      });
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

/** The engine pushes the rest of a queue on its own timers; wait for them, up to a limit. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await settle(10);
}

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

describe('a long time offline (WEB-07)', () => {
  it('sends a page saved two hundred times as one body', async () => {
    server.pulls.set('ws-E', (since) => (since === 0
      ? { changes: { page: [{ id: 'page-1', workspace_id: 'ws-E', title: 'Notes', content: '', body: crdt.empty(), seq: 1 }] }, cursor: 1 }
      : { cursor: since }));
    await sync.start('ws-E', 'ada');

    net.online = false;
    let text = '';
    for (let i = 0; i < 200; i++) {
      text += 'Ein Satz mehr. ';
      mutations.update('page', 'page-1', { body: crdt.edit(store.byId('page', 'page-1')!.body, text, sync.agentId()) });
    }
    await settle(10);
    assert.equal(sync.getStatus().pending, 1);
    const queued = await idb.readAll(idb.OUTBOX);
    assert.equal(queued.length, 1, 'on disk too');
    assert.equal(crdt.textOf(queued[0].patch.body), text, 'and it is the last state, which holds every earlier one');

    // A write with a field the later one lacks stays: its `body` alone dropped
    // would leave a bare `content`, which the server reads as a whole new page.
    const ticked = `${text}- [x] done\n`;
    mutations.update('page', 'page-1', { body: crdt.edit(store.byId('page', 'page-1')!.body, ticked, sync.agentId()), content: ticked });
    mutations.update('page', 'page-1', { body: crdt.edit(store.byId('page', 'page-1')!.body, `${ticked}Mehr.`, sync.agentId()) });
    await settle(10);
    const shapes = (await idb.readAll(idb.OUTBOX)).map((mutation) => Object.keys(mutation.patch).sort().join('+')).sort();
    assert.deepEqual(shapes, ['body', 'body+content']);

    net.online = true;
    await sync.flush();
    await settle(20);
    assert.equal(sync.getStatus().pending, 0);
  });

  it('pushes a few MiB at a time, however much is queued', async () => {
    net.online = false;
    const mebibyte = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 10; i++) mutations.update('task', `big-${i}`, { description: mebibyte });
    net.online = true;
    server.pushes.length = 0;
    await sync.flush();
    await until(() => sync.getStatus().pending === 0);
    assert.equal(sync.getStatus().pending, 0);
    assert.ok(server.pushes.length >= 3, `${server.pushes.length} pushes`);
    assert.ok(server.pushes.every((push) => push.bytes < 8 * 1024 * 1024), 'each under the server’s 8 MiB');
  });

  it('stops resending a push the server refuses outright, and keeps it', async () => {
    server.refuse = () => 403;
    net.online = false;
    mutations.update('task', 'kept', { title: 'written after access was taken away' });
    net.online = true;
    server.pushes.length = 0;
    await sync.flush();
    await sync.flush();
    await settle(300);
    assert.equal(server.pushes.length, 1, 'asked once, not every thirty seconds for ever');
    assert.equal(sync.getStatus().state, 'error');
    assert.equal((await idb.readAll(idb.OUTBOX)).length, 1, 'and the change is kept for when it may go');
    server.refuse = () => 0;
  });

  it('halves a push a proxy finds too large, and drops the one change too large on its own', async () => {
    // Started afresh, so the change the last test kept is not part of this one.
    await sync.start('ws-F', 'ada');
    server.refuse = (bytes) => (bytes > 1024 * 1024 ? 413 : 0);
    net.online = false;
    const part = 'y'.repeat(400 * 1024);
    for (let i = 0; i < 3; i++) mutations.update('task', `mid-${i}`, { description: part });
    mutations.update('task', 'huge', { description: 'z'.repeat(2 * 1024 * 1024) });
    net.online = true;
    server.pushes.length = 0;
    await sync.flush();
    await until(() => sync.getStatus().pending === 0);
    await settle(100);
    assert.equal(sync.getStatus().pending, 0, 'nothing left blocking the queue');
    assert.equal(server.pushes.filter((push) => push.status === 200).flatMap((push) => push.ids).length, 3, 'the three that fit went');
    assert.ok(server.pushes.length < 10, `not retried endlessly (${server.pushes.length} attempts)`);
    assert.match(sync.getStatus().message ?? '', /too large/);
    server.refuse = () => 0;
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

describe('two tabs of one browser editing one page (WEB-08)', () => {
  it('write as two CRDT agents, so neither loses the other’s text', async () => {
    const tab = (await import(`${'../src/kernel/sync/sync.ts'}?tab=two`)) as typeof sync;
    assert.notEqual(tab.agentId(), sync.agentId(), 'one profile, one client id, but one agent per tab');

    const base = crdt.fromText('Protokoll\nPunkt 1\n', 'server');
    const one = crdt.edit(base, 'Protokoll\nPunkt 1: Budget freigegeben\n', sync.agentId());
    const two = crdt.edit(base, 'Protokoll\nPunkt 1\nPunkt 2: Termin\n', tab.agentId());
    const both = 'Protokoll\nPunkt 1: Budget freigegeben\nPunkt 2: Termin\n';
    assert.equal(crdt.textOf(crdt.merge(one, two)), both, 'as the server merges it');
    assert.equal(crdt.textOf(crdt.merge(two, one)), both, 'and as the second tab does');
    tab.stop();
  });
});

describe('a change the server will not take (WEB-09)', () => {
  it('is kept with its content and counted until dismissed, not dropped behind a green pill', async () => {
    server.pulls.set('ws-H', (since) => (since === 0 ? { changes: { project: [project('proj-H', 'ws-H', 1)] }, cursor: 10 } : { cursor: since }));
    await sync.start('ws-H', 'ada');
    server.reject = () => ({ reason: 'Guests cannot modify this workspace', status: 403 });
    const typed = mutations.create('task', { project_id: 'proj-H', title: 'Zwei Stunden Notizen, offline getippt' });
    await sync.flush();
    await settle(20);
    server.reject = () => null;

    const status = sync.getStatus();
    assert.equal(status.pending, 0, 'not resent: the server said no');
    assert.deepEqual(status.rejected.map((change) => [change.entityId, change.patch.title, change.reason]),
      [[typed, 'Zwei Stunden Notizen, offline getippt', 'Guests cannot modify this workspace']]);
    const mirror = idb.mirrorName('ada', 'ws-H');
    assert.equal((await idb.getMeta('rejected', mirror)).length, 1, 'on disk');

    // Elsewhere and back, as a reload would: still there.
    await sync.start('ws-G', 'ada');
    assert.equal(sync.getStatus().rejected.length, 0, 'each workspace keeps its own');
    await sync.start('ws-H', 'ada');
    assert.equal(sync.getStatus().rejected[0]?.entityId, typed);

    await sync.dismissRejected();
    assert.equal(sync.getStatus().rejected.length, 0);
    assert.deepEqual(await idb.getMeta('rejected', mirror), []);
  });

  it('is retried when the server failed rather than refused', async () => {
    server.reject = () => ({ reason: 'database is locked', status: 500 });
    mutations.update('project', 'proj-H', { name: 'renamed while the database was busy' });
    await sync.flush();
    await settle(20);
    assert.equal(sync.getStatus().pending, 1, 'still queued');
    assert.equal(sync.getStatus().state, 'error');
    assert.equal(sync.getStatus().rejected.length, 0, 'and not filed as refused');

    server.reject = () => null;
    await sync.flush();
    await settle(20);
    assert.equal(sync.getStatus().pending, 0, 'sent once the server could take it');
    assert.equal((await idb.readAll(idb.OUTBOX)).length, 0);
  });
});

describe('a slow or failing server (WEB-10)', () => {
  it('sends one push at a time, and an edit during a slow one follows it', async () => {
    await sync.start('ws-I', 'ada');
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => { release = resolve; });
    server.pushes.length = 0;
    server.maxInFlight = 0;
    mutations.update('task', 'slow-1', { title: 'first' });
    const first = sync.flush();
    mutations.update('task', 'slow-2', { title: 'typed while the first was on the wire' });
    await settle(300);
    const again = sync.flush();
    release();
    server.hold = null;
    await Promise.all([first, again]);
    await until(() => sync.getStatus().pending === 0);
    assert.equal(server.maxInFlight, 1, 'the edit timer started a second push beside the slow one');
    const sent = server.pushes.flatMap((push) => push.ids);
    assert.equal(sent.length, new Set(sent).size, `a change went twice (${server.pushes.length} pushes)`);
    assert.equal(sync.getStatus().pending, 0);
  });

  it('keeps one retry timer however often the server answers 503, and bounds every request', async () => {
    const pending = new Set<unknown>();
    const wrapped = globalThis.setTimeout;
    const unwrapped = globalThis.clearTimeout;
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true, writable: true,
      value: (fn: () => void, ms = 0, ...rest: unknown[]) => {
        const timer = wrapped(() => { pending.delete(timer); fn(); }, ms, ...rest);
        if (ms >= 1000) pending.add(timer);
        return timer;
      },
    });
    Object.defineProperty(globalThis, 'clearTimeout', {
      configurable: true, writable: true,
      value: (timer: any) => { pending.delete(timer); unwrapped(timer); },
    });
    try {
      server.down = 503;
      mutations.update('task', 'during-outage', { title: 'typed while the server was down' });
      for (let i = 0; i < 4; i++) {
        await sync.flush();
        await sync.pull();
      }
      assert.equal(sync.getStatus().state, 'error');
      assert.equal(pending.size, 1, `${pending.size} retry chains after eight failed requests`);
      assert.equal(server.unbounded, 0, 'a sync request without a timeout can hold every later one');
    } finally {
      server.down = 0;
      sync.stop();
      Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: wrapped });
      Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: unwrapped });
    }
  });
});

describe('a pull while an edit is still queued (WEB-11)', () => {
  it('keeps the unsent field on screen and on disk, takes the rest, and reads the row back once sent', async () => {
    let row = { id: 'k1', workspace_id: 'ws-K', title: 'server title', priority: 'low', seq: 1 };
    server.pulls.set('ws-K', (since) => (since < row.seq ? { changes: { task: [row] }, cursor: row.seq } : { cursor: since }));
    await sync.start('ws-K', 'ada');
    assert.equal(store.byId('task', 'k1')?.title, 'server title');

    let release!: () => void;
    server.hold = new Promise<void>((resolve) => { release = resolve; });
    mutations.update('task', 'k1', { title: 'my new title' });
    const sending = sync.flush();
    // Somebody else changed the priority meanwhile; their row still carries the old title.
    row = { ...row, priority: 'high', seq: 2 };
    await sync.pull();
    assert.equal(store.byId('task', 'k1')?.title, 'my new title', 'the title jumped back to the server’s');
    assert.equal(store.byId('task', 'k1')?.priority, 'high', 'the rest of the row is the server’s');
    const saved = (await idb.readAll('task')).find((one: { id: string }) => one.id === 'k1');
    assert.equal(saved?.title, 'my new title', 'and a reload would have lost it');

    server.requests.length = 0;
    release();
    server.hold = null;
    await sending;
    await until(() => sync.getStatus().pending === 0 && server.requests.includes('/api/tasks/k1'));
    assert.ok(server.requests.includes('/api/tasks/k1'), 'a row shown under a queued change is read back once it is sent');
    sync.stop();
  });
});

// Chromium commits a transaction only after its success events ran; a reload right after Enter lost 14 of 40 quick-added tasks.
describe('a page left right after a change (NEW-QUICKADD)', () => {
  it('saves the change with its row in one committed transaction, and beacons the queue on the way out', async () => {
    const writes: { stores: string[]; committed: boolean }[] = [];
    const shim = globalThis.indexedDB as any;
    const open = shim.open;
    shim.open = (name: string, version?: number) => {
      const request = open.call(shim, name, version);
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (names: string | string[], mode?: string) => {
        const tx = transaction(names, mode);
        const write = { stores: [names].flat(), committed: false };
        if (mode === 'readwrite') writes.push(write);
        tx.commit = () => { write.committed = true; };
        return tx;
      };
      return request;
    };
    const beacons: { url: string; body: Blob }[] = [];
    (navigator as any).sendBeacon = (url: string, body: Blob) => { beacons.push({ url, body }); return true; };
    try {
      await sync.start('ws-Q', 'ada');
      writes.length = 0;
      const id = mutations.create('task', { project_id: 'p', title: 'quick-added' });
      window.dispatchEvent(new Event('pagehide'));
      await settle(10);

      const saved = writes.find((write) => write.stores.includes(idb.OUTBOX));
      assert.deepEqual(saved?.stores.sort(), [idb.OUTBOX, 'task'], 'the change and its row in one transaction');
      assert.ok(saved?.committed, 'committed at once, not after a round trip the page may not see');
      // Other tabs of this file (`?tab=…` imports) share the fake window, so only this workspace's beacon counts.
      const sent = await Promise.all(beacons.map(async ({ url, body }) => ({ url, ...JSON.parse(await body.text()) })));
      const mine = sent.filter((beacon) => beacon.workspaceId === 'ws-Q');
      assert.equal(mine.length, 1, 'the queue is sent as the page goes');
      assert.equal(mine[0].url, '/api/sync/push');
      assert.deepEqual(mine[0].mutations.map((m: { entityId: string }) => m.entityId), [id]);
    } finally {
      shim.open = open;
      delete (navigator as any).sendBeacon;
      await until(() => sync.getStatus().pending === 0);
      sync.stop();
    }
  });
});
