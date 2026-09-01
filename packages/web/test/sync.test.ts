/**
 * The client, tested where it actually lives: the real store, the real outbox
 * and the real sync engine, running against a real server, with the network
 * switched off underneath them.
 *
 * These are the paths the API tests cannot reach. A server test can prove the
 * merge rule; only this can prove that a change typed on a train survives the
 * tunnel, the reload and somebody else editing the same task meanwhile.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-client-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { directFetch, installBrowser, net, settle } from './browser.ts';

// Before anything from `src/lib` is loaded: those modules read `localStorage`
// and `navigator` at import time.
installBrowser();

const { server } = await import('../../server/src/index.ts');
const store = await import('../src/kernel/sync/store');
const sync = await import('../src/kernel/sync/sync');
const mutations = await import('../src/kernel/sync/mutations');
const idb = await import('../src/kernel/sync/idb');

let workspaceId = '';
let projectId = '';
let userId = '';

/** The other device: online even when this client is not. */
async function otherDevice(path: string, body?: unknown, method?: string): Promise<any> {
  const response = await directFetch(`${net.base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', cookie: net.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  net.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const session = await (await import('../src/kernel/sync/api')).api.register({
    email: 'ada@example.com', name: 'Ada', password: 'correct horse battery',
  });
  userId = session.user.id;
  workspaceId = session.workspaces[0].id;
  const project = await otherDevice(`/api/workspaces/${workspaceId}/projects`, { name: 'Client', key: 'CLI' });
  projectId = project.id;

  await sync.start(workspaceId);
});

after(() => {
  sync.stop();
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the first load', () => {
  it('fills the store from the server and writes it all to IndexedDB', async () => {
    assert.equal(store.byId('project', projectId)?.name, 'Client', 'the project the other device made');
    assert.ok(store.list('state', (s) => s.project_id === projectId).length >= 3, 'and its workflow states');

    // What is in IndexedDB is what a reload will find. If the pull only landed
    // in memory, the app would come back empty and nobody would notice offline.
    const stored = await idb.readAll('project');
    assert.ok(stored.some((row: any) => row.id === projectId), 'the project is on disk, not only in memory');
  });
});

describe('writing while offline', () => {
  let taskId = '';

  it('shows the change immediately and keeps it in the outbox', async () => {
    net.online = false;

    taskId = mutations.createTask({ project_id: projectId, title: 'Fix the tunnel' }, userId);
    // The interface reads the store, so this is what somebody sees — before any
    // network call has been attempted, let alone answered.
    assert.equal(store.byId('task', taskId)?.title, 'Fix the tunnel');

    await sync.flush();
    await settle(20);
    assert.equal(sync.getStatus().state, 'offline');
    assert.equal(sync.getStatus().pending, 1, 'one change waiting');

    const queued = await idb.readAll(idb.OUTBOX);
    assert.equal(queued.length, 1, 'and it is on disk, so a reload does not lose it');
    assert.equal((queued[0] as any).entityId, taskId);
  });

  it('sends it the moment the network comes back, and takes the server values', async () => {
    net.online = true;
    await sync.flush();
    await settle(20);

    assert.equal(sync.getStatus().pending, 0, 'the outbox is empty');
    assert.equal((await idb.readAll(idb.OUTBOX)).length, 0, 'on disk too');

    const onServer = await otherDevice(`/api/tasks/${taskId}`);
    assert.equal(onServer.title, 'Fix the tunnel', 'the server has the change');

    // The identifier was a placeholder until the server decided it.
    assert.match(store.byId('task', taskId)!.identifier, /^CLI-\d+$/, 'and the server’s answer replaced the guess');
  });
});

describe('two devices editing one task', () => {
  it('keeps both changes, because the merge is per field', async () => {
    const taskId = mutations.createTask({ project_id: projectId, title: 'Write it down' }, userId);
    await sync.flush();
    await settle(20);

    // This client goes offline and changes the priority.
    net.online = false;
    mutations.update('task', taskId, { priority: 'urgent' });
    await settle(10);

    // Meanwhile somebody else renames it.
    await otherDevice(`/api/tasks/${taskId}`, { title: 'Write it down properly' }, 'PATCH');

    net.online = true;
    await sync.flush();
    await settle(20);
    await sync.pull();
    await settle(20);

    const merged = store.byId('task', taskId)!;
    assert.equal(merged.priority, 'urgent', 'the field this device changed');
    assert.equal(merged.title, 'Write it down properly', 'and the field the other one did');

    const onServer = await otherDevice(`/api/tasks/${taskId}`);
    assert.equal(onServer.priority, 'urgent', 'and the server agrees with both');
    assert.equal(onServer.title, 'Write it down properly');
  });

  it('does not resurrect a task somebody else deleted', async () => {
    const taskId = mutations.createTask({ project_id: projectId, title: 'Temporary' }, userId);
    await sync.flush();
    await settle(20);

    await otherDevice(`/api/tasks/${taskId}`, undefined, 'DELETE');
    await sync.pull();
    await settle(20);

    assert.equal(store.byId('task', taskId), undefined, 'gone here as well');
    // The row itself is kept as a tombstone: that is how a third device learns.
    assert.ok(store.tables.task.get(taskId)?.deleted_at, 'as a tombstone rather than a hole');
  });
});

describe('coming back after a reload', () => {
  it('starts from IndexedDB with no network at all, outbox included', async () => {
    const pendingTitle = 'Typed in a lift';
    net.online = false;
    const pendingId = mutations.createTask({ project_id: projectId, title: pendingTitle }, userId);
    await settle(10);

    // A reload is a fresh sync engine over the same IndexedDB: the query makes
    // Node load a second copy of the module, while `store` and `idb` — imported
    // by their plain names — stay the singletons they are in a browser tab.
    store.reset();
    // The specifier is built rather than written out so it stays a runtime
    // value: a literal would be resolved at compile time and the query — the
    // whole point — would look like a module that does not exist.
    const fresh = `${'../src/kernel/sync/sync.ts'}?reload=1`;
    const reloaded = (await import(fresh)) as typeof sync;
    await reloaded.start(workspaceId);
    await settle(30);

    assert.equal(store.byId('project', projectId)?.name, 'Client', 'the workspace is there with the network down');
    assert.equal(store.byId('task', pendingId)?.title, pendingTitle, 'including the change that never left the device');
    assert.ok(reloaded.getStatus().pending >= 1, 'and it is still queued to send');

    net.online = true;
    await reloaded.flush();
    await settle(30);
    const onServer = await otherDevice(`/api/tasks/${pendingId}`);
    assert.equal(onServer.title, pendingTitle, 'and it arrives once there is a network');
    reloaded.stop();
  });
});

describe('a write the server refuses', () => {
  it('leaves nothing behind when it was a create', async () => {
    /*
     * The bug this pins: `undo` re-read the rejected row from the server and
     * swallowed the 404, on the theory that "the next full sync settles it".
     * A pull is a delta, and a row that was never created is a row no delta
     * will ever mention — so the optimistic copy stayed on the device, looking
     * exactly like a duplicate the server had accepted.
     *
     * Found by connecting the same mailbox twice on a screen, which is the
     * case where a person can trip a uniqueness rule by typing. Every other
     * guard fires on moves the interface does not offer, which is why this
     * survived so long.
     */
    await otherDevice(`/api/workspaces/${workspaceId}`, { features: { mail: true } }, 'PATCH');
    const first = await otherDevice(`/api/workspaces/${workspaceId}/mailboxes`, {
      address: 'support@example.com', host: 'imap.example.com',
    });
    await sync.pull();
    assert.equal(store.byId('mailbox', first.id)?.address, 'support@example.com');

    // The same address again, from this device. The server refuses it.
    const doomed = mutations.create('mailbox', {
      address: 'support@example.com', host: 'imap.example.com', port: 993, encryption: 'tls',
      access: 'workspace', members: [], enabled: 1, sync_days: 365,
    });
    assert.ok(store.byId('mailbox', doomed), 'the optimistic row is shown while it is in flight');

    await sync.flush();
    await settle(20);

    assert.equal(store.byId('mailbox', doomed), undefined, 'the refused row is gone from the store');
    assert.equal((await idb.readAll('mailbox')).some((row: any) => row.id === doomed), false,
      'and gone from IndexedDB, or a reload brings it back');
    // The one the server did take is untouched.
    assert.equal(store.byId('mailbox', first.id)?.address, 'support@example.com');
  });

  it('keeps a row the server merely would not change', async () => {
    /*
     * The other half, and the reason the fix is narrow. A row that came down a
     * pull has a `seq`; the server had it once. A rejection then means the edit
     * was refused, not that the row is imaginary — so it is re-read and kept,
     * never dropped.
     */
    const mailbox = store.list('mailbox')[0];
    assert.ok(mailbox?.seq, 'this row came from the server');
    // A restricted mailbox with nobody on it is refused by the entity rule —
    // a real rejection, not a value the server quietly corrects, which is what
    // an invalid port would have been.
    mutations.update('mailbox', mailbox.id, { access: 'members', members: [] });
    await sync.flush();
    await settle(20);
    assert.ok(store.byId('mailbox', mailbox.id), 'a refused edit does not delete the row');
    assert.equal(store.byId('mailbox', mailbox.id)?.access, 'workspace', 'and the refused change is undone');
  });
});

describe('the store itself', () => {
  it('hides deleted rows from lists but keeps them for the sync engine', () => {
    const id = crypto.randomUUID();
    store.tables.label.set(id, { id, name: 'Gone', deleted_at: Date.now(), workspace_id: workspaceId });
    assert.equal(store.list('label', (l) => l.id === id).length, 0);
    assert.equal(store.byId('label', id), undefined);
    assert.ok(store.tables.label.get(id), 'still addressable, because a tombstone has to sync');
    store.tables.label.delete(id);
  });

  it('merges a server row into a local one instead of replacing it', () => {
    const id = crypto.randomUUID();
    store.tables.task.set(id, { id, title: 'Local', description: 'typed here', project_id: projectId });
    store.applyChanges({ task: [{ id, title: 'From the server' }] } as never);

    const row = store.tables.task.get(id);
    assert.equal(row.title, 'From the server');
    assert.equal(row.description, 'typed here', 'a field the response left out is not a field that was cleared');
    store.tables.task.delete(id);
  });
});
