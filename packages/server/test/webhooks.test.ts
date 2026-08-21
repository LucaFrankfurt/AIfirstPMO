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
const { sign } = await import('../src/lib/webhooks.ts');
const { run, get } = await import('../src/db/index.ts');
const { env } = await import('../src/env.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

/** A receiver we control, so the assertions are about what actually arrived. */
const received: { event: string; signature: string | undefined; body: any }[] = [];
let behaviour: 'ok' | 'error' | 'hang' = 'ok';
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
        signature: request.headers['x-kolibri-signature'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      });
      if (behaviour === 'hang') return; // never answers
      response.writeHead(behaviour === 'error' ? 500 : 204).end();
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

  it('keeps the signing secret on the server', async () => {
    const listed = await api(`/api/workspaces/${workspaceId}/webhooks`);
    assert.ok(listed.length >= 1);
    assert.equal(listed[0].secret, undefined, 'a shared secret is not something the client is handed back');
    assert.ok('last_status' in listed[0], 'but the delivery result is worth showing');
  });
});
