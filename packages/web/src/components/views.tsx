import { Fragment, useMemo, useState } from 'react';
import type { Field, Filters, Layout, Task } from '@kolibri/shared';
import {
  FIELD_ANSWERED, FIELD_EMPTY, emptyValue, fieldChoices, fieldMatches, fieldValueId,
  formatFieldValue, isGroupable, orderKey, PRIORITIES, readFieldValue,
} from '@kolibri/shared';
import { byId, list, useQuery } from '../lib/store';
import { byOrder, create, update } from '../lib/mutations';
import { currentLocale, priorityKey, useT, type TranslationKey } from '../lib/i18n';
import { shortDate, today } from '../lib/format';
import { useCanWrite, useMemberMap, useMembers, useSession } from '../session';
import {
  fieldGroupId, groupedField, groupTasks, LabelChips, TaskCard, TaskRow,
  useLabels, useStates, useTypes, type BaseGroupBy, type GroupBy,
} from './task-parts';
import { setFieldValue, useFields } from './fields';
import { AvatarStack, Empty, Icon, MenuButton, PriorityBars, StateDot, type MenuItem } from './ui';
import { QueryBox } from './query-box';
import { SavedViews } from './saved-views';
import { SelectBox, type Selection } from './selection';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/field';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { navCount } from './ui/nav';
import { GanttView } from './gantt';

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

const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

const LAYOUT_KEY: Record<string, TranslationKey> = {
  list: 'view.list', board: 'view.board', calendar: 'view.calendar', table: 'view.table', gantt: 'view.gantt',
};

/** Every layout `LAYOUTS` declares is built. */
const BUILT_LAYOUTS: Layout[] = ['list', 'board', 'table', 'calendar', 'gantt'];

const GROUP_BY_KEY: Record<BaseGroupBy, TranslationKey> = {
  state: 'view.groupState', type: 'type.groupBy', priority: 'view.groupPriority', assignee: 'view.groupAssignee',
  label: 'view.groupLabel', cycle: 'view.groupCycle', project: 'view.groupProject', none: 'view.noGrouping',
};

const ORDER_BY_KEY: Record<ViewConfig['orderBy'], TranslationKey> = {
  manual: 'view.orderManual', priority: 'view.orderPriority', due_date: 'view.orderDueDate',
  created_at: 'view.orderUpdatedAt', updated_at: 'view.orderUpdatedAt', title: 'view.orderTitle',
};

const WEEKDAY_KEYS: TranslationKey[] = [
  'view.weekdayMon', 'view.weekdayTue', 'view.weekdayWed',
  'view.weekdayThu', 'view.weekdayFri', 'view.weekdaySat', 'view.weekdaySun',
];

/** Apply filters + sorting. Runs against the local cache, so it is instant. */
export function useVisibleTasks(tasks: Task[], view: ViewConfig): Task[] {
  return useMemo(() => {
    const { filters } = view;
    const day = today();
    // Answers are read once for the whole pass rather than per task: a project
    // with a few hundred tasks and half a dozen fields is a few thousand rows,
    // and this runs on every keystroke in the search box.
    const fieldFilters = Object.entries(filters.field ?? {}).filter(([, wanted]) => wanted?.length);
    const answers = fieldFilters.length
      ? new Map(list('fieldValue').map((row) => [`${row.task_id}.${row.field_id}`, row.value]))
      : new Map<string, string | null>();
    const filtered = tasks.filter((task) => {
      if (task.archived) return false;
      const state = byId('state', task.state_id);
      if (!view.showDone && (state?.group_key === 'completed' || state?.group_key === 'cancelled')) return false;
      if (filters.state?.length && !filters.state.includes(task.state_id)) return false;
      if (filters.type?.length && !filters.type.includes(task.type_id ?? '')) return false;
      if (filters.group?.length && !filters.group.includes(state?.group_key as any)) return false;
      if (filters.priority?.length && !filters.priority.includes(task.priority)) return false;
      if (filters.project?.length && !filters.project.includes(task.project_id)) return false;
      if (filters.cycle?.length && !filters.cycle.includes(task.cycle_id ?? '')) return false;
      if (filters.module?.length && !filters.module.includes(task.module_id ?? '')) return false;
      if (filters.assignee?.length && !filters.assignee.some((id) => (task.assignees ?? []).includes(id))) return false;
      if (filters.label?.length && !filters.label.some((id) => (task.labels ?? []).includes(id))) return false;
      // The same questions the other way round. Written out beside the
      // positive ones rather than derived from them: a loop over field names
      // would be shorter and would not survive the next field that needs a
      // rule of its own, the way `assignee` and `label` already do.
      const not = filters.not;
      if (not) {
        if (not.state?.includes(task.state_id)) return false;
        if (not.type?.includes(task.type_id ?? '')) return false;
        if (not.group?.includes(state?.group_key as any)) return false;
        if (not.priority?.includes(task.priority)) return false;
        if (not.project?.includes(task.project_id)) return false;
        if (not.cycle?.includes(task.cycle_id ?? '')) return false;
        if (not.module?.includes(task.module_id ?? '')) return false;
        // A list: excluded when *any* of the task's values is named. "Not
        // assigned to Ada" means the ones Ada is not on, including the ones
        // she shares with somebody else.
        if (not.assignee?.some((id) => (task.assignees ?? []).includes(id))) return false;
        if (not.label?.some((id) => (task.labels ?? []).includes(id))) return false;
      }
      if (filters.due === 'overdue' && !(task.due_date && task.due_date < day)) return false;
      if (filters.due === 'today' && task.due_date !== day) return false;
      if (filters.due === 'none' && task.due_date) return false;
      if (filters.text) {
        const needle = filters.text.toLowerCase();
        const haystack = `${task.identifier} ${task.title} ${task.description ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (fieldFilters.length) {
        for (const [fieldId, wanted] of fieldFilters) {
          const field = byId('field', fieldId);
          // A filter on a field that has since been deleted is ignored rather
          // than obeyed: it would silently hide everything.
          if (!field) continue;
          if (!fieldMatches(field.kind, answers.get(`${task.id}.${fieldId}`), wanted)) return false;
        }
      }
      return true;
    });

    const sorters: Record<string, (a: Task, b: Task) => number> = {
      manual: byOrder,
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      due_date: (a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'),
      created_at: (a, b) => b.created_at - a.created_at,
      updated_at: (a, b) => b.updated_at - a.updated_at,
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...filtered].sort(sorters[view.orderBy] ?? byOrder);
  }, [tasks, view]);
}

/* --------------------------------------------------------------- controls */

/**
 * One menu section per custom field.
 *
 * A field with a list of options offers them. A field without one — a note, a
 * number, a date — offers the only two questions worth asking of it: is there
 * an answer, and is there not. That is what somebody actually wants from
 * "steps to reproduce": which bugs are missing them.
 */
function fieldFilterItems(
  field: Field,
  view: ViewConfig,
  t: ReturnType<typeof useT>,
  members: { id: string; name: string }[],
  toggle: (fieldId: string, value: string) => void,
): MenuItem[] {
  const chosen = view.filters.field?.[field.id] ?? [];
  const choices: { value: string; label: string }[] = field.kind === 'person'
    ? members.map((member) => ({ value: member.id, label: member.name }))
    : field.kind === 'checkbox'
      ? [{ value: 'true', label: t('field.yes') }]
      : fieldChoices(field).map((option) => ({ value: option, label: option }));

  const tail = field.kind === 'checkbox'
    ? [{ value: FIELD_EMPTY, label: t('field.no') }]
    : [
      ...(choices.length ? [] : [{ value: FIELD_ANSWERED, label: t('field.answered') }]),
      { value: FIELD_EMPTY, label: t('field.noAnswer') },
    ];

  return [...choices, ...tail].map(({ value, label }) => ({
    id: `field-${field.id}-${value || 'empty'}`,
    section: field.name,
    label,
    hint: chosen.includes(value) ? '✓' : undefined,
    onSelect: () => toggle(field.id, value),
  }));
}

export function ViewControls({
  view, onChange, projectId, saveable,
}: {
  view: ViewConfig;
  onChange: (next: ViewConfig) => void;
  projectId?: string;
  /**
   * Offer saved views. Off for a cycle or a module: those screens already show
   * one slice of the project, and a view saved there would be a filter set that
   * has nothing to do with the cycle it was saved from.
   */
  saveable?: boolean;
}) {
  const t = useT();
  const states = useStates(projectId);
  const types = useTypes(projectId);
  const labels = useLabels(projectId);
  const members = useMembers();
  const fields = useFields(projectId);
  const { workspaceId } = useSession();

  const toggle = <K extends keyof Filters>(key: K, value: string) => {
    const current = (view.filters[key] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    onChange({ ...view, filters: { ...view.filters, [key]: next.length ? next : undefined } });
  };

  const toggleField = (fieldId: string, value: string) => {
    const current = view.filters.field?.[fieldId] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const field = { ...view.filters.field };
    if (next.length) field[fieldId] = next;
    else delete field[fieldId];
    onChange({
      ...view,
      filters: { ...view.filters, field: Object.keys(field).length ? field : undefined },
    });
  };

  const filterItems: MenuItem[] = [
    ...states.map((state) => ({
      id: `state-${state.id}`,
      section: t('view.groupState'),
      label: state.name,
      hint: view.filters.state?.includes(state.id) ? '✓' : undefined,
      icon: <StateDot group={state.group_key} color={state.color} />,
      onSelect: () => toggle('state', state.id),
    })),
    ...types.map((type) => ({
      id: `type-${type.id}`,
      section: t('type.label'),
      label: `${type.icon ?? ''} ${type.name}`.trim(),
      hint: view.filters.type?.includes(type.id) ? '✓' : undefined,
      onSelect: () => toggle('type', type.id),
    })),
    ...PRIORITIES.map((priority) => ({
      id: `priority-${priority}`,
      section: t('view.groupPriority'),
      label: t(priorityKey(priority)),
      hint: view.filters.priority?.includes(priority) ? '✓' : undefined,
      onSelect: () => toggle('priority', priority),
    })),
    ...members.map((member) => ({
      id: `assignee-${member.id}`,
      section: t('view.groupAssignee'),
      label: member.name,
      hint: view.filters.assignee?.includes(member.id) ? '✓' : undefined,
      onSelect: () => toggle('assignee', member.id),
    })),
    ...labels.map((label) => ({
      id: `label-${label.id}`,
      section: t('view.groupLabel'),
      label: label.name,
      hint: view.filters.label?.includes(label.id) ? '✓' : undefined,
      onSelect: () => toggle('label', label.id),
    })),
    ...fields.flatMap((field) => fieldFilterItems(field, view, t, members, toggleField)),
    { id: 'clear', section: t('view.reset'), label: t('view.clearFilters'), onSelect: () => onChange({ ...view, filters: {} }) },
  ];

  const activeFilters = Object.entries(view.filters)
    // A field filter is one entry holding several, and counting it as one would
    // under-report the badge that tells somebody why the list is short.
    .reduce((count, [key, value]) => count
      + (key === 'field' ? Object.values(value as Record<string, string[]>).filter((v) => v.length).length
        : Array.isArray(value) ? (value.length ? 1 : 0) : value ? 1 : 0), 0);

  return (
    // Emphatically not `flex-wrap`. Every one of these lives in the header,
    // which is one row 52px tall and scrolls sideways when its contents do not
    // fit — see `.header` in `app.css`. Allowed to wrap, the second row had
    // nowhere to go and drew itself straight over the tab strip below.
    <div className="flex items-center gap-1.5">
      {saveable && <SavedViews view={view} onChange={onChange} projectId={projectId} />}
      <QueryBox
        filters={view.filters}
        workspaceId={workspaceId}
        projectId={projectId}
        onChange={(filters) => onChange({ ...view, filters })}
      />
      {/* Four buttons side by side are right where there is room and too many
          on a phone, where the header also carries saved views, filter, display
          and the add button. Same choice, one button. */}
      <div className="flex items-center not-sm gap-0.5" style={{ border: '1px solid var(--line-strong)', borderRadius: 7, padding: 2 }}>
        {BUILT_LAYOUTS.map((layout) => (
          <button
            key={layout}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), view.layout === layout && 'bg-active text-fg')}
            style={view.layout === layout ? { background: 'var(--bg-active)' } : undefined}
            onClick={() => onChange({ ...view, layout })}
            title={t(LAYOUT_KEY[layout])}
            aria-label={t(LAYOUT_KEY[layout])}
            aria-pressed={view.layout === layout}
          >
            <Icon name={layout} size={14} />
          </button>
        ))}
      </div>
      <MenuButton
        className={cn(buttonVariants({ size: 'sm' }), 'only-sm')}
        title={t(LAYOUT_KEY[view.layout])}
        items={BUILT_LAYOUTS.map((layout) => ({
          id: layout,
          label: t(LAYOUT_KEY[layout]),
          icon: <Icon name={layout} size={14} />,
          hint: view.layout === layout ? '✓' : undefined,
          onSelect: () => onChange({ ...view, layout }),
        }))}
      >
        <Icon name={view.layout} size={14} />
      </MenuButton>

      <MenuButton
        variant="secondary" size="sm"
        search
        items={filterItems}
      >
        <Icon name="filter" size={14} />
        <span className="hide-sm">{t('view.filter')}</span>{activeFilters ? ` ${activeFilters}` : ''}
      </MenuButton>

      <MenuButton
        variant="secondary" size="sm"
        items={[
          ...(['state', 'type', 'priority', 'assignee', 'label', 'cycle', 'project', 'none'] as BaseGroupBy[]).map((groupBy) => ({
            id: groupBy,
            section: t('view.groupBy'),
            label: t(GROUP_BY_KEY[groupBy]),
            hint: view.groupBy === groupBy ? '✓' : undefined,
            onSelect: () => onChange({ ...view, groupBy }),
          })),
          // Only the fields whose answers come from a short list: grouping by a
          // free-text field is one heading per task.
          ...fields.filter((field) => isGroupable(field.kind)).map((field) => ({
            id: fieldGroupId(field.id),
            section: t('view.groupBy'),
            label: field.name,
            hint: view.groupBy === fieldGroupId(field.id) ? '✓' : undefined,
            onSelect: () => onChange({ ...view, groupBy: fieldGroupId(field.id) }),
          })),
          ...(['manual', 'priority', 'due_date', 'updated_at', 'title'] as ViewConfig['orderBy'][]).map((orderBy) => ({
            id: `order-${orderBy}`,
            section: t('view.orderBy'),
            label: t(ORDER_BY_KEY[orderBy]),
            hint: view.orderBy === orderBy ? '✓' : undefined,
            onSelect: () => onChange({ ...view, orderBy }),
          })),
          {
            id: 'done',
            section: t('view.display'),
            label: view.showDone ? t('view.hideCompleted') : t('view.showCompleted'),
            onSelect: () => onChange({ ...view, showDone: !view.showDone }),
          },
        ]}
      >
        <Icon name="sliders" size={14} />
        <span className="hide-sm">{t('view.display')}</span>
      </MenuButton>
    </div>
  );
}

/* ------------------------------------------------------------------- list */

export function ListView({
  tasks, view, onOpen, showProject, selection,
}: {
  tasks: Task[]; view: ViewConfig; onOpen: (task: Task) => void; showProject?: boolean; selection?: Selection;
}) {
  const t = useT();
  const states = useStates(undefined);
  const labels = useLabels(undefined);
  const members = useMembers();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () => groupTasks(tasks, view.groupBy, { states, members, labels, t }).filter((group) => group.tasks.length),
    [tasks, view.groupBy, states, members, labels, t],
  );

  // Shift-click needs the order the eye sees, not the order the array is in.
  const order = useMemo(() => groups.flatMap((group) => group.tasks.map((task) => task.id)), [groups]);

  if (!tasks.length) return <Empty emoji="🗒️" title={t('view.emptyTitle')} hint={t('view.emptyHint')} guide="views" />;

  return (
    <div>
      {groups.map((group) => {
        const ids = group.tasks.map((task) => task.id);
        const allSelected = !!selection && ids.every((id) => selection.has(id));
        return (
          <section key={group.id}>
            <div className="task-group">
              {selection && (
                <span
                  className="select-box"
                  onClick={() => selection.setMany(ids, !allSelected)}
                >
                  <input type="checkbox" checked={allSelected} aria-label={t('select.selectGroup')} onChange={() => {}} />
                </span>
              )}
              {/* The row's vertical padding lives on this button rather than on
                  the row, so the whole 35px band is tappable. With `padding: 0`
                  it looked like a row and answered to 19px of it, which on a
                  phone reads as a button that sometimes works. */}
              <button
                className="flex-1 min-w-0 flex items-center gap-2"
                style={{ border: 'none', background: 'none', cursor: 'pointer', gap: 7, padding: '10px 0 6px', font: 'inherit', color: 'inherit' }}
                onClick={() => setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))}
              >
                <Icon name={collapsed[group.id] ? 'chevronRight' : 'chevronDown'} size={13} />
                {group.color && <StateDot group={group.group} color={group.color} size={10} />}
                <span>{group.title}</span>
                <span className={navCount}>{group.tasks.length}</span>
              </button>
            </div>
            {!collapsed[group.id] && group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} onOpen={onOpen} showProject={showProject} selection={selection} order={order} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ board */

export function BoardView({
  tasks, view, onOpen, projectId,
}: { tasks: Task[]; view: ViewConfig; onOpen: (task: Task) => void; projectId?: string }) {
  const t = useT();
  const states = useStates(projectId);
  const labels = useLabels(projectId);
  const members = useMembers();
  const fields = useFields(projectId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  /** Where in the column the card would land — the gap the line is drawn in. */
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const canWrite = useCanWrite();
  /** `null` while the button is a button; a string while it is a field. */
  const [draftColumn, setDraftColumn] = useState<string | null>(null);

  const groups = useMemo(
    () => groupTasks(tasks, view.groupBy === 'none' ? 'state' : view.groupBy, { states, members, labels, t }),
    [tasks, view.groupBy, states, members, labels, t],
  );

  // Only on a project's own board, only when the columns are the states, and
  // only for somebody who may write. A board across several projects has no one
  // project to add the column to.
  const grouping = view.groupBy === 'none' ? 'state' : view.groupBy;
  const canAddColumn = canWrite && !!projectId && grouping === 'state';

  /** Dropping on a column both reorders and rewrites the grouped-by field. */
  /**
   * Drop a card into a column, at a position.
   *
   * `at` is the index it should land on among the column's other cards. A drop
   * used to append to the end regardless of where the card was released, which
   * is fine for a triage board and wrong for any board people order by hand.
   */
  const drop = (groupId: string, dropped?: Task, at?: number) => {
    const task = dropped ?? (dragId ? byId('task', dragId) : undefined);
    setDragId(null);
    setOverColumn(null);
    setOverIndex(null);
    if (!task) return;
    const column = groups.find((group) => group.id === groupId);
    const others = (column?.tasks ?? []).filter((other) => other.id !== task.id);
    const index = at === undefined ? others.length : Math.max(0, Math.min(at, others.length));
    const patch: Record<string, unknown> = {
      sort_order: orderKey(others[index - 1]?.sort_order ?? null, others[index]?.sort_order ?? null),
    };
    if (view.groupBy === 'state' || view.groupBy === 'none') patch.state_id = groupId;
    if (view.groupBy === 'priority') patch.priority = groupId;
    if (view.groupBy === 'type') patch.type_id = groupId === 'none' ? null : groupId;
    if (view.groupBy === 'cycle') patch.cycle_id = groupId === 'none' ? null : groupId;
    if (view.groupBy === 'assignee') patch.assignees = groupId === 'none' ? [] : [groupId];
    if (view.groupBy === 'label') {
      // Adding rather than replacing, for the reason a rule adds one: a task can
      // carry several labels, and a drag that quietly stripped the rest would be
      // a destructive gesture that looks like a tidy-up. The "no label" column
      // is the one place that clears them, because that is what it says.
      patch.labels = groupId === 'none' ? [] : [...new Set([...(task.labels ?? []), groupId])];
    }
    update('task', task.id, patch);

    const field = byId('field', groupedField(view.groupBy) ?? undefined);
    if (field) {
      const current = readFieldValue(field.kind, byId('fieldValue', fieldValueId(task.id, field.id))?.value);
      // Same rule as labels: a several-of field gains the column it was dropped
      // on and keeps what it had, so the card stays in the columns it belongs
      // to rather than losing them to a drag.
      const next = groupId === 'none'
        ? emptyValue(field.kind)
        : field.kind === 'multi_select'
          ? [...new Set([...(current as string[]), groupId])]
          : field.kind === 'checkbox' ? true : groupId;
      setFieldValue(task, field, next);
    }
  };

  return (
    <div className="board">
      {groups.map((group) => (
        <div
          key={group.id}
          className={`board-column${overColumn === group.id ? ' drop-target' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOverColumn(group.id);
            // Which gap the pointer is nearest: measure the cards rather than
            // guess, so the line is where the card will actually go.
            const cards = [...event.currentTarget.querySelectorAll('.task-card')] as HTMLElement[];
            const visible = cards.filter((card) => !card.classList.contains('dragging'));
            let index = visible.length;
            for (let position = 0; position < visible.length; position++) {
              const box = visible[position].getBoundingClientRect();
              if (event.clientY < box.top + box.height / 2) {
                index = position;
                break;
              }
            }
            setOverIndex(index);
          }}
          onDragLeave={() => setOverColumn((current) => (current === group.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            drop(group.id, undefined, overIndex ?? undefined);
          }}
        >
          <header>
            {group.color && <StateDot group={group.group} color={group.color} size={10} />}
            <span className="flex-1 min-w-0 truncate">{group.title}</span>
            {(() => {
              // A limit is a number the team agreed, so it is shown as a
              // fraction and marked when it is broken — never enforced by
              // refusing a drop, which only teaches people to work elsewhere.
              const limit = view.groupBy === 'state' ? byId('state', group.id)?.wip_limit ?? 0 : 0;
              if (!limit) return <span className="text-muted">{group.tasks.length}</span>;
              const over = group.tasks.length > limit;
              return (
                <span className={over ? 'wip over' : 'wip'} title={t('state.wipHint', { limit })}>
                  {group.tasks.length}/{limit}
                </span>
              );
            })()}
          </header>
          <div className="items">
            {group.tasks.map((task, position) => (
              <Fragment key={task.id}>
                {overColumn === group.id && overIndex === position && dragId !== task.id && <div className="drop-line" />}
              <TaskCard
                task={task}
                onOpen={onOpen}
                dragging={dragId === task.id}
                moveTargets={groups.map((target) => ({
                  id: target.id,
                  title: target.title,
                  onSelect: () => drop(target.id, task),
                }))}
                onDragStart={(event) => {
                  setDragId(task.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', task.id);
                }}
              />
              </Fragment>
            ))}
            {overColumn === group.id && overIndex !== null && overIndex >= group.tasks.length && <div className="drop-line" />}
            {!group.tasks.length && <span className="text-muted text-[12.5px]" style={{ padding: '6px 2px' }}>{t('common.empty')}</span>}
          </div>
        </div>
      ))}

      {/*
        A column can only be added when the board *is* the columns — grouped by
        state. Grouped by assignee, "add a column" would mean adding a person,
        and by priority it would mean inventing a sixth priority; neither is a
        thing this button can honestly do.

        It was already possible in Project → Settings, at the foot of a long
        page. Every other tool puts it at the right-hand end of the board, which
        is where people look and where the shape of the board makes it obvious
        what is about to happen.
      */}
      {canAddColumn && (
        <div className="board-column board-add">
          {draftColumn === null ? (
            <>
              <button type="button" onClick={() => setDraftColumn('')}>
                <Icon name="plus" size={14} /> {t('project.addColumn')}
              </button>
              <span className="text-muted text-[12px]">{t('project.addColumnHint')}</span>
            </>
          ) : (
            // In place rather than a dialog. Adding three columns in a row is
            // the normal case the first time somebody sets a board up, and a
            // dialog that has to be dismissed between each one makes the third
            // feel like an argument.
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const name = draftColumn.trim();
                if (!name) { setDraftColumn(null); return; }
                create('state', {
                  project_id: projectId,
                  name,
                  group_key: 'unstarted',
                  color: '#64748b',
                  sort_order: orderKey(states[states.length - 1]?.sort_order ?? null, null),
                });
                setDraftColumn('');
              }}
            >
              <Input
                autoFocus
                aria-label={t('project.addColumn')}
                placeholder={t('project.newColumnPrompt')}
                value={draftColumn}
                onChange={(event) => setDraftColumn(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setDraftColumn(null); }}
              />
              {/* Enter submits, and so does this. A form whose only way out is
                  the Enter key is one nobody finds on a phone — and the source
                  check in `forms.test.ts` says so before a person has to. */}
              <div className="flex items-center gap-1.5">
                <Button type="submit" size="sm" variant="primary" disabled={!draftColumn.trim()}>
                  {t('action.add')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraftColumn(null)}>
                  {t('action.cancel')}
                </Button>
              </div>
              <span className="text-muted text-[12px]">{t('project.addColumnHint')}</span>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- calendar */

export function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const t = useT();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7; // weeks start on Monday
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [month]);

  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.due_date) continue;
      const bucket = map.get(task.due_date) ?? [];
      bucket.push(task);
      map.set(task.due_date, bucket);
    }
    return map;
  }, [tasks]);

  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return (
    <div style={{ padding: 12 }}>
      <div className="flex items-center gap-2 mb-2.5">
        <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label={t('view.previousMonth')}><Icon name="chevronLeft" /></Button>
        <strong>{month.toLocaleDateString(currentLocale(), { month: 'long', year: 'numeric' })}</strong>
        <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label={t('view.nextMonth')}><Icon name="chevronRight" /></Button>
        <span className="flex-1 min-w-0" />
        <Button size="sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('common.today')}</Button>
      </div>
      <div className="calendar">
        {WEEKDAY_KEYS.map((weekday) => (
          <div className="weekday" key={weekday}>{t(weekday)}</div>
        ))}
        {days.map((date) => {
          const key = iso(date);
          const items = byDate.get(key) ?? [];
          return (
            <div
              key={key}
              className={`day${date.getMonth() !== month.getMonth() ? ' other' : ''}${key === today() ? ' today' : ''}`}
            >
              <span className="num">{date.getDate()}</span>
              {items.slice(0, 4).map((task) => (
                <span key={task.id} className="pill" onClick={() => onOpen(task)} title={task.title}>
                  {task.title}
                </span>
              ))}
              {items.length > 4 && <span className="text-muted text-[10px]">+{items.length - 4}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ table */

/** Columns, in the order they are shown. Narrow ones drop out on a phone. */
const COLUMNS = [
  { id: 'identifier', label: 'table.id' as const, orderBy: null, narrow: true },
  { id: 'title', label: 'table.title' as const, orderBy: 'title' as const, narrow: false },
  { id: 'type', label: 'type.label' as const, orderBy: null, narrow: true },
  { id: 'state', label: 'table.state' as const, orderBy: null, narrow: false },
  { id: 'assignees', label: 'table.assignees' as const, orderBy: null, narrow: false },
  { id: 'priority', label: 'table.priority' as const, orderBy: 'priority' as const, narrow: false },
  { id: 'due_date', label: 'table.due' as const, orderBy: 'due_date' as const, narrow: false },
  { id: 'estimate', label: 'table.estimate' as const, orderBy: null, narrow: true },
  { id: 'labels', label: 'table.labels' as const, orderBy: null, narrow: true },
  { id: 'updated_at', label: 'table.updated' as const, orderBy: 'updated_at' as const, narrow: true },
];

/**
 * One row per task and nothing else — the layout for comparing rather than
 * reading. Grouping still applies: a group becomes a header row rather than a
 * separate table, so the columns stay aligned down the whole page.
 */
export function TableView({
  tasks, view, onOpen, onChange, selection,
}: {
  tasks: Task[];
  view: ViewConfig;
  onOpen: (task: Task) => void;
  /** Clicking a sortable header changes the view, exactly as the menu does. */
  onChange?: (next: ViewConfig) => void;
  selection?: Selection;
}) {
  const t = useT();
  const states = useStates(undefined);
  const labels = useLabels(undefined);
  const members = useMembers();
  const memberMap = useMemberMap();
  const nameMap = useMemo(() => new Map([...memberMap].map(([id, user]) => [id, user.name])), [memberMap]);
  // Custom columns are per project, so they only appear when the rows on screen
  // come from one — a mixed list has no shared set of fields to line up.
  const project = tasks.length && tasks.every((task) => task.project_id === tasks[0].project_id) ? tasks[0].project_id : undefined;
  const extra = useQuery(
    () => (project
      ? list('field', (f) => f.project_id === project && !f.archived && !!f.show_in_table)
        .sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1))
      : []),
    [project],
  );
  const values = useQuery(() => {
    const map = new Map<string, string | null>();
    for (const row of list('fieldValue', (v) => !!extra.length && v.project_id === project)) {
      map.set(`${row.task_id}.${row.field_id}`, row.value);
    }
    return map;
  }, [project, extra.length]);

  const groups = useMemo(
    () => groupTasks(tasks, view.groupBy, { states, members, labels, t }).filter((group) => group.tasks.length),
    [tasks, view.groupBy, states, members, labels, t],
  );
  const order = useMemo(() => groups.flatMap((group) => group.tasks.map((task) => task.id)), [groups]);
  const allSelected = !!selection && order.length > 0 && order.every((id) => selection.has(id));

  if (!tasks.length) return <Empty emoji="🗒️" title={t('view.emptyTitle')} hint={t('view.emptyHint')} guide="views" />;

  return (
    <div className="table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            {selection && (
              <th className="pick">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label={t('select.selectGroup')}
                  onChange={() => selection.setMany(order, !allSelected)}
                />
              </th>
            )}
            {[...COLUMNS, ...extra.map((field) => ({ id: field.id, label: null, orderBy: null, narrow: true, field }))].map((column: any) => (
              <th key={column.id} className={`${column.field ? 'custom' : column.id}${column.narrow ? ' narrow' : ''}`}>
                {column.field ? column.field.name : null}
                {column.orderBy && onChange ? (
                  <button
                    className="sort"
                    aria-pressed={view.orderBy === column.orderBy}
                    onClick={() => onChange({ ...view, orderBy: column.orderBy! })}
                  >
                    {t(column.label)}
                    {view.orderBy === column.orderBy && <Icon name="chevronDown" size={11} />}
                  </button>
                ) : column.label ? t(column.label) : null}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id}>
            {view.groupBy !== 'none' && (
              <tr className="group">
                <th colSpan={COLUMNS.length + extra.length + (selection ? 1 : 0)}>
                  {group.color && <StateDot group={group.group} color={group.color} size={9} />}
                  <span>{group.title}</span>
                  <span className={navCount}>{group.tasks.length}</span>
                </th>
              </tr>
            )}
            {group.tasks.map((task) => {
              const state = byId('state', task.state_id);
              const done = state?.group_key === 'completed' || state?.group_key === 'cancelled';
              const people = (task.assignees ?? []).map((id) => memberMap.get(id)).filter(Boolean) as any[];
              return (
                <tr
                  key={task.id}
                  className={`${done ? 'done' : ''}${selection?.has(task.id) ? ' selected' : ''}`}
                  onClick={() => onOpen(task)}
                >
                  {selection && (
                    <td className="pick" onClick={(event) => event.stopPropagation()}>
                      <SelectBox id={task.id} order={order} selection={selection} label={t('select.selectRow')} />
                    </td>
                  )}
                  <td className="identifier narrow">{task.identifier}</td>
                  <td className="title">{task.title}</td>
                  <td className="type narrow">
                    {(() => {
                      const type = byId('taskType', task.type_id ?? undefined);
                      return type ? `${type.icon ?? ''} ${type.name}`.trim() : '';
                    })()}
                  </td>
                  <td className="state">
                    <StateDot group={state?.group_key} color={state?.color} /> {state?.name ?? ''}
                  </td>
                  <td className="assignees"><AvatarStack users={people} size={20} /></td>
                  <td className="priority">
                    {task.priority !== 'none' && <><PriorityBars priority={task.priority} /> {t(priorityKey(task.priority))}</>}
                  </td>
                  <td className="due_date">{task.due_date ? shortDate(task.due_date) : ''}</td>
                  <td className="estimate narrow">{task.estimate ?? ''}</td>
                  <td className="labels narrow"><LabelChips ids={task.labels ?? []} projectId={task.project_id} /></td>
                  <td className="updated_at narrow">{shortDate(task.updated_at)}</td>
                  {extra.map((field) => (
                    <td className="custom narrow" key={field.id}>
                      {formatFieldValue(field.kind, values.get(`${task.id}.${field.id}`), nameMap)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- dispatcher */


export function TaskViews(props: {
  tasks: Task[];
  view: ViewConfig;
  onOpen: (task: Task) => void;
  projectId?: string;
  showProject?: boolean;
  onChange?: (next: ViewConfig) => void;
  selection?: Selection;
}) {
  // The board and the calendar have no room for a checkbox column and no row
  // to put one in; selecting there is a different gesture, not a smaller one.
  if (props.view.layout === 'board') return <BoardView {...props} />;
  if (props.view.layout === 'calendar') return <CalendarView tasks={props.tasks} onOpen={props.onOpen} />;
  if (props.view.layout === 'table') return <TableView {...props} />;
  if (props.view.layout === 'gantt') {
    return <GanttView tasks={props.tasks} onOpen={props.onOpen} projectId={props.projectId} />;
  }
  return <ListView {...props} />;
}

/** Small helper used by cycle pages. */
export function CycleProgress({ cycleId }: { cycleId: string }) {
  const t = useT();
  const tasks = useQuery(() => list('task', (t) => t.cycle_id === cycleId), [cycleId]);
  const done = tasks.filter((task) => {
    const group = byId('state', task.state_id)?.group_key;
    return group === 'completed' || group === 'cancelled';
  }).length;
  const cycle = byId('cycle', cycleId);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="flex-1 min-w-0 truncate">{cycle?.name}</span>
        <span className="text-muted">{done}/{tasks.length}</span>
      </div>
      <div className="progress"><i style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} /></div>
      {cycle?.end_date && <span className="text-muted text-[11.5px]">{t('cycle.endsOn', { date: shortDate(cycle.end_date) })}</span>}
    </div>
  );
}
