/**
 * Voting over the wire: the switch, the promise a secret ballot makes, the two
 * rules a client must not be trusted with, and the cascades.
 *
 * The half worth the length is the anonymity. "Secret" here is not a column the
 * screens agree to hide — it is a clause in the sync filter, so the test that
 * matters is the one that pulls as somebody else and finds nothing. A version
 * that hid the names in the interface would pass every screen test and still
 * ship the answer in every device's IndexedDB.
 *
 * The other two are the rules the count depends on and a client could break for
 * everybody: one live vote per person in a single-choice ballot, and no vote at
 * all once it is closed. Both are refusals here rather than tidy-ups, because
 * quietly dropping a vote tells the person they voted.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-decision-api-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { voteId } from '@kolibri/shared';

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

/** A second person, in the same workspace. */
async function join(email: string, workspace: string, owner: Person, role = 'member'): Promise<Person> {
  const { person } = await register(email);
  const invite = await ok(`/api/workspaces/${workspace}/invites`, {
    cookie: owner.cookie, body: { email, role },
  });
  await ok(`/api/invites/${invite.code}/accept`, { cookie: person.cookie, body: {} });
  return person;
}

const switchOn = (workspace: string, owner: Person) =>
  ok(`/api/workspaces/${workspace}`, { cookie: owner.cookie, method: 'PATCH', body: { features: { decisions: true } } });

/** A decision with two options, straight through REST. */
async function ballot(workspace: string, who: Person, over: Record<string, unknown> = {}) {
  const decision = await ok(`/api/workspaces/${workspace}/decisions`, {
    cookie: who.cookie, body: { question: 'Which one?', ...over },
  });
  const options = [];
  for (const label of ['A', 'B']) {
    options.push(await ok(`/api/workspaces/${workspace}/decision-options`, {
      cookie: who.cookie, body: { decision_id: decision.id, label },
    }));
  }
  return { decision, options };
}

/** A vote, at the id it is derived from — which is how a client casts one. */
const castAs = (who: Person, decisionId: string, optionId: string, workspace: string) =>
  call(`/api/workspaces/${workspace}/decision-votes`, {
    cookie: who.cookie,
    body: { id: voteId(decisionId, optionId, who.id), decision_id: decisionId, option_id: optionId },
  });

const reread = (id: string, who: Person) => ok(`/api/decisions/${id}`, { cookie: who.cookie });

describe('the feature switch', () => {
  let me: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-switch@example.com');
    me = made.person;
    workspace = made.workspace;
  });

  it('refuses every decision tool while decisions are off', async () => {
    await assert.rejects(() => tool(me.token, 'list_decisions'), /switched off/);
    await assert.rejects(
      () => tool(me.token, 'create_decision', { question: 'Nope', options: ['a', 'b'] }),
      /switched off/,
    );
  });

  it('works once an admin switches them on', async () => {
    await switchOn(workspace, me);
    const listed = await tool(me.token, 'list_decisions');
    assert.deepEqual(listed.decisions, []);
  });
});

describe('the counters the write path keeps', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-count@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('vote-count-lin@example.com', workspace, owner);
  });

  it('counts the rows rather than adding one, so a replayed vote is still one vote', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    // The same vote again, which is what a second device syncing looks like.
    await castAs(owner, decision.id, options[0].id, workspace);
    await castAs(lin, decision.id, options[0].id, workspace);

    assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, options[0].id)!.tally), 2);
    assert.equal((await reread(decision.id, owner)).voters, 2);
  });

  it('takes the count back down when a vote is withdrawn', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    assert.equal((await reread(decision.id, owner)).voters, 1);

    await ok(`/api/decision-votes/${voteId(decision.id, options[0].id, owner.id)}`, {
      cookie: owner.cookie, method: 'DELETE',
    });
    assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, options[0].id)!.tally), 0);
    assert.equal((await reread(decision.id, owner)).voters, 0);
  });

  it('will not take a client’s word for the count', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await ok(`/api/decisions/${decision.id}`, { cookie: owner.cookie, method: 'PATCH', body: { voters: 500 } });
    await ok(`/api/decision-options/${options[0].id}`, { cookie: owner.cookie, method: 'PATCH', body: { tally: 500 } });
    assert.equal((await reread(decision.id, owner)).voters, 0);
    assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, options[0].id)!.tally), 0);
  });
});

describe('one live vote per person, in a single-choice ballot', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-single@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('withdraws the first when a second is picked', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    await castAs(owner, decision.id, options[1].id, workspace);

    const first = get<any>(`SELECT deleted_at FROM decision_votes WHERE id = ?`, voteId(decision.id, options[0].id, owner.id));
    assert.ok(first?.deleted_at, 'the first vote was left standing beside the second');
    assert.equal((await reread(decision.id, owner)).voters, 1);
    assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, options[0].id)!.tally), 0);
    assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, options[1].id)!.tally), 1);
  });

  it('leaves both standing when several may be held', async () => {
    const { decision, options } = await ballot(workspace, owner, { mode: 'multiple' });
    await castAs(owner, decision.id, options[0].id, workspace);
    await castAs(owner, decision.id, options[1].id, workspace);
    // Two options, one voter: the share is of the voters, so both read 100%.
    assert.equal((await reread(decision.id, owner)).voters, 1);
    for (const option of options) {
      assert.equal(Number(get<any>(`SELECT tally FROM decision_options WHERE id = ?`, option.id)!.tally), 1);
    }
  });
});

describe('a vote is cast by whoever casts it', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-identity@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('vote-identity-lin@example.com', workspace, owner);
  });

  it('refuses a vote written under somebody else’s id', async () => {
    const { decision, options } = await ballot(workspace, owner);
    const refused = await call(`/api/workspaces/${workspace}/decision-votes`, {
      cookie: owner.cookie,
      body: { id: voteId(decision.id, options[0].id, lin.id), decision_id: decision.id, option_id: options[0].id },
    });
    assert.equal(refused.status, 403);
    assert.equal((await reread(decision.id, owner)).voters, 0);
  });

  it('ignores a voter_id the client sent and files the vote under the caller', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await ok(`/api/workspaces/${workspace}/decision-votes`, {
      cookie: owner.cookie,
      body: {
        id: voteId(decision.id, options[0].id, owner.id),
        decision_id: decision.id, option_id: options[0].id, voter_id: lin.id,
      },
    });
    const row = get<any>(`SELECT voter_id FROM decision_votes WHERE id = ?`, voteId(decision.id, options[0].id, owner.id));
    assert.equal(row.voter_id, owner.id);
  });

  it('refuses an option that belongs to another decision', async () => {
    const mine = await ballot(workspace, owner);
    const other = await ballot(workspace, owner);
    const refused = await call(`/api/workspaces/${workspace}/decision-votes`, {
      cookie: owner.cookie,
      body: {
        id: voteId(mine.decision.id, other.options[0].id, owner.id),
        decision_id: mine.decision.id, option_id: other.options[0].id,
      },
    });
    assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
  });
});

describe('a closed vote refuses rather than quietly dropping', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-closed@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('refuses a vote after somebody closes it', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await ok(`/api/decisions/${decision.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'closed' } });
    const refused = await castAs(owner, decision.id, options[0].id, workspace);
    assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
  });

  /* Nothing runs when the deadline passes — the refusal is decided on the way in. */
  it('refuses a vote after the deadline, with nothing having run', async () => {
    const { decision, options } = await ballot(workspace, owner, { closes_at: Date.now() - 1000 });
    assert.equal((await reread(decision.id, owner)).status, 'open');
    const refused = await castAs(owner, decision.id, options[0].id, workspace);
    assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
  });

  /*
   * Withdrawing is refused too, and on purpose: a result somebody can still
   * shrink after it has been quoted is not a result.
   */
  it('refuses a withdrawal once it is closed', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    await ok(`/api/decisions/${decision.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'closed' } });
    const refused = await call(`/api/decision-votes/${voteId(decision.id, options[0].id, owner.id)}`, {
      cookie: owner.cookie, method: 'DELETE',
    });
    assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
    assert.equal((await reread(decision.id, owner)).voters, 1);
  });

  it('takes an unusable deadline as none rather than as 1970', async () => {
    const made = await ok(`/api/workspaces/${workspace}/decisions`, {
      cookie: owner.cookie, body: { question: 'When?', closes_at: 'next Tuesday' },
    });
    assert.equal(made.closes_at, null);
  });
});

describe('a secret ballot is secret at the pull', () => {
  let owner: Person;
  let lin: Person;
  let workspace = '';
  let secret: any;
  let open: any;

  before(async () => {
    const made = await register('vote-secret@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('vote-secret-lin@example.com', workspace, owner);

    secret = await ballot(workspace, owner, { visibility: 'anonymous' });
    open = await ballot(workspace, owner);
    await castAs(owner, secret.decision.id, secret.options[0].id, workspace);
    await castAs(owner, open.decision.id, open.options[0].id, workspace);
  });

  const pull = async (who: Person) => {
    const { body } = await call(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: who.cookie });
    return (body.changes?.decisionVote ?? []) as any[];
  };

  it('sends somebody else’s secret vote to nobody', async () => {
    const theirs = await pull(lin);
    assert.equal(theirs.some((row) => row.decision_id === secret.decision.id), false,
      'a secret ballot’s votes reached another member’s device');
  });

  it('still sends them their own, so their own choice survives a reload', async () => {
    await castAs(lin, secret.decision.id, secret.options[1].id, workspace);
    const theirs = await pull(lin);
    const mine = theirs.filter((row) => row.decision_id === secret.decision.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].voter_id, lin.id);
  });

  it('sends every vote on an open ballot, because that is the point of one', async () => {
    const theirs = await pull(lin);
    assert.equal(theirs.some((row) => row.decision_id === open.decision.id && row.voter_id === owner.id), true,
      'an open ballot hid a vote');
  });

  it('still gives everybody the count, off the counters', async () => {
    const row = await ok(`/api/decisions/${secret.decision.id}`, { cookie: lin.cookie });
    assert.equal(row.voters, 2);
    const option = await ok(`/api/decision-options/${secret.options[0].id}`, { cookie: lin.cookie });
    assert.equal(option.tally, 1);
  });

  it('reports no voters through MCP, which is not the same as nobody voting', async () => {
    const result = await tool(owner.token, 'decision_result', { decision: secret.decision.id });
    assert.equal(result.turnout, 2);
    for (const option of result.options) assert.equal(option.voters, null);

    const shown = await tool(owner.token, 'decision_result', { decision: open.decision.id });
    assert.deepEqual(shown.options[0].voters, ['vote-secret']);
  });
});

describe('a new ballot tells the workspace', () => {
  let owner: Person;
  let lin: Person;
  let sam: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-notify@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
    lin = await join('vote-notify-lin@example.com', workspace, owner);
    sam = await join('vote-notify-sam@example.com', workspace, owner, 'guest');
  });

  const inbox = (who: Person) =>
    all<any>(`SELECT * FROM notifications WHERE user_id = ? AND kind = 'decision' ORDER BY created_at`, who.id);

  it('says nothing while there is nothing to choose between', async () => {
    const decision = await ok(`/api/workspaces/${workspace}/decisions`, {
      cookie: owner.cookie, body: { question: 'Half a question' },
    });
    await ok(`/api/workspaces/${workspace}/decision-options`, {
      cookie: owner.cookie, body: { decision_id: decision.id, label: 'Only one' },
    });
    assert.equal(inbox(lin).length, 0, 'a ballot with one option was announced');
    assert.equal((await reread(decision.id, owner)).announced_at, null);
  });

  /*
   * The second option is what makes the question answerable, and the decision
   * and its options arrive in separate writes — the form and `create_decision`
   * both do it that way. Announcing on the decision's own creation would send
   * everybody to an empty screen.
   */
  it('tells every member who can see it, once the second option lands', async () => {
    const { decision } = await ballot(workspace, owner, { question: 'Which office?' });
    const theirs = inbox(lin);
    assert.equal(theirs.length, 1);
    assert.match(String(theirs[0].title), /Which office\?/);
    assert.equal(theirs[0].decision_id, decision.id);
    assert.equal(theirs[0].actor_id, owner.id);
    assert.ok((await reread(decision.id, owner)).announced_at);
  });

  it('does not tell whoever asked the question', () => {
    assert.equal(inbox(owner).length, 0, 'the author was told about their own ballot');
  });

  it('does not tell a guest, who cannot vote at all', () => {
    // The role is asserted as well as the silence: a `join` that quietly filed
    // this person as a member would make the line below pass for the wrong
    // reason and prove nothing at all.
    const role = get<any>(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspace, sam.id,
    )?.role;
    assert.equal(role, 'guest');
    assert.equal(inbox(sam).length, 0, 'a guest was asked for an answer they cannot give');
  });

  it('does not tell anybody a second time when a third option is added', async () => {
    const before = inbox(lin).length;
    const decision = all<any>(`SELECT id FROM decisions WHERE question = 'Which office?'`)[0];
    await ok(`/api/workspaces/${workspace}/decision-options`, {
      cookie: owner.cookie, body: { decision_id: decision.id, label: 'A third' },
    });
    assert.equal(inbox(lin).length, before, 'a third option announced the ballot again');
  });

  it('says nothing about one that was opened already closed', async () => {
    const before = inbox(lin).length;
    await ballot(workspace, owner, { question: 'Settled already', status: 'closed' });
    assert.equal(inbox(lin).length, before);
  });

  /* ...and says it when somebody opens that one. */
  it('tells them when a closed one is opened', async () => {
    const before = inbox(lin).length;
    const { decision } = await ballot(workspace, owner, { question: 'Not yet', status: 'closed' });
    assert.equal(inbox(lin).length, before);
    await ok(`/api/decisions/${decision.id}`, { cookie: owner.cookie, method: 'PATCH', body: { status: 'open' } });
    assert.equal(inbox(lin).length, before + 1);
  });

  it('says nothing about one whose deadline is already behind it', async () => {
    const before = inbox(lin).length;
    await ballot(workspace, owner, { question: 'Too late to ask', closes_at: Date.now() - 60_000 });
    assert.equal(inbox(lin).length, before, 'people were asked a question they could not have answered');
  });

  it('keeps a ballot in a private project off the inbox of somebody who cannot see it', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: owner.cookie, body: { name: 'Closed doors', key: 'CLD', visibility: 'private' },
    });
    const before = inbox(lin).length;
    const { decision } = await ballot(workspace, owner, { question: 'Behind the door', project_id: project.id });
    assert.equal(inbox(lin).length, before, 'a private project’s question reached somebody who cannot open it');
    // ...and it is still marked as announced, so it is not re-asked on every
    // later write to it.
    assert.ok((await reread(decision.id, owner)).announced_at);
  });
});

describe('the cascades', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-cascade@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  const liveVotes = (decisionId: string) =>
    Number(get<any>(`SELECT COUNT(*) AS n FROM decision_votes WHERE decision_id = ? AND deleted_at IS NULL`, decisionId)!.n);

  it('takes the options and the votes when the question goes', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    await ok(`/api/decisions/${decision.id}`, { cookie: owner.cookie, method: 'DELETE' });

    assert.equal(liveVotes(decision.id), 0);
    assert.ok(get<any>(`SELECT deleted_at FROM decision_options WHERE id = ?`, options[0].id)?.deleted_at);
  });

  it('takes the votes for an option when the option goes, and recounts', async () => {
    const { decision, options } = await ballot(workspace, owner);
    await castAs(owner, decision.id, options[0].id, workspace);
    await ok(`/api/decision-options/${options[0].id}`, { cookie: owner.cookie, method: 'DELETE' });

    assert.equal(liveVotes(decision.id), 0);
    assert.equal((await reread(decision.id, owner)).voters, 0);
  });

  /*
   * The opposite direction, and the same reason a KPI target outlives its
   * milestone: deleting the ticket does not unmake the choice the team took
   * on it.
   */
  it('leaves the decision standing when the task it is about goes', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: owner.cookie, body: { name: 'Voting', key: 'VOT' },
    });
    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: owner.cookie, body: { project_id: project.id, title: 'Pick an approach' },
    });
    const { decision } = await ballot(workspace, owner, { task_id: task.id });
    // A decision about a task is taken in that task's project, whatever was sent.
    assert.equal((await reread(decision.id, owner)).project_id, project.id);

    await ok(`/api/tasks/${task.id}`, { cookie: owner.cookie, method: 'DELETE' });
    const after = await reread(decision.id, owner);
    assert.equal(after.deleted_at, null);
    assert.equal(after.task_id, null);
    assert.equal(after.project_id, project.id);
  });
});

describe('the tools an assistant has', () => {
  let owner: Person;
  let workspace = '';

  before(async () => {
    const made = await register('vote-mcp@example.com');
    owner = made.person;
    workspace = made.workspace;
    await switchOn(workspace, owner);
  });

  it('refuses a question with fewer than two options', async () => {
    await assert.rejects(
      () => tool(owner.token, 'create_decision', { question: 'Well?', options: ['only one'] }),
      /at least two options/,
    );
  });

  it('creates one, votes on it, and reports the leader', async () => {
    const made = await tool(owner.token, 'create_decision', {
      question: 'Which database?', options: ['SQLite', 'Postgres'],
    });
    assert.equal(made.state, 'open');
    assert.equal(made.turnout, 0);

    const voted = await tool(owner.token, 'cast_vote', { decision: made.id, option: 'SQLite' });
    assert.equal(voted.turnout, 1);
    assert.deepEqual(voted.leading, ['SQLite']);

    // The same call again withdraws it, the way clicking a held option does.
    const undone = await tool(owner.token, 'cast_vote', { decision: made.id, option: 'SQLite' });
    assert.equal(undone.turnout, 0);
    assert.deepEqual(undone.leading, []);
  });

  it('closes a vote and then refuses one', async () => {
    const made = await tool(owner.token, 'create_decision', { question: 'Ship?', options: ['Yes', 'No'] });
    const closed = await tool(owner.token, 'close_decision', { decision: made.id });
    assert.equal(closed.state, 'closed');
    await assert.rejects(() => tool(owner.token, 'cast_vote', { decision: made.id, option: 'Yes' }), /closed/);
  });

  /* Reopening a vote the clock closed has to move the clock, or it reopens for
     exactly as long as it takes to read the answer back. */
  it('clears a deadline that has passed when it reopens one', async () => {
    const made = await tool(owner.token, 'create_decision', {
      question: 'Too late?', options: ['Yes', 'No'], closes_at: Date.now() - 5000,
    });
    assert.equal(made.state, 'expired');
    const reopened = await tool(owner.token, 'close_decision', { decision: made.id, open: true });
    assert.equal(reopened.state, 'open');
    assert.equal(reopened.closes_at, null);
  });

  it('lists what is open and says how many', async () => {
    const listed = await tool(owner.token, 'list_decisions', { state: 'open' });
    assert.ok(listed.decisions.every((row: any) => row.state === 'open'));
    assert.ok(listed.open >= 1);
  });
});
