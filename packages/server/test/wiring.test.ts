/**
 * That the write path has its listeners hung off it, wherever it is started
 * from.
 *
 * `repo.ts` used to call the rules engine by name, which made the two files a
 * knot. It offers `onWrite` now and knows nothing about who takes it up — a
 * better shape, and one with a new way to go wrong that the old one did not
 * have: a binary that writes rows without calling `installEffects` runs no
 * rules at all, silently, and nothing in the diff would say so.
 *
 * So the entry points are a list rather than a convention, and this checks the
 * list against both the files and the scripts that start them. What it cannot
 * check is that a rule then actually fires; `automation.test.ts` does that, end
 * to end, through the running server.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-wiring-${process.pid}`;

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/**
 * The source with its comments taken out.
 *
 * Because the first version of this test looked for the *text*
 * `installEffects()` and passed happily against a line somebody had commented
 * out — which is the one way this would actually get broken, and the only
 * thing the test was there to catch.
 */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const { entryPoints } = await import('../src/wiring.ts');

/**
 * `cli.ts` is exempt and it is worth saying why rather than leaving it off the
 * list: it backs up, restores, reindexes and vacuums. A restore replaces whole
 * tables and must emphatically *not* fire a rule for every row it puts back.
 */
const EXEMPT = new Set(['src/cli.ts']);

after(() => rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true }));

describe('write listeners are wired up', () => {
  it('every named entry point installs them', () => {
    for (const file of entryPoints) {
      assert.match(
        code(file),
        /^\s*installEffects\(\);/m,
        `${file} is named as an entry point but never calls installEffects()`,
      );
    }
  });

  it('every entry point a script starts is named or exempt', () => {
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const started = new Set<string>();
    for (const command of Object.values(manifest.scripts)) {
      for (const match of command.matchAll(/(src\/[\w./-]+\.ts)/g)) started.add(match[1]);
    }
    assert.ok(started.size > 0, 'no entry point found in package.json — has the shape of the scripts changed?');

    const unaccounted = [...started].filter(
      (file) => !EXEMPT.has(file) && !(entryPoints as readonly string[]).includes(file),
    );
    assert.deepEqual(
      unaccounted,
      [],
      'a script starts a file that neither installs the write listeners nor is exempt — add it to `entryPoints` in lib/wiring.ts, or to EXEMPT here with the reason',
    );
  });

  it('installing is idempotent, so two entry points in one process is not a bug', async () => {
    const { installEffects } = await import('../src/wiring.ts');
    const { onWrite } = await import('../src/kernel/write-path/repo.ts');
    let calls = 0;
    const counting = () => { calls += 1; };

    installEffects();
    installEffects();
    // `onWrite` de-duplicates by identity, so the same listener twice is once.
    onWrite(counting);
    onWrite(counting);

    const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
    assert.equal(typeof writeEntity, 'function');
    assert.equal(calls, 0, 'nothing was written, so nothing should have been heard');
  });
});
