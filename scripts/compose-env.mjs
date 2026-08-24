/**
 * Settings the server reads that a compose file never passes in.
 *
 * This exists because of a bug that shipped three times without anyone
 * noticing. Docker Compose reads `.env` to interpolate `${VAR}` *on the host*;
 * it does not hand that file to the container. So a setting only reaches the
 * server if some compose file names it under `environment:` — and when Telegram,
 * Web Push and task reviews were added, each one documented its variable in
 * `.env.example` and in `docs/`, and none of them touched a compose file.
 *
 * The result was silent in the worst way. `docs/ai.md` says "the operator puts a
 * key in the environment"; you put `ANTHROPIC_API_KEY` in `.env`, the container
 * never saw it, `/api/health` kept reporting `ai: "off"`, and Settings kept
 * saying no model was configured. Nothing failed. There was nothing to see.
 *
 * A variable name is a string in a YAML file, so the compiler cannot help. What
 * can help is the other end of it: every `process.env.X` the server reads should
 * be reachable from a deployment, or be on the list below with a reason.
 *
 *   node scripts/compose-env.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Read by the server but deliberately not settable through compose, because the
 * image already fixes it, or because nothing outside a test has any business
 * setting it. A name here is a decision; a name missing from here is a bug.
 */
const EXEMPT = new Map([
  ['PORT', 'fixed by the Dockerfile; the host side is KOLIBRI_PORT'],
  ['HOST', 'binds 0.0.0.0 inside the container, which is the only useful value'],
  ['NODE_ENV', 'set by the Dockerfile runtime stage'],
  ['KOLIBRI_DATA_DIR', 'the volume mount point, fixed by the image at /data'],
  ['KOLIBRI_WEB_DIR', 'where the build put the client, fixed by the image'],
  ['KOLIBRI_UPLOAD_DIR', 'derived from KOLIBRI_DATA_DIR'],
  ['KOLIBRI_DB', 'derived from KOLIBRI_DATA_DIR'],
  ['KOLIBRI_DEMO', 'read-only mode for the public demo instance, not a deployment setting'],
  ['KOLIBRI_TELEGRAM_API', 'test hook, so a test can point at a local stand-in'],
  ['KOLIBRI_SMTP_SECURE', 'legacy alias kept for old deployments; KOLIBRI_SMTP_ENCRYPTION replaced it'],
  // Vendor names, read so a .env written for that vendor's own tooling works
  // unchanged. Compose reaches them through the KOLIBRI_* name's fallback.
  ['SCW_SECRET_KEY_EMAIL', 'vendor alias, reached via KOLIBRI_SCALEWAY_SECRET_KEY'],
  ['SCW_PROJECT_ID', 'vendor alias, reached via KOLIBRI_SCALEWAY_PROJECT_ID'],
  ['SCW_EMAIL_API_URL', 'vendor alias, reached via KOLIBRI_SCALEWAY_EMAIL_URL'],
  ['EMAIL_FROM_INFO', 'vendor alias, reached via KOLIBRI_MAIL_FROM'],
  ['EMAIL_FROM_NAME', 'vendor alias, reached via KOLIBRI_MAIL_FROM_NAME'],
]);

/** Compose files a person actually deploys, as opposed to overlays. */
const DEPLOYABLE = ['docker-compose.yml', 'docker-compose.lite.yml', 'docker-compose.coolify.yml'];

/** Names a compose file may pass that the server does not read — other services. */
const FOREIGN = /^(MINIO_|MP_|SERVICE_|TZ$|COMPOSE_)/;

/** Every `process.env.NAME` the server reads. */
function readsOf(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  return new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
}

/**
 * Names a compose file passes into a container.
 *
 * Both spellings are in use — `KEY: "value"` in the files that interpolate
 * defaults, `- KEY=value` in the Coolify one — so both are read here, and only
 * inside an `environment:` block, so a `${VAR}` in a `command:` or a `ports:`
 * is not mistaken for one.
 */
function passedBy(file) {
  const names = new Set();
  let indent = -1;
  for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const at = line.search(/\S/);
    if (indent >= 0 && at <= indent) indent = -1;
    if (/^\s*environment:\s*$/.test(line)) { indent = at; continue; }
    if (indent < 0) continue;
    const m = line.match(/^\s*-?\s*([A-Z][A-Z0-9_]*)\s*[:=]/);
    if (m) names.add(m[1]);
  }
  return names;
}

const reads = readsOf('packages/server/src/env.ts');
const settable = [...reads].filter((n) => !EXEMPT.has(n)).sort();

let bad = 0;
for (const file of DEPLOYABLE) {
  const passed = passedBy(file);
  const missing = settable.filter((n) => !passed.has(n));
  const unknown = [...passed].filter((n) => !reads.has(n) && !FOREIGN.test(n)).sort();

  if (missing.length) {
    bad += missing.length;
    console.error(`\n${file} — ${missing.length} setting(s) the server reads but this file never passes:`);
    for (const n of missing) console.error(`  ${n}`);
    console.error('  Add them under `environment:`, or exempt them in scripts/compose-env.mjs with a reason.');
  }
  if (unknown.length) {
    bad += unknown.length;
    console.error(`\n${file} — passes ${unknown.length} name(s) the server never reads (typo, or a setting that was removed):`);
    for (const n of unknown) console.error(`  ${n}`);
  }
  if (!missing.length && !unknown.length) console.log(`${file}: ${passed.size} settings, all of them reachable`);
}

if (bad) {
  console.error(`\n${bad} problem(s). A setting the server reads and no compose file passes is documented and dead.`);
  process.exit(1);
}
console.log(`\n${settable.length} settable, ${EXEMPT.size} exempt by name. Nothing documented is unreachable.`);
