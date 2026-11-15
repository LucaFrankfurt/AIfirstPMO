/**
 * The push relay, as a process of its own.
 *
 * Not part of a Kolibri server and not started by one: it is run once, by
 * whoever publishes the iOS and Android app, with that publisher's Apple and
 * Google credentials. Every self-hosted server then wakes its users' phones
 * through it — see `adapters/push/app.ts` for what they send and
 * `adapters/relay/relay.ts` for what it does with it. It opens no database and
 * reads none of the server's configuration.
 *
 * It ships in the same image as the server because that is the image the
 * publisher already builds, deploys and trusts; `docker-compose.relay.yml` runs
 * it with a different command.
 *
 *   KOLIBRI_RELAY_PORT                  default 4010
 *   KOLIBRI_RELAY_FCM_SERVICE_ACCOUNT   the Firebase service account JSON, or a path to it
 *   KOLIBRI_RELAY_APNS_KEY              the .p8 key from Apple, or a path to it
 *   KOLIBRI_RELAY_APNS_KEY_ID           the key's ten-character id
 *   KOLIBRI_RELAY_APNS_TEAM_ID          the developer team's id
 *   KOLIBRI_RELAY_APNS_TOPIC            the app's bundle id, default day.kolibri.client
 *   KOLIBRI_RELAY_TRUST_PROXY           1 behind a proxy that sets X-Forwarded-For
 *
 * Either platform may be left out, and the relay serves the other. Neither is a
 * relay that cannot do anything, and it says so rather than start.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { apnsSender } from './adapters/relay/apns.ts';
import { fcmSender, readServiceAccount } from './adapters/relay/fcm.ts';
import { createRelay } from './adapters/relay/relay.ts';

/** A secret given inline, with `\n` for newlines as a one-line variable needs, or as a path to a file. */
function secret(value: string | undefined): string {
  const given = (value ?? '').trim();
  if (!given) return '';
  if (!given.startsWith('{') && !given.startsWith('-----') && existsSync(given)) return readFileSync(given, 'utf8');
  return given.replace(/\\n/g, '\n');
}

const env = process.env;
const account = secret(env.KOLIBRI_RELAY_FCM_SERVICE_ACCOUNT);
const apnsKey = secret(env.KOLIBRI_RELAY_APNS_KEY);

const android = account ? fcmSender(readServiceAccount(account)) : null;
const ios = apnsKey && env.KOLIBRI_RELAY_APNS_KEY_ID && env.KOLIBRI_RELAY_APNS_TEAM_ID
  ? apnsSender({
    key: apnsKey,
    keyId: env.KOLIBRI_RELAY_APNS_KEY_ID,
    teamId: env.KOLIBRI_RELAY_APNS_TEAM_ID,
    topic: env.KOLIBRI_RELAY_APNS_TOPIC || 'day.kolibri.client',
  })
  : null;

if (!android && !ios) {
  console.error('[relay] no credentials: set KOLIBRI_RELAY_FCM_SERVICE_ACCOUNT, or the three KOLIBRI_RELAY_APNS_* settings, or both');
  process.exit(1);
}

const port = Number(env.KOLIBRI_RELAY_PORT ?? 4010);
createServer(createRelay({ android, ios, trustProxy: env.KOLIBRI_RELAY_TRUST_PROXY === '1' }))
  .listen(port, () => console.log(`[relay] on :${port} — android ${android ? 'on' : 'off'}, ios ${ios ? 'on' : 'off'}`));
