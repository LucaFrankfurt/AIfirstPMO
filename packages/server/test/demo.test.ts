/** The public demo's shared account must not be the instance administrator. */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-demo-${process.pid}`;
// Env is read when the module loads, hence up here.
process.env.KOLIBRI_DEMO = 'true';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';

const db = await import('../src/kernel/platform/db/index.ts');
const { seedDemoData } = await import('../src/modules/operations/demo.ts');
(await import('../src/wiring.ts')).installEffects();

after(() => {
  db.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('the seeded demo with KOLIBRI_DEMO', () => {
  it('does not make the shared account an instance administrator', () => {
    assert.equal(seedDemoData(), true);
    const ada = db.get<any>(`SELECT is_admin FROM users WHERE email = 'ada@kolibri.dev'`);
    assert.ok(ada, 'the demo account exists');
    assert.equal(ada.is_admin, 0, 'anybody signing in to the public demo could rewire the server');
    assert.equal(db.get<any>(`SELECT count(*) AS n FROM users WHERE is_admin = 1`).n, 0);
  });
});
