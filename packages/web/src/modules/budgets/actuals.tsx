/**
 * What has actually gone: the record of spend, confirming what was planned,
 * and the form an entry is written in.
 */
import { useMemo, useState } from 'react';
import {
  COST_CATEGORIES, SPEND_STAGES, actualFromPlan, monthDistance, monthOf, periodOf, plannedForMonth,
  type Allocation, type Budget, type BudgetActual, type BudgetLine, type CostCategory,
  type PlannedForMonth, type SpendStage,
} from '@kolibri/shared';
import { AllocationEditor, categoryKey, stageKey, useRollUp } from './budget';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet, useConfirm, useDirty } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, formField, formRow } from '../../kernel/design-system/ui/field';
import { monthName, shortDate, today } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { pageBody } from '../../kernel/design-system/ui/page';
import { cn } from '../../kernel/design-system/cn';
import { DataTable, Td, Th, Tr, rowOpen } from '../../kernel/design-system/ui/data-table';

/**
 * How far real money has got, as a class. Written out for the reason
 * `HEALTH_CLASS` is: `check:css` reads the source for class names, and a
 * template literal is a name it cannot check. `invoiced` maps to nothing —
 * it is the ordinary middle of the three and needs no colour of its own.
 */
const STAGE_CLASS: Record<SpendStage, string> = {
  committed: 'stage-committed',
  invoiced: '',
  paid: 'stage-paid',
};

export function Actuals({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<BudgetActual | 'new' | null>(null);
  const actuals = useQuery(() => list('budgetActual', (row) => row.budget_id === budget.id), [budget.id]);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const lineNames = useMemo(() => new Map(lines.map((row) => [row.id, row.name])), [lines]);
  const sorted = useMemo(
    () => [...actuals].sort((a, b) => (a.spent_on < b.spent_on ? 1 : a.spent_on > b.spent_on ? -1 : b.created_at - a.created_at)),
    [actuals],
  );

  return (
    <div className={pageBody}>
      {canWrite && <ConfirmPlanned budget={budget} lines={lines} actuals={actuals} />}

      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addActual')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🧾" title={t('budget.noActuals')} hint={t('budget.noActualsHint')} />
      ) : (
        <div className="table-wrap">
          <DataTable>
            <thead>
              <tr>
                <Th>{t('budget.spentOn')}</Th>
                <Th>{t('budget.actualDescription')}</Th>
                <Th>{t('budget.against')}</Th>
                <Th>{t('budget.category')}</Th>
                <Th>{t('budget.stage')}</Th>
                <Th numeric>{t('budget.amount')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <Tr key={entry.id} onClick={() => canWrite && setEditing(entry)}>
                  <Td>{shortDate(entry.spent_on)}</Td>
                  <Td lead>
                    {canWrite ? <button type="button" className={rowOpen}>{entry.description}</button> : entry.description}
                    {entry.reference && <span className="row-sub">{entry.reference}</span>}
                  </Td>
                  <Td>
                    {entry.line_id
                      ? lineNames.get(entry.line_id) ?? t('budget.noLine')
                      : <span className="text-muted">{t('budget.noLine')}</span>}
                  </Td>
                  <Td>{t(categoryKey(entry.category))}</Td>
                  <Td>
                    <Chip className={STAGE_CLASS[entry.stage]}>{t(stageKey(entry.stage))}</Chip>
                  </Td>
                  <Td numeric>{asMoney(entry.amount, budget.currency)}</Td>
                  <Td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const amount = asMoney(entry.amount, budget.currency);
                          if (await confirm(t('budget.deleteActual', { amount }))) remove('budgetActual', entry.id);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      )}

      {editing && (
        <ActualForm
          budget={budget}
          entry={editing === 'new' ? null : editing}
          lines={lines}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

/**
 * Taking a month's planned costs across, one press each.
 *
 * The recurring half of a budget is almost all of it — twelve identical hosting
 * bills a year, four quarterly ones, a licence renewal — and typing the same
 * four fields twelve times is why the actuals in a budget stop being filled in
 * around April. A budget nobody records against is a budget with a plan and no
 * reality to compare it to, which is a worse failure than any of the ones the
 * forecast rules guard against.
 *
 * A confirmed row is an ordinary actual in every respect: same shape, same
 * table, editable and deletable like any other, and nothing downstream knows it
 * was not typed. See `actualFromPlan` — there is deliberately no flag on the
 * row saying where it came from.
 */
function ConfirmPlanned({ budget, lines, actuals }: {
  budget: Budget;
  lines: BudgetLine[];
  actuals: BudgetActual[];
}) {
  const t = useT();
  const toast = useToast();
  const totals = useRollUp(budget);
  /* The month somebody is closing: today's, clamped into the budget's period so
     a closed budget opens on its last month and one that has not started yet on
     its first — neither can have anything to confirm. Clamped against `periodOf`
     rather than against `period_end`, because a budget with an open end has a
     period all the same and reading the raw column would miss it. */
  const [month, setMonth] = useState(() => {
    const { from, to } = periodOf(budget, today());
    const now = monthOf(today());
    return now < from ? from : now > to ? to : now;
  });
  /**
   * What stage a confirmation records.
   *
   * A choice rather than a constant, because the same press means different
   * things depending on when in the month it happens: at the start it is a
   * commitment nobody has invoiced, at the end it is a bill that was paid.
   * Defaulted to paid, which is what somebody closing a month means.
   */
  const [stage, setStage] = useState<SpendStage>('paid');

  const planned = useMemo(
    () => (totals ? plannedForMonth({ lines, actuals, month, period: totals.period }) : []),
    [lines, actuals, month, totals],
  );
  const open = planned.filter((row) => !row.confirmed);
  const outstanding = open.reduce((sum, row) => sum + row.amount, 0);

  const describe = (row: PlannedForMonth) => `${row.line.name} · ${monthName(row.month)}`;
  const take = (rows: PlannedForMonth[]) => {
    for (const row of rows) create('budgetActual', actualFromPlan(row, { budgetId: budget.id, stage, describe }));
    toast(t('budget.confirmed', { count: rows.length }));
  };

  /**
   * Two ways for the strip to have nothing to offer, and both collapse it.
   *
   * Nothing planned is the empty month: the picker stays so somebody can look
   * at another one, but a heading over an empty box helps nobody. Settled is
   * the closed month, and it collapses for a different reason — every row it
   * would list is already a row in the table directly below, so leaving the
   * list up prints the same two figures twice on one screen and turns a
   * checklist into wallpaper. One sentence says the useful part.
   */
  const nothingPlanned = !planned.length;
  const settled = !nothingPlanned && !open.length;
  /**
   * Outside the budget's own period, which is a different sentence.
   *
   * "Nothing is planned for August" is true and useless when the budget runs to
   * June: it reads as *there is no plan* rather than as *you are looking past
   * the end of this budget*, and somebody reasonably concludes the feature is
   * broken. This is the one place that difference is visible, so it says which
   * it is and what the period actually is.
   */
  const outside = !!totals && (monthDistance(totals.period.from, month) < 0
    || monthDistance(month, totals.period.to) < 0);

  return (
    <div className="confirm-strip">
      <div className="confirm-head">
        <strong className="flex-1 min-w-0">{t('budget.confirmTitle')}</strong>
        <Input
          type="month"
          className="w-auto"
          aria-label={t('budget.month')}
          value={month}
          onChange={(event) => setMonth(event.target.value || monthOf(today()))}
        />
        {/* The stage only describes something about to be written, so it is
            not offered on a month with nothing left to write. */}
        {!!open.length && (
          <Select
            className="w-auto"
            aria-label={t('budget.stage')}
            value={stage}
            onChange={(event) => setStage(event.target.value as SpendStage)}
          >
            {SPEND_STAGES.map((name) => <option key={name} value={name}>{t(stageKey(name))}</option>)}
          </Select>
        )}
      </div>

      {outside ? (
        <p className="confirm-empty">
          {t('budget.confirmOutside', {
            month: monthName(month),
            from: monthName(totals!.period.from),
            to: monthName(totals!.period.to),
          })}
        </p>
      ) : nothingPlanned ? (
        <p className="confirm-empty">{t('budget.confirmNothing', { month: monthName(month) })}</p>
      ) : settled ? (
        <p className="confirm-empty done">
          <Icon name="check" size={13} /> {t('budget.confirmSettled', { month: monthName(month) })}
        </p>
      ) : (
        <>
          <ul className="confirm-list">
            {planned.map((row) => (
              <li key={row.line.id} className={row.confirmed ? 'done' : ''}>
                <span className="flex-1 min-w-0 truncate">{row.line.name}</span>
                <span className="text-label text-muted">{shortDate(row.on)}</span>
                <span className="tabular-nums">{asMoney(row.amount, budget.currency)}</span>
                {row.confirmed ? (
                  /* Already recorded, so no button — and the figure that is
                     really there, which is the useful thing when it is not the
                     one that was planned. */
                  <span className="confirm-done">
                    <Icon name="check" size={13} />
                    {t('budget.confirmAlready', { amount: asMoney(row.recorded, budget.currency) })}
                  </span>
                ) : (
                  <Button size="sm" onClick={() => take([row])}>{t('budget.confirmOne')}</Button>
                )}
              </li>
            ))}
          </ul>
          {open.length > 1 && (
            <div className="confirm-foot">
              <Button variant="primary" size="sm" onClick={() => take(open)}>
                {t('budget.confirmAll', { count: open.length, amount: asMoney(outstanding, budget.currency) })}
              </Button>
              <span className="text-label text-muted">{t('budget.confirmHint')}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActualForm({ budget, entry, lines, onClose }: {
  budget: Budget;
  entry: BudgetActual | null;
  lines: BudgetLine[];
  onClose: () => void;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const saveChanges = useSaveChanges('budgetActual', entry);
  const [form, setForm] = useState(() => ({
    description: entry?.description ?? '',
    amount: entry?.amount ?? 0,
    line_id: entry?.line_id ?? '',
    category: entry?.category ?? ('infrastructure' as CostCategory),
    spent_on: entry?.spent_on ?? today(),
    stage: entry?.stage ?? 'paid',
    vendor: entry?.vendor ?? '',
    reference: entry?.reference ?? '',
    note: entry?.note ?? '',
  }));
  const [allocations, setAllocations] = useState<Allocation[]>(entry?.allocations ?? []);
  const dirty = useDirty({ form, allocations });

  /**
   * Picking a plan line fills in the things the line already knows.
   *
   * Only the fields somebody has not touched — an invoice against the hosting
   * line is a hosting cost from that supplier, and asking again invites a
   * mismatch that only ever shows up as two categories that should have been
   * one. The split is deliberately left empty rather than copied: an empty
   * split *means* "follow the line", and copying it would freeze today's
   * percentages into an invoice that should follow the line when it changes.
   */
  const pickLine = (id: string) => {
    const line = lines.find((row) => row.id === id);
    setForm((current) => ({
      ...current,
      line_id: id,
      category: line?.category ?? current.category,
      vendor: current.vendor || (line?.vendor ?? ''),
    }));
  };

  const save = () => {
    const patch = {
      budget_id: budget.id,
      line_id: form.line_id || null,
      description: form.description.trim(),
      amount: form.amount,
      category: form.category,
      spent_on: form.spent_on || today(),
      stage: form.stage,
      vendor: form.vendor.trim() || null,
      reference: form.reference.trim() || null,
      allocations,
      note: form.note.trim() || null,
    };
    if (entry) saveChanges(patch);
    else create('budgetActual', patch);
    onClose();
  };

  return (
    <Sheet
      title={t('budget.addActual')}
      onClose={onClose}
      dirty={dirty}
      footer={<Button variant="primary" onClick={save} disabled={!form.description.trim()}>{t('action.save')}</Button>}
    >
      <div className={formField}>
        <label htmlFor="ba-what">{t('budget.actualDescription')}</label>
        <Input
          id="ba-what"
          autoFocus
          placeholder={t('budget.actualDescriptionPlaceholder')}
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-amount">{t('budget.amount')} ({budget.currency})</label>
          <MoneyInput
            id="ba-amount"
            currency={budget.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-date">{t('budget.spentOn')}</label>
          <Input id="ba-date" type="date" value={form.spent_on} onChange={(event) => setForm({ ...form, spent_on: event.target.value })} />
        </div>
      </div>

      <div className={formField}>
        <label htmlFor="ba-line">{t('budget.against')}</label>
        <Select id="ba-line" value={form.line_id} onChange={(event) => pickLine(event.target.value)}>
          <option value="">{t('budget.noLine')}</option>
          {lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
        </Select>
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-category">{t('budget.category')}</label>
          <Select
            id="ba-category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value as CostCategory })}
          >
            {COST_CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(categoryKey(category))}</option>
            ))}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-stage">{t('budget.stage')}</label>
          <Select
            id="ba-stage"
            value={form.stage}
            onChange={(event) => setForm({ ...form, stage: event.target.value as typeof form.stage })}
          >
            {SPEND_STAGES.map((stage) => <option key={stage} value={stage}>{t(stageKey(stage))}</option>)}
          </Select>
          <span className="text-label text-muted">{t('budget.stageHint')}</span>
        </div>
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-vendor">{t('budget.vendor')}</label>
          <Input id="ba-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="ba-ref">{t('budget.reference')}</label>
          <Input id="ba-ref" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
        </div>
      </div>

      <div className={formField} role="group" aria-labelledby="ba-charges">
        <label id="ba-charges">{t('budget.charges')}</label>
        <AllocationEditor value={allocations} projects={projects} onChange={setAllocations} />
      </div>
    </Sheet>
  );
}
