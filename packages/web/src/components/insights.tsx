/**
 * What the numbers already in the database say about a project.
 *
 * Every figure here is computed from the local mirror — no endpoint, no
 * aggregation table, no nightly job. The data was always there; nothing read
 * it. That also means these charts work on a train.
 *
 * The charts are hand-drawn SVG rather than a library, for the same reason the
 * CSV parser is written out: a chart you can read is worth more than one you
 * have to trust, and a charting dependency is a lot of kilobytes for four
 * pictures.
 *
 * Colours come from `--chart-1` / `--chart-2`, which were validated as a
 * categorical pair against both surfaces rather than picked by eye.
 */
import { useMemo, useState } from 'react';
import type { Task } from '@kolibri/shared';
import { duration } from '@kolibri/shared';
import { shortDate, today } from '../lib/format';
import { useT } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { useMemberMap } from '../session';
import { Empty } from './ui';

const DAY = 86_400_000;
const isDone = (task: Task): boolean => {
  const group = byId('state', task.state_id)?.group_key;
  return group === 'completed' || group === 'cancelled';
};

/* ------------------------------------------------------------- primitives */

/** A headline number. Not a one-bar bar chart. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export interface Column {
  key: string;
  label: string;
  value: number;
}

/**
 * Columns for a count over time. One series, so no legend — the heading says
 * what it is — and only the tallest column is labelled, because a number on
 * every column is chaos that goes unread.
 */
function Columns({ data, caption }: { data: Column[]; caption: string }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((column) => column.value));
  const width = 100 / Math.max(data.length, 1);
  const peak = data.reduce((best, column, index) => (column.value > data[best].value ? index : best), 0);

  return (
    <figure className="chart">
      {/* The peak is direct-labelled; this tick carries the rest, so a column
          half the height of another can be read as such. */}
      <div className="chart-scale"><span>{max}</span><span>0</span></div>
      <div className="chart-plot" style={{ height: 150 }} role="img" aria-label={caption}>
        {data.map((column, index) => {
          const height = (column.value / max) * 100;
          return (
            <div
              key={column.key}
              className="col-slot"
              style={{ width: `${width}%` }}
              // Keyboard focus shows what hover shows; a tooltip that only a
              // mouse can reach is a value only a mouse can read.
              tabIndex={0}
              role="figure"
              aria-label={`${column.label}: ${column.value}`}
              onPointerEnter={() => setHover(index)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
            >
              {(index === peak || hover === index) && column.value > 0 && (
                <span className="col-value">{column.value}</span>
              )}
              {/* A zero draws nothing. A 2px stub for "no tasks finished" is
                  ink that says there was some, which is worse than a gap. */}
              {column.value > 0 && (
                <span className="col-bar" style={{ height: `${height}%`, background: 'var(--chart-1)' }} />
              )}
              {hover === index && (
                <span className="chart-tip" role="status">{column.label}: {column.value}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="chart-axis">
        {data.map((column, index) => (
          // Every third tick, so the labels never collide at twelve columns.
          <span key={column.key} style={{ width: `${width}%` }}>{index % 3 === 0 ? column.label : ''}</span>
        ))}
      </div>
      <figcaption>{caption}</figcaption>
      <Table caption={t('insights.tableView')} head={[t('insights.week'), t('insights.completed')]}
        rows={data.map((column) => [column.label, String(column.value)])} />
    </figure>
  );
}

interface Series {
  name: string;
  color: string;
  points: number[];
}

/**
 * Two lines over the same days. Both are direct-labelled at their end as well
 * as being in the legend: the green sits below 3:1 on a white surface, and a
 * contrast warning obliges labels rather than being waved through.
 */
function Lines({ series, labels, caption }: { series: Series[]; labels: string[]; caption: string }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.flatMap((line) => line.points));
  const count = labels.length;
  const x = (index: number) => (count > 1 ? (index / (count - 1)) * 100 : 50);
  const y = (value: number) => 100 - (value / max) * 100;

  return (
    <figure className="chart">
      <div className="chart-legend">
        {series.map((line) => (
          <span key={line.name}>
            <i style={{ background: line.color }} aria-hidden /> {line.name}
          </span>
        ))}
      </div>
      <div
        className="chart-plot lines"
        style={{ height: 170 }}
        role="img"
        aria-label={caption}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          setHover(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="lines-svg">
          {[0, 50, 100].map((line) => (
            <line key={line} x1="0" x2="100" y1={line} y2={line} className="grid-line" vectorEffect="non-scaling-stroke" />
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1="0" y2="100" className="crosshair" vectorEffect="non-scaling-stroke" />
          )}
          {series.map((line) => (
            <polyline
              key={line.name}
              points={line.points.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {/* End markers and their labels sit outside the stretched SVG, so they
            are round and readable rather than sheared by preserveAspectRatio. */}
        {series.map((line) => {
          const last = line.points[line.points.length - 1] ?? 0;
          return (
            <span
              key={line.name}
              className="line-end"
              style={{ left: '100%', top: `${y(last)}%`, background: line.color }}
            >
              <b>{last}</b>
            </span>
          );
        })}
        {hover !== null && (
          <span className="chart-tip pinned" role="status" style={{ left: `${x(hover)}%` }}>
            {labels[hover]}
            {series.map((line) => ` · ${line.name} ${line.points[hover]}`)}
          </span>
        )}
      </div>
      <div className="chart-axis">
        <span className="flex-1">{labels[0]}</span>
        <span style={{ flex: 1, textAlign: 'end' }}>{labels[labels.length - 1]}</span>
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('insights.day'), ...series.map((line) => line.name)]}
        rows={labels.map((label, index) => [label, ...series.map((line) => String(line.points[index]))])}
      />
    </figure>
  );
}

/** Horizontal bars for a nominal breakdown — one hue, because length is the encoding. */
export function Bars({ data, caption }: { data: Column[]; caption: string }) {
  const t = useT();
  const max = Math.max(1, ...data.map((row) => row.value));
  return (
    <figure className="chart">
      <div className="bars">
        {data.map((row) => (
          <div className="bar-row" key={row.key}>
            <span className="bar-label truncate" title={row.label}>{row.label}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(row.value / max) * 100}%`, background: 'var(--chart-1)' }} />
            </span>
            <span className="bar-value">{row.value}</span>
          </div>
        ))}
      </div>
      <figcaption>{caption}</figcaption>
      <Table caption={t('insights.tableView')} head={[caption, t('insights.tasks')]}
        rows={data.map((row) => [row.label, String(row.value)])} />
    </figure>
  );
}

/** The same numbers as text. Required, not a nicety: colour is never the only channel. */
export function Table({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <details className="chart-table">
      <summary>{caption}</summary>
      <div className="table-wrap">
        <table className="task-table">
          <thead><tr>{head.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------- screen */

export function ProjectInsights({ projectId }: { projectId: string }) {
  const t = useT();
  const members = useMemberMap();
  const tasks = useQuery(() => list('task', (task) => task.project_id === projectId && !task.archived), [projectId]);
  const types = useQuery(() => list('taskType', (type) => type.project_id === projectId), [projectId]);
  const entries = useQuery(() => list('timeEntry', (entry) => entry.project_id === projectId), [projectId]);
  const cycles = useQuery(() => list('cycle', (cycle) => cycle.project_id === projectId), [projectId]);

  const stats = useMemo(() => {
    const done = tasks.filter(isDone);
    const open = tasks.length - done.length;
    const since = Date.now() - 30 * DAY;
    const recent = done.filter((task) => (task.completed_at ?? 0) >= since);

    // Median, not mean: one task that sat in the backlog for a year would drag
    // an average somewhere nobody recognises.
    const spans = recent
      .map((task) => ((task.completed_at ?? 0) - task.created_at) / DAY)
      .filter((days) => days >= 0)
      .sort((a, b) => a - b);
    const median = spans.length
      ? spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2
      : null;

    const minutes = entries
      .filter((entry) => new Date(`${entry.spent_on}T00:00:00Z`).getTime() >= since)
      .reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);

    return { open, done: done.length, recent: recent.length, median, minutes };
  }, [tasks, entries]);

  const throughput = useMemo(() => {
    const weeks: Column[] = [];
    const now = new Date();
    for (let back = 11; back >= 0; back--) {
      const end = new Date(now.getTime() - back * 7 * DAY);
      const start = new Date(end.getTime() - 7 * DAY);
      weeks.push({
        key: start.toISOString().slice(0, 10),
        label: shortDate(start.toISOString().slice(0, 10)),
        value: tasks.filter((task) => {
          const at = task.completed_at ?? 0;
          return at > start.getTime() && at <= end.getTime();
        }).length,
      });
    }
    return weeks;
  }, [tasks]);

  const burnUp = useMemo(() => {
    const day = today();
    const active = cycles.find((cycle) => cycle.start_date && cycle.end_date && cycle.start_date <= day && cycle.end_date >= day)
      ?? cycles.filter((cycle) => cycle.end_date).sort((a, b) => (a.end_date! < b.end_date! ? 1 : -1))[0];
    if (!active?.start_date || !active.end_date) return null;

    const inCycle = tasks.filter((task) => task.cycle_id === active.id);
    if (!inCycle.length) return null;

    const start = new Date(`${active.start_date}T00:00:00Z`).getTime();
    const end = new Date(`${active.end_date}T00:00:00Z`).getTime();
    const days = Math.max(1, Math.round((end - start) / DAY));
    const labels: string[] = [];
    const scope: number[] = [];
    const done: number[] = [];

    for (let index = 0; index <= days; index++) {
      const at = start + index * DAY;
      // Only up to today: drawing a flat line into the future looks like a
      // forecast, and this is a record of what happened.
      if (at > Date.now() + DAY) break;
      labels.push(shortDate(new Date(at).toISOString().slice(0, 10)));
      scope.push(inCycle.filter((task) => task.created_at <= at).length);
      done.push(inCycle.filter((task) => (task.completed_at ?? Infinity) <= at).length);
    }
    return { name: active.name, labels, scope, done };
  }, [tasks, cycles]);

  const byType = useMemo(() => {
    const rows: Column[] = types.map((type) => ({
      key: type.id,
      label: `${type.icon ?? ''} ${type.name}`.trim(),
      value: tasks.filter((task) => task.type_id === type.id).length,
    }));
    const untyped = tasks.filter((task) => !task.type_id).length;
    if (untyped) rows.push({ key: 'none', label: t('type.none'), value: untyped });
    return rows.filter((row) => row.value).sort((a, b) => b.value - a.value);
  }, [tasks, types, t]);

  const byPerson = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (isDone(task)) continue;
      for (const id of task.assignees ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, value]) => ({ key: id, label: members.get(id)?.name ?? t('common.someone'), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [tasks, members, t]);

  if (!tasks.length) {
    return <Empty emoji="📊" title={t('insights.emptyTitle')} hint={t('insights.emptyHint')} guide="planning" />;
  }

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="kpi-row">
        <Stat label={t('insights.open')} value={String(stats.open)} hint={t('insights.ofTotal', { count: tasks.length })} />
        <Stat label={t('insights.completed30')} value={String(stats.recent)} hint={t('insights.last30')} />
        <Stat
          label={t('insights.cycleTime')}
          value={
            stats.median === null ? '—'
              // "0 days" is arithmetically right and reads as a bug.
              : stats.median < 1 ? t('insights.underADay')
                : t('insights.days', { count: Math.round(stats.median * 10) / 10 })
          }
          hint={t('insights.medianHint')}
        />
        <Stat label={t('insights.timeLogged')} value={duration(stats.minutes)} hint={t('insights.last30')} />
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
        <h3 className="chart-title">{t('insights.throughput')}</h3>
        <p className="text-[12px] text-muted">{t('insights.throughputHint')}</p>
        <Columns data={throughput} caption={t('insights.throughputCaption')} />
      </div>

      {burnUp && (
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <h3 className="chart-title">{t('insights.burnUp', { name: burnUp.name })}</h3>
          <p className="text-[12px] text-muted">{t('insights.burnUpHint')}</p>
          <Lines
            labels={burnUp.labels}
            caption={t('insights.burnUpCaption', { name: burnUp.name })}
            series={[
              { name: t('insights.scope'), color: 'var(--chart-1)', points: burnUp.scope },
              { name: t('insights.done'), color: 'var(--chart-2)', points: burnUp.done },
            ]}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {byType.length > 0 && (
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
            <h3 className="chart-title">{t('insights.byType')}</h3>
            <Bars data={byType} caption={t('insights.byType')} />
          </div>
        )}
        {byPerson.length > 0 && (
          <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
            <h3 className="chart-title">{t('insights.byPerson')}</h3>
            <p className="text-[12px] text-muted">{t('insights.byPersonHint')}</p>
            <Bars data={byPerson} caption={t('insights.byPerson')} />
          </div>
        )}
      </div>
    </div>
  );
}
