/**
 * Channels and direct messages.
 *
 * Two things are worth testing here and the rest follows from them.
 *
 * The first is **convergence**: a direct conversation's id is derived from its
 * two members rather than invented, which is what lets two people open one with
 * each other while both are offline and still end up in one conversation. That
 * only holds if the server refuses to let the id and the membership disagree.
 *
 * The second is **who can read what**, and it is tested through every door
 * rather than once: the sync pull, the REST list, the REST row, and search.
 * The same rule is written in four places — SQL for the pull, SQL for the list,
 * a function for the guards, a join for search — because each has to be shaped
 * for its own query. Four copies of a rule is four chances to get it wrong, so
 * each is asked the same question here.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-chat-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { directChannelId, readStateId } = await import('@kolibri/shared');
const { canSeeChannel } = await import('../src/lib/repo.ts');
const { searchWorkspace } = await import('../src/routes/search.ts');
const { all, get, run } = await import('../src/db/index.ts');

let base = '';
let workspaceId = '';
let openProject = '';
let secretProject = '';

/** One signed-in person, and the calls they can make. */
interface Person {
  id: string;
  name: string;
  cookie: string;
}

const people: Record<string, Person> = {};

async function raw(who: Person | null, path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(who ? { cookie: who.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function as(who: Person, path: string, body?: unknown, method?: string): Promise<any> {
  const result = await raw(who, path, body, method);
  if (result.status >= 400) throw new Error(`${result.status} ${method ?? ''} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function register(email: string, name: string): Promise<Person> {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  return { id: session.user.id, name, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

const post = (who: Person, collection: string, body: Record<string, unknown>) =>
  as(who, `/api/workspaces/${workspaceId}/${collection}`, body);

/** Everything one person's device would pull down. */
async function pull(who: Person): Promise<Record<string, any[]>> {
  const response = await as(who, `/api/sync/pull?workspace=${workspaceId}&since=0`);
  return response.changes ?? {};
}

const idsOf = (changes: Record<string, any[]>, entity: string): string[] =>
  (changes[entity] ?? []).map((row: any) => row.id);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  people.ada = await register('ada@example.com', 'Ada');
  const session = await as(people.ada, '/api/session');
  workspaceId = session.workspaces[0].id;

  people.lin = await register('lin@example.com', 'Lin');
  people.max = await register('max@example.com', 'Max');
  // Everyone in one workspace, which is what makes "can Max see it" a question
  // about the conversation rather than about the workspace.
  for (const person of [people.lin, people.max]) {
    run(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, 'member', ?, ?, 0, '{}')`,
      `wm-${person.id}`, workspaceId, person.id, Date.now(), Date.now(),
    );
  }

  openProject = (await post(people.ada, 'projects', { name: 'Open', key: 'OPN', visibility: 'public' })).id;
  secretProject = (await post(people.ada, 'projects', { name: 'Secret', key: 'SEC', visibility: 'private' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------ conversations */

describe('a direct conversation', () => {
  it('has an id derived from the two people in it, whichever way round', () => {
    assert.equal(directChannelId('a', 'b'), directChannelId('b', 'a'));
    assert.equal(directChannelId('a', 'b'), 'dm.a.b');
    assert.throws(() => directChannelId('a', 'a'), /two different people/);
  });

  it('is one conversation even when both people create it at once', async () => {
    const id = directChannelId(people.ada.id, people.lin.id);
    await post(people.ada, 'channels', { id, kind: 'direct' });
    // Lin's device derived the same id, so this is an update, not a second row.
    await post(people.lin, 'channels', { id, kind: 'direct' });

    const rows = all(`SELECT id FROM channels WHERE kind = 'direct' AND id = ?`, id);
    assert.equal(rows.length, 1);
  });

  it('takes its members from its id rather than from what was sent', async () => {
    const id = directChannelId(people.ada.id, people.max.id);
    // A client claiming somebody else is in it does not make them in it.
    const created = await post(people.ada, 'channels', { id, kind: 'direct', members: [people.ada.id, people.lin.id] });
    assert.deepEqual([...created.members].sort(), [people.ada.id, people.max.id].sort());
  });

  it('is always private, whatever was asked for', async () => {
    const id = directChannelId(people.lin.id, people.max.id);
    const created = await post(people.lin, 'channels', { id, kind: 'direct', is_private: 0 });
    assert.equal(created.is_private, 1);
  });

  it('cannot be opened between two other people', async () => {
    const id = directChannelId(people.lin.id, people.max.id + '-other');
    const result = await raw(people.ada, `/api/workspaces/${workspaceId}/channels`, { id, kind: 'direct' });
    assert.equal(result.status, 403);
  });

  it('refuses an id that does not name two people', async () => {
    const result = await raw(people.ada, `/api/workspaces/${workspaceId}/channels`, { id: 'dm.only-one', kind: 'direct' });
    assert.equal(result.status, 400);
  });
});

describe('a named channel', () => {
  it('keeps its name in one shape, so two of them cannot look like one', async () => {
    const created = await post(people.ada, 'channels', { name: 'Design  Review!' });
    assert.equal(created.name, 'design-review');
  });

  it('puts whoever opened it in it', async () => {
    const created = await post(people.ada, 'channels', { name: 'private-one', is_private: 1 });
    assert.ok(created.members.includes(people.ada.id));
  });

  it('drops the member list when it is made open', async () => {
    const created = await post(people.ada, 'channels', { name: 'was-private', is_private: 1 });
    const opened = await as(people.ada, `/api/channels/${created.id}`, { is_private: 0 }, 'PATCH');
    assert.deepEqual(opened.members, []);
  });
});

/* ----------------------------------------------------------------- messages */

describe('saying something', () => {
  let channel = '';

  before(async () => {
    channel = (await post(people.ada, 'channels', { name: 'general' })).id;
  });

  it('is attributed to the session, not to the payload', async () => {
    const message = await post(people.lin, 'messages', { channel_id: channel, body: 'hello', author_id: people.ada.id });
    assert.equal(message.author_id, people.lin.id);
  });

  it('cannot be said into a conversation you are not in', async () => {
    const secret = (await post(people.ada, 'channels', { name: 'secret-club', is_private: 1 })).id;
    const result = await raw(people.max, `/api/workspaces/${workspaceId}/messages`, { channel_id: secret, body: 'hi' });
    assert.equal(result.status, 403);
  });

  it('can be edited by its author, and says that it was', async () => {
    const message = await post(people.ada, 'messages', { channel_id: channel, body: 'frist' });
    assert.equal(message.edited_at, null);
    const edited = await as(people.ada, `/api/messages/${message.id}`, { body: 'first' }, 'PATCH');
    assert.equal(edited.body, 'first');
    assert.ok(Number(edited.edited_at) > 0);
  });

  it('cannot be edited by anybody else', async () => {
    const message = await post(people.ada, 'messages', { channel_id: channel, body: 'mine' });
    const result = await raw(people.lin, `/api/messages/${message.id}`, { body: 'yours' }, 'PATCH');
    assert.equal(result.status, 403);
    assert.equal(get<any>(`SELECT body FROM messages WHERE id = ?`, message.id)!.body, 'mine');
  });

  it('cannot move to another conversation or change who said it', async () => {
    const elsewhere = (await post(people.ada, 'channels', { name: 'elsewhere' })).id;
    const message = await post(people.ada, 'messages', { channel_id: channel, body: 'stays put' });
    const patched = await as(people.ada, `/api/messages/${message.id}`, {
      channel_id: elsewhere, author_id: people.lin.id, body: 'stays put still',
    }, 'PATCH');
    assert.equal(patched.channel_id, channel);
    assert.equal(patched.author_id, people.ada.id);
  });

  it('is refused by an archived conversation', async () => {
    const closed = (await post(people.ada, 'channels', { name: 'closed' })).id;
    await as(people.ada, `/api/channels/${closed}`, { archived_at: Date.now() }, 'PATCH');
    const result = await raw(people.ada, `/api/workspaces/${workspaceId}/messages`, { channel_id: closed, body: 'still here?' });
    assert.equal(result.status, 400);
  });
});

/* --------------------------------------------------------------- visibility */

describe('who can read what', () => {
  let secret = '';
  let secretMessage = '';
  let open = '';

  before(async () => {
    secret = (await post(people.ada, 'channels', {
      name: 'leadership', is_private: 1, members: [people.ada.id, people.lin.id],
    })).id;
    secretMessage = (await post(people.ada, 'messages', { channel_id: secret, body: 'zarquon budget' })).id;
    open = (await post(people.ada, 'channels', { name: 'watercooler' })).id;
    await post(people.ada, 'messages', { channel_id: open, body: 'zarquon coffee' });
  });

  it('agrees with itself: canSeeChannel and the sync filter say the same thing', async () => {
    for (const person of [people.ada, people.lin, people.max]) {
      const visible = new Set(idsOf(await pull(person), 'channel'));
      assert.equal(
        visible.has(secret),
        canSeeChannel(person.id, secret),
        `${person.name} disagreed about the private channel`,
      );
      assert.equal(visible.has(open), canSeeChannel(person.id, open), `${person.name} disagreed about the open one`);
    }
  });

  it('does not sync a private conversation to somebody outside it', async () => {
    assert.ok(idsOf(await pull(people.lin), 'channel').includes(secret));
    assert.ok(!idsOf(await pull(people.max), 'channel').includes(secret));
  });

  it('does not sync its messages either', async () => {
    assert.ok(idsOf(await pull(people.lin), 'message').includes(secretMessage));
    assert.ok(!idsOf(await pull(people.max), 'message').includes(secretMessage));
  });

  it('does not list them over REST', async () => {
    const listed = await as(people.max, `/api/workspaces/${workspaceId}/channels`);
    assert.ok(!listed.some((row: any) => row.id === secret));
    const messages = await as(people.max, `/api/workspaces/${workspaceId}/messages`);
    assert.ok(!messages.some((row: any) => row.id === secretMessage));
  });

  it('refuses them by id', async () => {
    assert.equal((await raw(people.max, `/api/channels/${secret}`)).status, 403);
    assert.equal((await raw(people.max, `/api/messages/${secretMessage}`)).status, 403);
  });

  it('does not find them in search', () => {
    const forLin = searchWorkspace(workspaceId, people.lin.id, 'zarquon').map((hit) => hit.id);
    const forMax = searchWorkspace(workspaceId, people.max.id, 'zarquon').map((hit) => hit.id);
    // Both can reach the open channel's message; only Lin reaches the private one.
    assert.ok(forLin.includes(secretMessage));
    assert.ok(!forMax.includes(secretMessage));
    assert.ok(forMax.length > 0, 'the open message should still be findable');
  });

  it('stops sending a deleted conversation\'s messages, through every door', async () => {
    const doomed = (await post(people.ada, 'channels', { name: 'doomed' })).id;
    const said = (await post(people.ada, 'messages', { channel_id: doomed, body: 'zarquon doomed' })).id;
    await as(people.ada, `/api/channels/${doomed}`, undefined, 'DELETE');

    // All four doors, and they have to agree. The sync one did not: it checked
    // the channel's privacy and forgot its tombstone, so a deleted conversation
    // kept posting to devices that no longer had anywhere to put it.
    assert.equal(canSeeChannel(people.ada.id, doomed), false, 'the guard');
    assert.ok(!idsOf(await pull(people.ada), 'message').includes(said), 'the sync pull');
    assert.ok(!(await as(people.ada, `/api/workspaces/${workspaceId}/messages`)).some((row: any) => row.id === said), 'the REST list');
    assert.ok(!searchWorkspace(workspaceId, people.ada.id, 'zarquon').some((hit) => hit.id === said), 'search');
  });

  it('shuts the door on somebody who left the workspace', async () => {
    const channel = (await post(people.ada, 'channels', {
      name: 'stayers', is_private: 1, members: [people.ada.id, people.lin.id],
    })).id;
    assert.equal(canSeeChannel(people.lin.id, channel), true);

    // Leaving does not take your name out of the channels you were in — the
    // member list is a synced field, not a foreign key.
    run(`UPDATE workspace_members SET deleted_at = ? WHERE user_id = ? AND workspace_id = ?`,
      Date.now(), people.lin.id, workspaceId);
    assert.equal(canSeeChannel(people.lin.id, channel), false);
    run(`UPDATE workspace_members SET deleted_at = NULL WHERE user_id = ? AND workspace_id = ?`,
      people.lin.id, workspaceId);
  });

  it('refuses somebody adding themselves to a conversation', async () => {
    const result = await raw(people.max, `/api/channels/${secret}`, {
      members: [people.ada.id, people.lin.id, people.max.id],
    }, 'PATCH');
    assert.equal(result.status, 403);
    assert.ok(!canSeeChannel(people.max.id, secret));
  });

  it('follows the project a channel belongs to', async () => {
    const inSecret = (await post(people.ada, 'channels', { name: 'sec-chat', project_id: secretProject })).id;
    const inOpen = (await post(people.ada, 'channels', { name: 'opn-chat', project_id: openProject })).id;

    const forMax = new Set(idsOf(await pull(people.max), 'channel'));
    // Open channel, but inside a project Max is not on.
    assert.ok(!forMax.has(inSecret));
    assert.ok(forMax.has(inOpen));
  });
});

/* -------------------------------------------------------------- read markers */

describe('how far somebody has read', () => {
  let channel = '';

  before(async () => {
    channel = (await post(people.ada, 'channels', { name: 'read-me' })).id;
  });

  it('converges on one row per person per conversation', async () => {
    const id = readStateId(channel, people.ada.id);
    await post(people.ada, 'channel-reads', { id, channel_id: channel, last_read_at: 100 });
    await post(people.ada, 'channel-reads', { id, channel_id: channel, last_read_at: 200 });
    const rows = all(`SELECT id FROM channel_reads WHERE channel_id = ? AND user_id = ?`, channel, people.ada.id);
    assert.equal(rows.length, 1);
    assert.equal(get<any>(`SELECT last_read_at FROM channel_reads WHERE id = ?`, id)!.last_read_at, 200);
  });

  it('belongs to whoever wrote it, whatever the payload said', async () => {
    const id = readStateId(channel, people.lin.id);
    const marker = await post(people.lin, 'channel-reads', { id, channel_id: channel, user_id: people.ada.id });
    assert.equal(marker.user_id, people.lin.id);
  });

  it('refuses an id naming somebody else', async () => {
    const result = await raw(people.lin, `/api/workspaces/${workspaceId}/channel-reads`, {
      id: readStateId(channel, people.ada.id), channel_id: channel,
    });
    assert.equal(result.status, 403);
  });

  it('is private: nobody else pulls it', async () => {
    const mine = readStateId(channel, people.ada.id);
    assert.ok(idsOf(await pull(people.ada), 'channelRead').includes(mine));
    assert.ok(!idsOf(await pull(people.lin), 'channelRead').includes(mine));
  });

  it('defaults to mentions in a channel and everything in a direct conversation', async () => {
    const marker = await post(people.max, 'channel-reads', { id: readStateId(channel, people.max.id), channel_id: channel });
    assert.equal(marker.notify, 'mentions');

    const direct = directChannelId(people.ada.id, people.max.id);
    const dmMarker = await post(people.max, 'channel-reads', { id: readStateId(direct, people.max.id), channel_id: direct });
    assert.equal(dmMarker.notify, 'all');
  });
});

/* ------------------------------------------------------------ notifications */

describe('being told about a message', () => {
  const inbox = (person: Person): any[] =>
    all(`SELECT * FROM notifications WHERE user_id = ? AND kind = 'message' ORDER BY created_at`, person.id);

  it('tells the other person about a direct message', async () => {
    const id = directChannelId(people.ada.id, people.lin.id);
    const before = inbox(people.lin).length;
    await post(people.ada, 'messages', { channel_id: id, body: 'are you around' });
    const after = inbox(people.lin);
    assert.equal(after.length, before + 1);
    assert.match(after.at(-1)!.title, /Ada/);
  });

  it('does not tell you about your own', async () => {
    const id = directChannelId(people.ada.id, people.lin.id);
    const before = inbox(people.ada).length;
    await post(people.ada, 'messages', { channel_id: id, body: 'talking to myself' });
    assert.equal(inbox(people.ada).length, before);
  });

  it('stays quiet in a channel until somebody is named', async () => {
    const channel = (await post(people.ada, 'channels', { name: 'quiet' })).id;
    const before = inbox(people.lin).length;
    await post(people.ada, 'messages', { channel_id: channel, body: 'anybody about?' });
    assert.equal(inbox(people.lin).length, before, 'a channel that pings everybody is a channel people mute');

    await post(people.ada, 'messages', { channel_id: channel, body: 'morning @lin' });
    assert.equal(inbox(people.lin).length, before + 1);
  });

  it('tells somebody who asked for all of it', async () => {
    const channel = (await post(people.ada, 'channels', { name: 'loud' })).id;
    await post(people.lin, 'channel-reads', {
      id: readStateId(channel, people.lin.id), channel_id: channel, notify: 'all',
    });
    const before = inbox(people.lin).length;
    await post(people.ada, 'messages', { channel_id: channel, body: 'no names in this one' });
    assert.equal(inbox(people.lin).length, before + 1);
  });

  it('names the conversation, so the notification can be opened', async () => {
    const channel = (await post(people.ada, 'channels', { name: 'pointy' })).id;
    await post(people.ada, 'messages', { channel_id: channel, body: 'over here @lin' });
    const latest = inbox(people.lin).at(-1)!;
    assert.equal(latest.channel_id, channel, 'a notification with nowhere to go is worse than none');
  });

  it('stays quiet for somebody who asked for none of it, even by name', async () => {
    const channel = (await post(people.ada, 'channels', { name: 'muted' })).id;
    await post(people.lin, 'channel-reads', {
      id: readStateId(channel, people.lin.id), channel_id: channel, notify: 'none',
    });
    const before = inbox(people.lin).length;
    await post(people.ada, 'messages', { channel_id: channel, body: 'hey @lin' });
    assert.equal(inbox(people.lin).length, before, 'muting has to beat a mention or it is not muting');
  });
});

/* ------------------------------------------------------------- membership */

describe('who may change who is in a channel', () => {
  it('lets any member invite, by default', async () => {
    const channel = (await post(people.ada, 'channels', {
      name: 'open-invites', is_private: 1, members: [people.ada.id, people.lin.id],
    })).id;
    const updated = await as(people.lin, `/api/channels/${channel}`, {
      members: [people.ada.id, people.lin.id, people.max.id],
    }, 'PATCH');
    assert.ok(updated.members.includes(people.max.id));
  });

  it('narrows that to the creator and workspace admins when asked to', async () => {
    const channel = (await post(people.ada, 'channels', {
      name: 'tight-invites', is_private: 1, members: [people.ada.id, people.lin.id],
      invite_policy: 'admins',
    })).id;
    // Lin is in it, and that is no longer enough.
    const refused = await raw(people.lin, `/api/channels/${channel}`, {
      members: [people.ada.id, people.lin.id, people.max.id],
    }, 'PATCH');
    assert.equal(refused.status, 403);
    // Ada opened it, so Ada still can.
    const updated = await as(people.ada, `/api/channels/${channel}`, {
      members: [people.ada.id, people.lin.id, people.max.id],
    }, 'PATCH');
    assert.ok(updated.members.includes(people.max.id));
  });

  it('lets you leave whatever the policy says', async () => {
    const channel = (await post(people.ada, 'channels', {
      name: 'leavable', is_private: 1, members: [people.ada.id, people.lin.id],
      invite_policy: 'admins',
    })).id;
    // Taking only your own name off is not managing the room.
    const left = await as(people.lin, `/api/channels/${channel}`, { members: [people.ada.id] }, 'PATCH');
    assert.deepEqual(left.members, [people.ada.id]);
    assert.equal(canSeeChannel(people.lin.id, channel), false);
  });

  it('will not let the last person out leave an empty room standing', async () => {
    const channel = (await post(people.ada, 'channels', { name: 'lonely', is_private: 1 })).id;
    const refused = await raw(people.ada, `/api/channels/${channel}`, { members: [] }, 'PATCH');
    assert.equal(refused.status, 400);
  });

  it('keeps the policy itself an admin decision', async () => {
    const channel = (await post(people.ada, 'channels', {
      name: 'policy-guard', is_private: 1, members: [people.ada.id, people.lin.id],
    })).id;
    const refused = await raw(people.lin, `/api/channels/${channel}`, { invite_policy: 'admins' }, 'PATCH');
    assert.equal(refused.status, 403);
  });
});

describe('reacting to somebody else\'s message', () => {
  let channel = '';
  let said = '';

  before(async () => {
    channel = (await post(people.ada, 'channels', { name: 'reactions' })).id;
    said = (await post(people.ada, 'messages', { channel_id: channel, body: 'ship it' })).id;
  });

  it('is allowed, and is the only thing that is', async () => {
    const reacted = await as(people.lin, `/api/messages/${said}`, {
      reactions: { '👍': [people.lin.id] },
    }, 'PATCH');
    assert.deepEqual(reacted.reactions, { '👍': [people.lin.id] });

    // A reaction alongside an edit is an edit.
    const refused = await raw(people.lin, `/api/messages/${said}`, {
      reactions: { '👍': [people.lin.id] }, body: 'do not ship it',
    }, 'PATCH');
    assert.equal(refused.status, 403);
    assert.equal(get<any>(`SELECT body FROM messages WHERE id = ?`, said)!.body, 'ship it');
  });

  it('is refused from outside the conversation', async () => {
    const secret = (await post(people.ada, 'channels', { name: 'no-reacting', is_private: 1 })).id;
    const inside = (await post(people.ada, 'messages', { channel_id: secret, body: 'quiet' })).id;
    const refused = await raw(people.max, `/api/messages/${inside}`, { reactions: { '👍': [people.max.id] } }, 'PATCH');
    assert.equal(refused.status, 403);
  });
});

/* ---------------------------------------------------------------- guests */

describe('a guest and their own read marker', () => {
  let guest: Person;
  let channel = '';

  before(async () => {
    const ada$ = people.ada.cookie;
    guest = await register('gil@example.com', 'Gil');
    people.ada.cookie = ada$;
    run(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, 'guest', ?, ?, 0, '{}')`,
      `wm-${guest.id}`, workspaceId, guest.id, Date.now(), Date.now(),
    );
    channel = (await post(people.ada, 'channels', { name: 'lobby' })).id;
    await post(people.ada, 'messages', { channel_id: channel, body: 'anybody here' });
  });

  it('can write the one row that is only about them', async () => {
    const marker = await post(guest, 'channel-reads', {
      id: readStateId(channel, guest.id), channel_id: channel, last_read_at: Date.now(),
    });
    assert.equal(marker.user_id, guest.id);
    // Without this a guest's unread count climbs and can never come down.
    assert.ok(marker.last_read_at > 0);
  });

  it('can still change how much it tells them', async () => {
    const updated = await as(guest, `/api/channel-reads/${readStateId(channel, guest.id)}`, { notify: 'none' }, 'PATCH');
    assert.equal(updated.notify, 'none');
  });

  it('cannot write anything else', async () => {
    for (const [collection, body] of [
      ['messages', { channel_id: channel, body: 'hello?' }],
      ['channels', { name: 'guest-channel' }],
      ['pages', { title: 'A page' }],
    ] as const) {
      const result = await raw(guest, `/api/workspaces/${workspaceId}/${collection}`, body);
      assert.equal(result.status, 403, `a guest wrote a ${collection.slice(0, -1)}`);
    }
  });

  it('cannot write somebody else\'s read marker either', async () => {
    const result = await raw(guest, `/api/workspaces/${workspaceId}/channel-reads`, {
      id: readStateId(channel, people.ada.id), channel_id: channel,
    });
    assert.equal(result.status, 403);
  });

  it('is refused through the sync push, mutation by mutation', async () => {
    const push = async (mutations: unknown[]) => raw(guest, '/api/sync/push', {
      workspaceId, clientId: 'guest-device', mutations,
    });
    const result = await push([
      {
        id: 'm1', entity: 'channelRead', entityId: readStateId(channel, guest.id), op: 'upsert',
        hlc: '9999999999999:0:guest', patch: { channel_id: channel, last_read_at: 42 },
      },
      {
        id: 'm2', entity: 'message', entityId: 'nope', op: 'upsert',
        hlc: '9999999999999:1:guest', patch: { channel_id: channel, body: 'sneaking in' },
      },
    ]);
    assert.equal(result.status, 200);
    // The marker goes through; the message beside it is refused rather than
    // taking the whole push down with it.
    assert.deepEqual(result.body.accepted, ['m1']);
    assert.equal(result.body.rejected.length, 1);
    assert.equal(result.body.rejected[0].id, 'm2');
    assert.equal(get<any>(`SELECT body FROM messages WHERE id = 'nope'`), undefined);
  });
});
