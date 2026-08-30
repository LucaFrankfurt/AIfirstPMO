/**
 * `kolibri` — the maintenance commands.
 *
 * Everything here is something an operator needs at three in the morning, so
 * each command says what it did in sentences rather than in status codes, and
 * `--json` is there for the monitoring that reads it instead.
 *
 * The database is opened lazily, one command at a time: `restore` must run
 * against a *closed* database, and importing the db module at the top of this
 * file would open one before the argument list had even been read.
 */
import { env } from './kernel/platform/env.ts';

const USAGE = `kolibri — maintenance

  doctor [--fix] [--json]   check the database and the files, and say what is wrong
  reindex                   rebuild the full-text search index from the tables
  vacuum                    checkpoint the write-ahead log and give free space back
  backup [dir] [--keep N] [--offsite]
                            write a consistent snapshot (database + uploads) into dir
  backups [--json]          list the scheduled snapshots and say when the last one ran
  verify <dir>              check a snapshot without restoring it
  restore <dir> [--force]   put a snapshot back. The server must be stopped
  export <workspace> [file] write a workspace out as a .zip you can import anywhere
  files move <disk|s3>      move stored blobs onto the other backend

Database: ${env.dbFile}
Backups:  ${env.backup.dir ? `${env.backup.dir}, ${String(env.backup.hour).padStart(2, '0')}:00 daily, keeping ${env.backup.keep || 'all'}` : 'not scheduled (set KOLIBRI_BACKUP_DIR)'}
`;

type Exit = 0 | 1;

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
/** Anything that made the command fail. On stderr, where a caller looks for it. */
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

const MARK: Record<string, string> = { ok: '✓', warn: '!', fail: '✗' };

/** `--keep 5` or `--keep=5`, both of which somebody will type. */
function flagValue(argv: string[], name: string): number | undefined {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return Number(joined.slice(name.length + 1)) || 0;
  const at = argv.indexOf(name);
  if (at < 0 || at === argv.length - 1) return undefined;
  const value = Number(argv[at + 1]);
  return Number.isFinite(value) ? value : undefined;
}

async function doctor(flags: Set<string>): Promise<Exit> {
  const maintenance = await import('./modules/operations/maintenance.ts');
  let findings = [...maintenance.check(), ...(await maintenance.checkStorage())];

  const stranded = maintenance.strandedFiles();
  if (stranded > 0) {
    findings.push({
      check: 'backend',
      level: 'warn',
      detail: `${stranded} file(s) are still on the backend this instance no longer uses — "kolibri files move ${env.storage.kind}" brings them over`,
    });
  }

  const repairs: string[] = [];
  if (flags.has('--fix')) {
    // Order matters: index first, prune second, and give the space back last,
    // so the vacuum reclaims what the pruning just released.
    const indexed = maintenance.reindex();
    repairs.push(`rebuilt the search index over ${indexed} row(s)`);
    const pruned = maintenance.prune();
    repairs.push(`removed ${pruned.sessions} expired session(s), ${pruned.mutations} old mutation record(s), ${pruned.emails} sent message(s)`);
    // Only under --fix, and never on a sweep: dropping a tombstone a device
    // that has been away still refers to would land its pending edit in the
    // wrong place. A person choosing to run this knows who has been away.
    const folded = maintenance.compactPages();
    if (folded.pages) repairs.push(`folded away deleted text in ${folded.pages} page(s), saving ${maintenance.mb(folded.saved)}`);
    const { before, after } = maintenance.vacuum();
    repairs.push(`compacted the database from ${maintenance.mb(before)} to ${maintenance.mb(after)}`);
    // Re-check, so what is printed is the state after the repairs rather than
    // the state that prompted them.
    findings = [...maintenance.check(), ...(await maintenance.checkStorage())];
  }

  if (flags.has('--json')) {
    out(JSON.stringify({ status: maintenance.worst(findings), findings, repairs, counts: maintenance.counts() }, null, 2));
  } else {
    for (const f of findings) out(`  ${MARK[f.level]} ${f.check.padEnd(13)} ${f.detail}${f.level !== 'ok' && f.fixable && !flags.has('--fix') ? '  (--fix)' : ''}`);
    if (repairs.length) {
      out('');
      for (const line of repairs) out(`  → ${line}`);
    }
    const counts = maintenance.counts();
    out('');
    out(`  ${Object.entries(counts).map(([table, n]) => `${n} ${table}`).join(', ')}`);
  }
  // A warning is not a failure: it is a thing to do on a Tuesday. Only a
  // damaged database or missing bytes should turn a health check red.
  return maintenance.worst(findings) === 'fail' ? 1 : 0;
}

async function main(): Promise<Exit> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [command, ...rest] = argv.filter((a) => !a.startsWith('--'));

  switch (command) {
    case 'doctor':
      return doctor(flags);

    case 'reindex': {
      const { reindex } = await import('./modules/operations/maintenance.ts');
      out(`Rebuilt the search index over ${reindex()} row(s).`);
      return 0;
    }

    case 'vacuum': {
      const { vacuum, mb } = await import('./modules/operations/maintenance.ts');
      const { before, after } = vacuum();
      out(`Compacted the database from ${mb(before)} to ${mb(after)}.`);
      return 0;
    }

    /**
     * `backup <dir>` still writes exactly where it is told, because that is
     * what every crontab out there already passes it. With no directory it
     * uses the configured one and behaves like the nightly run: a snapshot
     * named for the day, the retention applied, and the offsite copy made.
     */
    case 'backup': {
      const explicit = rest[0];
      const keep = flagValue(argv, '--keep');
      if (explicit && !flags.has('--keep') && !flags.has('--offsite')) {
        const { backup } = await import('./modules/operations/maintenance.ts');
        const manifest = backup(explicit);
        out(`Snapshot written to ${explicit}`);
        out(`  ${Object.entries(manifest.counts).map(([table, n]) => `${n} ${table}`).join(', ')}`);
        out(`  uploads: ${manifest.uploads}`);
        if (manifest.uploads !== 'included') {
          out('  Back the bucket up separately — this snapshot holds the database only.');
        }
        out('');
        out(`  Check it before you trust it:  kolibri verify ${explicit}`);
        return 0;
      }

      const dir = explicit || env.backup.dir;
      if (!dir) { err('Where to? kolibri backup /var/backups/kolibri, or set KOLIBRI_BACKUP_DIR'); return 1; }
      const store = await import('./modules/operations/backups.ts');
      const done = store.take(dir, { force: true });
      if (!done) { err('Could not take a snapshot'); return 1; }
      out(`Snapshot ${done.snapshot.name} written to ${done.snapshot.path}`);
      out(`  ${Object.entries(done.manifest.counts).map(([table, n]) => `${n} ${table}`).join(', ')}`);
      out(`  uploads: ${done.manifest.uploads}`);

      const { verify } = await import('./modules/operations/restore.ts');
      try {
        verify(done.snapshot.path);
        out('  ✓ it opens and passes an integrity check');
      } catch (problem) {
        err(`  ✗ ${problem instanceof Error ? problem.message : problem}`);
        return 1;
      }

      // Only after it has been checked. Removing the last good snapshot on the
      // strength of one that turns out not to open is the failure this whole
      // command exists to prevent.
      const removed = store.prune(dir, keep ?? env.backup.keep);
      if (removed.length) out(`  removed ${removed.length} older snapshot(s): ${removed.join(', ')}`);
      if (flags.has('--offsite') || env.backup.offsite) {
        const sent = await store.offsite(done.snapshot.name, dir);
        out(`  copied ${sent.uploaded} object(s) offsite (${sent.skipped} already there)`);
      }
      return 0;
    }

    case 'backups': {
      const store = await import('./modules/operations/backups.ts');
      const status = store.status();
      const list = store.snapshots();
      if (flags.has('--json')) {
        out(JSON.stringify({ ...status, snapshots: list }, null, 2));
        return 0;
      }
      if (!status.enabled) {
        out('Scheduled backups are off. Set KOLIBRI_BACKUP_DIR to a directory on another volume.');
        return 0;
      }
      out(`${status.dir} — daily at ${String(status.hour).padStart(2, '0')}:00, keeping ${status.keep || 'all'}${status.offsite ? ', copied to the object store' : ''}`);
      if (!list.length) {
        out('  Nothing yet. "kolibri backup" takes one now.');
        return 0;
      }
      for (const snapshot of list) {
        const { mb } = await import('./modules/operations/maintenance.ts');
        out(`  ${snapshot.name}  ${mb(snapshot.size).padStart(10)}  ${Object.entries(snapshot.counts).map(([t, n]) => `${n} ${t}`).join(', ')}`);
      }
      out('');
      out(`  ${list.length} snapshot(s), ${status.size} in total.`);
      // A count is not a check. Saying so here is the difference between
      // knowing there are seven files and knowing seven of them would restore.
      out(`  None of these have been opened. Check the newest:  kolibri verify ${list[0].path}`);
      return 0;
    }

    /**
     * A workspace as a file, from a shell. The same document the app hands
     * out, which is the point: an operator's export and somebody's download
     * cannot drift apart if they are the same function.
     */
    case 'export': {
      const which = rest[0];
      if (!which) { err('Which workspace? kolibri export acme [acme.zip]'); return 1; }
      const { get } = await import('./kernel/platform/db/index.ts');
      const workspace = get<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM workspaces WHERE (id = ?1 OR slug = ?1) AND deleted_at IS NULL`, which,
      );
      if (!workspace) { err(`No workspace called ${which}. "kolibri doctor" lists what is here.`); return 1; }

      const { exportWorkspace } = await import('./adapters/transfer/workspace-transfer.ts');
      const { sendArchive } = await import('./modules/planning/archive.ts');
      const storage = await import('./kernel/files/storage.ts');
      await storage.init();

      const doc = exportWorkspace(workspace.id);
      const path = rest[1] || `${workspace.slug}-${new Date().toISOString().slice(0, 10)}.kolibri.zip`;
      const { createWriteStream } = await import('node:fs');
      const sink = createWriteStream(path);
      // `sendArchive` writes headers when handed an HTTP response and skips
      // them for anything else, so a file and a download are the same code.
      const report = await sendArchive(sink, path, doc, workspace.name);
      out(`Wrote ${path}`);
      out(`  ${doc.projects.length} project(s), ${doc.projects.reduce((sum, p) => sum + p.tasks.length, 0)} task(s), ${doc.files.length} file(s)`);
      if (report.missing.length) {
        err(`  ${report.missing.length} file(s) are named in the workspace but missing from the store: ${report.missing.slice(0, 5).join(', ')}`);
      }
      return 0;
    }

    case 'verify': {
      const dir = rest[0];
      if (!dir) { err('Which snapshot? kolibri verify /var/backups/kolibri/2026-08-19'); return 1; }
      const { verify, readManifest } = await import('./modules/operations/restore.ts');
      try {
        const { rows } = verify(dir);
        const manifest = readManifest(dir);
        out(`${dir} is a readable Kolibri snapshot${manifest?.created_at ? `, taken ${manifest.created_at}` : ''}.`);
        out(`  ${Object.entries(rows).map(([table, n]) => `${n} ${table}`).join(', ')}`);
        return 0;
      } catch (problem) {
        err(`${problem instanceof Error ? problem.message : problem}`);
        return 1;
      }
    }

    case 'restore': {
      const dir = rest[0];
      if (!dir) { err('Which snapshot? kolibri restore /var/backups/kolibri/2026-08-19'); return 1; }
      const { restore } = await import('./modules/operations/restore.ts');
      try {
        const report = restore(dir, { force: flags.has('--force') });
        out(`Restored ${report.from} into ${report.database}.`);
        out(`  uploads: ${report.uploads}`);
        if (report.displaced) out(`  the database that was there is kept at ${report.displaced}`);
        out('  Start the server; it will bring the schema forward if the snapshot is older.');
        return 0;
      } catch (problem) {
        err(`${problem instanceof Error ? problem.message : problem}`);
        return 1;
      }
    }

    case 'files': {
      if (rest[0] !== 'move' || (rest[1] !== 'disk' && rest[1] !== 's3')) {
        err('kolibri files move <disk|s3>');
        return 1;
      }
      const to = rest[1];
      const { moveFiles } = await import('./modules/operations/maintenance.ts');
      const storage = await import('./kernel/files/storage.ts');
      if (to === 's3' && env.storage.kind !== 's3') {
        err('KOLIBRI_STORAGE is not s3, so there is nothing configured to move to.');
        return 1;
      }
      await storage.init();
      const result = await moveFiles(to, (done, total) => {
        if (done % 25 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
      });
      out('');
      out(`Moved ${result.moved} file(s) to ${to}; ${result.already} were already there.`);
      if (result.failed.length) {
        err(`  ${result.failed.length} could not be read and were left where they are: ${result.failed.slice(0, 5).join(', ')}`);
        return 1;
      }
      out('  The copies on the old backend are left in place — delete them once you are happy.');
      return 0;
    }

    default:
      out(USAGE);
      return command ? 1 : 0;
  }
}

process.exitCode = await main();
