/**
 * Importing a CSV into a project.
 *
 * Three steps, in the order the questions actually arise: *what file*, *what do
 * the columns mean*, and *are you sure*. The third is a real dry run against
 * the server — the same code path that will do the writing, so what it promises
 * and what lands cannot drift apart.
 *
 * The file is parsed here as well, purely to fill in the mapping and show the
 * first rows. The server parses it again for the import itself; it is the same
 * parser, and trusting rows a client assembled would be trusting the wrong
 * side of the wire.
 */
import { useMemo, useState } from 'react';
import type { ImportField, ImportResult } from '@kolibri/shared';
import { guessMapping, IMPORT_FIELDS, MAX_ROWS, parseCsv } from '@kolibri/shared';
import { api } from '../lib/api';
import { priorityKey, useT, type TranslationKey } from '../lib/i18n';
import { shortDate } from '../lib/format';
import { pull } from '../lib/sync';
import { useSession } from '../session';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/field';
import { Chip } from './ui/chip';
import { Icon, Sheet, useToast } from './ui';

const FIELD_KEY: Record<ImportField, TranslationKey> = {
  title: 'import.fieldTitle',
  description: 'import.fieldDescription',
  state: 'import.fieldState',
  type: 'import.fieldType',
  priority: 'import.fieldPriority',
  assignee: 'import.fieldAssignee',
  labels: 'import.fieldLabels',
  due_date: 'import.fieldDue',
  parent: 'import.fieldParent',
  blocks: 'import.fieldBlocks',
  blocked_by: 'import.fieldBlockedBy',
  start_date: 'import.fieldStart',
  estimate: 'import.fieldEstimate',
  external_id: 'import.fieldExternalId',
};

/** Names the delimiter the sniffer chose, because "why is it one column" is the usual question. */
const DELIMITER_NAME: Record<string, TranslationKey> = {
  ',': 'import.delimiterComma',
  ';': 'import.delimiterSemicolon',
  '\t': 'import.delimiterTab',
  '|': 'import.delimiterPipe',
};

export function ImportSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useT();
  const { workspaceId } = useSession();
  const toast = useToast();

  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, ImportField | ''>>({});
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const table = useMemo(() => (csv ? parseCsv(csv) : null), [csv]);
  const hasTitle = Object.values(mapping).includes('title');

  const load = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text);
    setCsv(text);
    setFileName(file.name);
    setMapping(guessMapping(parsed.columns));
    setPreview(null);
    setFailed('');
  };

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setFailed('');
    try {
      const cleaned: Record<string, string> = {};
      for (const [column, field] of Object.entries(mapping)) if (field) cleaned[column] = field;
      const result = await api.import(workspaceId, {
        csv, project_id: projectId, mapping: cleaned, delimiter: table?.delimiter, dry_run: dryRun,
      });
      if (dryRun) {
        setPreview(result);
      } else {
        // The rows were written on the server, so the local mirror has to be
        // told; a hundred new tasks appearing only after a reload reads as a
        // failure.
        await pull();
        toast(t('import.done', { count: result.created }));
        onClose();
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t('import.title')}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          {preview ? (
            <Button variant="primary" disabled={busy || !preview.created} onClick={() => run(false)}>
              {t('import.confirm', { count: preview.created })}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !table?.rows.length || !hasTitle} onClick={() => run(true)}>
              {t('import.preview')}
            </Button>
          )}
        </>
      }
    >
      {!csv ? (
        <label className="import-drop">
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void load(file);
            }}
          />
          <Icon name="attach" size={20} />
          <strong>{t('import.chooseFile')}</strong>
          <span className="text-[12px] text-muted">{t('import.chooseHint', { max: MAX_ROWS })}</span>
        </label>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3 text-[12.5px]">
            <Icon name="page" size={14} />
            <strong className="truncate">{fileName}</strong>
            <span className="text-muted">
              {t('import.readRows', { count: table?.rows.length ?? 0 })}
              {table && DELIMITER_NAME[table.delimiter] ? ` · ${t(DELIMITER_NAME[table.delimiter])}` : ''}
            </span>
            <span className="flex-1 min-w-0" />
            <Button variant="ghost" size="sm" onClick={() => { setCsv(''); setPreview(null); }}>{t('import.otherFile')}</Button>
          </div>

          {!preview ? (
            <>
              <p className="text-[12px] text-muted mb-2.5">{t('import.mapHint')}</p>
              <div className="import-map">
                {(table?.columns ?? []).map((column) => (
                  <div className="flex items-center gap-2" key={column}>
                    <span className="truncate flex-1 min-w-0" title={column}>{column}</span>
                    <span className="text-muted truncate flex-1 text-[12.5px]">
                      {table?.rows[0]?.[column] || '—'}
                    </span>
                    <Select
                      style={{ width: 150 }}
                      aria-label={t('import.mapColumn', { column })}
                      value={mapping[column] ?? ''}
                      onChange={(event) => setMapping({ ...mapping, [column]: event.target.value as ImportField | '' })}
                    >
                      <option value="">{t('import.ignore')}</option>
                      {IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>{t(FIELD_KEY[field])}</option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
              {!hasTitle && <p className="text-[12px] text-danger mt-2.5">{t('import.needTitle')}</p>}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <Chip>{t('import.willCreate', { count: preview.created })}</Chip>
                {preview.skipped > 0 && <Chip>{t('import.willSkip', { count: preview.skipped })}</Chip>}
                {preview.problems.length > 0 && (
                  <Chip className="border-danger/40 text-danger">{t('import.problemCount', { count: preview.problems.length })}</Chip>
                )}
              </div>

              {preview.preview.length > 0 && (
                <table className="task-table mb-3.5">
                  <thead>
                    <tr>
                      <th>{t('table.title')}</th>
                      <th>{t('table.state')}</th>
                      <th>{t('table.priority')}</th>
                      <th>{t('table.due')}</th>
                      <th>{t('table.assignees')}</th>
                      <th>{t('table.labels')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((row, index) => (
                      <tr key={index}>
                        <td className="title">{row.title}</td>
                        <td>{row.state ?? '—'}</td>
                        {/* Translated, and the date already parsed: the point of
                            the preview is seeing what will land, not what was typed. */}
                        <td>{t(priorityKey(row.priority))}</td>
                        <td>{row.due ? shortDate(row.due) : '—'}</td>
                        <td>{row.assignee ?? '—'}</td>
                        <td>{row.labels.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {preview.problems.length > 0 && (
                <>
                  {/* Named, not counted: "12 problems" is not something anybody
                      can act on, and most of them are one wrong column. */}
                  <h4 className="text-[13.5px] mb-1.5">{t('import.problems')}</h4>
                  <div className="import-problems">
                    {preview.problems.slice(0, 40).map((problem, index) => (
                      <div className="flex items-center gap-2 text-[12.5px]" key={index}>
                        <span className="text-muted" style={{ minWidth: 54 }}>
                          {problem.row ? t('import.rowNumber', { row: problem.row }) : ''}
                        </span>
                        <span className="flex-1 min-w-0">{problem.message}</span>
                      </div>
                    ))}
                    {preview.problems.length > 40 && (
                      <p className="text-muted text-[12.5px]">{t('import.andMore', { count: preview.problems.length - 40 })}</p>
                    )}
                  </div>
                </>
              )}

              <p className="text-[12px] text-muted mt-3">{t('import.confirmHint')}</p>
            </>
          )}
        </>
      )}

      {failed && <p className="text-[12px] text-danger mt-2.5">{failed}</p>}
    </Sheet>
  );
}

/* --------------------------------------------------- another tool's export */

export interface Inspection {
  from: string;
  name: string;
  tasks: number;
  notes: string[];
}

const TOOL_NAME: Record<string, string> = {
  jira: 'Jira', linear: 'Linear', plane: 'Plane', openproject: 'OpenProject',
  trello: 'Trello', todoist: 'Todoist',
};

/**
 * What a foreign export turned out to be, before it is imported.
 *
 * The notes are the point of this screen. Every one of these tools has ideas
 * Kolibri has no equivalent for, and a converter that quietly dropped them
 * would produce a project that looks imported and is wrong in a way nobody
 * notices for a month. Reading what was left behind is cheaper before the
 * import than after it.
 */
export function ForeignImportSheet({
  found, onClose, onImport,
}: { found: Inspection; onClose: () => void; onImport: () => void }) {
  const t = useT();
  const tool = TOOL_NAME[found.from] ?? found.from;

  return (
    <Sheet
      title={t('foreign.title', { tool })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={onImport}>{t('foreign.import')}</Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {t('foreign.summary', { tool, name: found.name || t('foreign.unnamed'), count: found.tasks })}
      </p>
      {found.notes.length > 0 && (
        <>
          <h4 style={{ fontSize: 13, margin: '18px 0 6px' }}>{t('foreign.leftBehind')}</h4>
          <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, lineHeight: 1.6 }}>
            {found.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      )}
      <p className="text-[12px] text-muted mt-4">{t('foreign.caveat')}</p>
    </Sheet>
  );
}
