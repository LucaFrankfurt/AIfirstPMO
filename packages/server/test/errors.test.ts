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
// A web build to serve, so that a path for one is actually decoded: with no
// directory there, static serving gives up before it reads the path at all.
process.env.KOLIBRI_WEB_DIR = `/tmp/kolibri-errors-web-${process.pid}`;

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

mkdirSync(process.env.KOLIBRI_WEB_DIR, { recursive: true });
writeFileSync(`${process.env.KOLIBRI_WEB_DIR}/index.html`, '<!doctype html><title>Kolibri</title>');

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
  rmSync(process.env.KOLIBRI_WEB_DIR!, { recursive: true, force: true });
});

/**
 * A request exactly as written, and the status it gets.
 *
 * Over a socket rather than `fetch`, which normalises what it sends — and a
 * Host of `[` is one of the things being sent.
 */
function raw(target: string, headers: Record<string, string> = {}): Promise<number> {
  const lines = [`GET ${target} HTTP/1.1`, `Host: ${headers.host ?? '127.0.0.1'}`, 'Connection: close'];
  for (const [name, value] of Object.entries(headers)) if (name !== 'host') lines.push(`${name}: ${value}`);
  return new Promise((resolve, reject) => {
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1', () => socket.end(`${lines.join('\r\n')}\r\n\r\n`));
    let reply = '';
    socket.on('data', (chunk) => { reply += chunk; });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

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

/**
 * A request that cannot even be read.
 *
 * Everything above is a request the server understood and refused. These are
 * ones it could not read — an escape that decodes to nothing, a Host that is
 * not one — and what mattered was where they were caught. Before the route was
 * matched the listener had no `catch`, so each was an unhandled rejection and
 * the end of the process: measured, one request and the server was gone. So
 * every case here is followed by one that must still be answered, because a
 * 400 from a server that then dies is not the fix.
 */
describe('a request that cannot be read', () => {
  const alive = async () => assert.equal((await fetch(`${base}/api/health`)).status, 200, 'the server is still there');
  const upload = (name: string) => fetch(`${base}/api/workspaces/${workspace}/files`, {
    method: 'POST', headers: { cookie, 'content-type': 'text/plain', 'x-filename': name }, body: `bytes of ${name}`,
  });

  it('is a 400 when a path parameter will not decode', async () => {
    assert.equal(await raw('/api/workspaces/%E0/projects'), 400);
    await alive();
  });

  it('is a 400 when a path for the web build will not decode', async () => {
    assert.equal(await raw('/%E0.js'), 400);
    await alive();
  });

  it('is a 400 when the Host header cannot make a URL', async () => {
    assert.equal(await raw('/api/health', { host: '[' }), 400);
    await alive();
  });

  it('is a 400 when a file name will not decode, uploaded or asked for', async () => {
    assert.equal((await upload('%E0.txt')).status, 400);
    const { hash } = await (await upload('fine.txt')).json() as any;
    // `100%.txt` in a URL is a `%` with nothing after it; the name is spelled `100%25.txt` there.
    assert.equal((await fetch(`${base}/files/${hash}/100%.txt`, { headers: { cookie } })).status, 400);
    await alive();
  });

  it('downloads a stored name as it is, rather than decoding it as if it came from a URL', async () => {
    const { hash } = await (await upload('100%25.txt')).json() as any;
    const served = await fetch(`${base}/files/${hash}`, { headers: { cookie } });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-disposition'), 'inline; filename="100%.txt"');
  });

  it('is not refused over a cookie somebody else set, which will not decode', async () => {
    // Not this request's mistake — and it made every request from that browser a 500.
    assert.equal(await raw('/api/health', { cookie: 'elsewhere=%E0' }), 200);
    const session = await fetch(`${base}/api/session`, { headers: { cookie: `elsewhere=%E0; ${cookie}` } });
    assert.equal(session.status, 200, 'the session beside it still counts');
  });

  it('decodes a path parameter once, so the address cleared is the one named', async () => {
    const { isSuppressed, suppress } = await import('../src/adapters/mail/mail.ts');
    suppress('a%41@example.com', 'manual');
    suppress('aa@example.com', 'manual');
    const cleared = await fetch(`${base}/api/mail/suppressions/${encodeURIComponent('a%41@example.com')}`, {
      method: 'DELETE', headers: { cookie },
    });
    assert.equal(cleared.status, 200);
    assert.equal(isSuppressed('a%41@example.com'), false);
    // Decoded a second time, `a%41` read as `aA` — and cleared this one instead.
    assert.equal(isSuppressed('aa@example.com'), true);
  });
});
