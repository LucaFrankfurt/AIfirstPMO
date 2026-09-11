/**
 * The server says what time it thinks it is, on every answer.
 *
 * It has to, because the browser cannot tell otherwise. Every instant in the
 * database is stamped by this process, and a client that renders them against
 * its own clock shows the difference between the two machines on every relative
 * time at once: five minutes apart, and a task saved a second ago reads "vor 5
 * Minuten" — along with every comment, every page and every notification on the
 * screen. It was reported as a formatting bug in the client and was never one.
 *
 * Which of the two clocks is wrong is not decidable from either end and does
 * not need to be. The rows are stamped here, so this is the clock they are on,
 * and this header is how the other side learns it. See
 * `packages/web/src/kernel/sync/clock.ts` for what is done with it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-clock-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { CLOCK_HEADER } from '@kolibri/shared';

const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'clock@example.com', name: 'Clock', password: 'correct horse battery' }),
  });
  cookie = register.headers.get('set-cookie')!.split(';')[0];
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/** What the header said, and how far off this process's own clock it was. */
async function stampOf(path: string, init: RequestInit = {}): Promise<{ stamp: number; drift: number }> {
  const sentAt = Date.now();
  const response = await fetch(`${base}${path}`, { ...init, headers: { cookie, ...init.headers } });
  await response.text();
  const stamp = Number(response.headers.get(CLOCK_HEADER));
  return { stamp, drift: Math.abs(stamp - (sentAt + Date.now()) / 2) };
}

describe('the clock on an answer', () => {
  it('is on the one a client has not signed in for yet', async () => {
    // `/api/config` is what the sign-in screen asks first, and the screens
    // somebody reaches while signed out show timestamps too.
    const { stamp, drift } = await stampOf('/api/config');
    assert.ok(stamp > 0, 'a config response carries the clock');
    assert.ok(drift < 1000, `and it is this server's own clock, not something rounded (off by ${drift}ms)`);
  });

  it('is on an ordinary read', async () => {
    const { stamp } = await stampOf('/api/session');
    assert.ok(stamp > 0);
  });

  it('is on a refusal, which is the one a signed-out client gets most', async () => {
    const response = await fetch(`${base}/api/tokens`);
    await response.text();
    assert.equal(response.status, 401);
    assert.ok(Number(response.headers.get(CLOCK_HEADER)) > 0, 'a 401 still says what time it is');
  });

  it('advances, rather than being stamped once at boot', async () => {
    const first = await stampOf('/api/config');
    await new Promise((done) => setTimeout(done, 12));
    const second = await stampOf('/api/config');
    assert.ok(second.stamp > first.stamp, 'a header read from a module-level constant would sit still');
  });

  it('may be read by a client on another origin', async () => {
    // The packaged app loads from `capacitor://localhost`, so every response
    // header it is not explicitly handed is invisible to it — and a phone that
    // has just come back from a flight is the likeliest wrong clock there is.
    const response = await fetch(`${base}/api/config`, { headers: { origin: 'capacitor://localhost' } });
    await response.text();
    const exposed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    assert.ok(exposed.split(',').map((h) => h.trim()).includes(CLOCK_HEADER), `expose-headers was "${exposed}"`);
  });
});
