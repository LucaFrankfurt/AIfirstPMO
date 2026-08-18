import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSmtpUrl } from './lib/smtp.ts';

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

/** `disk` keeps uploads on the volume; `s3` puts them in an object store. */
const storageKind = (process.env.KOLIBRI_STORAGE ?? 'disk').toLowerCase() === 's3' ? 's3' : 'disk';

const storage = {
  kind: storageKind as 'disk' | 's3',
  s3: {
    endpoint: process.env.KOLIBRI_S3_ENDPOINT ?? 'http://minio:9000',
    bucket: process.env.KOLIBRI_S3_BUCKET ?? 'kolibri',
    region: process.env.KOLIBRI_S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.KOLIBRI_S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.KOLIBRI_S3_SECRET_KEY ?? '',
    // MinIO and Ceph address buckets by path; AWS and R2 by subdomain.
    forcePathStyle: bool(process.env.KOLIBRI_S3_PATH_STYLE, true),
  },
  /**
   * The endpoint a browser can reach, when it differs from the one the server
   * uses (`http://minio:9000` inside a compose network is not resolvable from
   * a laptop). Pre-signed URLs are signed for this host.
   */
  publicEndpoint: process.env.KOLIBRI_S3_PUBLIC_ENDPOINT ?? '',
  /** Serve downloads via a short-lived pre-signed URL instead of proxying bytes. */
  presign: bool(process.env.KOLIBRI_S3_PRESIGN, true),
  presignSeconds: int(process.env.KOLIBRI_S3_PRESIGN_SECONDS, 300),
};

/**
 * Mail is optional: without an SMTP host Kolibri simply keeps notifications
 * in-app, and every queued message is marked as skipped rather than retried.
 */
const smtpFromUrl = process.env.KOLIBRI_SMTP_URL ? parseSmtpUrl(process.env.KOLIBRI_SMTP_URL) : null;

const mail = {
  host: smtpFromUrl?.host ?? process.env.KOLIBRI_SMTP_HOST ?? '',
  port: smtpFromUrl?.port ?? int(process.env.KOLIBRI_SMTP_PORT, 587),
  secure: smtpFromUrl?.secure ?? bool(process.env.KOLIBRI_SMTP_SECURE, false),
  user: smtpFromUrl?.user ?? process.env.KOLIBRI_SMTP_USER ?? undefined,
  pass: smtpFromUrl?.pass ?? process.env.KOLIBRI_SMTP_PASS ?? undefined,
  allowInvalidCerts: smtpFromUrl?.allowInvalidCerts ?? bool(process.env.KOLIBRI_SMTP_INSECURE, false),
  from: process.env.KOLIBRI_MAIL_FROM ?? 'kolibri@localhost',
  fromName: process.env.KOLIBRI_MAIL_FROM_NAME ?? 'Kolibri',
  replyTo: process.env.KOLIBRI_MAIL_REPLY_TO ?? undefined,
  /** Wait this long before emailing, so a burst of activity becomes one message. */
  batchSeconds: int(process.env.KOLIBRI_MAIL_BATCH_SECONDS, 120),
  pollSeconds: int(process.env.KOLIBRI_MAIL_POLL_SECONDS, 20),
  maxAttempts: int(process.env.KOLIBRI_MAIL_MAX_ATTEMPTS, 6),
};

/**
 * Optional first-run provisioning, so an automated deployment comes up ready
 * to use instead of waiting for a human to claim the instance in a browser.
 */
const admin = {
  email: process.env.KOLIBRI_ADMIN_EMAIL ?? '',
  password: process.env.KOLIBRI_ADMIN_PASSWORD ?? '',
  name: process.env.KOLIBRI_ADMIN_NAME ?? 'Owner',
  workspace: process.env.KOLIBRI_WORKSPACE_NAME ?? 'Kolibri',
};

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
  /** Language for notifications and emails when a recipient has not chosen one. */
  defaultLocale: (process.env.KOLIBRI_DEFAULT_LOCALE ?? 'en').toLowerCase().split('-')[0],
  trustProxy: bool(process.env.KOLIBRI_TRUST_PROXY, true),
  demo: bool(process.env.KOLIBRI_DEMO, false),
  storage,
  mail,
  admin,
  /** Fill an empty database with the demo workspace on first start. */
  seedDemo: bool(process.env.KOLIBRI_SEED_DEMO, false),
  /**
   * `test-inbox` means the relay is a local capture tool (Mailpit and friends):
   * messages are delivered and then go nowhere. Worth saying out loud, because
   * every other signal in the app looks identical to real delivery.
   */
  get mailMode(): 'off' | 'relay' | 'test-inbox' {
    if (!mail.host) return 'off';
    return /^(mailpit|mailhog|maildev|localhost|127\.0\.0\.1|::1)$/i.test(mail.host) ? 'test-inbox' : 'relay';
  },
  /** Mail is configured; without a host nothing is ever sent. */
  get mailEnabled(): boolean {
    return !!mail.host;
  },
};

export type Env = typeof env;
