/**
 * The bar of actions for a selection.
 *
 * Separate from `selection.tsx` so the checkbox can be used by the row
 * components this file imports, without the two ending up in a cycle.
 */
import { useMemo } from 'react';
import type { Task } from '@kolibri/shared';
import { PRIORITIES, coversProject } from '@kolibri/shared';
import { priorityKey, useT } from '../../kernel/i18n/i18n';
import { moveTaskToProject, remove, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useMembers, useSession } from '../../kernel/identity/session';
import type { Selection } from '../../kernel/design-system/selection';
import { useLabels, useStates } from './task-parts';
import { Button } from '../../kernel/design-system/ui/button';
import { navCount } from '../../kernel/design-system/ui/nav';
import { Avatar, Icon, MenuButton, PriorityBars, StateDot, useConfirm, useToast, type MenuEntry, type MenuItem } from '../../kernel/design-system/ui';

/**
 * The bar that appears once something is selected. Fixed to the bottom, above
 * the mobile tab bar, because that is where a thumb already is.
 */
export function SelectionBar({ selection, tasks }: { selection: Selection; tasks: Task[] }) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const members = useMembers();
  const { workspaceId } = useSession();

  const selected = useMemo(() => tasks.filter((task) => selection.has(task.id)), [tasks, selection]);
  // One project, or several? Everything project-scoped hangs off this answer.
  const projectIds = new Set(selected.map((task) => task.project_id));
  const soleProject = projectIds.size === 1 ? [...projectIds][0] : undefined;

  const states = useStates(soleProject);
  const labels = useLabels(soleProject);
  const cycles = useQuery(
    () => (soleProject ? list('cycle', (cycle) => coversProject(cycle, soleProject)) : []),
    [soleProject],
  );
  /*
   * Where the selection could go — and the one menu here that does *not* need
   * the rows to share a project. State, labels and a cycle are a project's own
   * vocabulary and mean nothing across two; "file all of this over there" is
   * the same instruction whatever the rows start out as, and a mixed selection
   * is exactly when somebody is tidying up.
   *
   * The project they are all already in is left out, the way the picker on one
   * task leaves out its own. Across two there is no such project to leave out,
   * and then every one of them is a real destination for something here.
   */
  const targets = useQuery(
    () => list('project', (project) => project.workspace_id === workspaceId
      && !project.archived && !project.is_container && project.id !== soleProject)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId, soleProject],
  );

  if (!selected.length) return null;

  const applyToAll = (patch: Record<string, unknown> | ((task: Task) => Record<string, unknown>), message: string) => {
    for (const task of selected) update('task', task.id, typeof patch === 'function' ? patch(task) : patch);
    toast(message);
    selection.clear();
  };

  /**
   * File the lot under another project.
   *
   * Not `applyToAll`, because this is not a field being set: each row's state,
   * labels, cycle and module have to be re-resolved against the destination,
   * and a parent takes its sub-tasks with it. `moveTaskToProject` is that
   * rule, and it answers how many rows it actually moved — which is why the
   * count below is summed rather than taken from the selection. A parent and
   * its child both selected is one move, not two.
   */
  const moveToProject = (project: { id: string; name: string }) => {
    let moved = 0;
    for (const task of selected) moved += moveTaskToProject(task, project.id);
    // Nothing to say when nothing moved — picking the project the rows are
    // already in is a no-op, not a failure.
    if (moved) toast(t('select.movedToProject', { count: moved, project: project.name }));
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

  /*
   * Two drawers, because this menu listed every label *twice* — once to add and
   * once to take away. A workspace with sixty-four of them opened a menu of a
   * hundred and twenty-eight rows, where the second half was the first half
   * again and the only thing saying so was a heading that had scrolled past.
   */
  const labelItems: MenuEntry[] = [
    {
      id: 'add',
      label: t('select.addLabelSection'),
      icon: <Icon name="plus" size={14} />,
      search: labels.length > 8,
      items: labels.map((label) => ({
        id: label.id,
        label: label.name,
        onSelect: () => applyToAll(
          (task) => ({ labels: [...new Set([...(task.labels ?? []), label.id])] }),
          done,
        ),
      })),
    },
    {
      id: 'remove',
      label: t('select.removeLabelSection'),
      icon: <Icon name="close" size={14} />,
      search: labels.length > 8,
      items: labels.map((label) => ({
        id: `remove-${label.id}`,
        label: label.name,
        onSelect: () => applyToAll((task) => ({ labels: (task.labels ?? []).filter((id) => id !== label.id) }), done),
      })),
    },
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
        {targets.length > 0 && (
          <MenuButton
            variant="secondary" size="sm"
            search={targets.length > 8}
            title={t('select.moveToProject')}
            items={targets.map((project) => ({
              id: project.id,
              label: project.name,
              onSelect: () => moveToProject(project),
            }))}
          >
            <Icon name="folder" size={14} /> <span className="hide-sm">{t('task.project')}</span>
          </MenuButton>
        )}

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
