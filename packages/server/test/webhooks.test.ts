/**
 * Calling out when something happens.
 *
 * Two things are worth pinning down: a receiver can tell the call really came
 * from this instance, and a receiver that is down or slow cannot take the app
 * with it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-hooks-${process.pid}`;

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { sign } = await import('../src/adapters/webhooks/webhooks.ts');
const { run, get } = await import('../src/kernel/platform/db/index.ts');
const { flushDeliveries, pruneDeliveries } = await import('../src/adapters/webhooks/webhooks.ts');
const { env } = await import('../src/kernel/platform/env.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

/** A receiver we control, so the assertions are about what actually arrived. */
const received: { event: string; delivery: string | undefined; signature: string | undefined; body: any }[] = [];
let behaviour: 'ok' | 'error' | 'gone' | 'hang' | 'redirect' = 'ok';
let receiver: ReturnType<typeof createServer>;
let receiverUrl = '';

async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  receiver = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      received.push({
        event: String(request.headers['x-kolibri-event'] ?? ''),
        delivery: request.headers['x-kolibri-delivery'] as string | undefined,
        signature: request.headers['x-kolibri-signature'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      });
      if (behaviour === 'hang') return; // never answers
      // A proxy that redirects — http to https, or a path that moved. The
      // second request arrives as a GET, which a webhook receiver answers 404
      // to, and that is the trap this reproduces.
      if (behaviour === 'redirect' && (request.url ?? '') !== '/moved') {
        response.writeHead(302, { location: '/moved' }).end();
        return;
      }
      if (behaviour === 'redirect') { response.writeHead(404).end('no webhook here'); return; }
      response.writeHead(behaviour === 'error' ? 500 : behaviour === 'gone' ? 404 : 204).end();
    });
  });
  await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  // The receiver is on loopback, which delivery refuses by default — see
  // `outbound.ts`. Turned on here so these tests can be about the mechanics;
  // the refusal itself is asserted at the end of this file and unit-tested in
  // `injection.test.ts`.
  env.outbound.allowPrivate = true;

  const session = await api('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  projectId = (await api(`/api/workspaces/${workspaceId}/projects`, { name: 'Hooked', key: 'HK' })).id;
});

after(() => {
  server.close();
  receiver.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('calling out', () => {
  it('delivers a signed body a receiver can verify', async () => {
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'Test receiver', url: receiverUrl, events: 'task.created,task.completed', enabled: 1,
    });
    // The signing secret is server-only, so it is set here rather than sent.
    run(`UPDATE webhooks SET secret = 'shh' WHERE id = ?`, hook.id);

    received.length = 0;
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Ring the bell' });
    await settle();

    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'task.created');
    assert.equal(received[0].body.data.identifier, task.identifier);

    // The whole point of the signature: recomputing it from the raw body and
    // the shared secret must give the same answer.
    const expected = sign('shh', JSON.stringify(received[0].body));
    assert.equal(received[0].signature, expected);
    assert.equal(expected, `sha256=${createHmac('sha256', 'shh').update(JSON.stringify(received[0].body)).digest('hex')}`);
  });

  it('holds a batch\'s webhooks until the batch commits', async () => {
    /*
     * `create_tasks_batch` promises every task or none, and a database
     * rollback only delivers half of that promise: webhooks used to fire
     * inline, per write, inside the transaction. A batch that failed on its
     * last entry had already told this receiver about every earlier one —
     * tasks that, after the rollback, never existed — and the retry the
     * transaction makes safe told it about them all again.
     */
    run(`UPDATE webhooks SET enabled = 0`); // only this test's hook counts
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'Batch receiver', url: receiverUrl, events: 'task.created', enabled: 1,
    });
    const token = (await api('/api/tokens', { name: 'batch', workspaceId })).token;
    const batch = async (tasks: unknown[]) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'create_tasks_batch', arguments: { project: 'HK', tasks } },
        }),
      });
      return response.json();
    };

    // The failing batch: two good entries, then one with no title.
    received.length = 0;
    const refused = await batch([{ title: 'Ghost one' }, { title: 'Ghost two' }, { description: 'no title' }]);
    assert.match(JSON.stringify(refused), /tasks\[2\]/);
    await settle();
    assert.equal(received.length, 0, 'a rolled-back batch must announce nothing');

    // The same batch, mended: announced exactly once per task, after commit.
    received.length = 0;
    const accepted = await batch([{ title: 'Real one' }, { title: 'Real two' }]);
    assert.equal((accepted as any).result.structuredContent.created, 2);
    await settle();
    assert.deepEqual(
      received.map((r) => r.body.data.title).sort(),
      ['Real one', 'Real two'],
      'a committed batch announces each task exactly once',
    );

    run(`UPDATE webhooks SET enabled = 0 WHERE id = ?`, hook.id);
    run(`UPDATE webhooks SET enabled = 1 WHERE id != ?`, hook.id);
  });

  it('sends only the events that were asked for', async () => {
    received.length = 0;
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Then change me' });
    await settle();
    received.length = 0;

    await api(`/api/tasks/${task.id}`, { priority: 'urgent' }, 'PATCH');
    await settle();
    assert.equal(received.length, 0, 'task.updated was not subscribed to');

    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    await api(`/api/tasks/${task.id}`, { state_id: done.id }, 'PATCH');
    await settle();
    assert.equal(received.filter((entry) => entry.event === 'task.completed').length, 1);
  });

  it('records a failure without failing the write', async () => {
    behaviour = 'error';
    received.length = 0;
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'The endpoint is broken' });
    await settle();

    assert.ok(task.id, 'the write succeeded regardless');
    const hook = get<any>(`SELECT last_status, last_error FROM webhooks WHERE url = ?`, receiverUrl);
    assert.equal(hook.last_status, 500);
    assert.match(hook.last_error, /500/);
    behaviour = 'ok';
  });

  it('refuses an address on this machine when private targets are not allowed', async () => {
    // The default, and the reason it is the default: without it, anybody who
    // can save a webhook can make this server POST to whatever is listening
    // beside it — the database, the metadata service, a neighbour's admin port.
    env.outbound.allowPrivate = false;
    try {
      received.length = 0;
      await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Nowhere to go' });
      await settle();

      assert.equal(received.length, 0, 'nothing left the process');
      const hook = get<any>(`SELECT last_status, last_error FROM webhooks WHERE url = ?`, receiverUrl);
      assert.equal(hook.last_status, null);
      assert.match(hook.last_error, /Refused: .*not a public address/);
    } finally {
      env.outbound.allowPrivate = true;
    }
  });

  it('does not wait for a receiver that never answers', async () => {
    behaviour = 'hang';
    const started = Date.now();
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Slow receiver' });
    const took = Date.now() - started;

    assert.ok(task.id);
    // The delivery has a five-second timeout; the write must not be behind it.
    assert.ok(took < 2000, `the write took ${took}ms — it should not wait for the hook`);
    behaviour = 'ok';
  });

  /**
   * The events a report is built out of.
   *
   * A workflow somewhere else can read anything over the API; what it cannot do
   * is find out that something happened. So the assertions here are about the
   * two things a receiver cannot reconstruct afterwards — the state a task
   * left, and a row that has since become a tombstone — and about the payload
   * being wide enough that the obvious report needs no second call.
   */
  it('says what a task left and what it entered', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.moved' }, 'PATCH');

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Walk it across' });
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const started = states.find((state: any) => state.group_key === 'started');
    received.length = 0;

    await api(`/api/tasks/${task.id}`, { state_id: started.id }, 'PATCH');
    await settle();

    const moved = received.filter((entry) => entry.event === 'task.moved');
    assert.equal(moved.length, 1);
    // The whole reason this event exists: `task.updated` cannot say this.
    assert.equal(moved[0].body.data.from.group, 'backlog');
    assert.equal(moved[0].body.data.to.name, started.name);
    assert.equal(moved[0].body.data.to.group, 'started');
  });

  it('fires the move alongside the classification, not instead of it', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.updated,task.moved,task.completed' }, 'PATCH');

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Finish and be moved' });
    const states = await api(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
    const done = states.find((state: any) => state.group_key === 'completed');
    received.length = 0;

    await api(`/api/tasks/${task.id}`, { state_id: done.id }, 'PATCH');
    await settle();

    // A hook that was subscribed to `task.completed` before this event existed
    // has to go on hearing it.
    assert.equal(received.filter((entry) => entry.event === 'task.completed').length, 1);
    assert.equal(received.filter((entry) => entry.event === 'task.moved').length, 1);
  });

  it('carries enough about a task to report on it without asking again', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.created' }, 'PATCH');
    const label = await api(`/api/workspaces/${workspaceId}/labels`, { name: 'billing', color: '#888' });
    received.length = 0;

    await api(`/api/workspaces/${workspaceId}/tasks`, {
      project_id: projectId, title: 'Report on me', labels: [label.id], due_date: '2030-01-31', estimate: 3,
    });
    await settle();

    const { data } = received[0].body;
    assert.equal(data.project, 'Hooked');
    assert.equal(data.state_name, 'Backlog');
    // The group is where it always was: a receiver reading `state` goes on working.
    assert.equal(data.state, 'backlog');
    assert.deepEqual(data.labels, ['billing'], 'labels by name, because a name is what a filter is written against');
    assert.equal(data.due_date, '2030-01-31');
    assert.equal(data.estimate, 3);
    assert.equal(data.actor, 'Ada');
    assert.ok(Array.isArray(data.changed) && data.changed.includes('title'));
  });

  it('announces a page, a cycle, a module and logged time', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, {
      events: 'page.created,page.updated,cycle.created,module.created,module.updated,time.logged',
    }, 'PATCH');
    received.length = 0;

    const page = await api(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, title: 'Sprint notes' });
    await api(`/api/pages/${page.id}`, { content: 'What we shipped.' }, 'PATCH');
    await api(`/api/workspaces/${workspaceId}/cycles`, {
      project_id: projectId, name: 'Sprint 1', start_date: '2030-01-01', end_date: '2030-01-14',
    });
    const module_ = await api(`/api/workspaces/${workspaceId}/modules`, { project_id: projectId, name: 'Billing', status: 'planned' });
    await api(`/api/modules/${module_.id}`, { target_date: '2030-02-01' }, 'PATCH');
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Something to bill' });
    await api(`/api/workspaces/${workspaceId}/time-entries`, {
      project_id: projectId, task_id: task.id, minutes: 90, spent_on: '2030-01-02',
    });
    await settle();

    const heard = received.map((entry) => entry.event);
    for (const event of ['page.created', 'page.updated', 'cycle.created', 'module.created', 'module.updated', 'time.logged']) {
      assert.ok(heard.includes(event), `${event} was not delivered — heard ${heard.join(', ')}`);
    }
    // `changed` is what makes an update filterable without a second call.
    const moduleUpdate = received.find((entry) => entry.event === 'module.updated');
    assert.ok(moduleUpdate?.body.data.changed.includes('target_date'));
    assert.equal(received.find((entry) => entry.event === 'time.logged')?.body.data.minutes, 90);
  });

  it('says when a task is deleted, because nothing else can', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.deleted' }, 'PATCH');
    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Here and then not' });
    received.length = 0;

    await api(`/api/tasks/${task.id}`, undefined, 'DELETE');
    await settle();

    const gone = received.filter((entry) => entry.event === 'task.deleted');
    assert.equal(gone.length, 1);
    // The identifier is on it: after this, the row a receiver would read back
    // is a tombstone.
    assert.equal(gone[0].body.data.identifier, task.identifier);
  });

  /**
   * The log, and the retries.
   *
   * A dropped chat message is a shrug. A dropped event is a workflow that
   * quietly did not run, and nobody finds out until the month is over — so the
   * questions here are the two a receiver's owner actually asks: did *that*
   * event arrive, and if it did not, what is being done about it.
   */
  it('writes down every call out and what came back', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.created' }, 'PATCH');
    run(`DELETE FROM webhook_deliveries`);
    received.length = 0;

    await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Leave a trace' });
    await settle();

    const { deliveries } = await api(`/api/webhooks/${hook.id}/deliveries`);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].event, 'task.created');
    assert.equal(deliveries[0].status, 204);
    assert.equal(deliveries[0].attempts, 1);
    assert.ok(deliveries[0].sent_at, 'it arrived');
    assert.equal(deliveries[0].failed_at, null);
    // The receiver was told which delivery this is, so a retry it has already
    // seen can be recognised as one rather than acted on twice.
    assert.equal(received[0].delivery, deliveries[0].id);
  });

  it('tries again after the other end has a bad moment', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.created' }, 'PATCH');
    run(`DELETE FROM webhook_deliveries`);
    behaviour = 'error';
    received.length = 0;

    await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Try me again' });
    await settle();

    let [delivery] = (await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries;
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.sent_at, null);
    assert.equal(delivery.failed_at, null, 'a 500 is a bad moment, not a verdict');
    assert.ok(delivery.send_after > Date.now(), 'and it is waiting rather than hammering');

    // The receiver comes back. The sweep runs an hour later — driven here
    // rather than waited for, the way `sweep(now)` is everywhere else.
    behaviour = 'ok';
    const firstId = received[0].delivery;
    received.length = 0;
    await flushDeliveries(Date.now() + 10 * 60_000);
    await settle();

    [delivery] = (await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries;
    assert.equal(delivery.attempts, 2);
    assert.ok(delivery.sent_at, 'the second attempt arrived');
    assert.equal(received.length, 1);
    // Same delivery, second attempt: the id a receiver de-duplicates on holds.
    assert.equal(received[0].delivery, firstId);
  });

  it('does not retry a request that will never work', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.created' }, 'PATCH');
    run(`DELETE FROM webhook_deliveries`);
    behaviour = 'gone';

    await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Nobody home' });
    await settle();

    const [delivery] = (await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries;
    assert.equal(delivery.attempts, 1);
    assert.ok(delivery.failed_at, 'a 404 is the endpoint, and it will be the same endpoint next time');
    assert.match(delivery.last_error, /404/);
    behaviour = 'ok';
  });

  it('replays the event as it was, not the task as it has become', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    await api(`/api/webhooks/${hook.id}`, { events: 'task.created' }, 'PATCH');
    run(`DELETE FROM webhook_deliveries`);
    received.length = 0;

    const task = await api(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'As it was' });
    await settle();
    const [delivery] = (await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries;

    // The task moves on. The replay must not describe this.
    await api(`/api/tasks/${task.id}`, { title: 'As it is now' }, 'PATCH');
    received.length = 0;

    await api(`/api/webhooks/${hook.id}/deliveries/${delivery.id}/replay`, {});
    await settle();

    assert.equal(received.length, 1);
    assert.equal(received[0].body.data.title, 'As it was');
    assert.equal(received[0].delivery, delivery.id);
  });

  it('keeps the log a log rather than an archive', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    run(`DELETE FROM webhook_deliveries`);
    for (let i = 0; i < 5; i++) {
      run(
        `INSERT INTO webhook_deliveries (id, workspace_id, webhook_id, event, body, send_after, created_at, sent_at)
         VALUES (?, ?, ?, 'task.created', '{}', 0, ?, 1)`,
        `old-${i}`, workspaceId, hook.id, Date.now() - 30 * 86_400_000 - i,
      );
    }
    assert.equal(pruneDeliveries(Date.now()), 5);
    assert.equal((await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries.length, 0);
  });

  it('shows the log to an admin and to nobody else', async () => {
    const [hook] = await api(`/api/workspaces/${workspaceId}/webhooks`);
    const mine = cookie;
    try {
      cookie = '';
      const response = await fetch(`${base}/api/webhooks/${hook.id}/deliveries`);
      assert.ok(response.status === 401 || response.status === 403, `signed out got ${response.status}`);
    } finally {
      cookie = mine;
    }
  });

  /**
   * The three things somebody setting one of these up actually does: change
   * the address, read the secret their receiver has to check, and try it.
   */
  it('sends a test to whatever the URL says now', async () => {
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'Under test', url: 'https://example.invalid/nowhere', events: '', enabled: 1,
    });
    // The URL is an ordinary field, and changing it is what the screen does.
    await api(`/api/webhooks/${hook.id}`, { url: receiverUrl }, 'PATCH');
    received.length = 0;

    const answer = await api(`/api/webhooks/${hook.id}/test`, {});
    assert.equal(answer.ok, true);
    assert.match(answer.detail, /204/);
    assert.equal(received.length, 1);
    // Not an event: nothing happened in the workspace, and the log is about
    // things that did.
    assert.equal(received[0].event, 'ping');
    assert.equal(received[0].delivery, undefined);
    assert.equal((await api(`/api/webhooks/${hook.id}/deliveries`)).deliveries.length, 0);

    await api(`/api/webhooks/${hook.id}`, undefined, 'DELETE');
  });

  it('hands back the far end’s own sentence when a test fails', async () => {
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'Under test', url: receiverUrl, events: '', enabled: 1,
    });
    behaviour = 'gone';
    try {
      const response = await fetch(`${base}/api/webhooks/${hook.id}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
      });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as any).message, /404/);
    } finally {
      behaviour = 'ok';
      await api(`/api/webhooks/${hook.id}`, undefined, 'DELETE');
    }
  });

  it('says when a redirect is what turned the call into a 404', async () => {
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'Behind a proxy', url: receiverUrl, events: '', enabled: 1,
    });
    behaviour = 'redirect';
    try {
      const response = await fetch(`${base}/api/webhooks/${hook.id}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
      });
      const body = (await response.json()) as any;
      assert.equal(response.status, 400);
      // "HTTP 404" alone sends somebody looking at their workflow. The
      // redirect is the thing they can act on.
      assert.match(body.message, /redirect/);
      assert.match(body.message, /\/moved/);
    } finally {
      behaviour = 'ok';
      await api(`/api/webhooks/${hook.id}`, undefined, 'DELETE');
    }
  });

  it('will not test an incoming hook, which is a URL to be called rather than one to call', async () => {
    const hook = await api(`/api/workspaces/${workspaceId}/webhooks`, {
      name: 'GitHub', url: '', events: '', enabled: 1, direction: 'in',
    });
    const response = await fetch(`${base}/api/webhooks/${hook.id}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
    });
    assert.equal(response.status, 400);
    await api(`/api/webhooks/${hook.id}`, undefined, 'DELETE');
  });

  it('keeps the signing secret on the server', async () => {
    const listed = await api(`/api/workspaces/${workspaceId}/webhooks`);
    assert.ok(listed.length >= 1);
    assert.equal(listed[0].secret, undefined, 'a shared secret is not something the client is handed back');
    assert.ok('last_status' in listed[0], 'but the delivery result is worth showing');
  });
});
