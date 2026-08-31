/**
 * Sealing a secret with a key that is not in the database.
 *
 * This was inside `settings.ts`, which is where it was needed first and where
 * the reasoning behind it is still written down: an SMTP password stored in the
 * clear means a copied backup is a copied relay, and the twenty lines that stop
 * that are worth having. It moved down here the moment a second thing needed a
 * sealed value — a mailbox's IMAP password — because the alternative was a
 * second copy of AES-256-GCM in the module that happened to need it next.
 *
 * The **purpose** is the part that is new. Both callers derive their key from
 * the same instance secret, and without a purpose they would derive the *same*
 * key: a ciphertext lifted out of `instance_settings` would then open as a
 * mailbox credential and vice versa. That is not the attack anybody is most
 * worried about — somebody with the volume has both tables — but domain
 * separation is one string, and a key that means two things is a key that will
 * eventually be used for a third.
 *
 * Not a vault. An operator with the data directory has the database and the
 * `.secret` file beside it, and that is by design for something self-hosted.
 * The difference this buys is between "a leaked backup is a leaked backup" and
 * "a leaked backup is a leaked inbox".
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.ts';

/**
 * Derived rather than used directly, so the instance secret that signs a
 * session is not also literally an encryption key.
 */
const keyFor = (purpose: string): Buffer => createHash('sha256').update(`kolibri.${purpose}:${env.secret}`).digest();

export function seal(purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

/**
 * Null rather than a throw when it cannot be opened.
 *
 * The one way that happens in practice is an instance secret that changed —
 * `KOLIBRI_SECRET` set after the fact, or a restore without the `.secret` file.
 * Every session is invalid in that case too, and the honest thing is to read as
 * unset: a setting says "not set" and can be typed in again, and a mailbox says
 * it cannot sign in rather than pretending it has no password.
 */
export function unseal(purpose: string, stored: string): string | null {
  const [version, iv, tag, body] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
