import { Fragment } from 'react';
import {
  PRIORITIES, coversProject, fieldKeys, isDoneGroup, mayEnter,
  type Cycle, type Filters, type Label, type Layout, type Module, type Priority, type State, type Task,
} from '@kolibri/shared';
import { byId, list, useQuery } from '../lib/store';
import { ancestry, descendants } from '../lib/family';
import { byOrder, moveTaskToProject, toggleAssignee, toggleLabel, update } from '../lib/mutations';
import { dueClass, shortDate } from '../lib/format';
import { groupKey, priorityKey, useT, type Translate } from '../lib/i18n';
import { useMemberMap, useMembers, useSession } from '../session';
import { EMPTY_SELECTION, SelectBox, useLongPressSelect, type Selection } from './selection';
import { Input } from '../components/ui/field';
import { cn } from '../lib/cn';
import { Chip, chipDot, chipVariants } from './ui/chip';
import { Avatar, AvatarStack, Icon, MenuButton, PriorityBars, StateDot, useToast, type MenuItem } from './ui';

/* ------------------------------------------------------------------ moving */

/**
 * Filing a task under a different project, with the sentence that says so.
 *
 * One function for the two ways in, because they are the same act: dropping a
 * card on a project in the sidebar, and choosing one from the card's own menu.
 * The menu is not a convenience — a phone has no HTML5 drag and a keyboard has
 * no drag at all, and a move that exists only for a mouse is a move most of
 * this app's screens cannot make.
 *
 * It says what happened out loud because the card leaves the board it was on.
 * A row vanishing with nothing said reads as a deletion.
 */
export function useRefile(): (taskId: string, projectId: string) => void {
  const t = useT();
  const toast = useToast();
  return (taskId, projectId) => {
    const task = byId('task', taskId);
    const destination = byId('project', projectId);
    if (!task || !destination || !moveTaskToProject(task, projectId)) return;
    toast(t('task.movedToProject', { task: task.identifier, project: destination.name }));
  };
}

/** Where a task could go instead — every project that can hold one. */
export const useProjectTargets = (task: Task): { id: string; name: string }[] =>
  useQuery(
    () => list('project', (project) =>
      project.workspace_id === task.workspace_id
      && !project.archived && !project.is_container
      && project.id !== task.project_id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ id: project.id, name: project.name })),
    [task.workspace_id, task.project_id],
  );

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

/**
 * The project's cycles, newest first — the order the cycles page itself uses,
 * because the one somebody wants to filter on is nearly always the one running
 * now or the one after it, and both are at that end.
 */
export const useCycles = (projectId?: string | null): Cycle[] =>
  useQuery(
    () => list('cycle', (c) => !projectId || coversProject(c, projectId))
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '') || a.name.localeCompare(b.name)),
    [projectId],
  );

export const useModules = (projectId?: string | null): Module[] =>
  useQuery(
    // Without a project, every module in the store; with one, the modules that
    // project works on — its own and the ones it shares.
    () => list('module', (m) => !projectId || coversProject(m, projectId)).sort(byOrder),
    [projectId],
  );

export const stateOf = (task: Task): State | undefined => byId('state', task.state_id);

/* ----------------------------------------------------------------- pickers */

export function StatePicker({ task, compact }: { task: Task; compact?: boolean }) {
  const t = useT();
  const states = useStates(task.project_id);
  const current = stateOf(task);
  const { role } = useSession();
  // A column somebody may not move work into is not offered. The server refuses
  // it as well; this is so nobody has to find that out by being told no.
  const items: MenuItem[] = states.filter((state) => mayEnter(state.allowed_roles, role)).map((state) => ({
    id: state.id,
    label: state.name,
    section: t(groupKey(state.group_key)),
    icon: <StateDot group={state.group_key} color={state.color} />,
    onSelect: () => update('task', task.id, { state_id: state.id }),
  }));
  return (
    <MenuButton items={items} size={compact ? 'iconSm' : 'sm'} title={current?.name ?? t('task.state')}>
      <StateDot group={current?.group_key} color={current?.color} />
      {!compact && <span className="truncate">{current?.name ?? t('task.noState')}</span>}
    </MenuButton>
  );
}

export function PriorityPicker({ task, compact }: { task: Task; compact?: boolean }) {
  const t = useT();
  const items: MenuItem[] = PRIORITIES.map((priority) => ({
    id: priority,
    label: t(priorityKey(priority)),
    icon: <PriorityBars priority={priority} />,
    onSelect: () => update('task', task.id, { priority }),
  }));
  return (
    <MenuButton items={items} size={compact ? 'iconSm' : 'sm'} title={t(priorityKey(task.priority))}>
      <PriorityBars priority={task.priority} />
      {!compact && <span>{t(priorityKey(task.priority))}</span>}
    </MenuButton>
  );
}

export function AssigneePicker({ task, compact }: { task: Task; compact?: boolean }) {
  const t = useT();
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
    <MenuButton items={items} search size={compact ? 'iconSm' : 'sm'} title={t('task.assignees')}>
      {people.length ? <AvatarStack users={people} size={compact ? 18 : 20} /> : <Icon name="users" size={14} />}
      {!compact && <span className="truncate">{people.length ? people.map((p) => p.name).join(', ') : t('task.unassigned')}</span>}
    </MenuButton>
  );
}

export function LabelPicker({ task }: { task: Task }) {
  const t = useT();
  const labels = useLabels(task.project_id);
  // Only the ones that still exist. A task keeps the id of a label that was
  // deleted out from under it — every other place that reads them resolves the
  // id and skips what is gone, and this counted the raw list instead. Delete a
  // label from the project settings and the button went on saying "1 Label"
  // over a menu with nothing ticked and a row of chips showing none.
  const applied = new Set(labels.filter((label) => (task.labels ?? []).includes(label.id)).map((label) => label.id));
  const items: MenuItem[] = labels.map((label) => ({
    id: label.id,
    label: label.name,
    hint: applied.has(label.id) ? '✓' : undefined,
    icon: <span className={chipDot} style={{ background: label.color, width: 8, height: 8, borderRadius: 4 }} />,
    onSelect: () => toggleLabel(task, label.id),
  }));
  return (
    <MenuButton items={items} search variant="ghost" size="sm" title={t('task.labels')} empty={t('task.noLabelsYet')}>
      <Icon name="bolt" size={14} />
      {/* Set: say what it is. Unset: the icon and the menu behind it are the
          whole of it, and a phone has better uses for the width than three
          chips in a row reporting that nothing has been chosen. The button
          keeps its name through `title`, which is what a screen reader reads. */}
      {applied.size
        ? <span>{t('task.labelCount', { count: applied.size })}</span>
        : <span className="hidden sm:inline">{t('task.labels')}</span>}
    </MenuButton>
  );
}

/**
 * What this task sits under.
 *
 * A task sheet has always listed its sub-tasks and never said what it was a
 * sub-task *of* — the link ran one way, so from a child there was no way up
 * except remembering. This is the other half: the field, next to the ones it
 * belongs beside, and a breadcrumb above the title for getting there.
 *
 * Only tasks in the same project are offered. A parent in another project would
 * be legal in the model — relations already cross projects — but a sub-task
 * counted on one board and rolled up on another is a number nobody can check.
 *
 * The menu leaves out this task and everything under it, because those are the
 * choices that make a loop. The server refuses them too; this is so nobody has
 * to find that out by being told no.
 */
export function ParentPicker({ task }: { task: Task }) {
  const t = useT();
  const family = useQuery(
    () => list('task', (row) => row.project_id === task.project_id && !row.archived),
    [task.project_id],
  );
  const current = byId('task', task.parent_id);
  const forbidden = descendants(task.id, family);
  const candidates = family.filter((row) => !forbidden.has(row.id)).slice(0, 200);

  const items: MenuItem[] = [
    ...(task.parent_id
      ? [{ id: 'none', section: t('view.reset'), label: t('task.noParent'), onSelect: () => update('task', task.id, { parent_id: null }) }]
      : []),
    ...candidates.map((candidate) => ({
      id: candidate.id,
      label: `${candidate.identifier} ${candidate.title}`,
      hint: task.parent_id === candidate.id ? '✓' : undefined,
      onSelect: () => update('task', task.id, { parent_id: candidate.id }),
    })),
  ];

  return (
    <MenuButton items={items} variant="ghost" size="sm" search title={t('task.parent')} empty={t('task.noParentCandidates')}>
      <Icon name="hierarchy" size={14} />
      {current
        ? <span className="truncate">{current.identifier}</span>
        : <span className="hidden sm:inline">{t('task.noParent')}</span>}
    </MenuButton>
  );
}

/**
 * The way up, above the title.
 *
 * The whole chain rather than the immediate parent: a sub-task of a sub-task is
 * a thing people make, and "which of the three things above me am I looking at"
 * is the question a breadcrumb exists to answer.
 */
export function ParentTrail({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const family = useQuery(() => list('task', (row) => row.project_id === task.project_id), [task.project_id]);
  const above = useQuery(
    () => ancestry(task.id, family).slice(0, -1).map((id) => byId('task', id)).filter((row): row is Task => !!row),
    [task.id, family],
  );
  if (!above.length) return null;

  return (
    <nav className="parent-trail">
      {above.map((ancestor) => (
        <Fragment key={ancestor.id}>
          <button type="button" onClick={() => onOpen(ancestor)} title={ancestor.title}>
            <span className="mono">{ancestor.identifier}</span>
            <span className="truncate">{ancestor.title}</span>
          </button>
          <Icon name="chevronRight" size={12} aria-hidden />
        </Fragment>
      ))}
    </nav>
  );
}

export function CyclePicker({ task }: { task: Task }) {
  const t = useT();
  const cycles = useQuery(() => list('cycle', (c) => coversProject(c, task.project_id)), [task.project_id]);
  const current = byId('cycle', task.cycle_id);
  const items: MenuItem[] = [
    { id: 'none', label: t('task.noCycle'), onSelect: () => update('task', task.id, { cycle_id: null }) },
    ...cycles.map((cycle) => ({
      id: cycle.id,
      label: cycle.name,
      hint: cycle.end_date ? shortDate(cycle.end_date) : undefined,
      onSelect: () => update('task', task.id, { cycle_id: cycle.id }),
    })),
  ];
  return (
    <MenuButton items={items} variant="ghost" size="sm" title={t('task.cycle')}>
      <Icon name="cycle" size={14} />
      {current
        ? <span className="truncate">{current.name}</span>
        : <span className="hidden sm:inline">{t('task.noCycle')}</span>}
    </MenuButton>
  );
}

export function ModulePicker({ task }: { task: Task }) {
  const t = useT();
  const modules = useQuery(() => list('module', (m) => coversProject(m, task.project_id)), [task.project_id]);
  const current = byId('module', task.module_id);
  const items: MenuItem[] = [
    { id: 'none', label: t('task.noModule'), onSelect: () => update('task', task.id, { module_id: null }) },
    ...modules.map((module) => ({ id: module.id, label: module.name, onSelect: () => update('task', task.id, { module_id: module.id }) })),
  ];
  return (
    <MenuButton items={items} variant="ghost" size="sm" title={t('task.module')}>
      <Icon name="target" size={14} />
      {current
        ? <span className="truncate">{current.name}</span>
        : <span className="hidden sm:inline">{t('task.noModule')}</span>}
    </MenuButton>
  );
}

/**
 * What the screen a card sits on has already said about it.
 *
 * A cycle's board holds one cycle's tasks and a module's board one module's, so
 * a chip naming it on every card is a column of the same word. The card is told
 * what is already known rather than working it out, because only the screen
 * knows what its own header says.
 */
export interface Implied {
  cycleId?: string;
  moduleId?: string;
}

export function DateField({ value, onChange, label }: { value?: string | null; onChange: (value: string | null) => void; label: string }) {
  return (
    <Input
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
          <span className={chipVariants()} key={id}>
            <span className={chipDot} style={{ background: label.color }} />
            {label.name}
          </span>
        );
      })}
    </>
  );
}

export function TaskRow({
  task, onOpen, showProject, selection, order,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  showProject?: boolean;
  selection?: Selection;
  /** The visible order, so a shift-click knows what "in between" means. */
  order?: string[];
}) {
  const t = useT();
  const state = stateOf(task);
  const members = useMemberMap();
  const project = byId('project', task.project_id);
  const done = isDoneGroup(state?.group_key);
  const people = (task.assignees ?? []).map((id) => members.get(id)).filter(Boolean) as any[];
  const subtasks = useQuery(() => list('task', (t) => t.parent_id === task.id), [task.id]);
  const picked = !!selection?.has(task.id);
  const press = useLongPressSelect(task.id, order ?? [task.id], selection ?? EMPTY_SELECTION);

  return (
    <div
      className={`task-row${done ? ' done' : ''}${picked ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      {...(selection ? press : {})}
      onClick={() => {
        if (selection && press.swallowClick()) return;
        onOpen(task);
      }}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onOpen(task)}
    >
      {selection && <SelectBox id={task.id} order={order ?? [task.id]} selection={selection} label={t('select.selectRow')} />}
      <StateDot group={state?.group_key} color={state?.color} />
      <span className="id" title={project?.name}>{task.identifier}</span>
      <span className="title">{task.title}</span>
      <span className="meta">
        <LabelChips ids={task.labels ?? []} projectId={task.project_id} />
        {!!subtasks.length && <span className={chipVariants()} title={t('task.subtasks')}>⑂ {subtasks.length}</span>}
        {task.due_date && <span className={cn(chipVariants(), dueClass(task.due_date, state?.group_key))}>{shortDate(task.due_date)}</span>}
        {task.priority !== 'none' && <PriorityBars priority={task.priority} />}
        <AvatarStack users={people} size={20} />
      </span>
    </div>
  );
}

export function TaskCard({
  task, onOpen, onDragStart, onDragEnd, dragging, moveTargets, implied,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  onDragStart?: (event: React.DragEvent) => void;
  /**
   * The end of the drag, however it ended.
   *
   * `dragend` fires on the element the drag started from every time — dropped
   * on a column, dropped somewhere that refused it, released over nothing, or
   * cancelled with Escape. It is the only one of those the board hears, which
   * is why the "being dragged" look has to be cleared here rather than in the
   * handler for a successful drop.
   */
  onDragEnd?: (event: React.DragEvent) => void;
  dragging?: boolean;
  /** Columns this card can be moved to — the touch alternative to dragging. */
  moveTargets?: { id: string; title: string; onSelect: () => void }[];
  /** What the screen around the card already says. See `Implied`. */
  implied?: Implied;
}) {
  const t = useT();
  const members = useMemberMap();
  const refile = useRefile();
  const projects = useProjectTargets(task);
  // Through `useQuery` rather than a bare `byId`: the card is the one place on
  // the board that says these names, so a rename has to reach it.
  const module = useQuery(() => byId('module', task.module_id), [task.module_id]);
  const cycle = useQuery(() => byId('cycle', task.cycle_id), [task.cycle_id]);
  // And the state, because a due date is only late while the work is still open.
  const state = useQuery(() => byId('state', task.state_id), [task.state_id]);
  // A cycle's own board is every task in that cycle, and a module's is every
  // task in that module. Repeating it on all forty cards is a column of the
  // same word, so the chip stands down when the header has already said it.
  const showModule = module && module.id !== implied?.moduleId;
  const showCycle = cycle && cycle.id !== implied?.cycleId;
  const people = (task.assignees ?? []).map((id) => members.get(id)).filter(Boolean) as any[];
  return (
    <article
      className={`task-card${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="mono text-muted">{task.identifier}</span>
        <span className="flex-1 min-w-0" />
        {task.priority !== 'none' && <PriorityBars priority={task.priority} />}
        {(moveTargets && moveTargets.length > 1) || projects.length ? (
          <span onClick={(event) => event.stopPropagation()}>
            <MenuButton
              variant="ghost" size="iconSm"
              title={t('task.moveTo')}
              items={[
                ...(moveTargets && moveTargets.length > 1 ? moveTargets.map((target) => ({
                  id: target.id,
                  section: t('task.moveTo'),
                  label: target.title,
                  onSelect: target.onSelect,
                })) : []),
                // The same move the drag makes, for every device that cannot
                // drag. Second, because moving between columns is the thing
                // somebody opens this menu for many times a day and changing
                // project is the thing they do once.
                ...projects.map((project) => ({
                  id: `project-${project.id}`,
                  section: t('task.moveToProject'),
                  label: project.name,
                  onSelect: () => refile(task.id, project.id),
                })),
              ]}
            >
              <Icon name="dots" size={13} />
            </MenuButton>
          </span>
        ) : null}
      </div>
      <div className="title">{task.title}</div>
      <div className="footer">
        <LabelChips ids={task.labels ?? []} projectId={task.project_id} />
        {showCycle && (
          <span className={chipVariants()} title={t('task.cycle')}>
            <Icon name="cycle" size={11} />
            <span className="truncate">{cycle.name}</span>
          </span>
        )}
        {showModule && (
          <span className={chipVariants()} title={t('task.module')}>
            <Icon name="target" size={11} />
            <span className="truncate">{module.name}</span>
          </span>
        )}
        {task.due_date && <span className={cn(chipVariants(), dueClass(task.due_date, state?.group_key))}>{shortDate(task.due_date)}</span>}
        {task.estimate != null && <Chip>{task.estimate}p</Chip>}
        <span className="flex-1 min-w-0" />
        <AvatarStack users={people} size={20} />
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- grouping */

/** The groupings every project has. */
export type BaseGroupBy = 'state' | 'priority' | 'assignee' | 'label' | 'cycle' | 'project' | 'none';

/**
 * `field:<id>` groups by a custom field the project invented for itself. It is
 * a string rather than a second parameter so that a saved view stores one
 * value, and so that a grouping whose field was deleted simply finds nothing
 * instead of crashing the screen that reads it back.
 */
export type GroupBy = BaseGroupBy | `field:${string}`;

/**
 * What a list of tasks is currently showing.
 *
 * Here rather than in `views.tsx`, where it started, because `saved-views.tsx`
 * needs it too — and `views.tsx` renders the saved-view menu, so the two spent
 * a while importing each other. A type and its default are not a component;
 * both files already read `GroupBy` from this one. See `docs/modules.md`.
 */
export interface ViewConfig {
  layout: Layout;
  groupBy: GroupBy;
  orderBy: 'manual' | 'priority' | 'due_date' | 'created_at' | 'updated_at' | 'title';
  filters: Filters;
  showDone: boolean;
}

export const DEFAULT_VIEW: ViewConfig = {
  layout: 'list',
  groupBy: 'state',
  orderBy: 'manual',
  filters: {},
  showDone: true,
};


export const fieldGroupId = (fieldId: string): GroupBy => `field:${fieldId}`;
export const groupedField = (groupBy: GroupBy): string | null =>
  groupBy.startsWith('field:') ? groupBy.slice(6) : null;

export interface Group {
  id: string;
  title: string;
  color?: string;
  group?: string;
  tasks: Task[];
}

/**
 * Group by one project's own field.
 *
 * The groups are the answers the field *offers*, in the order somebody wrote
 * them down, rather than the answers that happen to be in use: an empty column
 * for a choice nobody has made is the useful half of a board. A multi-select
 * puts its task in every group it names, which is the same thing labels do.
 */
function groupByField(
  tasks: Task[],
  fieldId: string,
  context: { members: { id: string; name: string }[]; t: Translate },
): Group[] {
  const { t } = context;
  const field = byId('field', fieldId);
  if (!field) return [{ id: 'all', title: t('view.allTasks'), tasks }];

  const answers = new Map<string, string[]>();
  for (const row of list('fieldValue', (value) => value.field_id === fieldId)) {
    answers.set(row.task_id, fieldKeys(field.kind, row.value));
  }
  const inGroup = (task: Task, key: string) => (answers.get(task.id) ?? []).includes(key);

  const choices: { id: string; title: string }[] = field.kind === 'person'
    ? context.members.map((member) => ({ id: member.id, title: member.name }))
    : field.kind === 'checkbox'
      ? [{ id: 'true', title: t('field.yes') }]
      : (field.options ?? []).map((option) => ({ id: option, title: option }));

  const groups: Group[] = choices.map((choice) => ({
    ...choice,
    tasks: tasks.filter((task) => inGroup(task, choice.id)),
  }));
  groups.push({
    id: 'none',
    // A checkbox that is not ticked is not "no answer", it is "no" — the row is
    // deleted rather than stored as false, but nobody thinks of it that way.
    title: field.kind === 'checkbox' ? t('field.no') : t('field.noAnswer'),
    tasks: tasks.filter((task) => !(answers.get(task.id) ?? []).length),
  });
  return groups;
}

export function groupTasks(
  tasks: Task[],
  groupBy: GroupBy,
  context: { states: State[]; members: { id: string; name: string }[]; labels: Label[]; t: Translate },
): Group[] {
  const { t } = context;
  if (groupBy === 'none') return [{ id: 'all', title: t('view.allTasks'), tasks }];

  const fieldId = groupedField(groupBy);
  if (fieldId) return groupByField(tasks, fieldId, context);

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
      title: t(priorityKey(priority)),
      tasks: tasks.filter((task) => task.priority === priority),
    }));
  }

  if (groupBy === 'assignee') {
    const groups: Group[] = context.members.map((member) => ({
      id: member.id,
      title: member.name,
      tasks: tasks.filter((task) => (task.assignees ?? []).includes(member.id)),
    }));
    groups.push({ id: 'none', title: t('task.unassigned'), tasks: tasks.filter((task) => !(task.assignees ?? []).length) });
    return groups;
  }

  if (groupBy === 'label') {
    const groups: Group[] = context.labels.map((label) => ({
      id: label.id,
      title: label.name,
      color: label.color,
      tasks: tasks.filter((task) => (task.labels ?? []).includes(label.id)),
    }));
    groups.push({ id: 'none', title: t('view.noLabel'), tasks: tasks.filter((task) => !(task.labels ?? []).length) });
    return groups;
  }

  if (groupBy === 'cycle') {
    const cycles = list('cycle');
    const groups: Group[] = cycles.map((cycle) => ({
      id: cycle.id,
      title: cycle.name,
      tasks: tasks.filter((task) => task.cycle_id === cycle.id),
    }));
    groups.push({ id: 'none', title: t('task.noCycle'), tasks: tasks.filter((task) => !task.cycle_id) });
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
