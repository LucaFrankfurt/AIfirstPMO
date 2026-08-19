/**
 * Things that were deleted or archived, and the way back.
 *
 * Nothing is ever really deleted: a delete stamps `deleted_at` and the row
 * keeps syncing as a tombstone, which is what lets two devices agree about a
 * deletion at all. So the data for this screen was already on the device — it
 * was simply the one thing the store filtered out and no screen asked for.
 *
 * Archiving is the other half of the same question. It is a different act —
 * "done with, keep it" rather than "gone" — but somebody looking for a task
 * that has left the board does not know which of the two happened to it.
 */
import { useMemo, useState } from 'react';
import type { EntityName } from '@kolibri/shared';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { restore, update } from '../lib/mutations';
import { byId, tables } from '../lib/store';
import { useQuery } from '../lib/store';
import { pull } from '../lib/sync';
import { useMemberMap, useSession } from '../session';
import { Empty, Icon, useConfirm, useToast } from './ui';

/** What can end up in here, and what to call it. */
const KINDS: { entity: EntityName; label: TranslationKey; icon: string }[] = [
  { entity: 'task', label: 'trash.kindTask', icon: 'check' },
  { entity: 'page', label: 'trash.kindPage', icon: 'page' },
  { entity: 'project', label: 'trash.kindProject', icon: 'folder' },
  { entity: 'cycle', label: 'trash.kindCycle', icon: 'cycle' },
  { entity: 'module', label: 'trash.kindModule', icon: 'target' },
  { entity: 'comment', label: 'trash.kindComment', icon: 'inbox' },
];

interface Entry {
  entity: EntityName;
  label: TranslationKey;
  icon: string;
  id: string;
  title: string;
  when: number;
  where: string | null;
}

/**
 * Deleted rows are the one thing `list()` hides, so this reads the tables
 * directly. That is the whole reason the screen can exist without a new
 * endpoint: the tombstones are already here.
 */
function useRecoverable(workspaceId: string, mode: 'deleted' | 'archived'): Entry[] {
  return useQuery(() => {
    const out: Entry[] = [];
    for (const { entity, label, icon } of KINDS) {
      for (const row of tables[entity].values()) {
        const record = row as Record<string, any>;
        if (record.workspace_id !== workspaceId) continue;
        if (mode === 'deleted' ? !record.deleted_at : record.deleted_at || !record.archived) continue;
        // Archiving is not a concept for a comment, and a deleted comment
        // belongs to a task that may itself be gone.
        if (mode === 'archived' && (entity === 'comment' || entity === 'cycle')) continue;

        const project = record.project_id ? byId('project', record.project_id) : undefined;
        out.push({
          entity,
          label,
          icon,
          id: record.id,
          title: String(record.title ?? record.name ?? record.body ?? '').slice(0, 120) || '—',
          when: Number(mode === 'deleted' ? record.deleted_at : record.updated_at) || 0,
          where: project?.name ?? null,
        });
      }
    }
    return out.sort((a, b) => b.when - a.when);
  }, [workspaceId, mode]);
}

export function Trash() {
  const t = useT();
  const { workspaceId, role } = useSession();
  const toast = useToast();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [mode, setMode] = useState<'deleted' | 'archived'>('deleted');
  const [query, setQuery] = useState('');
  const [emptying, setEmptying] = useState(false);
  const canEmpty = role === 'owner' || role === 'admin';

  const entries = useRecoverable(workspaceId, mode);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? entries.filter((entry) => entry.title.toLowerCase().includes(needle)) : entries).slice(0, 200);
  }, [entries, query]);

  const bring = (entry: Entry) => {
    if (mode === 'deleted') restore(entry.entity, entry.id);
    else update(entry.entity, entry.id, { archived: 0 });
    toast(t('trash.restored', { title: entry.title }));
  };

  /**
   * The one irreversible button in the app, so it says so.
   *
   * It is a server call rather than a local change: a purge is the server
   * removing the rows and putting a marker in their place, which is then how
   * every other device learns to forget the same things. Pulling straight
   * afterwards is what makes this screen empty itself.
   */
  const empty = async () => {
    const count = entries.length;
    if (!count) return;
    if (!await confirm(t('trash.emptyConfirm', { count }), t('trash.emptyAction'))) return;
    setEmptying(true);
    try {
      const done = await api.post<{ purged: number }>(`/api/workspaces/${workspaceId}/trash/empty`, {});
      await pull();
      toast(t('trash.emptied', { count: done.purged }));
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('trash.emptyFailed'));
    } finally {
      setEmptying(false);
    }
  };

  return (
    <>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t('trash.title')}</h3>
      <p className="muted" style={{ fontSize: 13 }}>{t('trash.intro')}</p>

      <div className="row wrap" style={{ gap: 6, margin: '12px 0' }}>
        <div className="row" style={{ gap: 2, border: '1px solid var(--line-strong)', borderRadius: 7, padding: 2 }}>
          {(['deleted', 'archived'] as const).map((which) => (
            <button
              key={which}
              className={`btn ghost sm${mode === which ? ' active' : ''}`}
              style={mode === which ? { background: 'var(--bg-active)' } : undefined}
              aria-pressed={mode === which}
              onClick={() => setMode(which)}
            >
              {t(which === 'deleted' ? 'trash.tabDeleted' : 'trash.tabArchived')}
            </button>
          ))}
        </div>
        <input
          className="input grow"
          style={{ minWidth: 160 }}
          placeholder={t('trash.filter')}
          aria-label={t('trash.filter')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {mode === 'deleted' && canEmpty && entries.length > 0 && (
          <button className="btn sm danger" disabled={emptying} onClick={() => void empty()}>
            <Icon name="trash" size={13} />
            {emptying ? t('action.working') : t('trash.emptyAction')}
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty
          emoji={mode === 'deleted' ? '🗑️' : '📦'}
          title={t(mode === 'deleted' ? 'trash.emptyDeleted' : 'trash.emptyArchived')}
          hint={t('trash.emptyHint')}
        />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {shown.map((entry) => (
            <div className="row trash-row" key={`${entry.entity}-${entry.id}`} style={{ gap: 9 }}>
              <Icon name={entry.icon} size={14} />
              <span className="muted" style={{ fontSize: 11.5, minWidth: 62 }}>{t(entry.label)}</span>
              <span className="grow truncate">{entry.title}</span>
              {entry.where && <span className="muted truncate hide-sm" style={{ fontSize: 12, maxWidth: 130 }}>{entry.where}</span>}
              <span className="muted" style={{ fontSize: 12 }}>{entry.when ? relativeTime(entry.when) : ''}</span>
              <button className="btn sm" onClick={() => bring(entry)}>{t('trash.restore')}</button>
            </div>
          ))}
          {entries.length > shown.length && (
            <div className="row trash-row">
              <span className="muted" style={{ fontSize: 12 }}>{t('trash.andMore', { count: entries.length - shown.length })}</span>
            </div>
          )}
        </div>
      )}

      <p className="hint" style={{ marginTop: 10 }}>{t('trash.retentionHint')}</p>
      {mode === 'deleted' && canEmpty && <p className="hint">{t('trash.emptyHintWhat')}</p>}
      {dialog}
      {/* `members` is read so a future "deleted by" column has it to hand; the
          delete itself is not attributed on the row today. */}
      <span hidden>{members.size}</span>
    </>
  );
}
