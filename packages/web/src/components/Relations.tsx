import { RELATION_KINDS, type RelationKind, type Task } from '@kolibri/shared';
import { list, useQuery } from '../lib/store';
import { create, remove, update } from '../lib/mutations';
import { relationKey, useT } from '../lib/i18n';
import { Icon, MenuButton, StateDot, type MenuItem } from './ui';
import { Button } from '../components/ui/button';
import { stateOf } from './task-parts';

/** The other side of a relation, so an incoming row reads correctly. */
const INVERSE: Record<RelationKind, RelationKind> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicates: 'duplicated_by',
  duplicated_by: 'duplicates',
};

export function Relations({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const t = useT();
  const outgoing = useQuery(() => list('relation', (r) => r.task_id === task.id), [task.id]);
  const incoming = useQuery(() => list('relation', (r) => r.related_task_id === task.id), [task.id]);
  const candidates = useQuery(
    () => list('task', (t) => t.workspace_id === task.workspace_id && t.id !== task.id && !t.archived).slice(0, 300),
    [task.workspace_id, task.id],
  );

  const rows = [
    ...outgoing.map((relation) => ({
      id: relation.id,
      kind: relation.kind as RelationKind,
      lag: relation.lag ?? 0,
      // Lag belongs to the link, so it is only editable from the side that
      // *owns* it — the blocker. Showing the same number twice, editable from
      // both, would be two people editing one row from two pages.
      ownsLag: relation.kind === 'blocks',
      other: list('task', (t) => t.id === relation.related_task_id)[0],
    })),
    ...incoming.map((relation) => ({
      id: relation.id,
      kind: INVERSE[relation.kind as RelationKind] ?? 'relates_to',
      lag: relation.lag ?? 0,
      ownsLag: false,
      other: list('task', (t) => t.id === relation.task_id)[0],
    })),
  ].filter((row) => row.other);

  const addItems: MenuItem[] = RELATION_KINDS.flatMap((kind) =>
    candidates.slice(0, 60).map((candidate) => ({
      id: `${kind}-${candidate.id}`,
      section: t(relationKey(kind)),
      label: `${candidate.identifier} ${candidate.title}`,
      onSelect: () => create('relation', { task_id: task.id, related_task_id: candidate.id, kind }),
    })),
  );

  return (
    <section style={{ marginBottom: 18 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{t('relation.title')}</strong>
        <span className="flex-1 min-w-0" />
        <MenuButton variant="ghost" size="sm" items={addItems} search empty={t('relation.noCandidates')}>
          <Icon name="link" size={14} /> {t('relation.link')}
        </MenuButton>
      </div>

      {!rows.length && <span className="text-muted" style={{ fontSize: 12.5 }}>{t('relation.none')}</span>}

      {rows.map((row) => {
        const state = stateOf(row.other);
        return (
          <div key={row.id} className="flex items-center gap-2" style={{ padding: '5px 0', borderTop: '1px solid var(--line)' }}>
            <span className="chip">{t(relationKey(row.kind))}</span>
            <Button variant="ghost" size="sm" className="flex-1 min-w-0" style={{ justifyContent: 'flex-start' }} onClick={() => onOpen(row.other)}>
              <StateDot group={state?.group_key} color={state?.color} />
              <span className="mono text-muted">{row.other.identifier}</span>
              <span className="truncate">{row.other.title}</span>
            </Button>
            {row.ownsLag && (
              <label className="flex items-center gap-2" style={{ gap: 4, fontSize: 12 }} title={t('relation.lagHint')}>
                <span className="text-muted hide-sm">{t('relation.lag')}</span>
                <input
                  className="input" type="number" min={0} max={365} style={{ width: 62 }}
                  aria-label={t('relation.lag')}
                  value={row.lag}
                  onChange={(event) => update('relation', row.id, {
                    // Never negative: a lead time would say this may start
                    // before its blocker ends, which is the one rule the
                    // scheduler exists to keep.
                    lag: Math.max(0, Math.min(365, Math.round(Number(event.target.value) || 0))),
                  })}
                />
              </label>
            )}
            <Button variant="ghost" size="iconSm" title={t('relation.remove')} onClick={() => remove('relation', row.id)}>
              <Icon name="close" size={13} />
            </Button>
          </div>
        );
      })}
    </section>
  );
}
