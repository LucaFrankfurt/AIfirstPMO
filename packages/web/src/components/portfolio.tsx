/**
 * The portfolio: every project at once.
 *
 * Two questions a project screen cannot answer — *when* is everything, and
 * *where* is the work piling up. The first is a roadmap, which is a timeline of
 * date ranges rather than a chart of magnitudes; the second is the same counts
 * the project insights use, added up across projects.
 *
 * Like the insights, all of it is computed from the local mirror, so it works
 * on a train.
 */
import { useMemo, useState } from 'react';
import type { Project, Task } from '@kolibri/shared';
import { shortDate, today } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { useSession } from '../session';
import { Bars, Stat, Table } from './insights';
import { Empty, Icon } from './ui';

const DAY = 86_400_000;

export const projectStatusKey = (status: string): TranslationKey => `projectStatus.${status}` as TranslationKey;
const at = (date: string): number => new Date(`${date}T00:00:00Z`).getTime();

const isDone = (task: Task): boolean => {
  const group = byId('state', task.state_id)?.group_key;
  return group === 'completed' || group === 'cancelled';
};

interface Bar {
  project: Project;
  start: number;
  end: number;
  open: number;
  done: number;
  /** Share of this project's tasks that are finished, 0–1. */
  progress: number;
  overdue: boolean;
}

/* ------------------------------------------------------------- the roadmap */

/**
 * One row per project, a bar from start to target, and today as a line through
 * all of them.
 *
 * Deliberately not a chart of magnitudes: nothing here is being compared by
 * length, so the bars carry no scale and the only quantity shown is progress,
 * as a fill inside the bar it belongs to.
 */
function Roadmap({ bars, from, to }: { bars: Bar[]; from: number; to: number }) {
  const t = useT();
  const [hover, setHover] = useState<string | null>(null);
  const span = Math.max(to - from, DAY);
  const pct = (time: number): number => ((time - from) / span) * 100;
  const now = at(today());
  const showToday = now >= from && now <= to;

  // Enough month marks to read the scale, never so many that they collide.
  const months = useMemo(() => {
    const out: { at: number; label: string }[] = [];
    const cursor = new Date(from);
    cursor.setUTCDate(1);
    while (cursor.getTime() <= to && out.length < 24) {
      const time = cursor.getTime();
      if (time >= from) {
        out.push({
          at: time,
          label: new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(cursor),
        });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    // A mark every other month once there are more than eight, so the labels
    // never sit on top of each other.
    return out.length > 8 ? out.filter((_, index) => index % 2 === 0) : out;
  }, [from, to]);

  return (
    <figure className="chart">
      <div className="roadmap">
        <div className="roadmap-axis" aria-hidden="true">
          {months.map((month) => (
            <span key={month.at} style={{ insetInlineStart: `${pct(month.at)}%` }}>{month.label}</span>
          ))}
        </div>

        <div className="roadmap-rows">
          {/* The marker sits in a box that starts where the tracks start, so its
              percentage means the same thing the bars' percentages do. */}
          <div className="roadmap-overlay" aria-hidden="true">
            {showToday && <span className="roadmap-today" style={{ insetInlineStart: `${pct(now)}%` }} />}
          </div>
          {bars.map((bar) => {
            const left = Math.max(0, pct(bar.start));
            const width = Math.max(1.5, pct(bar.end) - left);
            return (
              <div className="roadmap-row" key={bar.project.id}>
                <span className="roadmap-name">
                  <span className="truncate" title={bar.project.name}>{bar.project.icon} {bar.project.name}</span>
                  {/* Late is a status, so it says so rather than only turning red —
                      and it sits outside the truncating half, because on a phone
                      the name is what gets cut, never the warning. */}
                  {bar.overdue && (
                    <span className="late-flag" title={t('portfolio.lateHint')}>
                      <Icon name="calendar" size={11} /> {t('portfolio.late')}
                    </span>
                  )}
                </span>
                <span className="roadmap-track">
                  <span
                    className={`roadmap-bar${bar.overdue ? ' late' : ''}`}
                    style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
                    tabIndex={0}
                    role="figure"
                    aria-label={`${bar.project.name}: ${shortDate(bar.project.start_date ?? '')} – ${shortDate(bar.project.target_date ?? '')}, ${Math.round(bar.progress * 100)}%${bar.overdue ? `, ${t('portfolio.late')}` : ''}`}
                    onPointerEnter={() => setHover(bar.project.id)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(bar.project.id)}
                    onBlur={() => setHover(null)}
                  >
                    {/* Progress lives inside the bar it describes, so the two
                        quantities are never mistaken for one another. */}
                    <span className="roadmap-fill" style={{ width: `${Math.round(bar.progress * 100)}%` }} />
                    {hover === bar.project.id && (
                      <span className="chart-tip">
                        {shortDate(bar.project.start_date ?? '')} – {shortDate(bar.project.target_date ?? '')} ·{' '}
                        {t('portfolio.doneOf', { done: bar.done, total: bar.done + bar.open })}
                      </span>
                    )}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption>{t('portfolio.roadmapCaption')}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('portfolio.project'), t('project.startDate'), t('project.targetDate'), t('portfolio.progress')]}
        rows={bars.map((bar) => [
          bar.project.name,
          shortDate(bar.project.start_date ?? ''),
          shortDate(bar.project.target_date ?? ''),
          `${Math.round(bar.progress * 100)}%`,
        ])}
      />
    </figure>
  );
}

/* -------------------------------------------------------------- the screen */

export function Portfolio() {
  const t = useT();
  const { workspaceId } = useSession();

  const projects = useQuery(
    () => list('project', (project) => project.workspace_id === workspaceId && !project.archived)
      .sort((a, b) => (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999') || a.name.localeCompare(b.name)),
    [workspaceId],
  );
  const tasks = useQuery(() => list('task', (task) => !task.archived), [workspaceId]);
  const entries = useQuery(() => list('timeEntry'), [workspaceId]);

  const byProject = useMemo(() => {
    const map = new Map<string, { open: number; done: number; overdue: number }>();
    for (const project of projects) map.set(project.id, { open: 0, done: 0, overdue: 0 });
    const now = today();
    for (const task of tasks) {
      const counts = map.get(task.project_id);
      if (!counts) continue;
      if (isDone(task)) counts.done++;
      else {
        counts.open++;
        if (task.due_date && task.due_date < now) counts.overdue++;
      }
    }
    return map;
  }, [projects, tasks]);

  const bars = useMemo<Bar[]>(() => {
    const now = today();
    return projects
      .filter((project) => project.start_date || project.target_date)
      .map((project) => {
        const counts = byProject.get(project.id) ?? { open: 0, done: 0, overdue: 0 };
        const total = counts.open + counts.done;
        // A project with only one date gets a fortnight in the other direction,
        // so it is still on the timeline rather than an invisible zero-width bar.
        const start = at(project.start_date ?? project.target_date!) - (project.start_date ? 0 : 14 * DAY);
        const end = at(project.target_date ?? project.start_date!) + (project.target_date ? 0 : 14 * DAY);
        return {
          project,
          start: Math.min(start, end),
          end: Math.max(start, end),
          open: counts.open,
          done: counts.done,
          progress: total ? counts.done / total : 0,
          overdue: !!project.target_date && project.target_date < now && counts.open > 0,
        };
      });
  }, [projects, byProject]);

  const undated = projects.filter((project) => !project.start_date && !project.target_date);

  const range = useMemo(() => {
    const now = at(today());
    if (!bars.length) return { from: now - 30 * DAY, to: now + 60 * DAY };
    const from = Math.min(now, ...bars.map((bar) => bar.start));
    const to = Math.max(now, ...bars.map((bar) => bar.end));
    // A week of air at each end, so a bar never runs into the edge.
    return { from: from - 7 * DAY, to: to + 7 * DAY };
  }, [bars]);

  const totals = useMemo(() => {
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const counts of byProject.values()) {
      open += counts.open;
      done += counts.done;
      overdue += counts.overdue;
    }
    const monthAgo = Date.now() - 30 * DAY;
    const doneThisMonth = tasks.filter((task) => task.completed_at && task.completed_at >= monthAgo).length;
    const minutes = entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);
    return { open, done, overdue, doneThisMonth, hours: Math.round(minutes / 60) };
  }, [byProject, tasks, entries]);

  if (!projects.length) {
    return <Empty emoji="🗺️" title={t('portfolio.emptyTitle')} hint={t('portfolio.emptyHint')} guide="planning" />;
  }

  return (
    <div className="page">
      <div className="kpi-row">
        <Stat label={t('portfolio.projects')} value={String(projects.length)} />
        <Stat label={t('portfolio.open')} value={String(totals.open)} hint={t('portfolio.acrossAll')} />
        <Stat label={t('portfolio.finishedMonth')} value={String(totals.doneThisMonth)} hint={t('insights.last30')} />
        <Stat
          label={t('portfolio.overdue')}
          value={String(totals.overdue)}
          hint={totals.overdue ? t('portfolio.overdueHint') : t('portfolio.overdueNone')}
        />
        <Stat label={t('portfolio.timeLogged')} value={`${totals.hours} h`} />
      </div>

      <h3 className="chart-title">{t('portfolio.roadmap')}</h3>
      {bars.length
        ? <Roadmap bars={bars} from={range.from} to={range.to} />
        : <p className="text-muted" style={{ fontSize: 13 }}>{t('portfolio.noDates')}</p>}

      {undated.length > 0 && (
        <p className="text-muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          <Icon name="calendar" size={12} /> {t('portfolio.undated', { names: undated.map((p) => p.name).join(', ') })}
        </p>
      )}

      <h3 className="chart-title" style={{ marginTop: 22 }}>{t('portfolio.openByProject')}</h3>
      <Bars
        caption={t('portfolio.openByProject')}
        data={projects.map((project) => ({
          key: project.id,
          label: project.name,
          value: byProject.get(project.id)?.open ?? 0,
        }))}
      />

      <h3 className="chart-title" style={{ marginTop: 22 }}>{t('portfolio.status')}</h3>
      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>{t('portfolio.project')}</th>
              <th>{t('project.statusLabel')}</th>
              <th className="narrow">{t('project.lead')}</th>
              <th className="narrow">{t('project.targetDate')}</th>
              <th>{t('portfolio.progress')}</th>
              <th className="narrow">{t('portfolio.overdue')}</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const counts = byProject.get(project.id) ?? { open: 0, done: 0, overdue: 0 };
              const total = counts.open + counts.done;
              const lead = byId('user', project.lead_id ?? undefined);
              return (
                <tr key={project.id}>
                  <td>{project.icon} {project.name}</td>
                  <td>{t(projectStatusKey(project.status))}</td>
                  <td className="narrow">{lead?.name ?? '—'}</td>
                  <td className="narrow">{project.target_date ? shortDate(project.target_date) : '—'}</td>
                  <td>{total ? `${Math.round((counts.done / total) * 100)}% · ${counts.done}/${total}` : '—'}</td>
                  <td className="narrow">{counts.overdue || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
