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

export type SettingGroup = 'mail' | 'telegram' | 'ai';
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

export const SETTINGS: SettingSpec[] = [
  {
    key: 'KOLIBRI_MAIL_TRANSPORT',
    group: 'mail',
    kind: 'choice',
    choices: ['smtp', 'scaleway'],
    read: () => env.mailTransport,
  },
  { key: 'KOLIBRI_SMTP_HOST', group: 'mail', kind: 'text', read: () => env.mail.host, check: host },
  { key: 'KOLIBRI_SMTP_PORT', group: 'mail', kind: 'number', read: () => String(env.mail.port), check: port },
  {
    key: 'KOLIBRI_SMTP_ENCRYPTION',
    group: 'mail',
    kind: 'choice',
    choices: ['tls', 'starttls', 'none'],
    read: () => env.mail.encryption,
    check: (value) => (isEncryption(value) ? null : 'Encryption is tls, starttls or none'),
  },
  { key: 'KOLIBRI_SMTP_USER', group: 'mail', kind: 'text', read: () => env.mail.user ?? '' },
  { key: 'KOLIBRI_SMTP_PASS', group: 'mail', kind: 'secret', read: () => env.mail.pass ?? '' },
  { key: 'KOLIBRI_SMTP_INSECURE', group: 'mail', kind: 'bool', read: () => String(env.mail.allowInvalidCerts) },
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
  { key: 'KOLIBRI_MAIL_OAUTH_GOOGLE_CLIENT_ID', group: 'mail', kind: 'text', read: () => env.mailOAuth.google.clientId },
  { key: 'KOLIBRI_MAIL_OAUTH_GOOGLE_CLIENT_SECRET', group: 'mail', kind: 'secret', read: () => env.mailOAuth.google.clientSecret },
  { key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_CLIENT_ID', group: 'mail', kind: 'text', read: () => env.mailOAuth.microsoft.clientId },
  { key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_CLIENT_SECRET', group: 'mail', kind: 'secret', read: () => env.mailOAuth.microsoft.clientSecret },
  {
    key: 'KOLIBRI_MAIL_OAUTH_MICROSOFT_TENANT',
    group: 'mail',
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
    kind: 'secret',
    aliases: ['SCW_SECRET_KEY_EMAIL'],
    read: () => env.mail.scaleway.secretKey,
  },
  {
    key: 'KOLIBRI_SCALEWAY_PROJECT_ID',
    group: 'mail',
    kind: 'text',
    aliases: ['SCW_PROJECT_ID'],
    read: () => env.mail.scaleway.projectId,
  },
  { key: 'KOLIBRI_TELEGRAM_BOT_TOKEN', group: 'telegram', kind: 'secret', read: () => env.telegram.botToken, check: botToken },
  {
    key: 'KOLIBRI_AI_PROVIDER',
    group: 'ai',
    kind: 'choice',
    choices: ['anthropic', 'gemini', 'openrouter'],
    read: () => env.aiProvider,
  },
  {
    key: 'KOLIBRI_AI_API_KEY',
    group: 'ai',
    kind: 'secret',
    aliases: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'],
    read: () => env.ai.key,
  },
  { key: 'KOLIBRI_AI_MODEL', group: 'ai', kind: 'text', read: () => env.ai.model },
  { key: 'KOLIBRI_AI_BASE_URL', group: 'ai', kind: 'text', read: () => env.ai.baseUrl, check: httpUrl },
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

/** Read every override into memory. Called on start-up and after a write. */
export function loadSettings(): void {
  const next: Record<string, string> = {};
  for (const row of all<{ key: string; value: string; secret: number }>(
    `SELECT key, value, secret FROM instance_settings`,
  )) {
    if (!SPECS.has(row.key)) continue;
    const value = row.secret ? unseal(row.value) : row.value;
    if (value !== null && value !== '') next[row.key] = value;
  }
  cache = next;
}

/**
 * Hand the store to `env`, which has been reading nothing until now.
 *
 * Installed rather than imported, because the database module opens itself
 * from `env.dbFile` and an import in the other direction would be a cycle.
 */
export function installSettings(): void {
  loadSettings();
  useSettingsSource(() => cache);
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
}

const fromEnvironment = (spec: SettingSpec): boolean =>
  [spec.key, ...(spec.aliases ?? [])].some((name) => (process.env[name] ?? '').trim() !== '');

export function describeSettings(): SettingView[] {
  return SETTINGS.map((spec) => {
    const effective = spec.read();
    return {
      key: spec.key,
      group: spec.group,
      kind: spec.kind,
      choices: spec.choices,
      value: spec.kind === 'secret' ? '' : effective,
      set: effective !== '' && effective !== 'off',
      source: cache[spec.key] !== undefined ? 'app' : fromEnvironment(spec) ? 'environment' : 'default',
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
