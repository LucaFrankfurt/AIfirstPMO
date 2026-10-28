/**
 * Meetings over the wire: the switch, who may read an agenda, the notes as a
 * merge, the lists narrowed to the workspace, the cascades, and the three
 * things an assistant does with a meeting afterwards.
 *
 * The case worth the length is the notes. Two people write in one point at
 * once during a meeting — that is the feature — so the test that matters sends
 * two concurrent edits from the same starting state and finds both sentences,
 * rather than whichever arrived second.
 *
 * The guest cases are the other half: the agenda is kept from a guest at the
 * pull, and a guest who could still `GET` a point by id, or ask MCP for it,
 * would not be kept from anything.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-meeting-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { crdt, type CrdtState } from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { get, all } = await import('../src/kernel/platform/db/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';

interface Person { id: string; cookie: string; token: string }

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
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await ok('/mcp', {
    token, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`${name}: ${response.result.content?.[0]?.text ?? 'failed'}`);
  return response.result.structuredContent;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

async function register(email: string): Promise<{ person: Person; workspace: string }> {
  resetRateLimits();
  const result = await call('/api/auth/register', {
    body: { email, name: email.split('@')[0], password: 'correct horse battery' },
  });
  if (result.status >= 400) throw new Error(`register ${email}: ${result.body?.message}`);
  const cookie = result.setCookie!.split(';')[0];
  const workspace = result.body.workspaces[0].id;
  const { token } = await ok('/api/tokens', { cookie, body: { name: 'mcp', workspaceId: workspace } });
  return { person: { id: result.body.user.id, cookie, token }, workspace };
}

async function join(email: string, workspace: string, owner: Person, role = 'member'): Promise<Person> {
  const { person } = await register(email);
  const invite = await ok(`/api/workspaces/${workspace}/invites`, { cookie: owner.cookie, body: { email, role } });
  await ok(`/api/invites/${invite.code}/accept`, { cookie: person.cookie, body: {} });
  // The token was minted for the person's own workspace; one for this one is
  // what an assistant acting for them here would hold.
  const { token } = await ok('/api/tokens', { cookie: person.cookie, body: { name: 'mcp-joined', workspaceId: workspace } });
  return { ...person, token };
}

const switchOn = (workspace: string, owner: Person) =>
  ok(`/api/workspaces/${workspace}`, { cookie: owner.cookie, method: 'PATCH', body: { features: { meetings: true } } });

const newMeeting = (workspace: string, who: Person, over: Record<string, unknown> = {}) =>
  ok(`/api/workspaces/${workspace}/meetings`, { cookie: who.cookie, body: { title: 'Weekly', ...over } });

const newItem = (workspace: string, who: Person, meetingId: string, over: Record<string, unknown> = {}) =>
  ok(`/api/workspaces/${workspace}/agenda-items`, { cookie: who.cookie, body: { meeting_id: meetingId, title: 'A topic', ...over } });

async function pull(who: Person, workspace: string) {
  const { body } = await call(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: who.cookie });
  return body.changes as Record<string, any[]>;
}

describe('the feature switch', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('meet-switch@example.com');
    me = made.person;
    workspace = made.workspace;
  });

  it('refuses every meeting tool while meetings are off', async () => {
    await assert.rejects(() => tool(me.token, 'list_meetings'), /switched off/);
    await assert.rejects(() => tool(me.token, 'create_meeting', { title: 'Nope' }), /switched off/);
  });

  it('works once an admin switches them on', async () => {
    await switchOn(workspace, me);
    const listed = await tool(me.token, 'list_meetings');
    assert.deepEqual(listed.meetings, []);
  });
});

describe('everybody brings topics, and the agenda says truthfully who', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';

  before(async () => {
    const made = await register('meet-topics@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('meet-topics-lin@example.com', workspace, owner);
  });

  it('lets any member add a point, filed under whoever added it', async () => {
    const meeting = await newMeeting(workspace, owner);
    // A client claiming somebody else brought it is not believed.
    const point = await newItem(workspace, lin, meeting.id, { created_by: owner.id });
    assert.equal(point.created_by, lin.id);
    assert.equal(point.status, 'open');
    assert.equal(meeting.created_by, owner.id);
  });

  it('refuses a point on a meeting that has been deleted', async () => {
    const meeting = await newMeeting(workspace, owner);
    await ok(`/api/meetings/${meeting.id}`, { cookie: owner.cookie, method: 'DELETE' });
    const refused = await call(`/api/workspaces/${workspace}/agenda-items`, {
      cookie: lin.cookie, body: { meeting_id: meeting.id, title: 'Too late' },
    });
    assert.equal(refused.status, 400);
  });

  it('keeps only projects of this workspace on a point, and only members on a meeting', async () => {
    const other = await register('meet-topics-elsewhere@example.com');
    const foreign = (await ok(`/api/workspaces/${other.workspace}/projects`, { cookie: other.person.cookie }))[0];
    const mine = (await ok(`/api/workspaces/${workspace}/projects`, { cookie: owner.cookie }))[0];
    const meeting = await newMeeting(workspace, owner, { attendees: [owner.id, other.person.id, lin.id] });
    assert.deepEqual(meeting.attendees, [owner.id, lin.id]);
    const point = await newItem(workspace, owner, meeting.id, { projects: [mine.id, foreign.id, 'nonsense'] });
    assert.deepEqual(point.projects, [mine.id]);
  });

  it('makes members responsible for a point, and nobody else', async () => {
    const sam = await join('meet-topics-sam@example.com', workspace, owner, 'guest');
    const stranger = await register('meet-topics-stranger@example.com');
    const meeting = await newMeeting(workspace, owner, { attendees: [owner.id, sam.id] });
    assert.deepEqual(meeting.attendees, [owner.id], 'a guest expected at a meeting they are never sent');

    const point = await newItem(workspace, lin, meeting.id, {
      assignees: [lin.id, owner.id, sam.id, stranger.person.id, lin.id],
    });
    assert.deepEqual(point.assignees, [lin.id, owner.id],
      'a guest, a stranger or a duplicate made responsible for a point');
    // Who brought it is still who brought it: responsibility is a different fact.
    assert.equal(point.created_by, lin.id);

    const cleared = await ok(`/api/agenda-items/${point.id}`, { cookie: owner.cookie, method: 'PATCH', body: { assignees: [] } });
    assert.deepEqual(cleared.assignees, []);
  });

  it('refuses a meeting in another workspace as a point’s meeting', async () => {
    const other = await register('meet-topics-cross@example.com');
    await switchOn(other.workspace, other.person);
    const theirs = await newMeeting(other.workspace, other.person);
    const refused = await call(`/api/workspaces/${workspace}/agenda-items`, {
      cookie: owner.cookie, body: { meeting_id: theirs.id, title: 'Sneaking in' },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /another workspace/);
  });
});

describe('telling somebody they are responsible for a point', () => {
  let owner: Person;
  let lin: Person;
  let grace: Person;
  let workspace = '';

  before(async () => {
    const made = await register('meet-tell@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('meet-tell-lin@example.com', workspace, owner);
    grace = await join('meet-tell-grace@example.com', workspace, owner);
  });

  const inbox = (who: Person) => all<any>(
    `SELECT * FROM notifications WHERE user_id = ? AND kind = 'agenda' ORDER BY created_at`, who.id,
  );

  it('tells the people made responsible, and not the person who did it', async () => {
    const meeting = await newMeeting(workspace, owner, { title: 'Weekly' });
    const point = await newItem(workspace, owner, meeting.id, { title: 'Pricing page', assignees: [lin.id, owner.id] });
    const told = inbox(lin);
    assert.equal(told.length, 1);
    assert.equal(told[0].meeting_id, meeting.id, 'the notification has to lead to the meeting');
    assert.match(told[0].title, /Pricing page/);
    assert.match(told[0].title, /Weekly/);
    assert.equal(told[0].actor_id, owner.id);
    assert.equal(inbox(owner).length, 0, 'told about something they did themselves');

    // Adding a second person tells the second person, not the first again.
    await ok(`/api/agenda-items/${point.id}`, { cookie: owner.cookie, method: 'PATCH', body: { assignees: [lin.id, grace.id] } });
    assert.equal(inbox(lin).length, 1);
    assert.equal(inbox(grace).length, 1);

    // The recipient's device receives it, with the meeting to open.
    const { body } = await call(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: lin.cookie });
    assert.ok((body.changes.notification ?? []).some((row: any) => row.kind === 'agenda' && row.meeting_id === meeting.id));
  });

  it('does not tell anybody again when the point is carried forward', async () => {
    const meeting = await newMeeting(workspace, owner, { title: 'Carried', starts_at: Date.parse('2026-11-03T10:00:00Z') });
    await newItem(workspace, owner, meeting.id, { title: 'Still open', assignees: [grace.id] });
    const before = inbox(grace).length;
    const carried = await tool(owner.token, 'carry_over_agenda', { meeting: meeting.id });
    assert.equal(carried.carried, 1);
    assert.equal(inbox(grace).length, before, 'the meeting moved; the responsibility did not');
  });
});

describe('the notes, written by several people at once', () => {
  let owner: Person;
  let workspace = '';
  let pointId = '';

  before(async () => {
    const made = await register('meet-notes@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    const meeting = await newMeeting(workspace, owner);
    pointId = (await newItem(workspace, owner, meeting.id)).id;
  });

  const stateOf = (): CrdtState => JSON.parse(String(get<any>(`SELECT notes_body FROM agenda_items WHERE id = ?`, pointId)!.notes_body));

  it('merges two edits made from the same starting point, keeping both', async () => {
    await ok(`/api/agenda-items/${pointId}`, { cookie: owner.cookie, method: 'PATCH', body: { notes: 'Agreed:' } });
    const start = stateOf();
    const ada = crdt.edit(start, 'Agreed:\nship on Friday', 'ada-laptop');
    const lin = crdt.edit(start, 'Lin: check the copy\nAgreed:', 'lin-phone');

    await ok(`/api/agenda-items/${pointId}`, { cookie: owner.cookie, method: 'PATCH', body: { notes_body: ada } });
    const after = await ok(`/api/agenda-items/${pointId}`, { cookie: owner.cookie, method: 'PATCH', body: { notes_body: lin } });

    assert.match(after.notes, /ship on Friday/);
    assert.match(after.notes, /Lin: check the copy/);
    assert.equal(after.notes, crdt.textOf(stateOf()), 'the text is what the merged state reads as');
  });

  it('ignores a text sent beside a state, which was computed before the merge', async () => {
    const start = stateOf();
    const edited = crdt.edit(start, `${crdt.textOf(start)}\nmore`, 'ada-laptop');
    const after = await ok(`/api/agenda-items/${pointId}`, {
      cookie: owner.cookie, method: 'PATCH', body: { notes_body: edited, notes: 'a stale copy' },
    });
    assert.match(after.notes, /more$/);
    assert.doesNotMatch(after.notes, /stale/);
  });

  it('lets a caller who knows nothing of any of this replace the notes with text', async () => {
    const after = await ok(`/api/agenda-items/${pointId}`, { cookie: owner.cookie, method: 'PATCH', body: { notes: 'Rewritten.' } });
    assert.equal(after.notes, 'Rewritten.');
    assert.equal(crdt.textOf(stateOf()), 'Rewritten.');
  });
});

describe('a guest is not in the room', () => {
  let owner: Person;
  let sam: Person;
  let workspace = '';
  let meetingId = '';
  let pointId = '';

  before(async () => {
    const made = await register('meet-guest@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    sam = await join('meet-guest-sam@example.com', workspace, owner, 'guest');
    meetingId = (await newMeeting(workspace, owner, { title: 'Board prep' })).id;
    pointId = (await newItem(workspace, owner, meetingId, { title: 'Pricing for Sam’s company' })).id;
  });

  it('sends a guest’s device no meeting and no agenda', async () => {
    const theirs = await pull(sam, workspace);
    assert.equal((theirs.meeting ?? []).length, 0);
    assert.equal((theirs.agendaItem ?? []).length, 0);
    const members = await pull(owner, workspace);
    assert.ok((members.agendaItem ?? []).some((row) => row.id === pointId));
  });

  it('refuses a guest the same rows through REST, listed or by id', async () => {
    assert.equal((await call(`/api/workspaces/${workspace}/meetings`, { cookie: sam.cookie })).status, 403);
    assert.equal((await call(`/api/workspaces/${workspace}/agenda-items`, { cookie: sam.cookie })).status, 403);
    assert.equal((await call(`/api/meetings/${meetingId}`, { cookie: sam.cookie })).status, 403);
    assert.equal((await call(`/api/agenda-items/${pointId}`, { cookie: sam.cookie })).status, 403);
  });

  it('refuses a guest through MCP as well', async () => {
    await assert.rejects(() => tool(sam.token, 'list_meetings', { workspace_id: workspace }), /members of the workspace/);
    await assert.rejects(() => tool(sam.token, 'get_meeting', { meeting: meetingId, workspace_id: workspace }), /members of the workspace/);
  });

  it('will not take a topic from a guest', async () => {
    const refused = await call(`/api/workspaces/${workspace}/agenda-items`, {
      cookie: sam.cookie, body: { meeting_id: meetingId, title: 'From outside' },
    });
    assert.equal(refused.status, 403);
  });
});

describe('deleting a meeting, and changing your mind', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('meet-trash@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('takes the agenda with it, and brings back only what went with it', async () => {
    const meeting = await newMeeting(workspace, owner);
    const kept = await newItem(workspace, owner, meeting.id, { title: 'Kept' });
    const dropped = await newItem(workspace, owner, meeting.id, { title: 'Dropped last week' });
    await ok(`/api/agenda-items/${dropped.id}`, { cookie: owner.cookie, method: 'DELETE' });
    // A millisecond between the two deletions, which is the case "deleted at
    // or after the meeting" has to tell apart.
    await new Promise((done) => setTimeout(done, 5));

    await ok(`/api/meetings/${meeting.id}`, { cookie: owner.cookie, method: 'DELETE' });
    assert.ok(get<any>(`SELECT deleted_at FROM agenda_items WHERE id = ?`, kept.id)!.deleted_at);

    await ok(`/api/meetings/${meeting.id}`, { cookie: owner.cookie, method: 'PATCH', body: { deleted_at: null, title: 'Weekly' } });
    assert.equal(get<any>(`SELECT deleted_at FROM agenda_items WHERE id = ?`, kept.id)!.deleted_at, null);
    assert.ok(get<any>(`SELECT deleted_at FROM agenda_items WHERE id = ?`, dropped.id)!.deleted_at,
      'a point removed before the meeting was deleted came back with it');
  });
});

describe('what an assistant does with a meeting afterwards', () => {
  let owner: Person;
  let workspace = '';
  let project: any;
  let meeting: any;

  before(async () => {
    const made = await register('meet-after@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    project = (await ok(`/api/workspaces/${workspace}/projects`, { cookie: owner.cookie }))[0];
    meeting = await tool(owner.token, 'create_meeting', {
      title: 'Release weekly',
      starts_at: '2026-11-03T10:00:00Z',
      location: 'Room 2',
      topics: ['Release date', 'Pricing page', 'Hiring'],
    });
  });

  it('calls a meeting with its first topics, in order, and the caller in the room', () => {
    assert.deepEqual(meeting.items.map((point: any) => point.title), ['Release date', 'Pricing page', 'Hiring']);
    assert.equal(meeting.starts_at, '2026-11-03T10:00:00.000Z');
    assert.equal(meeting.attendees.length, 1);
  });

  it('names who is responsible for a point, and refuses a name it cannot place', async () => {
    const grace = await join('meet-after-grace@example.com', workspace, owner);
    const guest = await join('meet-after-guest@example.com', workspace, owner, 'guest');
    // Its own meeting: the cases below count what is on the release weekly.
    // Undated, so it is never the meeting the carry-over below picks as "next".
    const planning = await tool(owner.token, 'create_meeting', { title: 'Budget planning' });
    const added = await tool(owner.token, 'add_agenda_item', {
      meeting: planning.id, title: 'Budget for Q1', assignees: ['meet-after-grace@example.com'],
    });
    assert.deepEqual(added.item.assignees, [grace.id]);

    await assert.rejects(
      () => tool(owner.token, 'update_agenda_item', { item: added.item.id, assignees: ['Nobody Atall'] }),
      /Nobody in this workspace matches/,
    );
    await assert.rejects(
      () => tool(owner.token, 'update_agenda_item', { item: added.item.id, assignees: [guest.id] }),
      /guest/,
    );

    const read = await tool(owner.token, 'get_meeting', { meeting: planning.id });
    assert.deepEqual(read.items[0].assignees, ['meet-after-grace']);
  });

  it('files a task from a point, in the point’s project, and remembers where it came from', async () => {
    const [release] = meeting.items;
    await tool(owner.token, 'update_agenda_item', { item: release.id, projects: [project.key] });
    const task = await tool(owner.token, 'create_task_from_agenda_item', { item: release.id, title: 'Tag the release' });
    assert.equal(task.project_id, project.id);
    assert.equal(get<any>(`SELECT agenda_item_id FROM tasks WHERE id = ?`, task.id)!.agenda_item_id, release.id);

    const read = await tool(owner.token, 'get_meeting', { meeting: meeting.id });
    assert.deepEqual(read.items[0].tasks.map((one: any) => one.identifier), [task.identifier]);
    assert.deepEqual(read.items[0].projects, [project.key]);
  });

  it('asks which project when a point is about none', async () => {
    await assert.rejects(
      () => tool(owner.token, 'create_task_from_agenda_item', { item: meeting.items[2].id }),
      /Which project/,
    );
  });

  it('appends to the notes rather than writing over them', async () => {
    const [release] = meeting.items;
    await tool(owner.token, 'update_agenda_item', { item: release.id, notes: 'Friday.' });
    const after = await tool(owner.token, 'update_agenda_item', { item: release.id, append_notes: 'Lin checks the copy.', status: 'discussed' });
    assert.equal(after.notes, 'Friday.\n\nLin checks the copy.');
    assert.equal(after.status, 'discussed');
  });

  it('carries what was not discussed into a follow-up it calls, once', async () => {
    const first = await tool(owner.token, 'carry_over_agenda', { meeting: meeting.id });
    assert.equal(first.called_follow_up, true);
    assert.equal(first.carried, 2);
    assert.equal(first.deferred, 2);
    assert.equal(first.into.starts_at, '2026-11-10T10:00:00.000Z');
    assert.deepEqual(first.into.items.map((point: any) => point.title), ['Pricing page', 'Hiring']);
    assert.ok(first.into.items.every((point: any) => point.status === 'open' && point.carried_from));

    // Into the meeting it just called, because that is now the next one.
    const again = await tool(owner.token, 'carry_over_agenda', { meeting: meeting.id });
    assert.equal(again.called_follow_up, false);
    assert.equal(again.carried, 0);
    assert.equal(again.into.id, first.into.id);
    const live = all<any>(`SELECT id FROM agenda_items WHERE meeting_id = ? AND deleted_at IS NULL`, first.into.id);
    assert.equal(live.length, 2, 'a topic carried twice is on the agenda twice');

    const source = await tool(owner.token, 'get_meeting', { meeting: meeting.id });
    assert.deepEqual(source.items.map((point: any) => point.status), ['discussed', 'deferred', 'deferred']);
  });

  it('files the minutes as a page and rewrites the same page the second time', async () => {
    const filed = await tool(owner.token, 'file_meeting_minutes', { meeting: meeting.id });
    const page = get<any>(`SELECT title, content FROM pages WHERE id = ?`, filed.page_id)!;
    assert.match(page.title, /Release weekly/);
    assert.match(page.content, /## 1\. Release date/);
    assert.match(page.content, /Lin checks the copy\./);
    assert.match(page.content, /Tag the release/);
    assert.equal(get<any>(`SELECT minutes_page_id FROM meetings WHERE id = ?`, meeting.id)!.minutes_page_id, filed.page_id);

    await tool(owner.token, 'add_agenda_item', { meeting: meeting.id, title: 'Any other business' });
    const again = await tool(owner.token, 'file_meeting_minutes', { meeting: meeting.id });
    assert.equal(again.page_id, filed.page_id);
    assert.equal(again.rewritten, true);
    assert.match(get<any>(`SELECT content FROM pages WHERE id = ?`, filed.page_id)!.content, /Any other business/);
  });

  it('keeps a private project’s task out of the minutes, and out of the report for those outside it', async () => {
    const lin = await join('meet-after-lin@example.com', workspace, owner);
    const secret = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: owner.cookie, body: { name: 'Acquisition', key: 'ACQ', visibility: 'private' },
    });
    const point = await tool(owner.token, 'add_agenda_item', { meeting: meeting.id, title: 'The thing we cannot name', projects: ['ACQ'] });
    await tool(owner.token, 'create_task_from_agenda_item', { item: point.item.id, title: 'Draft the term sheet' });

    const mine = await tool(owner.token, 'get_meeting', { meeting: meeting.id });
    const seen = mine.items.find((one: any) => one.id === point.item.id);
    assert.deepEqual(seen.projects, ['ACQ'], 'the person in the project sees it');
    assert.equal(seen.tasks.length, 1);

    const theirs = await tool(lin.token, 'get_meeting', { meeting: meeting.id, workspace_id: workspace });
    const unseen = theirs.items.find((one: any) => one.id === point.item.id);
    assert.deepEqual(unseen.projects, [], 'a private project named to somebody outside it');
    assert.deepEqual(unseen.tasks, [], 'a private task listed to somebody outside its project');

    const filed = await tool(owner.token, 'file_meeting_minutes', { meeting: meeting.id });
    const page = String(get<any>(`SELECT content FROM pages WHERE id = ?`, filed.page_id)!.content);
    assert.match(page, /The thing we cannot name/, 'the point itself is the meeting’s, and stays');
    assert.doesNotMatch(page, /term sheet|ACQ/, 'the minutes published a private project’s work to the wiki');
    void secret;
  });

  it('closes a meeting, and lists it among the closed ones', async () => {
    await tool(owner.token, 'update_meeting', { meeting: meeting.id, status: 'done' });
    const closed = await tool(owner.token, 'list_meetings', { status: 'done' });
    assert.deepEqual(closed.meetings.map((one: any) => one.id), [meeting.id]);
  });
});
