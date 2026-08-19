/**
 * Chat, from the client's side of the wire.
 *
 * The claim this file exists to check is the one that is easy to say and hard
 * to do: a conversation opened on a train is *the same conversation* the other
 * person opened, and a message typed with the network off is not lost.
 *
 * The server tests already prove that the server refuses to let a direct
 * channel's id and its membership disagree. What only this can prove is that
 * the client derives the same id in the first place — a rule written twice
 * would converge in the tests and diverge in the field.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-chat-client-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { directFetch, installBrowser, net, settle } from './browser.ts';

installBrowser();

const { server } = await import('../../server/src/index.ts');
const { directChannelId, readStateId, unreadCount, channelTitle, normaliseChannelName } =
  await import('@kolibri/shared');
const store = await import('../src/lib/store');
const sync = await import('../src/lib/sync');
const mutations = await import('../src/lib/mutations');

let workspaceId = '';
let ada = '';
let lin = '';

/** Somebody else's device: online even when this client is not. */
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

  const api = (await import('../src/lib/api')).api;
  const session = await api.register({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  ada = session.user.id;
  workspaceId = session.workspaces[0].id;

  // A second member, added straight to the database: registering through the
  // API would replace this client's session with theirs.
  const { run } = await import('../../server/src/db/index.ts');
  const { hashPassword } = await import('../../server/src/lib/auth.ts');
  lin = 'lin-user-id';
  run(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, seq, clocks)
     VALUES (?, 'lin@example.com', 'Lin', ?, ?, ?, 0, '{}')`,
    lin, hashPassword('correct horse battery'), Date.now(), Date.now(),
  );
  run(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
     VALUES ('wm-lin', ?, ?, 'member', ?, ?, 0, '{}')`,
    workspaceId, lin, Date.now(), Date.now(),
  );

  await sync.start(workspaceId);
});

after(() => {
  sync.stop();
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the rules both sides have to agree on', () => {
  it('derives the same direct id from either end', () => {
    assert.equal(directChannelId(ada, lin), directChannelId(lin, ada));
  });

  it('tidies a channel name the same way the server does', () => {
    assert.equal(normaliseChannelName('  Design  Review! '), 'design-review');
    assert.equal(normaliseChannelName('#### '), '');
  });

  it('counts unread without counting your own', () => {
    const messages = [
      { id: '1', channel_id: 'c', author_id: lin, created_at: 10 },
      { id: '2', channel_id: 'c', author_id: ada, created_at: 20 },
      { id: '3', channel_id: 'c', author_id: lin, created_at: 30 },
      { id: '4', channel_id: 'c', author_id: lin, created_at: 40, deleted_at: 41 },
    ];
    assert.equal(unreadCount(messages, 0, ada), 2);
    assert.equal(unreadCount(messages, 25, ada), 1);
    assert.equal(unreadCount(messages, 99, ada), 0);
  });

  it('names a direct conversation after the other person, per viewer', () => {
    const channel = { id: directChannelId(ada, lin), kind: 'direct', members: [ada, lin] };
    const nameOf = (id: string) => (id === ada ? 'Ada' : id === lin ? 'Lin' : undefined);
    assert.equal(channelTitle(channel, ada, nameOf), 'Lin');
    assert.equal(channelTitle(channel, lin, nameOf), 'Ada');
  });
});

describe('a conversation opened on a train', () => {
  it('is the same conversation the other person opened', async () => {
    const id = directChannelId(ada, lin);

    net.online = false;
    // This device opens it and says something, with no network at all.
    mutations.create('channel', { id, kind: 'direct', is_private: 1, members: [ada, lin] }, id);
    mutations.create('message', { channel_id: id, body: 'sent from the tunnel' });

    // Meanwhile the other person opened the same conversation and wrote in it.
    await otherDevice(`/api/workspaces/${workspaceId}/channels`, { id, kind: 'direct' });

    net.online = true;
    await sync.flush();
    await settle(20);
    await sync.pull();
    await settle(20);

    // One conversation, both messages. If the id were invented rather than
    // derived, this would be two conversations holding one message each.
    const channels = store.list('channel', (channel) => channel.kind === 'direct');
    assert.equal(channels.length, 1, 'two devices, one conversation');
    const messages = store.list('message', (message) => message.channel_id === id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'sent from the tunnel');
    assert.equal(messages[0].author_id, ada, 'the server stamped who said it');
  });
});

describe('how far somebody has read', () => {
  it('converges on one marker however many devices write it', async () => {
    const channel = await otherDevice(`/api/workspaces/${workspaceId}/channels`, { name: 'general' });
    await sync.pull();

    const markerId = readStateId(channel.id, ada);
    mutations.create('channelRead', { id: markerId, channel_id: channel.id, last_read_at: 100 }, markerId);
    mutations.update('channelRead', markerId, { last_read_at: 200 });
    await sync.flush();
    await settle(20);
    await sync.pull();
    await settle(20);

    const markers = store.list('channelRead', (marker) => marker.channel_id === channel.id);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].last_read_at, 200);
  });
});
