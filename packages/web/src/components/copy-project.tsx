/**
 * Copying a project, from the interface.
 *
 * The one place in the app that deliberately calls the server instead of
 * writing locally: a copy is a hundred rows that only make sense together, and
 * half of one arriving on another device would be worse than waiting.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { pull } from '../lib/sync';
import { useSession } from '../session';
import { Button } from '../components/ui/button';
import { Icon, Sheet, useToast } from './ui';

export function CopyProjectSheet({ projectId, onClose, onCopied }: {
  projectId: string;
  onClose: () => void;
  onCopied?: (id: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const source = byId('project', projectId);
  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived && p.id !== projectId),
    [workspaceId, projectId],
  );

  const [name, setName] = useState(source ? `${source.name} (copy)` : '');
  const [key, setKey] = useState('');
  const [parentId, setParentId] = useState(source?.parent_id ?? '');
  const [include, setInclude] = useState({
    members: true, automations: true, pages: false, tasks: false, doneTasks: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (field: keyof typeof include) => setInclude((current) => ({ ...current, [field]: !current[field] }));

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ project: { id: string }; counts: Record<string, number> }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/copy`,
        { name, key: key.trim() || undefined, parentId: parentId || null, include },
      );
      // The copy was made on the server, so the local mirror has to catch up
      // before anything can navigate to it.
      await pull();
      const rows = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
      toast(t('copy.done', { count: rows }));
      onCopied?.(result.project.id);
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('copy.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={t('copy.title')} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-[12px] text-muted" style={{ marginBottom: 12 }}>{t('copy.hint')}</p>
        {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="field">
          <label htmlFor="copy-name">{t('copy.name')}</label>
          <input id="copy-name" className="input" required value={name} autoFocus
            onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="copy-key">{t('copy.key')}</label>
          <input id="copy-key" className="input" value={key} maxLength={8} style={{ width: 140, textTransform: 'uppercase' }}
            onChange={(event) => setKey(event.target.value.toUpperCase())} />
          <span className="text-[12px] text-muted">{t('copy.keyAuto')}</span>
        </div>

        <div className="field">
          <label htmlFor="copy-parent">{t('copy.parent')}</label>
          <select id="copy-parent" className="select" value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">{t('project.parentNone')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.icon} {project.name}</option>
            ))}
          </select>
        </div>

        <strong style={{ fontSize: 13, display: 'block', margin: '14px 0 6px' }}>{t('copy.include')}</strong>
        {([
          ['members', t('copy.members')],
          ['automations', t('copy.automations')],
          ['pages', t('copy.pages')],
          ['tasks', t('copy.tasks')],
        ] as const).map(([field, label]) => (
          <label className="flex items-center gap-2" key={field} style={{ gap: 8, padding: '4px 0', fontSize: 13 }}>
            <input type="checkbox" checked={include[field]} onChange={() => toggle(field)} />
            {label}
          </label>
        ))}
        {include.tasks && (
          <>
            <label className="flex items-center gap-2" style={{ gap: 8, padding: '4px 0 4px 24px', fontSize: 13 }}>
              <input type="checkbox" checked={include.doneTasks} onChange={() => toggle('doneTasks')} />
              {t('copy.doneTasks')}
            </label>
            <span className="text-[12px] text-muted" style={{ display: 'block', marginTop: 4 }}>{t('copy.tasksHint')}</span>
          </>
        )}

        <Button variant="primary" size="lg" block type="submit" disabled={busy || !name.trim()} style={{ marginTop: 16 }}>
          {busy ? t('copy.working') : <><Icon name="copy" size={14} /> {t('copy.submit')}</>}
        </Button>
      </form>
    </Sheet>
  );
}
