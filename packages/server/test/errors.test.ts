/**
 * What a failure looks like from the outside, and why the difference matters.
 *
 * Every error leaves this server through one `catch` in `index.ts`, which knew
 * two kinds: an `HttpError`, which carries its own status, and everything else,
 * which is a 500. A constraint the database refused fell into "everything
 * else" — so a request that left out a `NOT NULL` column came back as
 * `500 internal_error`.
 *
 * That is the most expensive way an error can be misread. A client that retries
 * 5xx and not 4xx — which is every client with a job queue in it — spends its
 * whole attempt budget on a body that will never be accepted, and then either
 * keeps the report or throws it away. Both are wrong for the same reason: the
 * server said "try again" about something that cannot work.
 *
 * The half of this worth guarding is the other one. `no such column` is the
 * server asking the database for something that is not there, which is a bug
 * here and has to stay a 500 — and the easy mistake, once a branch like this
 * exists, is to widen it until it swallows those too.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-errors-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server, router } = await import('../src/index.ts');
const { constraintFailure, get } = await import('../src/kernel/platform/db/index.ts');

let base = '';
let cookie = '';
let workspace = '';
let taskId = '';

const call = async (path: string, options: { body?: unknown; method?: string } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { cookie, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  /*
   * A route that throws something the boundary has never seen, so the 500 half
   * can be tested without hunting for a bug to trigger. Registered from here
   * because `router` is exported for exactly this kind of question — what the
   * server does with an exception is a property of the boundary, not of
   * whichever handler happened to raise one.
   *
   * Four segments, because a three-segment path under `/api` is matched by the
   * generic `/api/:collection/:id` long before anything registered here and
   * comes back as "unknown collection".
   */
  router.get('/api/test-only/boundary/explode', () => {
    throw new TypeError('this is what an actual bug looks like');
  });
  router.get('/api/test-only/boundary/bad-sql', () => get(`SELECT no_such_column FROM tasks`));

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'errors@example.com', name: 'Err', password: 'correct horse battery' }),
  });
  const session = await register.json() as any;
  cookie = register.headers.get('set-cookie')!.split(';')[0];
  workspace = session.workspaces[0].id;

  const project = (await call(`/api/workspaces/${workspace}/projects`, {
    body: { name: 'Errors', key: 'ERR' },
  })).body;
  taskId = (await call(`/api/workspaces/${workspace}/tasks`, {
    body: { project_id: project.id, title: 'something to hang a file off' },
  })).body.id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a row the database refuses', () => {
  it('is a bad request, not a server error', async () => {
    // `attachments.url` is NOT NULL with no default.
    const { status, body } = await call(`/api/workspaces/${workspace}/attachments`, {
      body: { task_id: taskId, name: 'no-url.webp' },
    });
    assert.equal(status, 400, 'a body that cannot ever be accepted was answered "try again"');
    assert.equal(body.error, 'bad_request');
  });

  it('says which column, because guessing is the client’s only alternative', async () => {
    const { body } = await call(`/api/workspaces/${workspace}/attachments`, {
      body: { task_id: taskId, name: 'no-url.webp' },
    });
    assert.match(
      body.message, /attachments\.url/,
      'the message names nothing the client can act on',
    );
  });

  it('is recognised by the constraint class and not by a list of codes', () => {
    // 19 is SQLITE_CONSTRAINT; the extended codes are `19 | (n << 8)`, so a
    // constraint kind nobody has hit yet is classified the same way.
    for (const errcode of [1299, 1555, 275, 19]) {
      assert.ok(
        constraintFailure({ code: 'ERR_SQLITE_ERROR', errcode, message: 'constraint failed: t.c' }),
        `errcode ${errcode} was not read as a constraint failure`,
      );
    }
  });
});

describe('an actual server error', () => {
  it('is still a 500 that says nothing', async () => {
    const { status, body } = await call('/api/test-only/boundary/explode');
    assert.equal(status, 500, 'a genuine bug was reported to the client as its own fault');
    assert.deepEqual(body, { error: 'internal_error', message: 'Something went wrong' });
  });

  it('includes SQL this server got wrong — that is a bug here, not a bad body', async () => {
    const { status, body } = await call('/api/test-only/boundary/bad-sql');
    assert.equal(status, 500, '`no such column` is the server asking for something that is not there');
    assert.equal(body.error, 'internal_error');
  });

  it('is not classified as a constraint failure by the predicate either', () => {
    // The end-to-end case above is the one that matters; this pins the reason,
    // so a later widening of the mask fails here first and says why.
    assert.equal(constraintFailure({ code: 'ERR_SQLITE_ERROR', errcode: 1, message: 'no such column: nope' }), null);
    assert.equal(constraintFailure(new TypeError('not from sqlite at all')), null);
    assert.equal(constraintFailure({ code: 'ERR_SQLITE_ERROR' }), null);
  });
});
