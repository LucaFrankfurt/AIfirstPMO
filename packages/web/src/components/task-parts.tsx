import { PRIORITIES, type Label, type Priority, type State, type Task } from '@kolibri/shared';
import { byId, list, useQuery } from '../lib/store';
import { byOrder, toggleAssignee, toggleLabel, update } from '../lib/mutations';
import { dueClass, GROUP_LABEL, PRIORITY_LABEL, shortDate } from '../lib/format';
import { useMemberMap, useMembers } from '../session';
import { Avatar, AvatarStack, Icon, MenuButton, PriorityBars, StateDot, type MenuItem } from './ui';

/* ----------------------------------------------------------------- lookups */

export const useStates = (projectId?: string | null): State[] =>
  useQuery(
    () => list('state', (s) => !projectId || s.project_id === projectId).sort(byOrder),
    [projectId],
  );

export const useLabels = (projectId?: string | null): Label[] =>
  useQuery(
    () => list('label', (l) => !l.project_id || !projectId || l.project_id === projectId).sort((a, b) => a.name.localeCompare(b.name)),
    [projectId],
  );

export const stateOf = (task: Task): State | undefined => byId('state', task.state_id);

/* ----------------------------------------------------------------- pickers */

export function StatePicker({ task, compact }: { task: Task; compact?: boolean }) {
  const states = useStates(task.project_id);
  const current = stateOf(task);
  const items: MenuItem[] = states.map((state) => ({
    id: state.id,
    label: state.name,
    section: GROUP_LABEL[state.group_key] ?? state.group_key,
    icon: <StateDot group={state.group_key} color={state.color} />,
    onSelect: () => update('task', task.id, { state_id: state.id }),
  }));
  return (
    <MenuButton items={items} className={`btn ghost ${compact ? 'icon sm' : 'sm'}`} title={current?.name ?? 'State'}>
      <StateDot group={current?.group_key} color={current?.color} />
      {!compact && <span className="truncate">{current?.name ?? 'No state'}</span>}
    </MenuButton>
  );
}

export function PriorityPicker({ task, compact }: { task: Task; compact?: boolean }) {
  const items: MenuItem[] = PRIORITIES.map((priority) => ({
    id: priority,
    label: PRIORITY_LABEL[priority],
    icon: <PriorityBars priority={priority} />,
    onSelect: () => update('task', task.id, { priority }),
  }));
  return (
    <MenuButton items={items} className={`btn ghost ${compact ? 'icon sm' : 'sm'}`} title={PRIORITY_LABEL[task.priority]}>
      <PriorityBars priority={task.priority} />
      {!compact && <span>{PRIORITY_LABEL[task.priority]}</span>}
    </MenuButton>
  );
}

export function AssigneePicker({ task, compact }: { task: Task; compact?: boolean }) {
  const members = useMembers();
  const assigned = new Set(task.assignees ?? []);
  const items: MenuItem[] = members.map((user) => ({
    id: user.id,
    label: user.name,
    hint: assigned.has(user.id) ? '✓' : undefined,
    icon: <Avatar user={user} size={20} />,
    onSelect: () => toggleAssignee(task, user.id),
  }));
  const people = (task.assignees ?? []).map((id) => members.find((m) => m.id === id)).filter(Boolean) as any[];
  return (
    <MenuButton items={items} search className={`btn ghost ${compact ? 'icon sm' : 'sm'}`} title="Assignees">
      {people.length ? <AvatarStack users={people} size={compact ? 18 : 20} /> : <Icon name="users" size={14} />}
      {!compact && <span className="truncate">{people.length ? people.map((p) => p.name).join(', ') : 'Unassigned'}</span>}
    </MenuButton>
  );
}

export function LabelPicker({ task }: { task: Task }) {
  const labels = useLabels(task.project_id);
  const applied = new Set(task.labels ?? []);
  const items: MenuItem[] = labels.map((label) => ({
    id: label.id,
    label: label.name,
    hint: applied.has(label.id) ? '✓' : undefined,
    icon: <span className="dot" style={{ background: label.color, width: 8, height: 8, borderRadius: 4 }} />,
    onSelect: () => toggleLabel(task, label.id),
  }));
  return (
    <MenuButton items={items} search className="btn ghost sm" title="Labels" empty="No labels in this project yet">
      <Icon name="bolt" size={14} />
      <span>{applied.size ? `${applied.size} label${applied.size > 1 ? 's' : ''}` : 'Labels'}</span>
    </MenuButton>
  );
}

export function CyclePicker({ task }: { task: Task }) {
  const cycles = useQuery(() => list('cycle', (c) => c.project_id === task.project_id), [task.project_id]);
  const current = byId('cycle', task.cycle_id);
  const items: MenuItem[] = [
    { id: 'none', label: 'No cycle', onSelect: () => update('task', task.id, { cycle_id: null }) },
    ...cycles.map((cycle) => ({
      id: cycle.id,
      label: cycle.name,
      hint: cycle.end_date ? shortDate(cycle.end_date) : undefined,
      onSelect: () => update('task', task.id, { cycle_id: cycle.id }),
    })),
  ];
  return (
    <MenuButton items={items} className="btn ghost sm" title="Cycle">
      <Icon name="cycle" size={14} />
      <span className="truncate">{current?.name ?? 'No cycle'}</span>
    </MenuButton>
  );
}

export function ModulePicker({ task }: { task: Task }) {
  const modules = useQuery(() => list('module', (m) => m.project_id === task.project_id), [task.project_id]);
  const current = byId('module', task.module_id);
  const items: MenuItem[] = [
    { id: 'none', label: 'No module', onSelect: () => update('task', task.id, { module_id: null }) },
    ...modules.map((module) => ({ id: module.id, label: module.name, onSelect: () => update('task', task.id, { module_id: module.id }) })),
  ];
  return (
    <MenuButton items={items} className="btn ghost sm" title="Module">
      <Icon name="target" size={14} />
      <span className="truncate">{current?.name ?? 'No module'}</span>
    </MenuButton>
  );
}

export function DateField({ value, onChange, label }: { value?: string | null; onChange: (value: string | null) => void; label: string }) {
  return (
    <input
      className="input"
      type="date"
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      style={{ maxWidth: 190 }}
    />
  );
}

/* -------------------------------------------------------------------- rows */

export function LabelChips({ ids, projectId }: { ids: string[]; projectId?: string }) {
  const labels = useLabels(projectId);
  if (!ids?.length) return null;
  return (
    <>
      {ids.map((id) => {
        const label = labels.find((l) => l.id === id);
        if (!label) return null;
        return (
          <span className="chip" key={id}>
            <span className="dot" style={{ background: label.color }} />
            {label.name}
          </span>
        );
      })}
    </>
  );
}

export function TaskRow({ task, onOpen, showProject }: { task: Task; onOpen: (task: Task) => void; showProject?: boolean }) {
  const state = stateOf(task);
  const members = useMemberMap();
  const project = byId('project', task.project_id);
  const done = state?.group_key === 'completed' || state?.group_key === 'cancelled';
  const people = (task.assignees ?? []).map((id) => members.get(id)).filter(Boolean) as any[];
  const subtasks = useQuery(() => list('task', (t) => t.parent_id === task.id), [task.id]);

  return (
    <div className={`task-row${done ? ' done' : ''}`} onClick={() => onOpen(task)} role="button" tabIndex={0}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onOpen(task)}>
      <StateDot group={state?.group_key} color={state?.color} />
      <span className="id" title={project?.name}>{task.identifier}</span>
      <span className="title">{task.title}</span>
      <span className="meta">
        <LabelChips ids={task.labels ?? []} projectId={task.project_id} />
        {!!subtasks.length && <span className="chip" title="Sub-tasks">⑂ {subtasks.length}</span>}
        {task.due_date && <span className={`chip ${dueClass(task.due_date)}`}>{shortDate(task.due_date)}</span>}
        {task.priority !== 'none' && <PriorityBars priority={task.priority} />}
        <AvatarStack users={people} size={20} />
      </span>
    </div>
  );
}

export function TaskCard({
  task, onOpen, onDragStart, dragging,
}: { task: Task; onOpen: (task: Task) => void; onDragStart?: (event: React.DragEvent) => void; dragging?: boolean }) {
  const members = useMemberMap();
  const people = (task.assignees ?? []).map((id) => members.get(id)).filter(Boolean) as any[];
  return (
    <article
      className={`task-card${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={() => onOpen(task)}
    >
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="mono muted">{task.identifier}</span>
        <span className="grow" />
        {task.priority !== 'none' && <PriorityBars priority={task.priority} />}
      </div>
      <div className="title">{task.title}</div>
      <div className="footer">
        <LabelChips ids={task.labels ?? []} projectId={task.project_id} />
        {task.due_date && <span className={`chip ${dueClass(task.due_date)}`}>{shortDate(task.due_date)}</span>}
        {task.estimate != null && <span className="chip">{task.estimate}p</span>}
        <span className="grow" />
        <AvatarStack users={people} size={20} />
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- grouping */

export type GroupBy = 'state' | 'priority' | 'assignee' | 'label' | 'cycle' | 'project' | 'none';

export interface Group {
  id: string;
  title: string;
  color?: string;
  group?: string;
  tasks: Task[];
}

export function groupTasks(tasks: Task[], groupBy: GroupBy, context: { states: State[]; members: { id: string; name: string }[]; labels: Label[] }): Group[] {
  if (groupBy === 'none') return [{ id: 'all', title: 'All tasks', tasks }];

  if (groupBy === 'state') {
    return context.states.map((state) => ({
      id: state.id,
      title: state.name,
      color: state.color,
      group: state.group_key,
      tasks: tasks.filter((task) => task.state_id === state.id),
    }));
  }

  if (groupBy === 'priority') {
    return PRIORITIES.map((priority) => ({
      id: priority,
      title: PRIORITY_LABEL[priority],
      tasks: tasks.filter((task) => task.priority === priority),
    }));
  }

  if (groupBy === 'assignee') {
    const groups: Group[] = context.members.map((member) => ({
      id: member.id,
      title: member.name,
      tasks: tasks.filter((task) => (task.assignees ?? []).includes(member.id)),
    }));
    groups.push({ id: 'none', title: 'Unassigned', tasks: tasks.filter((task) => !(task.assignees ?? []).length) });
    return groups;
  }

  if (groupBy === 'label') {
    const groups: Group[] = context.labels.map((label) => ({
      id: label.id,
      title: label.name,
      color: label.color,
      tasks: tasks.filter((task) => (task.labels ?? []).includes(label.id)),
    }));
    groups.push({ id: 'none', title: 'No label', tasks: tasks.filter((task) => !(task.labels ?? []).length) });
    return groups;
  }

  if (groupBy === 'cycle') {
    const cycles = list('cycle');
    const groups: Group[] = cycles.map((cycle) => ({
      id: cycle.id,
      title: cycle.name,
      tasks: tasks.filter((task) => task.cycle_id === cycle.id),
    }));
    groups.push({ id: 'none', title: 'No cycle', tasks: tasks.filter((task) => !task.cycle_id) });
    return groups;
  }

  const projects = list('project');
  return projects
    .map((project) => ({
      id: project.id,
      title: `${project.icon ?? ''} ${project.name}`.trim(),
      tasks: tasks.filter((task) => task.project_id === project.id),
    }))
    .filter((group) => group.tasks.length);
}
