/**
 * Reading the mail configuration — the shapes people actually paste in.
 *
 * `env.ts` decides once at import, so each case re-imports it behind a unique
 * query string to get a fresh module. Ugly, and worth it: this file is the only
 * thing standing between a hosting panel's five fields and an instance that
 * silently sends nothing.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';

const root = `/tmp/kolibri-mailcfg-${process.pid}`;
let n = 0;

/** Load `env` with exactly these variables set and nothing left over. */
async function readEnv(vars: Record<string, string>) {
  for (const key of Object.keys(process.env)) {
    if (/^(KOLIBRI_|SCW_|EMAIL_FROM)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, vars);
  process.env.KOLIBRI_DATA_DIR = `${root}/${n}`;
  const { env } = await import(`../src/kernel/platform/env.ts?mailcfg=${n++}`);
  return env;
}

describe('mail configuration', () => {
  it('reads a relay given as five separate fields', async () => {
    // Host, port, encryption, username, password — the way a hosting panel
    // hands them over, rather than as a URL somebody has to assemble.
    const env = await readEnv({
      KOLIBRI_SMTP_HOST: 'mail.example.net',
      KOLIBRI_SMTP_PORT: '587',
      KOLIBRI_SMTP_USER: 'someone@example.de',
      KOLIBRI_SMTP_PASS: 'a-password',
      KOLIBRI_MAIL_FROM: 'info@example.de',
    });

    assert.equal(env.mailTransport, 'smtp');
    assert.equal(env.mail.host, 'mail.example.net');
    assert.equal(env.mail.port, 587);
    // Nobody typed this: 587 means STARTTLS, and the common case should need
    // no encryption setting at all.
    assert.equal(env.mail.encryption, 'starttls');
    assert.equal(env.mail.user, 'someone@example.de');
    assert.equal(env.mail.from, 'info@example.de');
  });

  it('reads 465 as implicit TLS without being told', async () => {
    const env = await readEnv({ KOLIBRI_SMTP_HOST: 'mail.example.net', KOLIBRI_SMTP_PORT: '465' });
    assert.equal(env.mail.encryption, 'tls');
  });

  it('keeps meaning implicit TLS for the old boolean', async () => {
    const env = await readEnv({ KOLIBRI_SMTP_HOST: 'mail.example.net', KOLIBRI_SMTP_SECURE: 'true' });
    assert.equal(env.mail.encryption, 'tls');
  });

  it('takes the Scaleway names Scaleway itself uses', async () => {
    const env = await readEnv({
      SCW_PROJECT_ID: 'a-project-id',
      SCW_SECRET_KEY_EMAIL: 'a-secret-key',
      EMAIL_FROM_INFO: 'info@example.de',
      EMAIL_FROM_NAME: 'Example',
    });

    assert.equal(env.mailTransport, 'scaleway');
    assert.equal(env.mailMode, 'scaleway');
    assert.equal(env.mailEnabled, true);
    assert.equal(env.mail.scaleway.projectId, 'a-project-id');
    assert.equal(env.mail.from, 'info@example.de');
    assert.equal(env.mail.fromName, 'Example');
    assert.match(env.mail.scaleway.url, /fr-par\/emails$/);
  });

  it('needs both halves of the Scaleway credentials to count as configured', async () => {
    // A key with no project is a half-finished setup, and quietly sending
    // nothing is the worst way to report one.
    const env = await readEnv({ SCW_SECRET_KEY_EMAIL: 'a-secret-key' });
    assert.equal(env.mailTransport, 'off');
    assert.equal(env.mailEnabled, false);
  });

  it('lets the transport be named when both are configured', async () => {
    const both = {
      KOLIBRI_SMTP_HOST: 'mail.example.net',
      SCW_PROJECT_ID: 'a-project-id',
      SCW_SECRET_KEY_EMAIL: 'a-secret-key',
    };
    assert.equal((await readEnv(both)).mailTransport, 'scaleway');
    assert.equal((await readEnv({ ...both, KOLIBRI_MAIL_TRANSPORT: 'smtp' })).mailTransport, 'smtp');
    assert.equal((await readEnv({ ...both, KOLIBRI_MAIL_TRANSPORT: 'scaleway' })).mailTransport, 'scaleway');
  });

  it('treats an empty variable as unset', async () => {
    /*
     * docker-compose writes `FOO=` for every `${FOO:-}` it interpolates, so a
     * compose file that merely *lists* an optional setting hands the server an
     * empty string. Read with `??` that is a value, and it wins over the
     * default — which would have blanked the Scaleway endpoint for everybody
     * using the compose file, without anybody setting anything.
     */
    const env = await readEnv({
      SCW_PROJECT_ID: 'a-project-id',
      SCW_SECRET_KEY_EMAIL: 'a-secret-key',
      KOLIBRI_SCALEWAY_EMAIL_URL: '',
      KOLIBRI_SCALEWAY_SECRET_KEY: '',
      KOLIBRI_SCALEWAY_PROJECT_ID: '',
      KOLIBRI_MAIL_TRANSPORT: '',
      KOLIBRI_SMTP_ENCRYPTION: '',
      KOLIBRI_MAIL_FROM: '',
      EMAIL_FROM_INFO: 'info@example.de',
    });

    assert.match(env.mail.scaleway.url, /^https:\/\/api\.scaleway\.com\//);
    assert.equal(env.mail.scaleway.projectId, 'a-project-id');
    assert.equal(env.mailTransport, 'scaleway');
    assert.equal(env.mail.from, 'info@example.de');
  });

  it('is off with nothing configured, and says so rather than pretending', async () => {
    const env = await readEnv({});
    assert.equal(env.mailTransport, 'off');
    assert.equal(env.mailMode, 'off');
    assert.equal(env.mailEnabled, false);
  });
});

after(() => rmSync(root, { recursive: true, force: true }));
