/**
 * The bar of actions for a selection.
 *
 * Separate from `selection.tsx` so the checkbox can be used by the row
 * components this file imports, without the two ending up in a cycle.
 */
import { useMemo } from 'react';
import type { Task } from '@kolibri/shared';
import { PRIORITIES } from '@kolibri/shared';
import { priorityKey, useT } from '../lib/i18n';
import { remove, update } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useMembers } from '../session';
import type { Selection } from './selection';
import { useLabels, useStates } from './task-parts';
import { Button } from '../components/ui/button';
import { navCount } from './ui/nav';
import { Avatar, Icon, MenuButton, PriorityBars, StateDot, useConfirm, useToast, type MenuItem } from './ui';

/**
 * The bar that appears once something is selected. Fixed to the bottom, above
 * the mobile tab bar, because that is where a thumb already is.
 */
export function SelectionBar({ selection, tasks }: { selection: Selection; tasks: Task[] }) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const members = useMembers();

  const selected = useMemo(() => tasks.filter((task) => selection.has(task.id)), [tasks, selection]);
  // One project, or several? Everything project-scoped hangs off this answer.
  const projectIds = new Set(selected.map((task) => task.project_id));
  const soleProject = projectIds.size === 1 ? [...projectIds][0] : undefined;

  const states = useStates(soleProject);
  const labels = useLabels(soleProject);
  const cycles = useQuery(
    () => (soleProject ? list('cycle', (cycle) => cycle.project_id === soleProject) : []),
    [soleProject],
  );

  if (!selected.length) return null;

  const applyToAll = (patch: Record<string, unknown> | ((task: Task) => Record<string, unknown>), message: string) => {
    for (const task of selected) update('task', task.id, typeof patch === 'function' ? patch(task) : patch);
    toast(message);
    selection.clear();
  };

  const count = selected.length;
  const done = t('select.applied', { count });

  const stateItems: MenuItem[] = states.map((state) => ({
    id: state.id,
    label: state.name,
    icon: <StateDot group={state.group_key} color={state.color} />,
    onSelect: () => applyToAll({ state_id: state.id }, done),
  }));

  const priorityItems: MenuItem[] = PRIORITIES.map((priority) => ({
    id: priority,
    label: t(priorityKey(priority)),
    icon: <PriorityBars priority={priority} />,
    onSelect: () => applyToAll({ priority }, done),
  }));

  // Assigning replaces, adding a label adds: the first is a decision about who
  // owns the work, the second is a tag among others.
  const assigneeItems: MenuItem[] = [
    ...members.map((member) => ({
      id: member.id,
      label: member.name,
      icon: <Avatar user={member} size={18} />,
      onSelect: () => applyToAll({ assignees: [member.id] }, done),
    })),
    { id: 'none', section: t('select.clearSection'), label: t('select.unassign'), onSelect: () => applyToAll({ assignees: [] }, done) },
  ];

  const labelItems: MenuItem[] = [
    ...labels.map((label) => ({
      id: label.id,
      label: label.name,
      onSelect: () => applyToAll(
        (task) => ({ labels: [...new Set([...(task.labels ?? []), label.id])] }),
        done,
      ),
    })),
    ...labels.map((label) => ({
      id: `remove-${label.id}`,
      section: t('select.removeLabelSection'),
      label: label.name,
      onSelect: () => applyToAll((task) => ({ labels: (task.labels ?? []).filter((id) => id !== label.id) }), done),
    })),
  ];

  const cycleItems: MenuItem[] = [
    ...cycles.map((cycle) => ({
      id: cycle.id,
      label: cycle.name,
      onSelect: () => applyToAll({ cycle_id: cycle.id }, done),
    })),
    { id: 'none', section: t('select.clearSection'), label: t('select.noCycle'), onSelect: () => applyToAll({ cycle_id: null }, done) },
  ];

  return (
    <>
      <div className="selection-bar" role="region" aria-label={t('select.barLabel')}>
        <span className={navCount}>{t('select.count', { count })}</span>

        {soleProject ? (
          <>
            <MenuButton variant="secondary" size="sm" items={stateItems} search={states.length > 8}>
              <StateDot /> <span className="hide-sm">{t('task.state')}</span>
            </MenuButton>
            <MenuButton variant="secondary" size="sm" items={labelItems} search={labels.length > 8}>
              <Icon name="target" size={14} /> <span className="hide-sm">{t('task.labels')}</span>
            </MenuButton>
            {cycles.length > 0 && (
              <MenuButton variant="secondary" size="sm" items={cycleItems}>
                <Icon name="cycle" size={14} /> <span className="hide-sm">{t('task.cycle')}</span>
              </MenuButton>
            )}
          </>
        ) : (
          // Saying why is better than an action that silently does nothing.
          <span className="text-muted hide-sm text-[12.5px]">{t('select.mixedProjects')}</span>
        )}

        <MenuButton variant="secondary" size="sm" items={priorityItems}>
          <Icon name="bolt" size={14} /> <span className="hide-sm">{t('task.priority')}</span>
        </MenuButton>
        <MenuButton variant="secondary" size="sm" items={assigneeItems} search={members.length > 8}>
          <Icon name="users" size={14} /> <span className="hide-sm">{t('task.assignees')}</span>
        </MenuButton>

        <MenuButton
          variant="ghost" size="iconSm"
          title={t('common.more')}
          label={t('common.moreActions')}
          items={[
            {
              id: 'archive',
              label: t('action.archive'),
              icon: <Icon name="archive" size={14} />,
              onSelect: () => applyToAll({ archived: 1 }, t('select.archived', { count })),
            },
            {
              id: 'unarchive',
              label: t('action.unarchive'),
              onSelect: () => applyToAll({ archived: 0 }, done),
            },
            {
              id: 'delete',
              label: t('action.delete'),
              danger: true,
              icon: <Icon name="trash" size={14} />,
              onSelect: async () => {
                if (!(await confirm(t('select.deleteConfirm', { count })))) return;
                for (const task of selected) remove('task', task.id);
                toast(t('select.deleted', { count }));
                selection.clear();
              },
            },
          ]}
        >
          <Icon name="dots" size={15} />
        </MenuButton>

        <Button variant="ghost" size="sm" onClick={selection.clear}>{t('select.clear')}</Button>
      </div>
      {dialog}
    </>
  );
}

/** The tasks a selection refers to, for a caller that only has ids. */
export const selectedTasks = (selection: Selection): Task[] =>
  [...selection.ids].map((id) => byId('task', id)).filter(Boolean) as Task[];
