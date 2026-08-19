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
import { env } from './env.ts';

const USAGE = `kolibri — maintenance

  doctor [--fix] [--json]   check the database and the files, and say what is wrong
  reindex                   rebuild the full-text search index from the tables
  vacuum                    checkpoint the write-ahead log and give free space back
  backup <dir>              write a consistent snapshot (database + uploads) into dir
  verify <dir>              check a snapshot without restoring it
  restore <dir> [--force]   put a snapshot back. The server must be stopped
  files move <disk|s3>      move stored blobs onto the other backend

Database: ${env.dbFile}
`;

type Exit = 0 | 1;

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
/** Anything that made the command fail. On stderr, where a caller looks for it. */
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

const MARK: Record<string, string> = { ok: '✓', warn: '!', fail: '✗' };

async function doctor(flags: Set<string>): Promise<Exit> {
  const maintenance = await import('./lib/maintenance.ts');
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
      const { reindex } = await import('./lib/maintenance.ts');
      out(`Rebuilt the search index over ${reindex()} row(s).`);
      return 0;
    }

    case 'vacuum': {
      const { vacuum, mb } = await import('./lib/maintenance.ts');
      const { before, after } = vacuum();
      out(`Compacted the database from ${mb(before)} to ${mb(after)}.`);
      return 0;
    }

    case 'backup': {
      const dir = rest[0];
      if (!dir) { err('Where to? kolibri backup /var/backups/kolibri/2026-08-19'); return 1; }
      const { backup } = await import('./lib/maintenance.ts');
      const manifest = backup(dir);
      out(`Snapshot written to ${dir}`);
      out(`  ${Object.entries(manifest.counts).map(([table, n]) => `${n} ${table}`).join(', ')}`);
      out(`  uploads: ${manifest.uploads}`);
      if (manifest.uploads !== 'included') {
        out('  Back the bucket up separately — this snapshot holds the database only.');
      }
      out('');
      out(`  Check it before you trust it:  kolibri verify ${dir}`);
      return 0;
    }

    case 'verify': {
      const dir = rest[0];
      if (!dir) { err('Which snapshot? kolibri verify /var/backups/kolibri/2026-08-19'); return 1; }
      const { verify, readManifest } = await import('./lib/restore.ts');
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
      const { restore } = await import('./lib/restore.ts');
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
      const { moveFiles } = await import('./lib/maintenance.ts');
      const storage = await import('./lib/storage.ts');
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
