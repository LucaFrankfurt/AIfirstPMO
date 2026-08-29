/**
 * Rates, and everything money-shaped that hangs off logged time.
 *
 * The whole file is behind two conditions and it is worth saying why rather
 * than leaving it to be discovered: time tracking has to be switched on, and
 * the person looking has to be an owner or an admin. The second is not a
 * screen-level nicety — a member's device never receives a rate at all, so
 * these components would render empty columns for them even if they got here.
 * Checking here means they get a sentence instead.
 */
import { useMemo, useState } from 'react';
import {
  RATE_KINDS, duration, formatMoney, rateHistory, resolveRate, timesheet, totalsOf, utilisation,
  weekDays, weekStart,
  type ID, type MoneyByCurrency, type Rate, type RateKind, type TimeEntry,
} from '@kolibri/shared';
import { currentLocale, useT, type TranslationKey } from '../lib/i18n';
import { today } from '../lib/format';
import { create, remove } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useMembers, useSession } from '../session';
import { Empty, Icon, Sheet, useConfirm } from './ui';
import { Button } from './ui/button';
import { Chip } from './ui/chip';
import { Input, Select } from './ui/field';
import { SectionHeading } from './ui/section';
import { MoneyInput, asMoney } from './budget';

export const rateKindKey = (kind: string): TranslationKey => `rate.kind.${kind}` as TranslationKey;

/** Whether this person may see money at all. See the note at the top. */
export function useSeesMoney(): boolean {
  const { role } = useSession();
  return role === 'owner' || role === 'admin';
}

/**
 * A list of amounts in different currencies, as one string.
 *
 * Nothing here adds two currencies — see `Budget.currency` for the argument —
 * so a workspace paying in two shows both, and one paying in one, which is
 * almost all of them, never notices this exists.
 *
 * `compact` is for a headline figure and nothing else. In a column it is
 * actively wrong: compact notation drops the cents, so a table of costs comes
 * out as "€9.2K" beside "€234.7" — two different roundings of two adjacent
 * numbers, and the second is not even a sum of money anybody writes.
 */
export function Money({ of, empty = '—', compact = false }: {
  of: MoneyByCurrency[];
  empty?: string;
  compact?: boolean;
}) {
  if (!of.length) return <span className="money-flat">{empty}</span>;
  return (
    <span className="tabular-nums">
      {of.map((row) => formatMoney(row.amount, row.currency, currentLocale(), { compact })).join(' + ')}
    </span>
  );
}

/** Hours no rate covered, said out loud. Silence here would read as zero. */
export function Unrated({ minutes }: { minutes: number }) {
  const t = useT();
  if (!minutes) return null;
  return <Chip className="stage-committed">{t('rate.unrated', { hours: duration(minutes) })}</Chip>;
}

/* ------------------------------------------------------------- timesheet */

/**
 * One week, as a grid: a row per person or per project, a column per day.
 *
 * Seven columns always, including the ones nobody logged against — a sheet
 * that hides its empty days cannot be read down, and a blank Thursday is a
 * fact about the week rather than an absence of data.
 */
export function Timesheet() {
  const t = useT();
  const members = useMembers();
  const seesMoney = useSeesMoney();
  const [week, setWeek] = useState(() => weekStart(today()));
  const [by, setBy] = useState<'user' | 'project'>('user');

  const entries = useQuery(() => list('timeEntry'), []);
  const rates = useQuery(() => list('rate'), []);
  const projects = useQuery(() => list('project'), []);

  const nameOf = useMemo(() => {
    const names = new Map<ID, string>();
    for (const member of members) names.set(member.id, member.name);
    for (const project of projects) names.set(project.id, project.name);
    return names;
  }, [members, projects]);

  const sheet = useMemo(
    () => timesheet({ entries, rates, week, by }),
    [entries, rates, week, by],
  );

  const dayLabel = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(currentLocale(), { weekday: 'short', timeZone: 'UTC' });
  const dayNumber = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="week-bar">
        <Button size="icon" aria-label={t('timesheet.previous')} onClick={() => setWeek(weekStart(shift(week, -1)))}>
          <Icon name="chevronLeft" size={15} />
        </Button>
        <strong className="flex-1 min-w-0 truncate">
          {dayNumber(sheet.days[0])} – {dayNumber(sheet.days[6])}
        </strong>
        <Button size="sm" onClick={() => setWeek(weekStart(today()))}>{t('timesheet.thisWeek')}</Button>
        <Button size="icon" aria-label={t('timesheet.next')} onClick={() => setWeek(weekStart(shift(week, 1)))}>
          <Icon name="chevronRight" size={15} />
        </Button>
        <Select
          className="w-auto"
          aria-label={t('timesheet.groupBy')}
          value={by}
          onChange={(event) => setBy(event.target.value as 'user' | 'project')}
        >
          <option value="user">{t('timesheet.byPerson')}</option>
          <option value="project">{t('timesheet.byProject')}</option>
        </Select>
      </div>

      {!sheet.rows.length ? (
        <Empty emoji="🗓️" title={t('timesheet.emptyTitle')} hint={t('timesheet.emptyHint')} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="task-table timesheet">
              <thead>
                <tr>
                  <th>{by === 'user' ? t('timesheet.person') : t('budget.project')}</th>
                  {sheet.days.map((day, index) => (
                    <th key={day} className={`num${index >= 5 ? ' weekend' : ''}`}>
                      <span className="day-name">{dayLabel(day)}</span>
                      <span className="day-date">{dayNumber(day)}</span>
                    </th>
                  ))}
                  <th className="num">{t('timesheet.total')}</th>
                  {seesMoney && <th className="num">{t('rate.cost')}</th>}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="title">
                      {row.key ? nameOf.get(row.key) ?? t('timesheet.unknown') : t('timesheet.noProject')}
                      {seesMoney && row.unratedMinutes > 0 && (
                        <span className="row-sub">{t('rate.unrated', { hours: duration(row.unratedMinutes) })}</span>
                      )}
                    </td>
                    {row.days.map((minutes, index) => (
                      <td key={index} className={`num${index >= 5 ? ' weekend' : ''}`}>
                        {/* An empty cell rather than "0h". A zero in every gap
                            is a grid nobody can find the worked days in. */}
                        {minutes ? duration(minutes) : ''}
                      </td>
                    ))}
                    <td className="num"><strong>{duration(row.minutes)}</strong></td>
                    {seesMoney && <td className="num"><Money of={row.cost} /></td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{t('timesheet.total')}</th>
                  {sheet.perDay.map((minutes, index) => (
                    <th key={index} className={`num${index >= 5 ? ' weekend' : ''}`}>
                      {minutes ? duration(minutes) : ''}
                    </th>
                  ))}
                  <th className="num">{duration(sheet.totals.minutes)}</th>
                  {seesMoney && <th className="num"><Money of={sheet.totals.cost} /></th>}
                </tr>
              </tfoot>
            </table>
          </div>
          {seesMoney && sheet.totals.unratedMinutes > 0 && (
            <p className="mt-2 text-[12px] text-muted">{t('rate.unratedHint')}</p>
          )}
        </>
      )}
    </div>
  );
}

const shift = (day: string, weeks: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ cost */

/**
 * What logged time cost over a window, and how much of it was billable.
 *
 * The window is a month rather than the week the sheet shows, because the two
 * questions have different shapes: a timesheet is checked, a cost report is
 * reported, and nobody reports a week.
 */
export function CostReport() {
  const t = useT();
  const members = useMembers();
  const projects = useQuery(() => list('project'), []);
  const entries = useQuery(() => list('timeEntry'), []);
  const rates = useQuery(() => list('rate'), []);
  const [months, setMonths] = useState(3);
  /** Hours a person is available. Not a fact this app holds — see `utilisation`. */
  const [target, setTarget] = useState(0);

  const from = useMemo(() => {
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - months);
    return date.toISOString().slice(0, 10);
  }, [months]);

  const within = useMemo(
    () => entries.filter((entry) => entry.spent_on >= from && Number(entry.minutes) > 0),
    [entries, from],
  );
  const totals = useMemo(() => totalsOf(within, rates), [within, rates]);
  const perPerson = useMemo(
    () => utilisation({ entries: within, by: 'user', targetMinutes: target ? target * 60 : undefined }),
    [within, target],
  );
  const perProject = useMemo(() => {
    const groups = new Map<string, TimeEntry[]>();
    for (const entry of within) {
      const key = String(entry.project_id ?? '');
      const rows = groups.get(key) ?? [];
      rows.push(entry);
      groups.set(key, rows);
    }
    return [...groups]
      .map(([key, rows]) => ({ key, name: projects.find((p) => p.id === key)?.name ?? t('timesheet.noProject'), ...totalsOf(rows, rates) }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [within, rates, projects, t]);

  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  if (!within.length) {
    return <Empty emoji="🧮" title={t('rate.noTime')} hint={t('rate.noTimeHint')} />;
  }

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <div className="week-bar">
        <Select
          className="w-auto"
          aria-label={t('rate.window')}
          value={String(months)}
          onChange={(event) => setMonths(Number(event.target.value))}
        >
          {[1, 3, 6, 12].map((count) => (
            <option key={count} value={count}>{t('rate.lastMonths', { count })}</option>
          ))}
        </Select>
        <div className="flex-1 min-w-0" />
        <label className="target-field">
          {t('rate.target')}
          <Input
            type="number"
            min={0}
            className="w-[92px]"
            value={target || ''}
            placeholder="—"
            onChange={(event) => setTarget(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>
      </div>

      <div className="kpi-row">
        <div className="stat">
          <span className="stat-label">{t('rate.cost')}</span>
          <strong className="stat-value"><Money of={totals.cost} compact /></strong>
          {totals.unratedMinutes > 0 && (
            <span className="stat-hint">{t('rate.unrated', { hours: duration(totals.unratedMinutes) })}</span>
          )}
        </div>
        <div className="stat">
          <span className="stat-label">{t('rate.revenue')}</span>
          <strong className="stat-value"><Money of={totals.revenue} compact /></strong>
          <span className="stat-hint">{t('rate.revenueHint')}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('rate.margin')}</span>
          <strong className="stat-value"><Money of={totals.margin} compact /></strong>
          <span className="stat-hint">{t('rate.marginHint')}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('rate.billableShare')}</span>
          <strong className="stat-value">
            {totals.billableShare === null ? '—' : `${Math.round(totals.billableShare * 100)}%`}
          </strong>
          <span className="stat-hint">{duration(totals.billableMinutes)} / {duration(totals.minutes)}</span>
        </div>
      </div>

      <SectionHeading tight>{t('rate.perProject')}</SectionHeading>
      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>{t('budget.project')}</th>
              <th className="num">{t('rate.hours')}</th>
              <th className="num">{t('rate.billable')}</th>
              <th className="num">{t('rate.cost')}</th>
              <th className="num">{t('rate.revenue')}</th>
              <th className="num">{t('rate.margin')}</th>
            </tr>
          </thead>
          <tbody>
            {perProject.map((row) => (
              <tr key={row.key}>
                <td className="title">
                  {row.name}
                  {row.unratedMinutes > 0 && (
                    <span className="row-sub">{t('rate.unrated', { hours: duration(row.unratedMinutes) })}</span>
                  )}
                </td>
                <td className="num">{duration(row.minutes)}</td>
                <td className="num">{duration(row.billableMinutes)}</td>
                <td className="num"><Money of={row.cost} /></td>
                <td className="num"><Money of={row.revenue} /></td>
                <td className="num"><Money of={row.margin} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHeading>{t('rate.perPerson')}</SectionHeading>
      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>{t('timesheet.person')}</th>
              <th className="num">{t('rate.hours')}</th>
              <th className="num">{t('rate.billable')}</th>
              <th className="num">{t('rate.billableShare')}</th>
              {target > 0 && <th className="num">{t('rate.againstTarget')}</th>}
            </tr>
          </thead>
          <tbody>
            {perPerson.map((row) => (
              <tr key={row.key}>
                <td className="title">{nameOf.get(row.key) ?? t('timesheet.unknown')}</td>
                <td className="num">{duration(row.minutes)}</td>
                <td className="num">{duration(row.billableMinutes)}</td>
                <td className="num">{row.share === null ? '—' : `${Math.round(row.share * 100)}%`}</td>
                {target > 0 && (
                  <td className="num">{row.againstTarget === null ? '—' : `${Math.round(row.againstTarget * 100)}%`}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-muted">{t('rate.targetHint')}</p>
    </div>
  );
}

/* --------------------------------------------------------------- editing */

/**
 * The rates a workspace has agreed on, and the history behind each.
 *
 * There is no edit button, on purpose. Changing a rate is adding one that
 * starts on a day — the old row stays, because it is the answer to "why was
 * March costed at eighty". Deleting is for a row somebody typed by mistake,
 * and it is the only destructive thing here.
 */
export function RateSettings() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const rates = useQuery(() => list('rate'), []);
  const projects = useQuery(() => list('project', (row) => !row.archived), []);

  const nameOf = useMemo(() => {
    const names = new Map<ID, string>();
    for (const member of members) names.set(member.id, member.name);
    for (const project of projects) names.set(project.id, project.name);
    return names;
  }, [members, projects]);

  /**
   * Grouped by who and where, newest first inside each — so a rate that has
   * changed three times reads as one thing with a history rather than as three
   * unrelated rows that happen to sort next to each other.
   */
  const groups = useMemo(() => {
    const seen = new Map<string, { kind: RateKind; userId: ID | null; projectId: ID | null; rows: Rate[] }>();
    for (const rate of rates) {
      const key = `${rate.kind}:${rate.user_id ?? ''}:${rate.project_id ?? ''}`;
      if (!seen.has(key)) {
        seen.set(key, {
          kind: rate.kind,
          userId: rate.user_id ?? null,
          projectId: rate.project_id ?? null,
          rows: rateHistory(rates, { userId: rate.user_id ?? null, projectId: rate.project_id ?? null, kind: rate.kind }),
        });
      }
    }
    // The workspace default first, then the more specific ones: the list reads
    // the way the resolution rule does.
    return [...seen.values()].sort((a, b) => {
      const rank = (row: typeof a) => (row.userId ? 2 : 0) + (row.projectId ? 1 : 0);
      return rank(a) - rank(b) || (a.kind < b.kind ? -1 : 1);
    });
  }, [rates]);

  const day = today();

  return (
    <>
      <p className="text-[13px] text-muted">{t('rate.settingsHint')}</p>
      <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
        <Icon name="plus" size={14} /> {t('rate.add')}
      </Button>

      {!groups.length ? (
        <p className="mt-3 text-[13px] text-muted">{t('rate.none')}</p>
      ) : (
        groups.map((group) => {
          const current = resolveRate(rates, {
            userId: group.userId, projectId: group.projectId, day, kind: group.kind,
          });
          return (
            <div className="rate-group" key={`${group.kind}:${group.userId}:${group.projectId}`}>
              <div className="rate-head">
                <strong className="flex-1 min-w-0 truncate">
                  {group.userId ? nameOf.get(group.userId) ?? t('timesheet.unknown') : t('rate.anybody')}
                  {' · '}
                  {group.projectId ? nameOf.get(group.projectId) ?? t('budget.unknownProject') : t('rate.everywhere')}
                </strong>
                <Chip className={group.kind === 'billable' ? 'stage-paid' : ''}>{t(rateKindKey(group.kind))}</Chip>
              </div>
              {group.rows.map((rate) => (
                <div className={`rate-row${current?.id === rate.id ? ' current' : ''}`} key={rate.id}>
                  <span className="rate-amount">
                    {formatMoney(rate.amount, rate.currency, currentLocale())}{t('rate.perHour')}
                  </span>
                  <span className="rate-from">{t('rate.from', { date: rate.starts_on })}</span>
                  {current?.id === rate.id && <Chip className="health-healthy">{t('rate.inForce')}</Chip>}
                  {rate.note && <span className="rate-note truncate">{rate.note}</span>}
                  <div className="flex-1 min-w-0" />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('action.delete')}
                    onClick={async () => {
                      if (await confirm(t('rate.deleteConfirm'))) remove('rate', rate.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
              ))}
            </div>
          );
        })
      )}

      {adding && <RateForm members={members} projects={projects} onClose={() => setAdding(false)} />}
      {dialog}
    </>
  );
}

function RateForm({ members, projects, onClose }: {
  members: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  onClose: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState(() => ({
    user_id: '',
    project_id: '',
    kind: 'cost' as RateKind,
    amount: 0,
    currency: 'EUR',
    starts_on: today(),
    note: '',
  }));

  return (
    <Sheet
      title={t('rate.add')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!form.amount}
          onClick={() => {
            create('rate', {
              user_id: form.user_id || null,
              project_id: form.project_id || null,
              kind: form.kind,
              amount: form.amount,
              currency: form.currency,
              starts_on: form.starts_on,
              note: form.note.trim() || null,
            });
            onClose();
          }}
        >
          {t('action.save')}
        </Button>
      )}
    >
      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="r-amount">{t('rate.amount')}</label>
          <MoneyInput
            id="r-amount"
            currency={form.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="r-currency">{t('budget.currency')}</label>
          <Input
            id="r-currency"
            maxLength={3}
            value={form.currency}
            onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
          />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="r-kind">{t('rate.kindLabel')}</label>
          <Select
            id="r-kind"
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as RateKind })}
          >
            {RATE_KINDS.map((kind) => <option key={kind} value={kind}>{t(rateKindKey(kind))}</option>)}
          </Select>
        </div>
      </div>

      <div className="field-row">
        <div className="field flex-1 min-w-0">
          <label htmlFor="r-user">{t('rate.who')}</label>
          <Select id="r-user" value={form.user_id} onChange={(event) => setForm({ ...form, user_id: event.target.value })}>
            <option value="">{t('rate.anybody')}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="r-project">{t('rate.where')}</label>
          <Select id="r-project" value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })}>
            <option value="">{t('rate.everywhere')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="r-from">{t('rate.startsOn')}</label>
        <Input id="r-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        <span className="text-[12px] text-muted">{t('rate.startsOnHint')}</span>
      </div>

      <div className="field">
        <label htmlFor="r-note">{t('budget.adjNote')}</label>
        <Input id="r-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/** Kept for the screens that ask "and what did this week's hours cost". */
export const weekOf = (day: string) => ({ start: weekStart(day), days: weekDays(day) });

export { asMoney };
