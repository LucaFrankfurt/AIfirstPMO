/**
 * The paths the server works out for itself.
 *
 * These are the ones no typechecker and no unit test can be wrong about,
 * because they are strings resolved at runtime against the file's own location.
 * `ROOT` was `resolve(here, '../../..')` and stayed that way when `env.ts` moved
 * two directories deeper in step 10: everything compiled, all 1 340 tests
 * passed, and the server quietly served no web build at all. The browser
 * walkthrough was the first thing that noticed, which is far too late.
 *
 * So the three that are computed rather than configured are pinned here.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-paths-${process.pid}`;

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { ROOT, env } = await import('../src/kernel/platform/env.ts');

after(() => rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true }));

describe('what the server works out about where it is', () => {
  it('finds the workspace root, not some directory above or below it', () => {
    const manifest = join(ROOT, 'package.json');
    assert.ok(existsSync(manifest), `${ROOT} has no package.json — that is not the workspace root`);
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.ok(Array.isArray(pkg.workspaces), `${ROOT}/package.json declares no workspaces`);
    assert.ok(existsSync(join(ROOT, 'packages/server')), `${ROOT} does not contain packages/server`);
  });

  it('points at a web build that is where a build would put one', () => {
    // Not that it exists — a checkout that has not been built is fine — but
    // that the path is the one `npm run build` writes to.
    assert.equal(env.webDir, join(ROOT, 'packages/web/dist'));
  });

  it('reads the schema from beside the module that reads it', () => {
    const dbDir = join(ROOT, 'packages/server/src/kernel/platform/db');
    assert.ok(existsSync(join(dbDir, 'index.ts')), 'db/index.ts is not where this test thinks');
    assert.ok(
      existsSync(join(dbDir, 'schema.sql')),
      'schema.sql is not beside db/index.ts, which reads it with join(here, …) and would throw at startup',
    );
  });
});
