/**
 * The Gantt view.
 *
 * Not a layout so much as a scheduler with a picture attached: bars can be
 * dragged and resized, dependencies are drawn between them, and moving one task
 * moves everything waiting on it. The rule that does the moving lives in
 * `@kolibri/shared` so the server applies the same one.
 *
 * The chart is plain elements rather than SVG for the bars — they have to be
 * dragged, focused and labelled — with one SVG layer on top for the arrows,
 * which are the only thing here that is genuinely a drawing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DAY, addDays, dayOf, daysBetween, isWorkingDay, isoDay, moveTask as planMove, span,
  type Dependency, type Task,
} from '@kolibri/shared';
import { shortDate, today } from '../lib/format';
import { useT } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { create, update } from '../lib/mutations';
import { useCanWrite } from '../session';
import { Empty, Icon, StateDot, useToast } from './ui';

/** How wide a day is, per zoom step. */
const ZOOM = [4, 8, 14, 26] as const;
const ROW = 34;

type Drag = {
  id: string;
  mode: 'move' | 'start' | 'end';
  originX: number;
  start: string;
  due: string;
  /** Days shifted so far, snapped. */
  days: number;
};

export function GanttView({ tasks, onOpen, projectId }: {
  tasks: Task[];
  onOpen: (task: Task) => void;
  projectId?: string;
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const toast = useToast();
  const [zoom, setZoom] = useState(2);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [baselineId, setBaselineId] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const dayWidth = ZOOM[zoom];

  const baselines = useQuery(
    () => list('baseline', (row) => !projectId || row.project_id === projectId)
      .sort((a, b) => b.taken_at - a.taken_at),
    [projectId],
  );
  const baseline = baselines.find((row) => row.id === baselineId);

  // `blocks` is the only relation that means "and therefore later"; the others
  // are cross-references, and drawing them as arrows would imply an order that
  // nobody wrote down.
  const ids = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  /**
   * The days this project works on. Used when the *scheduler* moves something;
   * a bar dragged onto a Saturday by hand stays there, because somebody who
   * did that has said what they meant.
   */
  const workingDays = useQuery(
    () => (projectId ? byId('project', projectId)?.working_days ?? null : null),
    [projectId],
  );

  const dependencies = useQuery<Dependency[]>(
    () => list('relation', (relation) => relation.kind === 'blocks')
      .filter((relation) => ids.has(relation.task_id) && ids.has(relation.related_task_id))
      .map((relation) => ({ from: relation.task_id, to: relation.related_task_id, lag: relation.lag ?? 0 })),
    [ids],
  );

  /** Only tasks with at least one date are on a timeline; the rest are listed under it. */
  const dated = useMemo(
    () => tasks
      .filter((task) => task.start_date || task.due_date)
      .sort((a, b) => (span(a)!.start).localeCompare(span(b)!.start) || a.title.localeCompare(b.title)),
    [tasks],
  );
  const undated = useMemo(() => tasks.filter((task) => !task.start_date && !task.due_date), [tasks]);

  const range = useMemo(() => {
    const now = today();
    if (!dated.length) return { from: addDays(now, -7), to: addDays(now, 30) };
    let first = span(dated[0])!.start;
    let last = first;
    for (const task of dated) {
      const bounds = span(task)!;
      if (bounds.start < first) first = bounds.start;
      if (bounds.end > last) last = bounds.end;
    }
    if (now < first) first = now;
    if (now > last) last = now;
    return { from: addDays(first, -3), to: addDays(last, 5) };
  }, [dated]);

  const totalDays = Math.max(1, daysBetween(range.from, range.to) + 1);
  const x = (date: string): number => daysBetween(range.from, date) * dayWidth;

  /**
   * The stretches this project does not work on, as one band per run of days,
   * so a weekend is one element rather than two and a fortnight's holiday
   * shutdown is still one.
   */
  const offDays = useMemo(() => {
    const days = workingDays;
    if (!days?.length || days.length >= 7 || dayWidth < 6) return [];
    const bands: { left: number; width: number }[] = [];
    let run: string | null = null;
    for (let i = 0; i < totalDays; i++) {
      const date = addDays(range.from, i);
      if (!isWorkingDay(date, days)) {
        if (run === null) run = date;
      } else if (run !== null) {
        bands.push({ left: x(run), width: x(date) - x(run) });
        run = null;
      }
    }
    if (run !== null) bands.push({ left: x(run), width: totalDays * dayWidth - x(run) });
    return bands;
  }, [workingDays, range.from, totalDays, dayWidth]);

  /** Month strips across the top, so a bar can be placed without counting days. */
  const months = useMemo(() => {
    const out: { left: number; width: number; label: string }[] = [];
    let cursor = `${range.from.slice(0, 7)}-01`;
    while (cursor <= range.to) {
      const nextMonth = isoDay(dayOf(cursor) + 32 * DAY).slice(0, 7);
      const end = `${nextMonth}-01`;
      const left = Math.max(0, x(cursor));
      const right = Math.min(totalDays * dayWidth, x(end));
      if (right > left) {
        out.push({
          left,
          width: right - left,
          label: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
            .format(new Date(dayOf(cursor))),
        });
      }
      cursor = end;
    }
    return out;
  }, [range.from, range.to, dayWidth, totalDays]);

  /* ------------------------------------------------------------- dragging */

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent): void => {
      const days = Math.round((event.clientX - drag.originX) / dayWidth);
      if (days !== drag.days) setDrag({ ...drag, days });
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

  function preview(task: Task): { start: string; end: string } {
    const bounds = span(task)!;
    if (!drag || drag.id !== task.id || !drag.days) return bounds;
    if (drag.mode === 'move') return { start: addDays(bounds.start, drag.days), end: addDays(bounds.end, drag.days) };
    if (drag.mode === 'start') {
      const start = addDays(bounds.start, drag.days);
      return { start: start > bounds.end ? bounds.end : start, end: bounds.end };
    }
    const end = addDays(bounds.end, drag.days);
    return { start: bounds.start, end: end < bounds.start ? bounds.start : end };
  }

  /**
   * Write the move, and everything the move implies.
   *
   * The successors are written as ordinary local changes like any other edit,
   * so this works offline and merges per field the same way — a Gantt that only
   * schedules when the server is reachable would be a different app.
   */
  function commit(state: Drag): void {
    if (!state.days || !canWrite) return;
    const task = byId('task', state.id);
    if (!task) return;
    const bounds = preview(task);
    const scheduled = dated.map((row) => ({ id: row.id, start_date: row.start_date, due_date: row.due_date }));
    const moves = planMove(
      state.id,
      task.start_date ? bounds.start : null,
      task.due_date ? bounds.end : (task.start_date ? null : bounds.end),
      scheduled,
      dependencies,
      { workingDays },
    );
    for (const move of moves) {
      const patch: Record<string, unknown> = {};
      if (move.start_date !== undefined) patch.start_date = move.start_date;
      if (move.due_date !== undefined) patch.due_date = move.due_date;
      update('task', move.id, patch);
    }
  }

  function begin(event: React.PointerEvent, task: Task, mode: Drag['mode']): void {
    if (!canWrite) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = span(task)!;
    setDrag({ id: task.id, mode, originX: event.clientX, start: bounds.start, due: bounds.end, days: 0 });
  }

  /**
   * Keep today's dates under a name.
   *
   * The whole plan in one row rather than a date pair per task: a baseline is
   * something somebody *took*, it is read all at once, and it must not drift as
   * tasks are added afterwards.
   */
  function takeBaseline(): void {
    if (!projectId) return;
    const entries: Record<string, [string | null, string | null]> = {};
    for (const task of tasks) {
      if (task.start_date || task.due_date) entries[task.id] = [task.start_date, task.due_date];
    }
    const name = t('baseline.defaultName', { date: shortDate(today()) });
    const id = create('baseline', { project_id: projectId, name, taken_at: Date.now(), entries });
    setBaselineId(id);
    toast(t('baseline.saved', { name }));
  }

  /** Keyboard equivalent of a drag: a bar can be moved a day at a time. */
  function nudge(task: Task, days: number): void {
    if (!canWrite) return;
    const bounds = span(task);
    if (!bounds) return;
    commit({ id: task.id, mode: 'move', originX: 0, start: bounds.start, due: bounds.end, days });
  }

  if (!tasks.length) return <Empty emoji="📅" title={t('view.emptyTitle')} hint={t('view.emptyHint')} guide="planning" />;

  const rowOf = new Map(dated.map((task, index) => [task.id, index]));
  const width = totalDays * dayWidth;
  const nowX = x(today());

  return (
    <div className="gantt">
      <div className="gantt-toolbar row wrap">
        <span className="muted" style={{ fontSize: 12 }}>{t('gantt.hint')}</span>
        <span className="grow" />
        {baselines.length > 0 && (
          <select
            className="select sm" style={{ width: 'auto' }} value={baselineId}
            aria-label={t('baseline.compare')}
            onChange={(event) => setBaselineId(event.target.value)}
          >
            <option value="">{t('baseline.none')}</option>
            {baselines.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        )}
        {canWrite && projectId && (
          <button className="btn ghost sm" onClick={() => takeBaseline()} title={t('baseline.hint')}>
            <Icon name="bookmark" size={13} /> {t('baseline.take')}
          </button>
        )}
        <button className="btn ghost sm icon" onClick={() => setZoom(Math.max(0, zoom - 1))}
          disabled={zoom === 0} aria-label={t('gantt.zoomOut')} title={t('gantt.zoomOut')}>−</button>
        <button className="btn ghost sm icon" onClick={() => setZoom(Math.min(ZOOM.length - 1, zoom + 1))}
          disabled={zoom === ZOOM.length - 1} aria-label={t('gantt.zoomIn')} title={t('gantt.zoomIn')}>+</button>
      </div>

      <div className="gantt-scroll" ref={surface}>
        <div className="gantt-names">
          <div className="gantt-head" />
          {dated.map((task) => (
            <button key={task.id} className="gantt-name" onClick={() => onOpen(task)} title={task.title}>
              <StateDot group={byId('state', task.state_id)?.group_key} color={byId('state', task.state_id)?.color} />
              <span className="truncate">{task.title}</span>
            </button>
          ))}
        </div>

        <div className="gantt-plot" style={{ width }}>
          <div className="gantt-head" style={{ width }}>
            {months.map((month) => (
              <span key={month.label} className="gantt-month" style={{ insetInlineStart: month.left, width: month.width }}>
                {month.width > 60 ? month.label : ''}
              </span>
            ))}
          </div>

          <div className="gantt-rows" style={{ width, height: dated.length * ROW }}>
            {/* Days the project does not work on, shaded rather than blocked:
                the scheduler avoids them, and somebody dragging a bar onto a
                Saturday on purpose has said what they meant. */}
            {offDays.map((day) => (
              <span key={day.left} className="gantt-off" style={{ insetInlineStart: day.left, width: day.width }} aria-hidden="true" />
            ))}
            {nowX >= 0 && nowX <= width && <span className="gantt-today" style={{ insetInlineStart: nowX }} aria-hidden="true" />}

            {/* Arrows first, so a bar being dragged passes over them. */}
            <svg className="gantt-links" width={width} height={dated.length * ROW} aria-hidden="true">
              {dependencies.map((link) => {
                const fromRow = rowOf.get(link.from);
                const toRow = rowOf.get(link.to);
                const fromTask = byId('task', link.from);
                const toTask = byId('task', link.to);
                if (fromRow === undefined || toRow === undefined || !fromTask || !toTask) return null;
                const fromEnd = x(preview(fromTask).end) + dayWidth;
                const toStart = x(preview(toTask).start);
                const y1 = fromRow * ROW + ROW / 2;
                const y2 = toRow * ROW + ROW / 2;
                // Out of the blocker, along the gap, then into the successor —
                // an elbow rather than a diagonal, so crossings stay readable.
                const mid = Math.max(fromEnd + 6, toStart - 6);
                return (
                  <path
                    key={`${link.from}-${link.to}`}
                    d={`M ${fromEnd} ${y1} H ${mid} V ${y2} H ${toStart}`}
                    className={toStart < fromEnd ? 'link late' : 'link'}
                    markerEnd="url(#gantt-arrow)"
                  />
                );
              })}
              <defs>
                <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
                </marker>
              </defs>
            </svg>

            {/* The plan, behind the work: a thin ghost of where each bar was
                when the baseline was taken. Drawn first, so a bar that has not
                moved simply covers it. */}
            {baseline && dated.map((task, index) => {
              const planned = baseline.entries?.[task.id];
              if (!planned) return null;
              const bounds = span({ id: task.id, start_date: planned[0], due_date: planned[1] });
              if (!bounds) return null;
              const left = x(bounds.start);
              const barWidth = Math.max(dayWidth, (daysBetween(bounds.start, bounds.end) + 1) * dayWidth);
              return (
                <span
                  key={`plan-${task.id}`} className="gantt-plan"
                  style={{ insetInlineStart: left, width: barWidth, top: index * ROW + 25 }}
                  title={`${t('baseline.compare')} ${shortDate(bounds.start)} – ${shortDate(bounds.end)}`}
                />
              );
            })}

            {dated.map((task, index) => {
              const bounds = preview(task);
              const left = x(bounds.start);
              const barWidth = Math.max(dayWidth, (daysBetween(bounds.start, bounds.end) + 1) * dayWidth);
              const state = byId('state', task.state_id);
              const done = state?.group_key === 'completed' || state?.group_key === 'cancelled';
              const late = !done && bounds.end < today();
              return (
                <div
                  key={task.id}
                  className={`gantt-bar${done ? ' done' : ''}${late ? ' late' : ''}${drag?.id === task.id ? ' dragging' : ''}`}
                  style={{ insetInlineStart: left, width: barWidth, top: index * ROW + 6 }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${task.identifier} ${task.title}: ${shortDate(bounds.start)} – ${shortDate(bounds.end)}`}
                  onPointerDown={(event) => begin(event, task, 'move')}
                  onDoubleClick={() => onOpen(task)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') { event.preventDefault(); nudge(task, 1); }
                    else if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(task, -1); }
                    else if (event.key === 'Enter') onOpen(task);
                  }}
                >
                  <span className="gantt-grip start" onPointerDown={(event) => begin(event, task, 'start')} />
                  {/* A label inside a bar three days wide is a sliver of a
                      letter. The aria-label and the name column still say it. */}
                  {barWidth >= 46 && <span className="gantt-label truncate">{task.identifier}</span>}
                  <span className="gantt-grip end" onPointerDown={(event) => begin(event, task, 'end')} />
                  {drag?.id === task.id && (
                    <span className="chart-tip">{shortDate(bounds.start)} – {shortDate(bounds.end)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {undated.length > 0 && (
        <div className="gantt-undated">
          <strong style={{ fontSize: 12.5 }}>{t('gantt.undated', { count: undated.length })}</strong>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {undated.slice(0, 40).map((task) => (
              <button key={task.id} className="chip button" onClick={() => onOpen(task)}>
                <Icon name="calendar" size={11} /> {task.identifier} {task.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
