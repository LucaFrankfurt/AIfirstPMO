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
import { env, refreshEnv } from './kernel/platform/env.ts';
import { installBackends } from './backends.ts';

/*
 * Backends, not effects.
 *
 * Every command below that reads or writes a file needs to know how to reach
 * one; none of them may fire a write rule, which is why this file is exempt
 * from `installEffects` and says so in `wiring.test.ts`. `backends.ts` is the
 * half that is safe here — and its absence is what made `kolibri doctor` die on
 * every S3 instance while passing on every checkout.
 *
 * Safe at import: the S3 adapter reaches for `env` and the storage registry and
 * nothing that opens a database, so the lazy opening this file depends on is
 * untouched.
 */
installBackends();

const USAGE = `kolibri — maintenance

  doctor [--fix] [--json]   check the database and the files, and say what is wrong
  reindex                   rebuild the full-text search index from the tables
  vacuum                    checkpoint the write-ahead log and give free space back
  backup [dir] [--keep N] [--send]
                            write a consistent snapshot (database + uploads) into dir;
                            with --send or no dir, also send it to the bucket or address
  backups [--json]          list the snapshots, where they go, and when one last arrived
  verify <dir>              check a snapshot without restoring it
  restore <dir> [--force]   put a snapshot back. The server must be stopped
  export <workspace> [file] write a workspace out as a .zip you can import anywhere
  files move <disk|s3>      move stored blobs onto the other backend

Database: ${env.dbFile}
Backups:  ${env.backup.dir ? `${env.backup.dir}, ${String(env.backup.hour).padStart(2, '0')}:00 daily, keeping ${env.backup.keep || 'all'}` : 'no directory'} — "kolibri backups" says where else they go
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
     * behaves like the nightly run: a snapshot named for the day, opened, the
     * retention applied, and sent to every place configured — which, with no
     * directory configured either, is the only place it goes.
     */
    case 'backup': {
      // The value after `--keep` is not a directory, though it looks like one
      // to a parser that only knows what starts with two dashes.
      const keepAt = argv.indexOf('--keep');
      const explicit = rest.find((arg) => keepAt < 0 || argv.indexOf(arg) !== keepAt + 1);
      const keep = flagValue(argv, '--keep');
      const send = flags.has('--send') || flags.has('--offsite');
      if (explicit && !flags.has('--keep') && !send) {
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

      // A bucket or an address typed into Settings → Server lives in the
      // database, and this is the first moment the database is open.
      const { installSettings } = await import('./kernel/platform/settings.ts');
      installSettings();
      // `--offsite` used to mean "and into the uploads' bucket" whatever the
      // environment said, and crontabs still pass it that way.
      if (flags.has('--offsite') && !env.backup.s3.bucket && env.storage.kind === 's3') {
        process.env.KOLIBRI_BACKUP_OFFSITE = 'true';
        refreshEnv();
      }

      const store = await import('./modules/operations/backups.ts');
      const dir = explicit || env.backup.dir;
      if (!store.somewhere() && !dir) {
        err('Where to? kolibri backup /var/backups/kolibri — or set KOLIBRI_BACKUP_DIR, or a bucket or an address in Settings → Server');
        return 1;
      }
      let done: Awaited<ReturnType<typeof store.backUpNow>>;
      try {
        // Opened before anything older is pruned: removing the last good
        // snapshot on the strength of one that turns out not to open is the
        // failure this whole command exists to prevent.
        done = await store.backUpNow({ dir, keep });
      } catch (problem) {
        err(`  ✗ ${problem instanceof Error ? problem.message : problem}`);
        return 1;
      }
      out(done.kept
        ? `Snapshot ${done.snapshot.name} written to ${done.snapshot.path}`
        : `Snapshot ${done.snapshot.name} taken — nothing is kept on this machine`);
      out(`  ${Object.entries(done.manifest.counts).map(([table, n]) => `${n} ${table}`).join(', ')}`);
      out(`  uploads: ${done.manifest.uploads}`);
      out('  ✓ it opens and passes an integrity check');
      if (done.pruned.length) out(`  removed ${done.pruned.length} older snapshot(s): ${done.pruned.join(', ')}`);
      for (const sent of done.sent) out(`  ${sent.ok ? '✓' : '✗'} ${sent.kind}: ${sent.detail}`);
      // A snapshot that went nowhere it was meant to go is not the backup this
      // was asked for, whatever the directory holds.
      return done.sent.every((sent) => sent.ok) ? 0 : 1;
    }

    case 'backups': {
      const { installSettings } = await import('./kernel/platform/settings.ts');
      installSettings();
      const store = await import('./modules/operations/backups.ts');
      const status = store.status();
      const list = store.snapshots();
      if (flags.has('--json')) {
        out(JSON.stringify({ ...status, snapshots: list }, null, 2));
        return 0;
      }
      if (!status.enabled) {
        out('Scheduled backups are off. Set a bucket or an address in Settings → Server, or KOLIBRI_BACKUP_DIR to a directory on another volume.');
        for (const place of status.destinations) if (place.problem) out(`  ! ${place.kind}: ${place.problem}`);
        return 0;
      }
      out(`Daily at ${String(status.hour).padStart(2, '0')}:00${status.dir ? `, into ${status.dir}, keeping ${status.keep || 'all'}` : ''}`);
      const when = (at: number | null) => (at ? new Date(at).toLocaleString() : 'never');
      for (const place of status.destinations) {
        if (place.problem) { out(`  ! ${place.kind}: ${place.problem}`); continue; }
        if (!place.configured) continue;
        const last = place.last;
        out(`  ${place.kind} → ${place.where}`);
        if (!last) out('      nothing sent yet');
        else if (last.ok) out(`      ✓ ${last.snapshot}, ${when(last.attempted_at)} — ${last.detail}`);
        else {
          out(`      ✗ ${last.snapshot}, ${when(last.attempted_at)} — ${last.detail}`);
          out(`      last arrived: ${last.delivered ?? 'never'}${last.delivered_at ? `, ${when(last.delivered_at)}` : ''}`);
        }
      }
      if (!status.dir) return 0;
      if (!list.length) {
        out('  Nothing in the directory yet. "kolibri backup" takes one now.');
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
