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
import { currentLocale, useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { today } from '../../kernel/design-system/format';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useMembers, useSeesMoney } from '../../kernel/identity/session';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { pageBody } from '../../kernel/design-system/ui/page';
import { statHint, statLabel, statRow, statTile, statValue } from '../../kernel/design-system/ui/stat';
import { cn } from '../../kernel/design-system/cn';
import { DataTable, Td, Th, Tr, tableCell } from '../../kernel/design-system/ui/data-table';

export const rateKindKey = (kind: string): TranslationKey => `rate.kind.${kind}` as TranslationKey;

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
    <div className={pageBody}>
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
            {/* A grid people scan down a column of: every figure tabular and at
                least 68px wide, so the days line up whatever is in them, and the
                weekend tinted rather than hidden — Saturday with work on it is
                worth noticing, and a column that is not there cannot be. The
                headings stand on the bottom edge, where a day's two lines and
                the other columns' one line agree. */}
            <DataTable>
              <thead>
                <tr>
                  <Th className="align-bottom">{by === 'user' ? t('timesheet.person') : t('budget.project')}</Th>
                  {sheet.days.map((day, index) => (
                    <Th key={day} numeric className={cn('min-w-17 align-bottom', index >= 5 && 'bg-sunken')}>
                      <span className="block font-semibold">{dayLabel(day)}</span>
                      <span className="block text-caption font-normal text-muted">{dayNumber(day)}</span>
                    </Th>
                  ))}
                  <Th numeric className="min-w-17 align-bottom">{t('timesheet.total')}</Th>
                  {seesMoney && <Th numeric className="min-w-17 align-bottom">{t('rate.cost')}</Th>}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row) => (
                  <Tr key={row.key}>
                    <Td lead>
                      {row.key ? nameOf.get(row.key) ?? t('timesheet.unknown') : t('timesheet.noProject')}
                      {seesMoney && row.unratedMinutes > 0 && (
                        <span className="row-sub">{t('rate.unrated', { hours: duration(row.unratedMinutes) })}</span>
                      )}
                    </Td>
                    {row.days.map((minutes, index) => (
                      <Td key={index} numeric className={cn('min-w-17', index >= 5 && 'bg-sunken')}>
                        {/* An empty cell rather than "0h". A zero in every gap
                            is a grid nobody can find the worked days in. */}
                        {minutes ? duration(minutes) : ''}
                      </Td>
                    ))}
                    <Td numeric className="min-w-17"><strong>{duration(row.minutes)}</strong></Td>
                    {seesMoney && <Td numeric className="min-w-17"><Money of={row.cost} /></Td>}
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong">
                  <th className={tableCell()}>{t('timesheet.total')}</th>
                  {sheet.perDay.map((minutes, index) => (
                    <th key={index} className={cn(tableCell({ numeric: true }), 'min-w-17', index >= 5 && 'bg-sunken')}>
                      {minutes ? duration(minutes) : ''}
                    </th>
                  ))}
                  <th className={cn(tableCell({ numeric: true }), 'min-w-17')}>{duration(sheet.totals.minutes)}</th>
                  {seesMoney && <th className={cn(tableCell({ numeric: true }), 'min-w-17')}><Money of={sheet.totals.cost} /></th>}
                </tr>
              </tfoot>
            </DataTable>
          </div>
          {seesMoney && sheet.totals.unratedMinutes > 0 && (
            <p className="mt-2 text-label text-muted">{t('rate.unratedHint')}</p>
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
    <div className={pageBody}>
      <div className="week-bar flex-wrap">
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

      <div className={statRow}>
        <div className={statTile}>
          <span className={statLabel}>{t('rate.cost')}</span>
          <strong className={statValue}><Money of={totals.cost} compact /></strong>
          {totals.unratedMinutes > 0 && (
            <span className={statHint}>{t('rate.unrated', { hours: duration(totals.unratedMinutes) })}</span>
          )}
        </div>
        <div className={statTile}>
          <span className={statLabel}>{t('rate.revenue')}</span>
          <strong className={statValue}><Money of={totals.revenue} compact /></strong>
          <span className={statHint}>{t('rate.revenueHint')}</span>
        </div>
        <div className={statTile}>
          <span className={statLabel}>{t('rate.margin')}</span>
          <strong className={statValue}><Money of={totals.margin} compact /></strong>
          <span className={statHint}>{t('rate.marginHint')}</span>
        </div>
        <div className={statTile}>
          <span className={statLabel}>{t('rate.billableShare')}</span>
          <strong className={statValue}>
            {totals.billableShare === null ? '—' : `${Math.round(totals.billableShare * 100)}%`}
          </strong>
          <span className={statHint}>{duration(totals.billableMinutes)} / {duration(totals.minutes)}</span>
        </div>
      </div>

      <SectionHeading tight>{t('rate.perProject')}</SectionHeading>
      <div className="table-wrap">
        <DataTable>
          <thead>
            <tr>
              <Th>{t('budget.project')}</Th>
              <Th numeric>{t('rate.hours')}</Th>
              <Th numeric>{t('rate.billable')}</Th>
              <Th numeric>{t('rate.cost')}</Th>
              <Th numeric>{t('rate.revenue')}</Th>
              <Th numeric>{t('rate.margin')}</Th>
            </tr>
          </thead>
          <tbody>
            {perProject.map((row) => (
              <Tr key={row.key}>
                <Td lead>
                  {row.name}
                  {row.unratedMinutes > 0 && (
                    <span className="row-sub">{t('rate.unrated', { hours: duration(row.unratedMinutes) })}</span>
                  )}
                </Td>
                <Td numeric>{duration(row.minutes)}</Td>
                <Td numeric>{duration(row.billableMinutes)}</Td>
                <Td numeric><Money of={row.cost} /></Td>
                <Td numeric><Money of={row.revenue} /></Td>
                <Td numeric><Money of={row.margin} /></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      </div>

      <SectionHeading>{t('rate.perPerson')}</SectionHeading>
      <div className="table-wrap">
        <DataTable>
          <thead>
            <tr>
              <Th>{t('timesheet.person')}</Th>
              <Th numeric>{t('rate.hours')}</Th>
              <Th numeric>{t('rate.billable')}</Th>
              <Th numeric>{t('rate.billableShare')}</Th>
              {target > 0 && <Th numeric>{t('rate.againstTarget')}</Th>}
            </tr>
          </thead>
          <tbody>
            {perPerson.map((row) => (
              <Tr key={row.key}>
                <Td lead>{nameOf.get(row.key) ?? t('timesheet.unknown')}</Td>
                <Td numeric>{duration(row.minutes)}</Td>
                <Td numeric>{duration(row.billableMinutes)}</Td>
                <Td numeric>{row.share === null ? '—' : `${Math.round(row.share * 100)}%`}</Td>
                {target > 0 && (
                  <Td numeric>{row.againstTarget === null ? '—' : `${Math.round(row.againstTarget * 100)}%`}</Td>
                )}
              </Tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      <p className="mt-2 text-label text-muted">{t('rate.targetHint')}</p>
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
      <p className="text-body text-muted">{t('rate.settingsHint')}</p>
      <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
        <Icon name="plus" size={14} /> {t('rate.add')}
      </Button>

      {!groups.length ? (
        <p className="mt-3 text-body text-muted">{t('rate.none')}</p>
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
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-amount">{t('rate.amount')}</label>
          <MoneyInput
            id="r-amount"
            currency={form.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-currency">{t('budget.currency')}</label>
          <Input
            id="r-currency"
            maxLength={3}
            value={form.currency}
            onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
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

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-user">{t('rate.who')}</label>
          <Select id="r-user" value={form.user_id} onChange={(event) => setForm({ ...form, user_id: event.target.value })}>
            <option value="">{t('rate.anybody')}</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="r-project">{t('rate.where')}</label>
          <Select id="r-project" value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })}>
            <option value="">{t('rate.everywhere')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </div>
      </div>

      <div className={formField}>
        <label htmlFor="r-from">{t('rate.startsOn')}</label>
        <Input id="r-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        <span className="text-label text-muted">{t('rate.startsOnHint')}</span>
      </div>

      <div className={formField}>
        <label htmlFor="r-note">{t('budget.adjNote')}</label>
        <Input id="r-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}

/** Kept for the screens that ask "and what did this week's hours cost". */
export const weekOf = (day: string) => ({ start: weekStart(day), days: weekDays(day) });

export { asMoney };
