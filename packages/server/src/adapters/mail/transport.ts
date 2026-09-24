/**
 * The one place that knows there is more than one way out.
 *
 * Its own file, apart from the queue in `mail.ts`, because the queue is a
 * table and this is not: the nightly backup sends its attachment straight
 * through here, and `backends.ts` — which is how the backup's senders reach
 * the CLI — must be importable before anything opens the database. So nothing
 * here does.
 *
 * Read per message rather than chosen once at startup, so that a test send
 * from the settings screen exercises the configuration the instance actually
 * has rather than the one it booted with.
 */
import { env } from '../../kernel/platform/env.ts';
import { type SmtpConfig } from '../../kernel/mail/relay.ts';
import { sendMail } from './smtp.ts';
import { sendViaScaleway } from './scaleway.ts';
import { DeliveryError, type Deliverable } from './delivery.ts';

const smtp = (): SmtpConfig => ({
  host: env.mail.host,
  port: env.mail.port,
  encryption: env.mail.encryption,
  user: env.mail.user,
  pass: env.mail.pass,
  allowInvalidCerts: env.mail.allowInvalidCerts,
});

export async function deliver(mail: Deliverable): Promise<string> {
  if (env.mailTransport === 'scaleway') {
    return sendViaScaleway({
      url: env.mail.scaleway.url,
      secretKey: env.mail.scaleway.secretKey,
      projectId: env.mail.scaleway.projectId,
    }, mail);
  }
  if (env.mailTransport === 'smtp') return sendMail(smtp(), mail);
  // Reached only if the transport went away between queueing and flushing.
  throw new DeliveryError('No mail transport is configured', false);
}
