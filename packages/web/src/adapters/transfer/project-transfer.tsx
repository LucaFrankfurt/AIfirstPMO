/**
 * Moving a project in and out: the CSV importer, the project as a document or
 * an archive, a spreadsheet of its tasks, and reading a document another tool
 * wrote.
 *
 * It was a section of the project's settings tab, and lives here since that
 * tab left the route file: a planning file may not reach outward to an
 * adapter, and an adapter is what this is — every control in it is a format
 * crossing the edge of the app. The route hands it to the settings tab as a
 * slot, which is the same composing the route always did.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ForeignImportSheet, ImportSheet, type Inspection } from './import';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { api } from '../../kernel/sync/api';
import { useRow } from '../../kernel/sync/store';
import { pull } from '../../kernel/sync/sync';
import { useCanWrite, useSession } from '../../kernel/identity/session';
import { useT } from '../../kernel/i18n/i18n';
import { Button, buttonVariants } from '../../kernel/design-system/ui/button';
import { cn } from '../../kernel/design-system/cn';
import { Select, formField } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { fileDate, saveBlob, saveFromServer } from '../../kernel/files/save';

export function ProjectTransfer({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const canWrite = useCanWrite();
  const { workspaceId } = useSession();
  const project = useRow('project', projectId);
  /** What the project's downloads are called: its key, as the server names them too. */
  const projectName = (project?.key ?? 'project').toLowerCase();
  const [importing, setImporting] = useState(false);
  const [foreign, setForeign] = useState<{ document: unknown; found: Inspection } | null>(null);
  /**
   * A Kolibri file, waiting for one question: a new project, or this one?
   *
   * Asked rather than assumed, because the two are genuinely different
   * operations — one cannot damage anything and the other writes into work
   * people are doing — and because until now the answer was always "a new
   * one" whether that was wanted or not.
   */
  const [landing, setLanding] = useState<{ name: string; document?: unknown; archive?: ArrayBuffer } | null>(null);
  const [into, setInto] = useState<'new' | 'this'>('new');

  /**
   * A project as a document: for moving it to another instance, and for reading
   * it. The download is built here rather than by navigating to the endpoint,
   * so it goes through the same authenticated fetch as everything else.
   */
  async function exportJson(): Promise<void> {
    try {
      const doc = await api.get<unknown>(`/api/workspaces/${workspaceId}/projects/${projectId}/export`);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      await saveBlob(blob, `${projectName}.kolibri.json`);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /**
   * Read a file first, import it second.
   *
   * A Kolibri document goes straight in — it is this app's own shape and there
   * is nothing to warn anybody about. Anything from another tool is *converted*,
   * and what a converter leaves behind is the part worth reading before a
   * project appears, not after.
   */
  async function importJson(file: File): Promise<void> {
    try {
      // An archive is not inspected first: its document is inside it, and
      // unpacking a .zip in the browser to look would be a second reader of a
      // format the server already reads. The question below is the same one.
      if (file.name.endsWith('.zip')) {
        setInto('new');
        setLanding({ name: file.name, archive: await file.arrayBuffer() });
        return;
      }
      const document_ = JSON.parse(await file.text());
      const found = await api.post<Inspection>(`/api/workspaces/${workspaceId}/import/json/inspect`, { document: document_ });
      if (found.from === 'kolibri') {
        setInto('new');
        setLanding({ name: String(found.name || file.name), document: document_ });
        return;
      }
      setForeign({ document: document_, found });
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  type ImportReport = {
    project: { id: string };
    counts: Record<string, number>;
    unmatched: string[];
    updated?: number;
    missingFiles?: string[];
  };

  async function finishJsonImport(document_: unknown, target?: string): Promise<void> {
    setForeign(null);
    setLanding(null);
    try {
      const result = await api.post<ImportReport>(
        `/api/workspaces/${workspaceId}/import/json`,
        { document: document_, project_id: target },
      );
      await report(result);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /** The same for a `.zip`, which the server unpacks and reads for itself. */
  async function finishArchiveImport(archive: ArrayBuffer, target?: string): Promise<void> {
    setLanding(null);
    try {
      const query = new URLSearchParams({ workspace: workspaceId, ...(target ? { project_id: target } : {}) });
      await report(await api.postArchive<ImportReport>(`/api/import/archive?${query}`, archive));
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('transfer.failed'));
    }
  }

  /**
   * Say what landed — and, when it is not all of it, what did not.
   *
   * A count on its own is a lie by omission the moment anything was left
   * behind, which is why the missing files are named rather than counted.
   */
  async function report(result: ImportReport): Promise<void> {
    await pull();
    const rows = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
    if (result.missingFiles?.length) toast(t('transfer.missingFiles', { names: result.missingFiles.join(', ') }));
    if (result.updated) toast(t('transfer.merged', { count: result.updated, added: rows }));
    else {
      toast(result.unmatched.length
        ? t('transfer.importedWithGaps', { count: rows, names: result.unmatched.join(', ') })
        : t('transfer.imported', { count: rows }));
    }
    navigate(`/projects/${result.project.id}`);
  }

  return (
    <>
      <SectionHeading>{t('import.title')}</SectionHeading>
      <div className="flex items-center gap-2 flex-wrap">
        {canWrite && (
          <Button onClick={() => setImporting(true)}>
            <Icon name="attach" size={14} /> {t('import.action')}
          </Button>
        )}
        <Button onClick={() => void exportJson()}>
          <Icon name="page" size={14} /> {t('transfer.export')}
        </Button>
        {/* The archive and the spreadsheet are streamed by the server rather
            than fetched into a blob: a project with its screenshots in it is
            large. They used to be a navigation, which in the packaged app took
            the whole app to an `/api/…` path its bundle answers with itself. */}
        <Button onClick={() => void saveFromServer(`/api/workspaces/${workspaceId}/projects/${projectId}/export.zip`, `${projectName}-${fileDate()}.kolibri.zip`)}>
          <Icon name="archive" size={14} /> {t('transfer.exportZip')}
        </Button>
        <Button onClick={() => void saveFromServer(`/api/workspaces/${workspaceId}/export/tasks.csv?project_id=${projectId}`, `${projectName}-tasks-${fileDate()}.csv`)}>
          <Icon name="table" size={14} /> {t('transfer.exportCsv')}
        </Button>
        {canWrite && (
          <label className={cn(buttonVariants({  }), 'cursor-pointer')}>
            <Icon name="plus" size={14} /> {t('transfer.import')}
            <input
              type="file" accept=".json,.zip,application/json,application/zip" style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importJson(file);
              }}
            />
          </label>
        )}
      </div>
      <p className="text-label text-muted mt-1.5">{t('transfer.hint')}</p>
      {importing && <ImportSheet projectId={projectId} onClose={() => setImporting(false)} />}
      {landing && (
        <Sheet
          title={t('transfer.import')}
          onClose={() => setLanding(null)}
          footer={
            <>
              <Button onClick={() => setLanding(null)}>{t('action.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const target = into === 'this' ? projectId : undefined;
                  if (landing.archive) void finishArchiveImport(landing.archive, target);
                  else void finishJsonImport(landing.document, target);
                }}
              >
                {t('data.importConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('data.importAbout', { name: landing.name })}</p>
          <div className={formField}>
            <label htmlFor="import-into">{t('transfer.into')}</label>
            <Select id="import-into" value={into} onChange={(event) => setInto(event.target.value as 'new' | 'this')}>
              <option value="new">{t('transfer.intoNew')}</option>
              <option value="this">{t('transfer.intoThis')}</option>
            </Select>
          </div>
          <p className="text-body text-muted">
            {into === 'new' ? t('transfer.intoNewHint') : t('transfer.intoThisHint')}
          </p>
        </Sheet>
      )}
      {foreign && (
        <ForeignImportSheet
          found={foreign.found}
          onClose={() => setForeign(null)}
          onImport={() => void finishJsonImport(foreign.document)}
        />
      )}
    </>
  );
}
