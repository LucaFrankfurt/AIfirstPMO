/**
 * First-run provisioning: a deployment should come up ready to use, and doing
 * it twice should change nothing.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-provision-${process.pid}`;
process.env.KOLIBRI_ADMIN_EMAIL = 'owner@example.com';
process.env.KOLIBRI_ADMIN_PASSWORD = 'a good long password';
process.env.KOLIBRI_ADMIN_NAME = 'Owner';
process.env.KOLIBRI_WORKSPACE_NAME = 'Acme';
// Point the object store at a port nothing listens on, so the retry path is
// the one under test. Env is read when the module loads, hence up here.
process.env.KOLIBRI_STORAGE = 's3';
process.env.KOLIBRI_S3_ENDPOINT = 'http://127.0.0.1:1';
process.env.KOLIBRI_S3_ACCESS_KEY = 'x';
process.env.KOLIBRI_S3_SECRET_KEY = 'y';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';

const db = await import('../src/kernel/platform/db/index.ts');
const { bootstrapAdmin, initStorage } = await import('../src/modules/operations/provision.ts');
const { verifyPassword } = await import('../src/kernel/identity/auth.ts');
// `initStorage` readies whichever backend is configured, and a backend is
// something a build registers — see `wiring.ts`.
(await import('../src/wiring.ts')).installEffects();

const messages: string[] = [];
const log = (level: string, message: string) => {
  messages.push(`${level}: ${message}`);
};

after(() => {
  db.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('provisioning', () => {
  it('creates the owner account, workspace and starter project', () => {
    assert.equal(bootstrapAdmin(log), true);

    const user = db.get<any>(`SELECT * FROM users WHERE email = 'owner@example.com'`);
    assert.ok(user, 'the owner exists');
    assert.equal(user.is_admin, 1);
    assert.ok(verifyPassword('a good long password', user.password_hash), 'the password works');

    const workspace = db.get<any>(`SELECT * FROM workspaces WHERE name = 'Acme'`);
    assert.ok(workspace);
    const membership = db.get<any>(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      workspace.id, user.id,
    );
    assert.equal(membership?.role, 'owner');

    const project = db.get<any>(`SELECT * FROM projects WHERE workspace_id = ?`, workspace.id);
    assert.ok(project, 'a starter project so the workspace is not empty');
    const states = db.all<any>(`SELECT * FROM states WHERE project_id = ?`, project.id);
    assert.equal(states.length, 6, 'with its default workflow');
  });

  it('is idempotent — a restarting container must not duplicate anything', () => {
    assert.equal(bootstrapAdmin(log), false);
    const users = db.all<any>(`SELECT id FROM users`);
    const workspaces = db.all<any>(`SELECT id FROM workspaces`);
    assert.equal(users.length, 1);
    assert.equal(workspaces.length, 1);
  });

  it('waits for a storage backend that is not up yet, then gives up cleanly', async () => {
    const started = Date.now();
    await assert.rejects(() => initStorage(log, 2), /fetch failed|ECONNREFUSED|Cannot reach|unusable/i);

    assert.ok(Date.now() - started >= 1500, 'it backed off between attempts instead of failing instantly');
    assert.ok(messages.some((m) => m.startsWith('warn: Storage not ready')), 'and said so');
    assert.ok(messages.some((m) => m.startsWith('error: Storage backend unusable')), 'before giving up');
  });
});
