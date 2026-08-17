import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../..');

const int = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export const DATA_DIR = resolve(process.env.KOLIBRI_DATA_DIR ?? join(ROOT, 'data'));
mkdirSync(DATA_DIR, { recursive: true });

export const UPLOAD_DIR = resolve(process.env.KOLIBRI_UPLOAD_DIR ?? join(DATA_DIR, 'uploads'));
mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * A stable secret is required to keep sessions alive across restarts. If the
 * operator did not supply one we generate it once and persist it next to the
 * database, so a bare `docker run` still behaves sanely.
 */
function resolveSecret(): string {
  if (process.env.KOLIBRI_SECRET) return process.env.KOLIBRI_SECRET;
  const file = join(DATA_DIR, '.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const env = {
  port: int(process.env.PORT, 4000),
  host: process.env.HOST ?? '0.0.0.0',
  dbFile: process.env.KOLIBRI_DB ?? join(DATA_DIR, 'kolibri.sqlite'),
  uploadDir: UPLOAD_DIR,
  secret: resolveSecret(),
  webDir: resolve(process.env.KOLIBRI_WEB_DIR ?? join(ROOT, 'packages/web/dist')),
  /** Public base URL, used for absolute links in notifications and MCP output. */
  publicUrl: (process.env.KOLIBRI_PUBLIC_URL ?? '').replace(/\/$/, ''),
  /** Turn off to lock the instance down to invited users only. */
  allowSignup: bool(process.env.KOLIBRI_ALLOW_SIGNUP, true),
  maxUploadBytes: int(process.env.KOLIBRI_MAX_UPLOAD_MB, 25) * 1024 * 1024,
  sessionDays: int(process.env.KOLIBRI_SESSION_DAYS, 60),
  logLevel: process.env.KOLIBRI_LOG_LEVEL ?? 'info',
  trustProxy: bool(process.env.KOLIBRI_TRUST_PROXY, true),
  demo: bool(process.env.KOLIBRI_DEMO, false),
};

export type Env = typeof env;
