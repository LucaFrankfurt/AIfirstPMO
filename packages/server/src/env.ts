import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEncryption, parseSmtpUrl, type SmtpEncryption } from './lib/smtp.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../..');

const int = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);
/**
 * A variable that is present but empty is not set.
 *
 * `??` alone reads `FOO=""` as a value, and docker-compose writes exactly that
 * for every `${FOO:-}` it interpolates — so a compose file listing an optional
 * setting is enough to blank whatever default the code had.
 */
const text = (...values: (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.trim() !== '');
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
 * Mail is optional: with neither an SMTP host nor a Scaleway key Kolibri simply
 * keeps notifications in-app, and every queued message is marked as skipped
 * rather than retried.
 */
const smtpFromUrl = process.env.KOLIBRI_SMTP_URL ? parseSmtpUrl(process.env.KOLIBRI_SMTP_URL) : null;

/**
 * How the SMTP connection is protected — see `SmtpEncryption`.
 *
 * Unset, it follows the port, because the two ports have meant these two things
 * for twenty years: 465 is TLS from the first byte, everything else is a
 * plaintext connection upgraded with STARTTLS. Turning encryption off is never
 * inferred; `none` has to be typed.
 *
 * `KOLIBRI_SMTP_SECURE=true` still means implicit TLS, so an existing
 * deployment keeps working. What changed underneath is the other half of that
 * boolean: `false` used to mean "STARTTLS if the relay happens to offer it",
 * and now means STARTTLS or nothing.
 */
const smtpEncryption = (): SmtpEncryption => {
  const asked = text(process.env.KOLIBRI_SMTP_ENCRYPTION)?.trim().toLowerCase();
  if (isEncryption(asked)) return asked;
  if (smtpFromUrl) return smtpFromUrl.encryption;
  if (bool(process.env.KOLIBRI_SMTP_SECURE, false)) return 'tls';
  return int(process.env.KOLIBRI_SMTP_PORT, 587) === 465 ? 'tls' : 'starttls';
};

/**
 * Scaleway Transactional Email, as an alternative to an SMTP relay.
 *
 * The `SCW_*` names are read as well as Kolibri's own. They are the names
 * Scaleway's own tooling uses and the ones people already have in a `.env`
 * next to this one, and refusing to look at them would buy consistency at the
 * cost of a silent "mail is off" for somebody whose configuration is sitting
 * right there. Kolibri's own names win where both are set.
 */
const scaleway = {
  secretKey: text(process.env.KOLIBRI_SCALEWAY_SECRET_KEY, process.env.SCW_SECRET_KEY_EMAIL) ?? '',
  projectId: text(process.env.KOLIBRI_SCALEWAY_PROJECT_ID, process.env.SCW_PROJECT_ID) ?? '',
  // `fr-par` is the only region the service runs in, so the whole URL is the
  // setting rather than a region name with one legal value.
  url: text(process.env.KOLIBRI_SCALEWAY_EMAIL_URL, process.env.SCW_EMAIL_API_URL)
    ?? 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails',
};

const mail = {
  host: smtpFromUrl?.host ?? text(process.env.KOLIBRI_SMTP_HOST) ?? '',
  port: smtpFromUrl?.port ?? int(process.env.KOLIBRI_SMTP_PORT, 587),
  encryption: smtpEncryption(),
  user: smtpFromUrl?.user ?? text(process.env.KOLIBRI_SMTP_USER),
  pass: smtpFromUrl?.pass ?? text(process.env.KOLIBRI_SMTP_PASS),
  allowInvalidCerts: smtpFromUrl?.allowInvalidCerts ?? bool(process.env.KOLIBRI_SMTP_INSECURE, false),
  // `EMAIL_FROM_INFO` / `EMAIL_FROM_NAME` for the same reason as the `SCW_*`
  // names above: they travel with a Scaleway setup.
  from: text(process.env.KOLIBRI_MAIL_FROM, process.env.EMAIL_FROM_INFO) ?? 'kolibri@localhost',
  fromName: text(process.env.KOLIBRI_MAIL_FROM_NAME, process.env.EMAIL_FROM_NAME) ?? 'Kolibri',
  replyTo: text(process.env.KOLIBRI_MAIL_REPLY_TO),
  scaleway,
  /** Wait this long before emailing, so a burst of activity becomes one message. */
  batchSeconds: int(process.env.KOLIBRI_MAIL_BATCH_SECONDS, 120),
  pollSeconds: int(process.env.KOLIBRI_MAIL_POLL_SECONDS, 20),
  maxAttempts: int(process.env.KOLIBRI_MAIL_MAX_ATTEMPTS, 6),
};

/**
 * Optional first-run provisioning, so an automated deployment comes up ready
 * to use instead of waiting for a human to claim the instance in a browser.
 */
/**
 * The model that reviews a task, and which company's it is.
 *
 * Three providers, one key each, and the vendor's own variable name read
 * alongside Kolibri's for the same reason the `SCW_*` names are read above: a
 * `.env` that already has `ANTHROPIC_API_KEY` in it should not need a second
 * copy of the same secret under a different name.
 *
 * Every default lives here rather than in the adapters, so `docs/ai.md` and
 * this block are the only two places that have to agree.
 */
const ai = {
  key: text(
    process.env.KOLIBRI_AI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.OPENROUTER_API_KEY,
  ) ?? '',
  model: text(process.env.KOLIBRI_AI_MODEL) ?? '',
  /** For a gateway, a proxy, or a model running on the same docker network. */
  baseUrl: text(process.env.KOLIBRI_AI_BASE_URL)?.replace(/\/$/, '') ?? '',
  timeoutMs: int(process.env.KOLIBRI_AI_TIMEOUT_MS, 20_000),
  /**
   * How many reviews one person may ask for. A review is the first thing in
   * this app that costs money per click, so the bucket is small and the window
   * is long — nobody reviewing tasks by hand notices it, and a loop does.
   */
  burst: int(process.env.KOLIBRI_AI_BURST, 10),
  everySeconds: int(process.env.KOLIBRI_AI_EVERY_SECONDS, 20),
};

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
  /**
   * The largest import this will read.
   *
   * Bigger than an upload because it is a whole workspace rather than one
   * file, and finite because an archive is read into memory to be read at all
   * — a ZIP can only be opened from its end. An export too big for this is a
   * per-project export, which is the honest answer rather than a server that
   * falls over at four in the morning.
   */
  maxImportBytes: int(process.env.KOLIBRI_MAX_IMPORT_MB, 200) * 1024 * 1024,
  sessionDays: int(process.env.KOLIBRI_SESSION_DAYS, 60),
  logLevel: process.env.KOLIBRI_LOG_LEVEL ?? 'info',
  /** Language for notifications and emails when a recipient has not chosen one. */
  defaultLocale: (process.env.KOLIBRI_DEFAULT_LOCALE ?? 'en').toLowerCase().split('-')[0],
  trustProxy: bool(process.env.KOLIBRI_TRUST_PROXY, true),
  /**
   * Single sign-on. Off unless an issuer and a client are configured; the
   * password form stays available either way unless `oidcOnly` is set.
   */
  oidc: {
    issuer: (process.env.KOLIBRI_OIDC_ISSUER ?? '').replace(/\/$/, ''),
    clientId: process.env.KOLIBRI_OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.KOLIBRI_OIDC_CLIENT_SECRET ?? '',
    scope: process.env.KOLIBRI_OIDC_SCOPE ?? 'openid email profile',
    /** What to call the button. */
    label: process.env.KOLIBRI_OIDC_LABEL ?? 'Single sign-on',
    /** Create an account for anybody the provider vouches for. */
    autoCreate: bool(process.env.KOLIBRI_OIDC_AUTO_CREATE, true),
    /** Hide the password form entirely. */
    only: bool(process.env.KOLIBRI_OIDC_ONLY, false),
    /**
     * Where the groups live in the token. A dotted path, because Keycloak puts
     * them at `resource_access.kolibri.roles` and Entra at `groups`, and
     * neither is going to change for us.
     */
    groupsClaim: process.env.KOLIBRI_OIDC_GROUPS_CLAIM ?? 'groups',
    /** `group=role, group=role` — see `oidc.ts`. Empty leaves roles alone. */
    roleMap: process.env.KOLIBRI_OIDC_ROLE_MAP ?? '',
    /**
     * The role somebody in none of the mapped groups gets. `none` refuses the
     * sign-in, which is how "only these groups may in" is written.
     */
    defaultRole: (process.env.KOLIBRI_OIDC_DEFAULT_ROLE ?? 'member').trim().toLowerCase(),
    /**
     * The workspace an account made through the provider joins, by slug or id.
     * Without it, a lone workspace on the instance is joined and anything else
     * gets its own — see `joinWorkspace` in `auth.ts`.
     */
    workspace: process.env.KOLIBRI_OIDC_WORKSPACE ?? '',
  },
  /**
   * Web Push. On by default: the key pair is generated into the data directory
   * on first use, and a browser that never asks for permission never hears
   * about it. Set the pair explicitly to keep subscriptions across a restore.
   */
  push: {
    enabled: bool(process.env.KOLIBRI_PUSH, true),
    publicKey: process.env.KOLIBRI_VAPID_PUBLIC ?? '',
    privateKey: (process.env.KOLIBRI_VAPID_PRIVATE ?? '').replace(/\\n/g, '\n'),
    /** Who a push service should complain to. */
    subject: process.env.KOLIBRI_VAPID_SUBJECT ?? '',
  },
  /**
   * Telegram. A third way to be told, next to the bell, email and Web Push.
   *
   * Off without a bot token, and the token is the only thing that has to be
   * configured: the link between an account and a chat is made by the person
   * themselves, from their own Telegram. Updates are collected by long-polling
   * `getUpdates` rather than by a webhook, because a self-hosted instance
   * behind NAT has no public URL to give Telegram — and the ones that do have
   * one still should not need to expose an endpoint for this.
   */
  telegram: {
    botToken: process.env.KOLIBRI_TELEGRAM_BOT_TOKEN ?? '',
    /** Overridable so a test can point at a local stand-in. */
    apiBase: (process.env.KOLIBRI_TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/$/, ''),
    /** How long one long-poll waits. Telegram allows up to 50. */
    pollSeconds: Math.min(50, Math.max(1, int(process.env.KOLIBRI_TELEGRAM_POLL_SECONDS, 25))),
    /** Give up on one notification after this many failed sends. */
    maxAttempts: int(process.env.KOLIBRI_TELEGRAM_MAX_ATTEMPTS, 5),
  },
  /**
   * Where this server is willing to connect when a *feature* names an address:
   * an outgoing webhook's URL, a Web Push endpoint.
   *
   * By default, nowhere private. A webhook URL is typed in by a person with an
   * admin role in some workspace, and on an instance where anybody can sign up
   * and make a workspace that is anybody — so the address is checked, the name
   * is resolved before the connection rather than during it, and loopback, the
   * RFC 1918 ranges and the cloud metadata service are all refused.
   *
   * Set `KOLIBRI_ALLOW_PRIVATE_WEBHOOKS=1` on an instance where posting to
   * `http://n8n:5678` on its own docker network is the point. That is a real
   * thing to want; it is just not a safe default for the instance that has not
   * thought about it.
   */
  outbound: {
    allowPrivate: bool(process.env.KOLIBRI_ALLOW_PRIVATE_WEBHOOKS, false),
  },
  /** A shared secret a mail provider posts bounce reports with. Empty disables it. */
  bounceToken: process.env.KOLIBRI_BOUNCE_TOKEN ?? '',
  /**
   * Days a deleted thing stays in the trash before it goes for good. `0` — the
   * default — keeps it until somebody empties the trash themselves. A default
   * that quietly destroyed things after a month would be a policy this project
   * has no business choosing for somebody else's data.
   */
  trashDays: Math.max(0, Number(process.env.KOLIBRI_TRASH_DAYS ?? 0) || 0),
  /**
   * Backups that take themselves.
   *
   * Off until a directory is named, because where somebody else's backups
   * belong is not this program's decision — and a default of "next to the
   * database" would put the copy on the disk whose failure it is meant to
   * survive. `KOLIBRI_BACKUP_DIR=/backups` with that path mounted from
   * somewhere else is the arrangement this is for.
   *
   * `KEEP` is a count and not a number of days: a count is what a disk has
   * room for, and an instance that was off for a fortnight should still have
   * seven snapshots rather than none.
   */
  backup: {
    dir: (process.env.KOLIBRI_BACKUP_DIR ?? '').trim(),
    /** Local hour to take it, 0–23. Three in the morning by default. */
    hour: Math.min(23, Math.max(0, int(process.env.KOLIBRI_BACKUP_HOUR, 3))),
    /** How many to keep. `0` keeps every one, and fills the disk in a year. */
    keep: Math.max(0, int(process.env.KOLIBRI_BACKUP_KEEP, 7)),
    /** Also copy each snapshot into the object store, when there is one. */
    offsite: bool(process.env.KOLIBRI_BACKUP_OFFSITE, false),
    /** Where in the bucket. Content-addressed blobs share `<prefix>/blobs`. */
    prefix: (process.env.KOLIBRI_BACKUP_PREFIX ?? 'backups').replace(/^\/+|\/+$/g, ''),
  },
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
  get mailMode(): 'off' | 'relay' | 'scaleway' | 'test-inbox' {
    if (this.mailTransport === 'scaleway') return 'scaleway';
    if (!mail.host) return 'off';
    return /^(mailpit|mailhog|maildev|localhost|127\.0\.0\.1|::1)$/i.test(mail.host) ? 'test-inbox' : 'relay';
  },
  /**
   * Which way mail leaves, when there is more than one way it could.
   *
   * `KOLIBRI_MAIL_TRANSPORT` settles it outright. Otherwise a Scaleway key
   * wins, on the grounds that nobody sets an API key for a provider they did
   * not mean to send through — and a deployment that has both configured
   * usually has the SMTP block left over from the arrangement it replaced.
   */
  get mailTransport(): 'off' | 'smtp' | 'scaleway' {
    const asked = text(process.env.KOLIBRI_MAIL_TRANSPORT)?.trim().toLowerCase();
    if (asked === 'smtp') return mail.host ? 'smtp' : 'off';
    if (asked === 'scaleway') return scaleway.secretKey && scaleway.projectId ? 'scaleway' : 'off';
    if (scaleway.secretKey && scaleway.projectId) return 'scaleway';
    return mail.host ? 'smtp' : 'off';
  },
  /** Mail is configured; with no transport nothing is ever sent. */
  get mailEnabled(): boolean {
    return this.mailTransport !== 'off';
  },
  /** A bot token is the whole of the Telegram configuration. */
  get telegramEnabled(): boolean {
    return !!this.telegram.botToken;
  },
  ai,
  /**
   * Whose model answers, when a key is present at all.
   *
   * `KOLIBRI_AI_PROVIDER` settles it outright, and downgrades to `off` when the
   * provider it names has no key — the same refusal to silently fall through to
   * a different provider that `mailTransport` makes, and for a stronger reason
   * here: the fallback would send the workspace's words to a company nobody
   * chose.
   *
   * Otherwise the provider is read off whichever vendor variable is set, with
   * Anthropic first where several are. A key under `KOLIBRI_AI_API_KEY` alone
   * says nothing about whose it is, so that case needs the provider named.
   */
  get aiProvider(): 'off' | 'anthropic' | 'gemini' | 'openrouter' {
    const asked = text(process.env.KOLIBRI_AI_PROVIDER)?.trim().toLowerCase();
    if (asked === 'anthropic' || asked === 'gemini' || asked === 'openrouter') {
      return ai.key ? asked : 'off';
    }
    if (asked) return 'off';
    if (text(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
    if (text(process.env.GEMINI_API_KEY)) return 'gemini';
    if (text(process.env.OPENROUTER_API_KEY)) return 'openrouter';
    return 'off';
  },
  /** A model is reachable. The workspace switch decides whether it is asked. */
  get aiEnabled(): boolean {
    return this.aiProvider !== 'off';
  },
};

export type Env = typeof env;
