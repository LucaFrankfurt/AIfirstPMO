/**
 * The settings an admin can change without redeploying.
 *
 * A relay, a bot token, a model key: all three are things somebody discovers
 * they need *after* the container is running, and all three used to require
 * editing a compose file and restarting. That is the right shape for a
 * platform team and the wrong one for the person who set this up on a Sunday
 * and now wants password resets to arrive.
 *
 * Three decisions hold this together:
 *
 * **The keys are the environment's own names.** `KOLIBRI_SMTP_HOST` is what
 * the field writes, what `docs/deployment.md` documents and what `.env.example`
 * lists. A second vocabulary would mean two names for one thing and a table
 * mapping between them that is wrong the first time somebody adds a setting.
 *
 * **A stored value wins over the environment**, and says so on screen. The
 * other way round is defensible — immutable infrastructure, the container is
 * the truth — but it makes the screen a lie: you would type a relay in, press
 * Save, and nothing would change because a compose file three directories away
 * had an opinion. Clearing the field hands the setting back to the environment.
 *
 * **Only the instance's own admin may write any of it**, which is also why
 * there is no address check here. A relay on `127.0.0.1`, a model gateway at
 * `http://ollama:11434`: both are things the person who owns the server
 * legitimately wants, and both are what the environment already allows. The
 * guard in `lib/outbound.ts` exists because a *webhook* URL can be typed by an
 * admin of any workspace, and on an open instance that is anybody. This is a
 * different question with a different answer.
 *
 * **Secrets are sealed with a key that is not in the database.** The instance
 * secret lives in `.secret` beside the file, so a copied database is not a
 * copied SMTP password. Not a vault — an operator with the volume has both
 * halves — but the difference between "a leaked backup is a leaked backup" and
 * "a leaked backup is a leaked relay" is worth the twenty lines.
 */
import { all, run } from './db/index.ts';
import { env, refreshEnv, useSettingsSource } from './env.ts';
import { isEmailAddress } from '../mail/address.ts';
import { badRequest } from './http.ts';
import { isEncryption } from '../mail/relay.ts';
import { cleanHost, nameOfCharacter } from '../mail/mailbox.ts';
import { seal as sealWith, unseal as unsealWith } from './seal.ts';

export type SettingGroup = 'mail' | 'telegram' | 'ai' | 'backup';
export type SettingKind = 'text' | 'secret' | 'number' | 'bool' | 'choice';

export interface SettingSpec {
  /** The environment variable's name, which is also the column value. */
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  /** For `choice`. The empty string is always allowed and means "unset". */
  choices?: string[];
  /**
   * What this setting is *currently* worth, read off `env` rather than
   * recomputed here — so the screen shows what the next message will actually
   * use, including whatever the environment contributed. Never returned for a
   * secret; only whether it is empty.
   */
  read: () => string;
  /** Other names the environment may supply this under. */
  aliases?: string[];
  /** Reject a value that cannot work, with a sentence saying why. */
  check?: (value: string) => string | null;
  /**
   * For a setting that takes its value from elsewhere while nothing is set for
   * it — the backup bucket borrowing the file storage's endpoint, a region read
   * off that endpoint. The screen shows what is in effect as a placeholder
   * rather than as a value, because a value in the field would read as though
   * somebody had typed it, and saving the form would then make it so.
   */
  inherits?: boolean;
  /**
   * Settings that only work together — a key and the account it belongs to.
   * A restore keeps or replaces them as one (see `keepOwnSettings`); a setting
   * without one is a set of its own.
   */
  set?: string;
}

const port = (value: string): string | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65_535 ? null : 'A port is a number from 1 to 65535';
};

const address = (value: string): string | null =>
  (isEmailAddress(value) ? null : 'That is not an email address this server can send from');

// The relay host, and the same trap the mailbox host fell into: this is pasted
// out of a hosting panel, so what it picks up at the edges is invisible here.
// `checkMailbox` carries the reasoning; this is the same rule for the other
// host on the instance.
const host = (value: string): string | null => {
  const cleaned = cleanHost(value);
  if (!cleaned) return 'A relay needs a host to connect to';
  const stray = cleaned.match(/[^A-Za-z0-9.:_-]/);
  return stray ? `A host name is letters, digits, dots and dashes — this one has ${nameOfCharacter(stray[0])} in it` : null;
};

const httpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'The address has to be http or https';
  } catch {
    return 'That is not a web address';
  }
};

/**
 * Telegram's own shape: a number, a colon, and a long opaque tail.
 *
 * Checked because the failure it prevents is the confusing one — a token with
 * a space or a stray "bot" prefix pasted from a chat window fails with 404 from
 * an API nobody wants to read the documentation of at that moment.
 */
const botToken = (value: string): string | null =>
  (/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value) ? null : 'A bot token looks like 123456789:AA… — paste the whole line BotFather sent');

const hour = (value: string): string | null =>
  (Number(value) >= 0 && Number(value) <= 23 ? null : 'The hour is a number from 0 to 23, in the server’s own time zone');

/**
 * A bucket's name, and the two things people paste instead of one.
 *
 * The rules differ a little between providers — AWS wants lower case, older
 * MinIO buckets need not be — so this refuses only what no provider accepts:
 * a scheme, a slash, a space. `s3://backups` and `https://…/backups` are what
 * a console's copy button tends to produce, and each would otherwise fail at
 * three in the morning as a signature error.
 */
const bucketName = (value: string): string | null => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('/')) {
    return 'Just the bucket’s name — the address goes in the endpoint field';
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,62}$/.test(value) ? null : 'A bucket name is 3 to 63 letters, digits, dots and dashes';
};

const region = (value: string): string | null =>
  (/^[A-Za-z0-9-]+$/.test(value) ? null : 'A region is a name like eu-central-1 or fr-par');

export const SETTINGS: SettingSpec[] = [
  {
    key: 'KOLIBRI_MAIL_TRANSPORT',
    group: 'mail',
    kind: 'choice',
    choices: ['smtp', 'scaleway'],
    read: () => env.mailTransport,
  },
  { key: 'KOLIBRI_SMTP_HOST', group: 'mail', set: 'relay', kind: 'text', read: () => env.mail.host, check: host },
  { key: 'KOLIBRI_SMTP_PORT', group: 'mail', set: 'relay', kind: 'number', read: () => String(env.mail.port), check: port },
  {
    key: 'KOLIBRI_SMTP_ENCRYPTION',
    group: 'mail',
    set: 'relay',
    kind: 'choice',
    choices: ['tls', 'starttls', 'none'],
    read: () => env.mail.encryption,
    check: (value) => (isEncryption(value) ? null : 'Encryption is tls, starttls or none'),
  },
  { key: 'KOLIBRI_SMTP_USER', group: 'mail', set: 'relay', kind: 'text', read: () => env.mail.user ?? '' },
  { key: 'KOLIBRI_SMTP_PASS', group: 'mail', set: 'relay', kind: 'secret', read: () => env.mail.pass ?? '' },
  { key: 'KOLIBRI_SMTP_INSECURE', group: 'mail', set: 'relay', kind: 'bool', read: () => String(env.mail.allowInvalidCerts) },
  { key: 'KOLIBRI_MAIL_FROM', group: 'mail', kind: 'text', aliases: ['EMAIL_FROM_INFO'], read: () => env.mail.from, check: address },
  { key: 'KOLIBRI_MAIL_FROM_NAME', group: 'mail', kind: 'text', aliases: ['EMAIL_FROM_NAME'], read: () => env.mail.fromName },
  { key: 'KOLIBRI_MAIL_REPLY_TO', group: 'mail', kind: 'text', read: () => env.mail.replyTo ?? '', check: address },
  /*
   * Signing in to somebody else's mailbox.
   *
   * Here rather than only in the environment for the reason the relay is: this
   * is a thing somebody discovers they need after the container is running —
   * an inbox at Google that will not take an app password — and editing a
   * compose file and restarting is the wrong shape for that afternoon.
   *
   * The redirect URI the app registration has to carry is
   * `<public URL>/api/mail/oauth/callback`, which the mailbox screen shows so
   * it does not have to be remembered.
   */
  { key: 'KOLIBRI_MAIL_OAUTH_GOOGLE_CLIENT_ID', group: 'mail', set: 'google', kind: 'text', read: () => env.mailOAuth.google.clientId },
  { key: 'KOLIBRI_MAIL_OAUTH_GOOGLE_CLIENT_SECRET', group: 'mail', set: 'google', kind: 'secret', read: () => env.mailOAuth.google.clientSecret },
  { key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_CLIENT_ID', group: 'mail', set: 'microsoft', kind: 'text', read: () => env.mailOAuth.microsoft.clientId },
  { key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_CLIENT_SECRET', group: 'mail', set: 'microsoft', kind: 'secret', read: () => env.mailOAuth.microsoft.clientSecret },
  {
    key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_TENANT',
    group: 'mail',
    set: 'microsoft',
    kind: 'text',
    read: () => env.mailOAuth.microsoft.tenant,
    // A tenant is `common`, `organizations`, `consumers`, or a GUID — never a
    // URL, which is what people paste when they copy it out of the portal's
    // address bar and is a 400 from Microsoft with no explanation.
    check: (value) => (/^[A-Za-z0-9-]+$/.test(value) ? null : 'A tenant is `common` or a directory id, not a URL'),
  },
  {
    key: 'KOLIBRI_SCALEWAY_SECRET_KEY',
    group: 'mail',
    set: 'scaleway',
    kind: 'secret',
    aliases: ['SCW_SECRET_KEY_EMAIL'],
    read: () => env.mail.scaleway.secretKey,
  },
  {
    key: 'KOLIBRI_SCALEWAY_PROJECT_ID',
    group: 'mail',
    set: 'scaleway',
    kind: 'text',
    aliases: ['SCW_PROJECT_ID'],
    read: () => env.mail.scaleway.projectId,
  },
  { key: 'KOLIBRI_TELEGRAM_BOT_TOKEN', group: 'telegram', kind: 'secret', read: () => env.telegram.botToken, check: botToken },
  {
    key: 'KOLIBRI_AI_PROVIDER',
    group: 'ai',
    set: 'ai',
    kind: 'choice',
    choices: ['anthropic', 'gemini', 'openrouter'],
    read: () => env.aiProvider,
  },
  {
    key: 'KOLIBRI_AI_API_KEY',
    group: 'ai',
    set: 'ai',
    kind: 'secret',
    aliases: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'],
    read: () => env.ai.key,
  },
  { key: 'KOLIBRI_AI_MODEL', group: 'ai', set: 'ai', kind: 'text', read: () => env.ai.model },
  { key: 'KOLIBRI_AI_BASE_URL', group: 'ai', set: 'ai', kind: 'text', read: () => env.ai.baseUrl, check: httpUrl },
  /*
   * Where the nightly snapshot goes, when it is not only a directory.
   *
   * Here for the reason the relay is: a bucket or an inbox is something
   * somebody sets up after the container is running, and the directory — the
   * one place that needs a volume mounted — was the only way there was. That
   * one stays in the environment, since a path is worth nothing until a
   * deployment mounts something at it.
   */
  { key: 'KOLIBRI_BACKUP_HOUR', group: 'backup', kind: 'number', read: () => String(env.backup.hour), check: hour },
  { key: 'KOLIBRI_BACKUP_KEEP', group: 'backup', kind: 'number', read: () => String(env.backup.keep) },
  { key: 'KOLIBRI_BACKUP_EMAIL', group: 'backup', kind: 'text', read: () => env.backup.email.to, check: address },
  { key: 'KOLIBRI_BACKUP_S3_BUCKET', group: 'backup', set: 'bucket', kind: 'text', read: () => env.backup.s3.bucket, check: bucketName, inherits: true },
  { key: 'KOLIBRI_BACKUP_S3_ENDPOINT', group: 'backup', set: 'bucket', kind: 'text', read: () => env.backup.s3.endpoint, check: httpUrl, inherits: true },
  { key: 'KOLIBRI_BACKUP_S3_REGION', group: 'backup', set: 'bucket', kind: 'text', read: () => env.backup.s3.region, check: region, inherits: true },
  { key: 'KOLIBRI_BACKUP_S3_ACCESS_KEY', group: 'backup', set: 'bucket', kind: 'text', read: () => env.backup.s3.accessKeyId, inherits: true },
  { key: 'KOLIBRI_BACKUP_S3_SECRET_KEY', group: 'backup', set: 'bucket', kind: 'secret', read: () => env.backup.s3.secretAccessKey, inherits: true },
];

const SPECS = new Map(SETTINGS.map((spec) => [spec.key, spec]));

/* ------------------------------------------------------------------ sealing */

/**
 * The mechanics moved to `seal.ts` when a mailbox password needed the same
 * treatment; what stays here is the name of the purpose these values are sealed
 * under, which is what keeps a settings ciphertext from opening as anything
 * else. The reasoning is in that file.
 */
const seal = (plain: string): string => sealWith('settings', plain);
const unseal = (stored: string): string | null => unsealWith('settings', stored);

/* -------------------------------------------------------------------- store */

let cache: Record<string, string> = {};

/**
 * Secrets that are stored and cannot be opened here — sealed under another
 * instance's secret, which after a restore is the ordinary case.
 *
 * They still read as unset, since there is no value to use; what changed is
 * that they are no longer *indistinguishable* from unset. Measured before
 * this: an instance restored with a different secret showed the backup
 * bucket's key as never typed, counted the bucket as not set up, and quietly
 * took no backups at all from the next restart on — no failure, because
 * nothing was attempted.
 */
let unreadable = new Set<string>();

/** Read every override into memory. Called on start-up and after a write. */
export function loadSettings(): void {
  const next: Record<string, string> = {};
  const lost = new Set<string>();
  for (const row of all<{ key: string; value: string; secret: number }>(
    `SELECT key, value, secret FROM instance_settings`,
  )) {
    if (!SPECS.has(row.key)) continue;
    const value = row.secret ? unseal(row.value) : row.value;
    if (value === null) lost.add(row.key);
    else if (value !== '') next[row.key] = value;
  }
  for (const key of lost) {
    if (!unreadable.has(key)) {
      console.warn(`[settings] ${key} was saved under a different instance secret and cannot be read here — type it in again in Settings → Server`);
    }
  }
  cache = next;
  unreadable = lost;
}

/**
 * Hand the store to `env`, which has been reading nothing until now.
 *
 * Installed rather than imported, because the database module opens itself
 * from `env.dbFile` and an import in the other direction would be a cycle.
 */
export function installSettings(): void {
  loadSettings();
  useSettingsSource(() => cache, () => unreadable);
}

const followers: (() => void)[] = [];

/**
 * @port what has to follow a change of settings while the server runs
 *
 * A worker started at boot on the strength of a setting — the mail worker, the
 * Telegram poller — which a write in Settings → Server, or a restore replacing
 * the whole table, would otherwise leave running on the values it started with.
 */
export function onSettingsChange(follow: () => void): void {
  followers.push(follow);
}

/**
 * Read the store again and make the running server match it.
 *
 * After a write, and after a restore — which replaces the whole table under a
 * process that had read it at boot. Without this the process went on with what
 * it had in memory: "Send a test" answered for the instance that had just been
 * replaced, and the truth arrived with the next restart.
 */
export function applySettings(): void {
  loadSettings();
  refreshEnv();
  for (const follow of followers) follow();
}

/* ------------------------------------------------------------ restoring */

export interface StoredSetting {
  key: string;
  value: string;
  secret: number;
  updated_at: number;
  updated_by: string | null;
}

/** The rows as stored — what a restore is about to replace. */
export const storedSettings = (): StoredSetting[] =>
  all<StoredSetting>(`SELECT key, value, secret, updated_at, updated_by FROM instance_settings`);

/**
 * After a restore has replaced `instance_settings`: put back what of this
 * instance's own the snapshot has nothing usable in place of.
 *
 * Moving house is restoring into a fresh instance, and the first thing done on
 * it is to type in the bucket to restore *from*. The restore then replaced
 * those rows with the old instance's — and in two ways that left a server with
 * no backups and no complaint, both measured against a real MinIO:
 *
 *   - **The snapshot says nothing about it.** The old instance had its bucket
 *     in its environment, so its snapshot has no rows for one, and the rows
 *     just typed were deleted with the rest.
 *   - **The snapshot holds a secret that cannot be opened here**, sealed under
 *     the old instance's secret. The key just typed was replaced by one that
 *     reads as unset.
 *
 * In both, this instance's own is put back — by `set`, not by field: a key is
 * only right next to the account it belongs to, and this instance's secret
 * beside the snapshot's *other* access key would be a pair that never matched.
 * So a secret is kept only where every other field of its set that both sides
 * have says the same; a signature error is a worse thing to find than a field
 * that asks to be typed again. Everything the snapshot does say, and can be
 * read here, wins — that is what restoring means.
 */
export function keepOwnSettings(before: StoredSetting[]): string[] {
  const restored = new Map(storedSettings().map((row) => [row.key, row]));
  const setOf = (key: string): string | undefined => {
    const spec = SPECS.get(key);
    return spec ? spec.set ?? spec.key : undefined;
  };
  const spoken = new Set([...restored.keys()].map(setOf));
  const kept: string[] = [];
  const put = (row: StoredSetting): void => {
    run(
      `INSERT INTO instance_settings (key, value, secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret,
                                        updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      row.key, row.value, row.secret, row.updated_at, row.updated_by,
    );
    kept.push(row.key);
  };
  for (const own of before) {
    const set = setOf(own.key);
    if (!set) continue;
    if (!spoken.has(set)) { put(own); continue; }
    const theirs = restored.get(own.key);
    if (!own.secret || !theirs?.secret || unseal(theirs.value) !== null || unseal(own.value) === null) continue;
    const agrees = before
      .filter((other) => !other.secret && setOf(other.key) === set && restored.has(other.key))
      .every((other) => restored.get(other.key)!.value === other.value);
    if (agrees) put(own);
  }
  return kept;
}

/** Only for tests, which want an instance that has never been configured. */
export function resetSettings(): void {
  run(`DELETE FROM instance_settings`);
  loadSettings();
  refreshEnv();
}

/* ------------------------------------------------------------------ reading */

export interface SettingView {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  choices?: string[];
  /** The value in effect. Always empty for a secret — those never leave here. */
  value: string;
  /** Whether there is a value at all. The only thing said about a secret. */
  set: boolean;
  /** `app` — typed in here. `environment` — the container was started with it. */
  source: 'app' | 'environment' | 'default';
  /** The setting takes its value from elsewhere while it is unset — see `SettingSpec.inherits`. */
  inherits?: boolean;
  /** What that value is, while nothing is set here. Never given for a secret. */
  inherited?: string;
  /** Stored, and sealed under another instance's secret — to be typed again. */
  unreadable?: boolean;
}

const fromEnvironment = (spec: SettingSpec): boolean =>
  [spec.key, ...(spec.aliases ?? [])].some((name) => (process.env[name] ?? '').trim() !== '');

export function describeSettings(): SettingView[] {
  return SETTINGS.map((spec) => {
    const effective = spec.read();
    const source = cache[spec.key] !== undefined ? 'app' : fromEnvironment(spec) ? 'environment' : 'default';
    // Borrowed, not set: said as what applies, never as though it were typed.
    const borrowed = !!spec.inherits && source === 'default';
    return {
      key: spec.key,
      group: spec.group,
      kind: spec.kind,
      choices: spec.choices,
      value: spec.kind === 'secret' || borrowed ? '' : effective,
      set: effective !== '' && effective !== 'off',
      source,
      ...(spec.inherits ? { inherits: true } : {}),
      ...(borrowed && spec.kind !== 'secret' && effective ? { inherited: effective } : {}),
      // Only while nothing else supplies one: a stored value that cannot be
      // read, behind one the environment provides, changes nothing.
      ...(unreadable.has(spec.key) && !fromEnvironment(spec) ? { unreadable: true } : {}),
    };
  });
}

/** What the settings add up to, in the words the rest of the app uses. */
export function instanceStatus() {
  return {
    mail: {
      enabled: env.mailEnabled,
      transport: env.mailTransport,
      mode: env.mailMode,
      from: env.mail.from,
      host: env.mailTransport === 'scaleway' ? new URL(env.mail.scaleway.url).host
        : env.mail.host ? `${env.mail.host}:${env.mail.port}` : '',
    },
    telegram: { enabled: env.telegramEnabled },
    ai: { provider: env.aiProvider, model: env.ai.model },
  };
}

/* ------------------------------------------------------------------ writing */

/**
 * Save a patch: a value per key, or `null` to hand one back to the environment.
 *
 * Everything is checked before anything is written, so a form with one bad
 * field is rejected whole rather than half-applied — half a relay is worse
 * than none, because the half that landed looks configured.
 */
export function writeSettings(patch: Record<string, string | null>, actorId: string): void {
  const writes: { spec: SettingSpec; value: string | null }[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const spec = SPECS.get(key);
    if (!spec) throw badRequest(`${key} is not a setting this server has`);
    const value = raw === null ? null : String(raw).trim();
    if (value === null || value === '') {
      writes.push({ spec, value: null });
      continue;
    }
    if (spec.kind === 'number' && !/^\d+$/.test(value)) throw badRequest(`${key} has to be a number`);
    if (spec.kind === 'bool' && !['true', 'false'].includes(value)) throw badRequest(`${key} is true or false`);
    if (spec.kind === 'choice' && !(spec.choices ?? []).includes(value)) {
      throw badRequest(`${key} is one of ${(spec.choices ?? []).join(', ')}`);
    }
    // A control character in any of these ends up in an SMTP conversation, a
    // URL or an HTTP header, and each of those is line-oriented.
    if (/[\r\n\t\0]/.test(value)) throw badRequest(`${key} contains a character that cannot be sent`);
    const complaint = spec.check?.(value);
    if (complaint) throw badRequest(complaint);
    writes.push({ spec, value });
  }

  const now = Date.now();
  for (const { spec, value } of writes) {
    if (value === null) {
      run(`DELETE FROM instance_settings WHERE key = ?`, spec.key);
      continue;
    }
    run(
      `INSERT INTO instance_settings (key, value, secret, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret,
                                      updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      spec.key, spec.kind === 'secret' ? seal(value) : value, spec.kind === 'secret' ? 1 : 0, now, actorId,
    );
  }

  loadSettings();
  refreshEnv();
}
