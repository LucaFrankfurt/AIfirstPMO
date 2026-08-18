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
import { Icon, Sheet, useToast } from './ui';

const FIELD_KEY: Record<ImportField, TranslationKey> = {
  title: 'import.fieldTitle',
  description: 'import.fieldDescription',
  state: 'import.fieldState',
  priority: 'import.fieldPriority',
  assignee: 'import.fieldAssignee',
  labels: 'import.fieldLabels',
  due_date: 'import.fieldDue',
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
          <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
          {preview ? (
            <button className="btn primary" disabled={busy || !preview.created} onClick={() => run(false)}>
              {t('import.confirm', { count: preview.created })}
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !table?.rows.length || !hasTitle} onClick={() => run(true)}>
              {t('import.preview')}
            </button>
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
          <span className="hint">{t('import.chooseHint', { max: MAX_ROWS })}</span>
        </label>
      ) : (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12, fontSize: 12.5 }}>
            <Icon name="page" size={14} />
            <strong className="truncate">{fileName}</strong>
            <span className="muted">
              {t('import.readRows', { count: table?.rows.length ?? 0 })}
              {table && DELIMITER_NAME[table.delimiter] ? ` · ${t(DELIMITER_NAME[table.delimiter])}` : ''}
            </span>
            <span className="grow" />
            <button className="btn ghost sm" onClick={() => { setCsv(''); setPreview(null); }}>{t('import.otherFile')}</button>
          </div>

          {!preview ? (
            <>
              <p className="hint" style={{ marginBottom: 10 }}>{t('import.mapHint')}</p>
              <div className="import-map">
                {(table?.columns ?? []).map((column) => (
                  <div className="row" key={column} style={{ gap: 8 }}>
                    <span className="truncate grow" title={column}>{column}</span>
                    <span className="muted truncate" style={{ flex: 1, fontSize: 12 }}>
                      {table?.rows[0]?.[column] || '—'}
                    </span>
                    <select
                      className="select"
                      style={{ width: 150 }}
                      aria-label={t('import.mapColumn', { column })}
                      value={mapping[column] ?? ''}
                      onChange={(event) => setMapping({ ...mapping, [column]: event.target.value as ImportField | '' })}
                    >
                      <option value="">{t('import.ignore')}</option>
                      {IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>{t(FIELD_KEY[field])}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {!hasTitle && <p className="hint warn" style={{ marginTop: 10 }}>{t('import.needTitle')}</p>}
            </>
          ) : (
            <>
              <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
                <span className="chip">{t('import.willCreate', { count: preview.created })}</span>
                {preview.skipped > 0 && <span className="chip">{t('import.willSkip', { count: preview.skipped })}</span>}
                {preview.problems.length > 0 && (
                  <span className="chip danger">{t('import.problemCount', { count: preview.problems.length })}</span>
                )}
              </div>

              {preview.preview.length > 0 && (
                <table className="task-table" style={{ marginBottom: 14 }}>
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
                  <h4 style={{ fontSize: 13, marginBottom: 6 }}>{t('import.problems')}</h4>
                  <div className="import-problems">
                    {preview.problems.slice(0, 40).map((problem, index) => (
                      <div className="row" key={index} style={{ gap: 8, fontSize: 12.5 }}>
                        <span className="muted" style={{ minWidth: 54 }}>
                          {problem.row ? t('import.rowNumber', { row: problem.row }) : ''}
                        </span>
                        <span className="grow">{problem.message}</span>
                      </div>
                    ))}
                    {preview.problems.length > 40 && (
                      <p className="muted" style={{ fontSize: 12 }}>{t('import.andMore', { count: preview.problems.length - 40 })}</p>
                    )}
                  </div>
                </>
              )}

              <p className="hint" style={{ marginTop: 12 }}>{t('import.confirmHint')}</p>
            </>
          )}
        </>
      )}

      {failed && <p className="hint warn" style={{ marginTop: 10 }}>{failed}</p>}
    </Sheet>
  );
}
