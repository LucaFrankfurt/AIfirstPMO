import { useMemo, useState } from 'react';
import type { Filters, Layout, Task } from '@kolibri/shared';
import { orderKey, PRIORITIES } from '@kolibri/shared';
import { byId, list, useQuery } from '../lib/store';
import { byOrder, update } from '../lib/mutations';
import { currentLocale, priorityKey, useT, type TranslationKey } from '../lib/i18n';
import { shortDate, today } from '../lib/format';
import { useMemberMap, useMembers } from '../session';
import { groupTasks, LabelChips, TaskCard, TaskRow, useLabels, useStates, useTypes, type GroupBy } from './task-parts';
import { AvatarStack, Empty, Icon, MenuButton, PriorityBars, StateDot, type MenuItem } from './ui';
import { SavedViews } from './saved-views';
import { SelectBox, type Selection } from './selection';

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
  list: 'view.list', board: 'view.board', calendar: 'view.calendar', table: 'view.table',
};

/** The layouts that are built. `LAYOUTS` also declares `gantt`, which is not. */
const BUILT_LAYOUTS: Layout[] = ['list', 'board', 'table', 'calendar'];

const GROUP_BY_KEY: Record<GroupBy, TranslationKey> = {
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
      if (filters.due === 'overdue' && !(task.due_date && task.due_date < day)) return false;
      if (filters.due === 'today' && task.due_date !== day) return false;
      if (filters.due === 'none' && task.due_date) return false;
      if (filters.text) {
        const needle = filters.text.toLowerCase();
        const haystack = `${task.identifier} ${task.title} ${task.description ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
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

  const toggle = <K extends keyof Filters>(key: K, value: string) => {
    const current = (view.filters[key] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    onChange({ ...view, filters: { ...view.filters, [key]: next.length ? next : undefined } });
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
    { id: 'clear', section: t('view.reset'), label: t('view.clearFilters'), onSelect: () => onChange({ ...view, filters: {} }) },
  ];

  const activeFilters = Object.values(view.filters).filter((value) => (Array.isArray(value) ? value.length : !!value)).length;

  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {saveable && <SavedViews view={view} onChange={onChange} projectId={projectId} />}
      {/* Four buttons side by side are right where there is room and too many
          on a phone, where the header also carries saved views, filter, display
          and the add button. Same choice, one button. */}
      <div className="row not-sm" style={{ gap: 2, border: '1px solid var(--line-strong)', borderRadius: 7, padding: 2 }}>
        {BUILT_LAYOUTS.map((layout) => (
          <button
            key={layout}
            className={`btn ghost sm${view.layout === layout ? ' active' : ''}`}
            style={view.layout === layout ? { background: 'var(--bg-active)' } : undefined}
            onClick={() => onChange({ ...view, layout })}
            title={t(LAYOUT_KEY[layout])}
            aria-pressed={view.layout === layout}
          >
            <Icon name={layout} size={14} />
          </button>
        ))}
      </div>
      <MenuButton
        className="btn sm only-sm"
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
        className="btn sm"
        search
        items={filterItems}
      >
        <Icon name="filter" size={14} />
        <span className="hide-sm">{t('view.filter')}</span>{activeFilters ? ` ${activeFilters}` : ''}
      </MenuButton>

      <MenuButton
        className="btn sm"
        items={[
          ...(['state', 'type', 'priority', 'assignee', 'label', 'cycle', 'project', 'none'] as GroupBy[]).map((groupBy) => ({
            id: groupBy,
            section: t('view.groupBy'),
            label: t(GROUP_BY_KEY[groupBy]),
            hint: view.groupBy === groupBy ? '✓' : undefined,
            onSelect: () => onChange({ ...view, groupBy }),
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
        <Icon name="list" size={14} />
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
              <button
                className="grow row"
                style={{ border: 'none', background: 'none', cursor: 'pointer', gap: 7, padding: 0, font: 'inherit', color: 'inherit' }}
                onClick={() => setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))}
              >
                <Icon name={collapsed[group.id] ? 'chevronRight' : 'chevronDown'} size={13} />
                {group.color && <StateDot group={group.group} color={group.color} size={10} />}
                <span>{group.title}</span>
                <span className="count">{group.tasks.length}</span>
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const groups = useMemo(
    () => groupTasks(tasks, view.groupBy === 'none' ? 'state' : view.groupBy, { states, members, labels, t }),
    [tasks, view.groupBy, states, members, labels, t],
  );

  /** Dropping on a column both reorders and rewrites the grouped-by field. */
  const drop = (groupId: string, dropped?: Task) => {
    const task = dropped ?? (dragId ? byId('task', dragId) : undefined);
    setDragId(null);
    setOverColumn(null);
    if (!task) return;
    const column = groups.find((group) => group.id === groupId);
    const last = column?.tasks.filter((t) => t.id !== task.id).slice(-1)[0];
    const patch: Record<string, unknown> = { sort_order: orderKey(last?.sort_order ?? null, null) };
    if (view.groupBy === 'state' || view.groupBy === 'none') patch.state_id = groupId;
    if (view.groupBy === 'priority') patch.priority = groupId;
    if (view.groupBy === 'cycle') patch.cycle_id = groupId === 'none' ? null : groupId;
    if (view.groupBy === 'assignee') patch.assignees = groupId === 'none' ? [] : [groupId];
    update('task', task.id, patch);
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
          }}
          onDragLeave={() => setOverColumn((current) => (current === group.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            drop(group.id);
          }}
        >
          <header>
            {group.color && <StateDot group={group.group} color={group.color} size={10} />}
            <span className="grow truncate">{group.title}</span>
            <span className="muted">{group.tasks.length}</span>
          </header>
          <div className="items">
            {group.tasks.map((task) => (
              <TaskCard
                key={task.id}
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
            ))}
            {!group.tasks.length && <span className="muted" style={{ fontSize: 12, padding: '6px 2px' }}>{t('common.empty')}</span>}
          </div>
        </div>
      ))}
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
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn ghost icon" onClick={() => shift(-1)} aria-label={t('view.previousMonth')}><Icon name="chevronLeft" /></button>
        <strong>{month.toLocaleDateString(currentLocale(), { month: 'long', year: 'numeric' })}</strong>
        <button className="btn ghost icon" onClick={() => shift(1)} aria-label={t('view.nextMonth')}><Icon name="chevronRight" /></button>
        <span className="grow" />
        <button className="btn sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('common.today')}</button>
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
              {items.length > 4 && <span className="muted" style={{ fontSize: 10 }}>+{items.length - 4}</span>}
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
            {COLUMNS.map((column) => (
              <th key={column.id} className={`${column.id}${column.narrow ? ' narrow' : ''}`}>
                {column.orderBy && onChange ? (
                  <button
                    className="sort"
                    aria-pressed={view.orderBy === column.orderBy}
                    onClick={() => onChange({ ...view, orderBy: column.orderBy! })}
                  >
                    {t(column.label)}
                    {view.orderBy === column.orderBy && <Icon name="chevronDown" size={11} />}
                  </button>
                ) : t(column.label)}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id}>
            {view.groupBy !== 'none' && (
              <tr className="group">
                <th colSpan={COLUMNS.length + (selection ? 1 : 0)}>
                  {group.color && <StateDot group={group.group} color={group.color} size={9} />}
                  <span>{group.title}</span>
                  <span className="count">{group.tasks.length}</span>
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
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ fontSize: 12.5 }}>
        <span className="grow truncate">{cycle?.name}</span>
        <span className="muted">{done}/{tasks.length}</span>
      </div>
      <div className="progress"><i style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} /></div>
      {cycle?.end_date && <span className="muted" style={{ fontSize: 11.5 }}>{t('cycle.endsOn', { date: shortDate(cycle.end_date) })}</span>}
    </div>
  );
}
