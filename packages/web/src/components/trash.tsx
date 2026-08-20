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
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input } from '../components/ui/field';
import { SectionHeading } from './ui/section';
import { Empty, Icon, useConfirm, useToast } from './ui';

/** What can end up in here, and what to call it. */
const KINDS: { entity: EntityName; label: TranslationKey; icon: string }[] = [
  { entity: 'task', label: 'trash.kindTask', icon: 'check' },
  { entity: 'page', label: 'trash.kindPage', icon: 'page' },
  { entity: 'project', label: 'trash.kindProject', icon: 'folder' },
  { entity: 'cycle', label: 'trash.kindCycle', icon: 'cycle' },
  { entity: 'module', label: 'trash.kindModule', icon: 'target' },
  { entity: 'comment', label: 'trash.kindComment', icon: 'inbox' },
  // A deleted channel hides the room and keeps everything said in it, so
  // putting it back is putting the conversation back. Messages are not listed:
  // a message somebody deleted should stay deleted, and a list of them would
  // be a way to read what was withdrawn.
  { entity: 'channel', label: 'trash.kindChannel', icon: 'chat' },
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
        // A channel records when it was archived rather than that it was; the
        // rest carry a flag. Both mean the same thing to this screen.
        const isArchived = record.archived_at ? true : !!record.archived;
        if (mode === 'deleted' ? !record.deleted_at : record.deleted_at || !isArchived) continue;
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
    else if (entry.entity === 'channel') update(entry.entity, entry.id, { archived_at: null });
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
      <SectionHeading tight>{t('trash.title')}</SectionHeading>
      <p className="text-muted text-[13.5px]">{t('trash.intro')}</p>

      <div className="flex items-center flex-wrap gap-1.5" style={{ margin: '12px 0' }}>
        <div className="flex items-center gap-0.5" style={{ border: '1px solid var(--line-strong)', borderRadius: 7, padding: 2 }}>
          {(['deleted', 'archived'] as const).map((which) => (
            <button
              key={which}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), mode === which && 'bg-active text-fg')}
              style={mode === which ? { background: 'var(--bg-active)' } : undefined}
              aria-pressed={mode === which}
              onClick={() => setMode(which)}
            >
              {t(which === 'deleted' ? 'trash.tabDeleted' : 'trash.tabArchived')}
            </button>
          ))}
        </div>
        <Input
          className="flex-1 min-w-0"
          style={{ minWidth: 160 }}
          placeholder={t('trash.filter')}
          aria-label={t('trash.filter')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {mode === 'deleted' && canEmpty && entries.length > 0 && (
          <Button variant="danger" size="sm" disabled={emptying} onClick={() => void empty()}>
            <Icon name="trash" size={13} />
            {emptying ? t('action.working') : t('trash.emptyAction')}
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty
          emoji={mode === 'deleted' ? '🗑️' : '📦'}
          title={t(mode === 'deleted' ? 'trash.emptyDeleted' : 'trash.emptyArchived')}
          hint={t('trash.emptyHint')}
        />
      ) : (
        <div className="rounded-[var(--radius)] border border-line bg-raised p-0">
          {shown.map((entry) => (
            <div className="flex items-center gap-2 trash-row" key={`${entry.entity}-${entry.id}`} style={{ gap: 9 }}>
              <Icon name={entry.icon} size={14} />
              <span className="text-muted text-[11.5px]" style={{ minWidth: 62 }}>{t(entry.label)}</span>
              <span className="flex-1 min-w-0 truncate">{entry.title}</span>
              {entry.where && <span className="text-muted truncate hide-sm text-[12.5px]" style={{ maxWidth: 130 }}>{entry.where}</span>}
              <span className="text-muted text-[12.5px]">{entry.when ? relativeTime(entry.when) : ''}</span>
              <Button size="sm" onClick={() => bring(entry)}>{t('trash.restore')}</Button>
            </div>
          ))}
          {entries.length > shown.length && (
            <div className="flex items-center gap-2 trash-row">
              <span className="text-muted text-[12.5px]">{t('trash.andMore', { count: entries.length - shown.length })}</span>
            </div>
          )}
        </div>
      )}

      <p className="text-[12px] text-muted mt-2.5">{t('trash.retentionHint')}</p>
      {mode === 'deleted' && canEmpty && <p className="text-[12px] text-muted">{t('trash.emptyHintWhat')}</p>}
      {dialog}
      {/* `members` is read so a future "deleted by" column has it to hand; the
          delete itself is not attributed on the row today. */}
      <span hidden>{members.size}</span>
    </>
  );
}
