import { RELATION_KINDS, type RelationKind, type Task } from '@kolibri/shared';
import { list, useQuery } from '../lib/store';
import { create, remove } from '../lib/mutations';
import { relationKey, useT } from '../lib/i18n';
import { Icon, MenuButton, StateDot, type MenuItem } from './ui';
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
      other: list('task', (t) => t.id === relation.related_task_id)[0],
    })),
    ...incoming.map((relation) => ({
      id: relation.id,
      kind: INVERSE[relation.kind as RelationKind] ?? 'relates_to',
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
      <div className="row" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{t('relation.title')}</strong>
        <span className="grow" />
        <MenuButton className="btn ghost sm" items={addItems} search empty={t('relation.noCandidates')}>
          <Icon name="link" size={14} /> {t('relation.link')}
        </MenuButton>
      </div>

      {!rows.length && <span className="muted" style={{ fontSize: 12.5 }}>{t('relation.none')}</span>}

      {rows.map((row) => {
        const state = stateOf(row.other);
        return (
          <div key={row.id} className="row" style={{ padding: '5px 0', borderTop: '1px solid var(--line)' }}>
            <span className="chip">{t(relationKey(row.kind))}</span>
            <button className="btn ghost sm grow" style={{ justifyContent: 'flex-start' }} onClick={() => onOpen(row.other)}>
              <StateDot group={state?.group_key} color={state?.color} />
              <span className="mono muted">{row.other.identifier}</span>
              <span className="truncate">{row.other.title}</span>
            </button>
            <button className="btn ghost sm icon" title={t('relation.remove')} onClick={() => remove('relation', row.id)}>
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
