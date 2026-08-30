/**
 * Everything an instance needs before it is usable, done by the instance
 * itself rather than by a human following a runbook:
 *
 *   1. the object store is reachable and the bucket exists,
 *   2. an owner account exists if one was configured,
 *   3. optional demo data on a fresh database.
 *
 * All of it is idempotent, so a container that restarts ten times converges on
 * the same state instead of accumulating duplicates.
 */
import { get, run } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import { hashPassword } from '../../kernel/identity/auth.ts';
import { createProject, createWorkspace, serverClock } from '../../kernel/write-path/bootstrap.ts';
import { seedDemoData } from './demo.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { writeEntity } from '../../kernel/write-path/repo.ts';
import * as storage from '../../kernel/files/storage.ts';

type Log = (level: string, message: string, extra?: unknown) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MinIO in the same compose stack may still be starting when we are already
 * up, so this waits rather than failing the boot. `depends_on` covers the
 * normal case; this covers the slow disk, the cold start and the restart loop.
 */
export async function initStorage(log: Log, attempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await storage.init();
      log('info', `Uploads: ${storage.describe()}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) {
        log('error', `Storage backend unusable after ${attempts} attempts: ${message}`);
        throw error;
      }
      const wait = Math.min(2 ** attempt, 8) * 1000;
      log('warn', `Storage not ready (${message}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/**
 * Create the first account from the environment, so a deployment is usable
 * without someone opening the browser to claim the instance. Runs only while
 * the database has no users at all.
 */
export function bootstrapAdmin(log: Log): boolean {
  const email = env.admin.email.trim().toLowerCase();
  const password = env.admin.password;
  if (!email || !password) return false;
  if (get(`SELECT id FROM users LIMIT 1`)) return false;

  if (password.length < 8) {
    log('warn', 'KOLIBRI_ADMIN_PASSWORD is shorter than 8 characters — skipping admin bootstrap');
    return false;
  }

  const id = uid();
  const now = Date.now();
  run(
    `INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at, seq, clocks)
     VALUES (?, ?, ?, ?, 1, ?, ?, 0, '{}')`,
    id, email, env.admin.name, hashPassword(password), now, now,
  );
  writeEntity('user', id, { name: env.admin.name, email }, {
    workspaceId: '', actorId: id, hlc: serverClock.now(), system: true, silent: true,
  });

  const workspace = createWorkspace(env.admin.workspace, id);
  createProject(workspace.id, id, { name: 'Getting started', key: 'GET', icon: '👋' });

  log('info', `Created the owner account ${email} and workspace "${workspace.name}"`);
  return true;
}

export function seedDemo(log: Log): boolean {
  if (!env.seedDemo) return false;
  const seeded = seedDemoData();
  if (seeded) log('info', 'Seeded the demo workspace (KOLIBRI_SEED_DEMO=true)');
  return seeded;
}

/** Runs in the background while the server is already answering health checks. */
export async function provision(log: Log): Promise<void> {
  await initStorage(log);
  bootstrapAdmin(log);
  seedDemo(log);

  if (env.mailMode === 'test-inbox') {
    log('warn', `Mail goes to the test inbox at ${env.mail.host}:${env.mail.port} — messages are captured, no recipient ever receives them. Point KOLIBRI_SMTP_URL at a real relay to send for real.`);
  } else if (env.mailMode === 'relay') {
    log('info', `Mail: ${env.mail.host}:${env.mail.port} as ${env.mail.from}`);
  } else {
    log('info', 'Mail: disabled (in-app notifications only)');
  }
}
