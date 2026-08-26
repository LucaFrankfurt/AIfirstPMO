/**
 * Settings → Data: taking the whole thing with you, and the snapshots an
 * operator restores from.
 *
 * The screen used to say "everything is plain data" and point at the API,
 * which is true and is not an answer: somebody who is deciding whether to
 * trust a tool with five years of work wants a button, and somebody leaving
 * wants one even more. Three things live here — a workspace as a file, one
 * person's own data, and the backups — and they are the same promise said
 * three times.
 *
 * Restoring is not here on purpose. SQLite must not be open when its file is
 * replaced, so a restore is a command run against a stopped server; a button
 * that could only ever half-work is worse than a sentence saying which command.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { useSession } from '../session';
import { Empty, Icon, Sheet, useConfirm, useToast } from './ui';
import { Button, buttonVariants } from './ui/button';
import { Input } from './ui/field';

import { SectionHeading } from './ui/section';
import { cn } from '../lib/cn';

/**
 * A download the browser streams straight to disk.
 *
 * Not `fetch` and a blob, which is how the smaller downloads here work: an
 * archive of a workspace with its files in it can be hundreds of megabytes,
 * and holding that in a tab to hand it to the tab is a way to run out of
 * memory in front of somebody. A same-origin navigation carries the session
 * cookie, so this is authenticated exactly as everything else is.
 */
function streamDownload(path: string): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = path;
  document.body.appendChild(frame);
  // Long enough for the response headers to arrive and the download to be
  // handed to the browser; the transfer itself carries on without the frame.
  setTimeout(() => frame.remove(), 60_000);
}

/** A download small enough to build in the tab, so an error is still visible. */
async function saveJson(path: string, filename: string): Promise<void> {
  const doc = await api.get<unknown>(path);
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const mb = (bytes: number): string =>
  bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1_048_576).toFixed(1)} MB`;

/* --------------------------------------------------------- the workspace */

interface Preview {
  workspace: string;
  projects: number;
  tasks: number;
  pages: number;
  people: number;
  files: number;
  fileBytes: number;
}

export function WorkspaceTransfer() {
  const t = useT();
  const toast = useToast();
  const { workspaceId, role } = useSession();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [arriving, setArriving] = useState<{ name: string; kind: 'workspace' | 'archive'; file: File } | null>(null);

  const mayExport = role === 'admin' || role === 'owner';

  useEffect(() => {
    if (!mayExport) return;
    setPreview(null);
    api.get<Preview>(`/api/workspaces/${workspaceId}/export/preview`)
      .then(setPreview)
      .catch(() => undefined);
  }, [workspaceId, mayExport]);

  /**
   * A file is inspected before it is imported, the same way the project
   * import already does it: what a document is, and how much of it there is,
   * are things to know before a workspace appears rather than after.
   */
  async function inspect(file: File): Promise<void> {
    if (file.name.endsWith('.zip')) {
      setArriving({ name: file.name, kind: 'archive', file });
      return;
    }
    try {
      const document_ = JSON.parse(await file.text());
      if (typeof document_?.format !== 'string' || !document_.format.startsWith('kolibri.workspace/')) {
        toast(t('transfer.notAWorkspace'));
        return;
      }
      setArriving({ name: String(document_.workspace?.name ?? file.name), kind: 'workspace', file });
    } catch {
      toast(t('transfer.failed'));
    }
  }

  async function importFile(): Promise<void> {
    if (!arriving) return;
    setBusy(true);
    try {
      const report = arriving.kind === 'archive'
        ? await api.postArchive<{ workspace?: { id: string; name: string }; missingFiles?: string[]; unmatched?: string[] }>(
          '/api/import/archive', await arriving.file.arrayBuffer(),
        )
        : await api.post<{ workspace?: { id: string; name: string }; missingFiles?: string[]; unmatched?: string[] }>(
          '/api/import/workspace', { document: JSON.parse(await arriving.file.text()) },
        );
      setArriving(null);
      if (!report.workspace) {
        toast(t('transfer.imported'));
        return;
      }
      toast(t('data.workspaceImported', { name: report.workspace.name }));
      // A new workspace is not in this tab's copy of anything, and stitching
      // one in by hand is how a stale cache happens. A reload is honest.
      setTimeout(() => window.location.assign('/'), 1200);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeading tight>{t('data.exportWorkspace')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('data.exportWorkspaceHint')}</p>

      {!mayExport ? (
        <p className="text-[12px] text-muted mb-3">{t('data.exportAdminOnly')}</p>
      ) : (
        <>
          {preview && (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5 text-[13.5px]">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0">{t('data.exportContents')}</span>
                <strong>
                  {t('data.exportCounts', {
                    projects: preview.projects, tasks: preview.tasks, pages: preview.pages, people: preview.people,
                  })}
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0">{t('data.exportFiles')}</span>
                <strong>{preview.files ? `${preview.files} · ${mb(preview.fileBytes)}` : '—'}</strong>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={() => {
                void saveJson(`/api/workspaces/${workspaceId}/export`, `workspace-${new Date().toISOString().slice(0, 10)}.kolibri.json`)
                  .catch((problem) => toast(problem instanceof Error ? problem.message : t('transfer.failed')));
              }}
            >
              <Icon name="page" size={14} /> {t('data.exportJson')}
            </Button>
            <Button onClick={() => streamDownload(`/api/workspaces/${workspaceId}/export?format=zip`)}>
              <Icon name="archive" size={14} /> {t('data.exportZip')}
            </Button>
            <Button onClick={() => streamDownload(`/api/workspaces/${workspaceId}/export/tasks.csv`)}>
              <Icon name="table" size={14} /> {t('data.exportCsv')}
            </Button>
          </div>
          <p className="text-[12px] text-muted mt-1.5">{t('data.exportFormatsHint')}</p>
        </>
      )}

      <SectionHeading>{t('data.importWorkspace')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('data.importWorkspaceHint')}</p>
      <label className={cn(buttonVariants({}), 'cursor-pointer')}>
        <Icon name="plus" size={14} /> {t('data.importChoose')}
        <input
          type="file" accept=".json,.zip,application/json,application/zip" style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void inspect(file);
          }}
        />
      </label>

      {arriving && (
        <Sheet
          title={t('data.importWorkspace')}
          onClose={() => setArriving(null)}
          footer={
            <>
              <Button onClick={() => setArriving(null)}>{t('action.cancel')}</Button>
              <Button variant="primary" disabled={busy} onClick={() => void importFile()}>
                {busy ? t('data.importing') : t('data.importConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('data.importAbout', { name: arriving.name })}</p>
          <p className="text-[13px] text-muted">{t('data.importNewWorkspace')}</p>
          <p className="text-[13px] text-muted">{t('data.importPeople')}</p>
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------------------------------------- my own data */

export function PersonalExport() {
  const t = useT();
  return (
    <>
      <SectionHeading>{t('data.mine')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('data.mineHint')}</p>
      <Button onClick={() => streamDownload('/api/me/export?download=1')}>
        <Icon name="page" size={14} /> {t('data.mineDownload')}
      </Button>
    </>
  );
}

/* ---------------------------------------------------------------- backups */

interface Snapshot {
  name: string;
  size: number;
  created_at: string | null;
  counts: Record<string, number>;
  uploads: string;
  intact?: boolean;
  problem?: string;
}

interface Held {
  counts: Record<string, number>;
  uploads: number;
  replacing: { users: number; workspaces: number; tasks: number; unused: boolean };
}

interface BackupStatus {
  enabled: boolean;
  dir: string;
  hour: number;
  keep: number;
  offsite: boolean;
  total: number;
  size: string;
  snapshots: Snapshot[];
}

/**
 * Backups cover the whole instance, so this is for whoever administers the
 * instance — not for an administrator of one workspace in it. Rather than
 * teach the session about that, the panel asks and hides itself when the
 * answer is no: one source of truth for the rule, on the server, where the
 * routes enforce it anyway.
 */
export function Backups() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [busy, setBusy] = useState('');
  /**
   * A restore, waiting to be agreed to.
   *
   * `held` is what the snapshot turns out to contain, which is only knowable
   * for one already on the server — an uploaded file has not been sent yet.
   * The confirmation says so rather than showing blanks.
   */
  const [restoring, setRestoring] = useState<{ name?: string; file?: File; held?: Held } | null>(null);
  const [typed, setTyped] = useState('');

  const load = async () => {
    try {
      setStatus(await api.get<BackupStatus>('/api/admin/backups'));
    } catch (problem) {
      if (problem instanceof ApiError && (problem.status === 403 || problem.status === 401)) setAllowed(false);
    }
  };
  useEffect(() => { void load(); }, []);

  if (!allowed || !status) return null;

  const act = async (what: string, run: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await run();
      toast(done);
      await load();
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    } finally {
      setBusy('');
    }
  };

  /** Open the confirmation, having first asked what the snapshot holds. */
  async function askAbout(snapshot?: Snapshot, file?: File): Promise<void> {
    setTyped('');
    if (!snapshot) { setRestoring({ file }); return; }
    setBusy(`inspect:${snapshot.name}`);
    try {
      setRestoring({ name: snapshot.name, held: await api.post<Held>(`/api/admin/backups/${snapshot.name}/inspect`) });
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    } finally {
      setBusy('');
    }
  }

  /**
   * The one destructive thing on this screen.
   *
   * Afterwards nothing here is signed in — the sessions table was one of the
   * ones replaced — so there is no state left worth refreshing. Sending the
   * browser back to the sign-in page is both the honest next step and the
   * thing that makes every device fetch the restored data rather than merge
   * its own copy into it.
   */
  async function restore(): Promise<void> {
    if (!restoring) return;
    setBusy('restore');
    try {
      const report = restoring.file
        ? await api.postArchive<{ replaced?: string }>('/api/admin/restore', await restoring.file.arrayBuffer())
        : await api.post<{ replaced?: string }>(`/api/admin/backups/${restoring.name}/restore`);
      setRestoring(null);
      toast(report.replaced ? t('restore.doneKept', { name: report.replaced }) : t('restore.done'));
      setTimeout(() => window.location.assign('/login'), 1800);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
      setBusy('');
    }
  }

  return (
    <>
      <SectionHeading>{t('backup.title')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('backup.hint')}</p>

      {!status.enabled ? (
        <Empty emoji="🗄️" title={t('backup.off')} hint={t('backup.offHint')} />
      ) : (
        <>
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-3.5 text-[13.5px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t('backup.schedule')}</span>
              <strong>{t('backup.scheduleValue', { hour: String(status.hour).padStart(2, '0'), keep: status.keep || t('backup.keepAll') })}</strong>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t('backup.where')}</span>
              <strong className="truncate">{status.dir}</strong>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t('backup.last')}</span>
              <strong>
                {status.snapshots[0]?.created_at
                  ? `${shortDate(Date.parse(status.snapshots[0].created_at))} · ${relativeTime(Date.parse(status.snapshots[0].created_at))}`
                  : t('backup.never')}
              </strong>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{t('backup.offsite')}</span>
              <strong>{status.offsite ? t('backup.offsiteOn') : t('backup.offsiteOff')}</strong>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Button
              disabled={busy === 'take'}
              onClick={() => void act('take', () => api.post('/api/admin/backups'), t('backup.taken'))}
            >
              <Icon name="refresh" size={14} /> {busy === 'take' ? t('backup.taking') : t('backup.now')}
            </Button>
          </div>

          {status.snapshots.length === 0 ? (
            <p className="text-[12px] text-muted">{t('backup.none')}</p>
          ) : (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-0">
              {status.snapshots.map((snapshot) => (
                <div className="flex items-center gap-2 trash-row" key={snapshot.name} style={{ gap: 9 }}>
                  <Icon name="archive" size={15} className="text-muted" />
                  <span style={{ minWidth: 110 }}>{snapshot.name}</span>
                  <span className="flex-1 min-w-0 truncate text-muted text-[12.5px]">
                    {Object.entries(snapshot.counts).map(([table, n]) => `${n} ${table}`).join(', ')}
                  </span>
                  <span className="text-muted text-[12.5px] hide-sm">{mb(snapshot.size)}</span>
                  {snapshot.intact !== undefined && (
                    <span className={cn('text-[12.5px]', snapshot.intact ? 'text-muted' : 'text-danger')}>
                      {snapshot.intact ? t('backup.intact') : t('backup.damaged')}
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={busy === snapshot.name}
                    onClick={() => void act(snapshot.name, () => api.post(`/api/admin/backups/${snapshot.name}/verify`), t('backup.verified'))}
                  >
                    <Icon name="shield" size={13} /> {t('backup.verify')}
                  </Button>
                  <Button size="sm" onClick={() => streamDownload(`/api/admin/backups/${snapshot.name}/download`)}>
                    <Icon name="archive" size={13} /> {t('backup.download')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === `inspect:${snapshot.name}`}
                    onClick={() => void askAbout(snapshot)}
                  >
                    <Icon name="refresh" size={13} /> {t('restore.action')}
                  </Button>
                  <Button
                    size="sm" variant="danger"
                    onClick={async () => {
                      if (!(await confirm(t('backup.deleteConfirm', { name: snapshot.name })))) return;
                      await act(snapshot.name, () => api.delete(`/api/admin/backups/${snapshot.name}`), t('backup.deleted'));
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[12px] text-muted mt-2">{t('backup.restoreHint')}</p>
        </>
      )}

      {/* Offered whether or not this instance takes its own backups: an
          instance deployed somewhere new has none of its own yet, and this is
          the file it has instead. */}
      <SectionHeading>{t('restore.upload')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('restore.uploadHint')}</p>
      <label className={cn(buttonVariants({}), 'cursor-pointer')}>
        <Icon name="refresh" size={14} /> {t('restore.choose')}
        <input
          type="file" accept=".zip,application/zip" style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void askAbout(undefined, file);
          }}
        />
      </label>

      {restoring && (
        <Sheet
          title={t('restore.title')}
          onClose={() => setRestoring(null)}
          footer={
            <>
              <Button onClick={() => setRestoring(null)}>{t('action.cancel')}</Button>
              <Button
                variant="danger"
                disabled={busy === 'restore' || typed.trim().toLowerCase() !== t('restore.word').toLowerCase()}
                onClick={() => void restore()}
              >
                {busy === 'restore' ? t('restore.working') : t('restore.confirm')}
              </Button>
            </>
          }
        >
          <p>{restoring.file ? t('restore.aboutFile', { name: restoring.file.name }) : t('restore.about', { name: restoring.name ?? '' })}</p>

          {restoring.held && (
            <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 my-2 text-[13.5px]">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0">{t('restore.arriving')}</span>
                <strong>
                  {Object.entries(restoring.held.counts).map(([table, n]) => `${n} ${table}`).join(', ')}
                  {restoring.held.uploads ? `, ${restoring.held.uploads} files` : ''}
                </strong>
              </div>
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0">{t('restore.going')}</span>
                <strong>
                  {t('restore.goingValue', {
                    users: restoring.held.replacing.users,
                    workspaces: restoring.held.replacing.workspaces,
                    tasks: restoring.held.replacing.tasks,
                  })}
                </strong>
              </div>
            </div>
          )}

          {/* Said in this order on purpose: the irreversible part, then the
              thing that makes it survivable, then what happens next. */}
          <p className="text-[13px] text-danger">
            {restoring.held?.replacing.unused ? t('restore.emptyInstance') : t('restore.replaces')}
          </p>
          <p className="text-[13px] text-muted">{status.enabled ? t('restore.safety') : t('restore.noSafety')}</p>
          <p className="text-[13px] text-muted">{t('restore.signedOut')}</p>
          <p className="text-[13px] text-muted">{t('restore.secret')}</p>

          <div className="field">
            <label htmlFor="restore-confirm">{t('restore.typeToConfirm', { word: t('restore.word') })}</label>
            <Input
              id="restore-confirm" value={typed} autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        </Sheet>
      )}
      {dialog}
    </>
  );
}
