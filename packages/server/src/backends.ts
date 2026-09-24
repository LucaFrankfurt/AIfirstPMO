/**
 * The adapters a process needs to reach things outside it, without the write path.
 *
 * `wiring.ts` is "what is hung off the write path" and the CLI is deliberately
 * not on that list: a restore replaces whole tables and must emphatically not
 * fire a rule for every row it puts back. That exemption is right, and it took
 * a storage backend down with it — `installS3Storage` sat in the middle of
 * `installEffects`, so `kolibri doctor` on an S3 instance died with
 *
 *     Error: storage: nothing registered for "s3" — see wiring.ts
 *
 * which is a maintenance command that cannot run on the deployment it is for.
 * The two things were never the same kind of thing. A rule is a reaction to a
 * write; a backend is how this process reads a byte at all, and every binary
 * that touches a file needs one whatever it intends to do with it.
 *
 * So they are separated. `wiring.ts` calls this and then adds the write path;
 * `cli.ts` calls only this. Registering a backend fires nothing, which is why
 * it is safe in front of a restore.
 *
 * The places a backup is sent are the same kind of thing — `kolibri backup`
 * sends to a bucket and an address exactly as the nightly run does — and
 * carry the same obligation: nothing imported from here may open the
 * database, because the CLI imports this before it has read its arguments.
 * The bucket goes first, so the email can say where the files went.
 */
import { installS3Storage } from './adapters/s3/backend.ts';
import { installS3Backups } from './adapters/s3/backup.ts';
import { installMailBackups } from './adapters/mail/backup.ts';

let installed = false;

/** Idempotent, so a process that calls it twice is not a bug. */
export function installBackends(): void {
  if (installed) return;
  installed = true;
  installS3Storage();
  installS3Backups();
  installMailBackups();
}
