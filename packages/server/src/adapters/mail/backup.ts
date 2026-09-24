/**
 * An inbox as a place backups go.
 *
 * The attachment is the database and its manifest as a `.zip` — the same file
 * Settings → Data → Restore from a file takes, so "open the mail, upload the
 * attachment" is the whole of putting one back. The uploads are not in it:
 * they are what makes a snapshot too big to post, and with a bucket set up
 * they are there, where a restore fetches them from.
 *
 * Sent straight through the transport rather than queued: the queue is a
 * table, and a queued attachment would ride along in the next night's backup.
 * Which also means no retry — one attempt a night, like the rest of the sweep,
 * and a failure is on the screen and in the log rather than retried quietly
 * into a mailbox that has since filled up.
 *
 * Two limits decide whether a snapshot fits: `KOLIBRI_BACKUP_EMAIL_MAX_MB`,
 * and Scaleway's API, which takes two megabytes for the whole message. Over
 * either — or refused by the provider, which is how a type it will not attach
 * comes back — what arrives is a notice saying so, and the night counts as
 * failed. A backup that quietly stopped arriving is the failure this whole
 * feature exists to prevent, so the one place somebody reads is told.
 *
 * What it costs to have: the attachment is the whole database, and the inbox
 * becomes exactly as sensitive as the server. Every message says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../kernel/platform/env.ts';
import { zip } from '../../kernel/files/zip.ts';
import {
  registerDestination,
  type Delivery, type Destination, type DestinationState, type Outgoing,
} from '../../modules/operations/destinations.ts';
import type { ServerKey } from '../../kernel/i18n/i18n.ts';
import { isPermanentFailure, type Attachment } from './delivery.ts';
import { deliver } from './transport.ts';

type Words = (key: ServerKey, vars?: Record<string, string | number>) => string;

/**
 * Scaleway's API takes two megabytes for a message, attachment included, and
 * base64 costs a third on top — so an attachment gets three quarters of it,
 * less room for the words around it.
 */
const SCALEWAY_ATTACHMENT = Math.floor((2 * 1024 * 1024 * 3) / 4) - 64 * 1024;

const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The largest attachment this will send over the transport configured now. */
export const attachmentLimit = (): number =>
  Math.min(env.backup.email.maxBytes, env.mailTransport === 'scaleway' ? SCALEWAY_ATTACHMENT : Infinity);

/** What this instance is called in a subject line: its host, or its name. */
function instance(): string {
  try {
    if (env.publicUrl) return new URL(env.publicUrl).host;
  } catch { /* fall through */ }
  return 'Kolibri';
}

/**
 * The words, in the instance's language.
 *
 * Imported when a message is written rather than at the top: the catalogue
 * module reads a person's locale from the database, and `backends.ts` — which
 * installs this — is imported by the CLI before any database may be opened.
 * By the time there is a snapshot to send, one is.
 */
async function words(): Promise<{ t: Words; when: (at: Date) => string }> {
  const { defaultLocale, translate } = await import('../../kernel/i18n/i18n.ts');
  const locale = defaultLocale();
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return {
    t: (key, vars) => translate(locale, key, vars),
    when: (at) => format.format(at),
  };
}

async function post(subject: string, text: string, attachments?: Attachment[]): Promise<void> {
  await deliver({
    from: env.mail.from,
    fromName: env.mail.fromName,
    replyTo: env.mail.replyTo,
    to: env.backup.email.to,
    subject,
    text,
    ...(attachments ? { attachments } : {}),
  });
}

function state(): DestinationState {
  const to = env.backup.email.to;
  if (!to) return { configured: false, where: '' };
  if (!env.mailEnabled) {
    return { configured: false, where: to, problem: 'An address needs a way for mail to leave — set up Email in Settings → Server first' };
  }
  return { configured: true, where: to };
}

/** Where the snapshot is kept besides the inbox, in a sentence — for a notice that it is not attached. */
function keptWhere(t: Words, earlier: Delivery[]): string {
  const bucket = earlier.find((one) => one.kind === 's3' && one.ok);
  if (bucket) return t('backup.keptInBucket', { bucket: bucketName() });
  if (env.backup.dir) return t('backup.keptInDirectory', { dir: env.backup.dir });
  return t('backup.keptNowhere');
}

const bucketName = (): string => [env.backup.s3.bucket, env.backup.prefix].join('/');

/**
 * Where the uploads are, since they are not in the attachment — and, whatever
 * there is to upload, a bucket that refused tonight's copy. The inbox is the
 * one place somebody reads; a bucket failing quietly for a month is the thing
 * it is best placed to prevent.
 */
function filesLine(t: Words, snapshot: Outgoing, earlier: Delivery[]): string | null {
  const bucket = earlier.find((one) => one.kind === 's3');
  if (bucket && !bucket.ok) return t('backup.bucketFailed', { bucket: bucketName(), problem: bucket.detail });
  if (!snapshot.files.length) return null;
  if (bucket) return t('backup.filesInBucket', { bucket: bucketName() });
  if (snapshot.manifest.uploads === 'included' && env.backup.dir) return t('backup.filesInDirectory', { dir: env.backup.dir });
  if (snapshot.manifest.uploads === 'in the object store') return t('backup.filesInStore');
  return t('backup.filesNowhere');
}

async function send(snapshot: Outgoing, earlier: Delivery[]): Promise<{ detail: string; bytes: number }> {
  const { t, when } = await words();
  const taken = new Date(snapshot.manifest.created_at ?? Date.now());
  const archive = await zip([
    { name: 'kolibri.sqlite', body: readFileSync(join(snapshot.dir, 'kolibri.sqlite')) },
    { name: 'manifest.json', body: readFileSync(join(snapshot.dir, 'manifest.json')) },
  ], taken);

  const limit = attachmentLimit();
  if (archive.length > limit) {
    await post(
      t('backup.tooLargeSubject', { name: snapshot.name }),
      [t('backup.tooLarge', { instance: instance(), size: megabytes(archive.length), limit: megabytes(limit) }), '', keptWhere(t, earlier)].join('\n'),
    );
    throw new Error(`${megabytes(archive.length)} is more than the ${megabytes(limit)} this instance emails — a notice went to ${env.backup.email.to} instead`);
  }

  const counts = Object.entries(snapshot.manifest.counts ?? {}).map(([table, n]) => `${n} ${table}`).join(', ');
  const files = filesLine(t, snapshot, earlier);
  try {
    await post(
      t('backup.subject', { name: snapshot.name, instance: instance() }),
      [
        t('backup.body', { instance: instance(), when: when(taken), counts }),
        '',
        t('backup.howToRestore'),
        ...(files ? ['', files] : []),
        '',
        t('backup.sensitive'),
      ].join('\n'),
      [{ filename: `kolibri-${snapshot.name}.zip`, contentType: 'application/zip', content: archive }],
    );
  } catch (error) {
    // Refused for good — too big for the relay, a type the provider will not
    // attach. The same words without the file will go, and say so.
    if (isPermanentFailure(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      await post(
        t('backup.refusedSubject', { name: snapshot.name }),
        [t('backup.refused', { instance: instance(), reason }), '', keptWhere(t, earlier)].join('\n'),
      ).catch(() => undefined);
    }
    throw error;
  }
  return { detail: `${megabytes(archive.length)} attached, to ${env.backup.email.to}`, bytes: archive.length };
}

const destination: Destination = {
  kind: 'email',
  state,
  send,

  /**
   * A message with a small `.zip` attached, because the attachment is what can
   * fail: a relay that takes any message may still refuse the file, and
   * Scaleway attaches a `.zip` only on one of its plans.
   */
  async test() {
    const { t } = await words();
    const note = await zip([{ name: 'kolibri-test.txt', body: Buffer.from(`${t('backup.testFile')}\n`) }]);
    await post(
      t('backup.testSubject', { instance: instance() }),
      t('backup.testBody', { instance: instance() }),
      [{ filename: 'kolibri-test.zip', contentType: 'application/zip', content: note }],
    );
    return env.backup.email.to;
  },

  async failed(problem, at) {
    const { t, when } = await words();
    await post(
      t('backup.failedSubject', { instance: instance() }),
      [t('backup.failed', { instance: instance(), when: when(at), problem }), '', t('backup.failedNext')].join('\n'),
    );
  },
};

/** Hung off the backups by `backends.ts`. */
export const installMailBackups = (): void => registerDestination(destination);
