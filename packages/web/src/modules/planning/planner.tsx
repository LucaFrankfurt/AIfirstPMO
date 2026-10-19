/**
 * The team planner: who is working on what, and when.
 *
 * One row per person, their dated work laid along the same timeline the Gantt
 * uses. Dragging a bar sideways moves the dates — through the same scheduler, so
 * whatever is blocked by it moves too — and dropping it on another row reassigns
 * it. That is the whole gesture: a planner is a place to *move work about*.
 *
 * On capacity, deliberately: load is counted in **tasks running at once**, not
 * in hours. `tasks.estimate` is in points, so any hour figure here would be an
 * invention — and an invented number in a capacity report is how a team ends up
 * planning against a spreadsheet nobody believes. The comfortable number is set
 * by whoever is looking, because it is their judgement, not a property of the
 * data.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  addDays, daysBetween, packRows, moveTask as planMove, span,
  type Dependency, type Task,
} from '@kolibri/shared';
import { shortDate, today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { update } from '../../kernel/sync/mutations';
import { useCanWrite, useMembers, useSession } from '../../kernel/identity/session';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { Avatar, Empty, Icon, StateDot } from '../../kernel/design-system/ui';

const DAY_WIDTH = 12;
/** Height of one task bar's row inside a person's lane. */
const SUB = 28;   // one stacked bar: 24px tall, 4px of air beneath it
/** The load strip at the foot of every lane. */
const STRIP = 10;
/**
 * The two widths that decide where a task's name is drawn.
 *
 * A bar is as long as the task runs, and most tasks here have a due date and no
 * start date — which is one day, which is 12px, which the 24px floor below
 * widens to a thumb. A name inside that is a sliver of one letter, and the
 * planner's own name column says *who*, not what: unlike the Gantt, there is no
 * second place reading the title. So a name too big for its bar is drawn beside
 * it instead, in the gap before whatever is next on that row.
 *
 * `INSIDE` is where a truncated name still says something — 72px is the 24px of
 * dot, gap and padding plus about six characters. `BESIDE` is the least gap
 * worth spending on one: under that, the row is busy enough that a name would
 * land on the next bar, and the tooltip is the honest answer.
 */
const INSIDE = 72;
const BESIDE = 44;
const UNASSIGNED = '__nobody__';
const LIMIT_KEY = 'kolibri.planner-limit';

interface Lane {
  id: string;
  name: string;
  user?: { id: string; name: string; avatar_url?: string | null };
  tasks: Task[];
  /** Which row inside the lane each task sits on, so two at once do not overlap. */
  row: Map<string, number>;
  /** Where the next bar on the same row starts, for a name drawn beside one. */
  after: Map<string, string>;
  rows: number;
  top: number;
  height: number;
}

export function Planner() {
  const t = useT();
  const canWrite = useCanWrite();
  const { workspaceId } = useSession();
  const members = useMembers();
  const [weeks, setWeeks] = useState(8);
  const [limit, setLimit] = useState(() => Number(localStorage.getItem(LIMIT_KEY)) || 3);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; days: number; lane: string | null } | null>(null);
  const board = useRef<HTMLDivElement>(null);

  useEffect(() => { localStorage.setItem(LIMIT_KEY, String(limit)); }, [limit]);

  const tasks = useQuery(
    () => list('task', (task) => !task.archived && (!!task.start_date || !!task.due_date)),
    [workspaceId],
  );
  const dependencies = useQuery<Dependency[]>(
    () => list('relation', (relation) => relation.kind === 'blocks')
      .map((relation) => ({ from: relation.task_id, to: relation.related_task_id, lag: relation.lag ?? 0 })),
    [workspaceId],
  );

  const from = useMemo(() => addDays(today(), -7), []);
  const to = addDays(from, weeks * 7);
  const totalDays = daysBetween(from, to) + 1;
  const x = (date: string): number => daysBetween(from, date) * DAY_WIDTH;

  const inWindow = useMemo(
    () => tasks.filter((task) => {
      const bounds = span(task)!;
      return bounds.end >= from && bounds.start <= to;
    }),
    [tasks, from, to],
  );

  const lanes = useMemo<Lane[]>(() => {
    const empty = () => ({
      tasks: [] as Task[], row: new Map<string, number>(), after: new Map<string, string>(),
      rows: 1, top: 0, height: 0,
    });
    const out: Lane[] = members.map((user) => ({ id: user.id, name: user.name, user, ...empty() }));
    const nobody: Lane = { id: UNASSIGNED, name: t('planner.unassigned'), ...empty() };
    const byUser = new Map(out.map((lane) => [lane.id, lane]));
    for (const task of inWindow) {
      const assignees = task.assignees ?? [];
      if (!assignees.length) nobody.tasks.push(task);
      // A task with two people on it appears in both rows. It is one task in two
      // people's weeks, which is exactly what it is.
      for (const id of assignees) byUser.get(id)?.tasks.push(task);
    }
    const all = [...out, nobody].filter((lane) => lane.tasks.length || lane.id !== UNASSIGNED);
    let top = 0;
    for (const lane of all) {
      lane.tasks.sort((a, b) => span(a)!.start.localeCompare(span(b)!.start));
      const packed = packRows(lane.tasks);
      lane.row = packed.row;
      lane.rows = packed.rows;
      /* Who is next along each row. `lane.tasks` is already in start order, so
         the first task seen on a row after this one is the one that limits how
         far its name may reach. */
      const lastOnRow = new Map<number, Task>();
      for (const task of lane.tasks) {
        const index = packed.row.get(task.id) ?? 0;
        const previous = lastOnRow.get(index);
        if (previous) lane.after.set(previous.id, span(task)!.start);
        lastOnRow.set(index, task);
      }
      lane.top = top;
      lane.height = packed.rows * SUB + STRIP;
      top += lane.height;
    }
    return all;
  }, [members, inWindow, t]);

  const totalHeight = lanes.reduce((sum, lane) => sum + lane.height, 0);

  /** How many tasks each person has running on each day of the window. */
  const load = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const lane of lanes) {
      const days = new Array<number>(totalDays).fill(0);
      for (const task of lane.tasks) {
        const bounds = span(task)!;
        const start = Math.max(0, daysBetween(from, bounds.start));
        const end = Math.min(totalDays - 1, daysBetween(from, bounds.end));
        for (let day = start; day <= end; day++) days[day]++;
      }
      map.set(lane.id, days);
    }
    return map;
  }, [lanes, from, totalDays]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent): void => {
      const days = Math.round((event.clientX - drag.x) / DAY_WIDTH);
      // Lanes are different heights, so the row under the pointer is read from
      // the element it is over rather than divided out of a constant.
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.planner-lane');
      const lane = over?.getAttribute('data-lane') ?? drag.lane;
      if (days !== drag.days || lane !== drag.lane) setDrag({ ...drag, days, lane });
    };
    const onUp = (): void => {
      commit(drag);
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  });

  function commit(state: { id: string; days: number; lane: string | null }): void {
    if (!canWrite) return;
    const task = byId('task', state.id);
    if (!task) return;

    if (state.days) {
      const bounds = span(task)!;
      const scheduled = tasks.map((row) => ({ id: row.id, start_date: row.start_date, due_date: row.due_date }));
      const moves = planMove(
        task.id,
        task.start_date ? addDays(bounds.start, state.days) : null,
        task.due_date ? addDays(bounds.end, state.days) : null,
        scheduled,
        dependencies,
        // The planner crosses projects, so the calendar is looked up per task:
        // the project a task belongs to is the one that decides whether its
        // Saturday counts.
        { workingDays: (taskId) => byId('project', byId('task', taskId)?.project_id)?.working_days ?? null },
      );
      for (const move of moves) update('task', move.id, { start_date: move.start_date, due_date: move.due_date });
    }

    if (state.lane && !(task.assignees ?? []).includes(state.lane)) {
      // Reassigning replaces rather than adds: dragging a card to somebody is
      // saying "you do this", not "you as well".
      update('task', task.id, { assignees: state.lane === UNASSIGNED ? [] : [state.lane] });
    }
  }

  if (!members.length) return <Empty emoji="👥" title={t('planner.emptyTitle')} hint={t('planner.emptyHint')} guide="teams" />;

  const width = totalDays * DAY_WIDTH;
  const nowX = x(today());

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="flex items-center flex-wrap gap-2.5 mb-2.5">
        {/* `h1`, because this is the name of the screen. It was an `h2` and
            the planner was the one route in the app whose heading outline
            started halfway down. */}
        <h1 className="text-base m-0">{t('planner.title')}</h1>
        <span className="flex-1 min-w-0" />
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <span className="text-muted">{t('planner.limit')}</span>
          <Input type="number" min={1} max={20} style={{ width: 62 }}
            value={limit} onChange={(event) => setLimit(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <span className="text-muted">{t('planner.weeks')}</span>
          <Select style={{ width: 90 }} value={weeks}
            onChange={(event) => setWeeks(Number(event.target.value))}>
            {[4, 8, 13, 26].map((count) => <option key={count} value={count}>{count}</option>)}
          </Select>
        </label>
      </div>

      <p className="text-[12px] text-muted mb-2.5">{t('planner.hint')}</p>

      <div className="planner-scroll" ref={board}>
        <div className="planner-names">
          <div className="planner-head" />
          {lanes.map((lane) => (
            <div className="planner-name" key={lane.id} style={{ height: lane.height }}>
              {lane.user ? <Avatar user={lane.user} size={20} /> : <Icon name="inbox" size={15} />}
              <span className="truncate">{lane.name}</span>
              <span className="text-muted text-[11.5px]">{lane.tasks.length}</span>
            </div>
          ))}
        </div>

        <div className="planner-plot" style={{ width }}>
          <div className="planner-head" style={{ width }}>
            {Array.from({ length: weeks }, (_, index) => {
              const date = addDays(from, index * 7);
              return (
                <span key={date} className="planner-week" style={{ insetInlineStart: x(date), width: 7 * DAY_WIDTH }}>
                  {shortDate(date)}
                </span>
              );
            })}
          </div>

          <div className="planner-rows" style={{ width, height: totalHeight }}>
            {nowX >= 0 && nowX <= width && <span className="planner-today" style={{ insetInlineStart: nowX }} aria-hidden="true" />}

            {lanes.map((lane) => (
              <div className="planner-lane" key={lane.id} data-lane={lane.id} style={{ top: lane.top, height: lane.height, width }}>
                {/* The load strip: one block per day, darker the more is running.
                    Over the comfortable number it takes the warning colour and
                    the row says so in its title, never in colour alone. */}
                {(load.get(lane.id) ?? []).map((count, day) => (
                  count > 0 ? (
                    <span
                      key={day}
                      className={`planner-load${count > limit ? ' over' : ''}`}
                      style={{ insetInlineStart: day * DAY_WIDTH, width: DAY_WIDTH, opacity: Math.min(1, 0.25 + count * 0.2) }}
                      title={t('planner.loadOn', { date: shortDate(addDays(from, day)), count })}
                    />
                  ) : null
                ))}

                {lane.tasks.map((task) => {
                  const bounds = span(task)!;
                  const dragging = drag?.id === task.id;
                  const shifted = dragging && drag!.days
                    ? { start: addDays(bounds.start, drag!.days), end: addDays(bounds.end, drag!.days) }
                    : bounds;
                  const left = x(shifted.start);
                  // The 24px floor is the thumb-sized target the bar has to be;
                  // past that its length is the task's length and means it.
                  const barWidth = Math.max(24, (daysBetween(shifted.start, shifted.end) + 1) * DAY_WIDTH);
                  const state = byId('state', task.state_id);
                  const top = (lane.row.get(task.id) ?? 0) * SUB + 2;

                  /* Where the name goes. Inside when the bar can hold one;
                     otherwise in the gap before the next bar on this row, which
                     is what stops it being drawn over its neighbour. */
                  const next = lane.after.get(task.id);
                  const gap = (next === undefined ? width : x(next)) - (left + barWidth) - 6;
                  const beside = barWidth < INSIDE && gap >= BESIDE;
                  const name = `${task.identifier} ${task.title}`;

                  return (
                    <Fragment key={`${lane.id}-${task.id}`}>
                      <button
                        className={`planner-bar${dragging ? ' dragging' : ''}`}
                        style={{ insetInlineStart: left, width: barWidth, top }}
                        title={`${name} · ${shortDate(bounds.start)} – ${shortDate(bounds.end)}`}
                        // Spelled out rather than left to `title`: a bar too
                        // narrow for its name has no text at all inside it, and
                        // a screen reader would read a row of "button".
                        aria-label={name}
                        onPointerDown={(event) => {
                          if (!canWrite) return;
                          event.preventDefault();
                          setDrag({ id: task.id, x: event.clientX, y: event.clientY, days: 0, lane: null });
                        }}
                      >
                        <StateDot group={state?.group_key} color={state?.color} size={7} />
                        {barWidth >= INSIDE && <span className="truncate">{task.title}</span>}
                      </button>
                      {beside && (
                        /* Not inside the button: it would stretch the target
                           past the days the task actually runs, and this is a
                           caption rather than something to press. */
                        <span
                          className="planner-tag truncate"
                          style={{ insetInlineStart: left + barWidth + 4, maxWidth: gap, top }}
                          aria-hidden="true"
                        >
                          {task.title}
                        </span>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {!inWindow.length && (
        <p className="text-muted text-[13.5px] mt-3">{t('planner.nothingDated')}</p>
      )}
    </div>
  );
}
