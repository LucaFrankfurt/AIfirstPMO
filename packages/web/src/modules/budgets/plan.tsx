/** What a budget plans to spend, line by line, and the form a line is written in. */
import { useMemo, useState } from 'react';
import {
  COST_CATEGORIES, COST_CONFIDENCE, COST_KINDS, COST_RECURRENCES, compareOrder, orderKey,
  plannedTotal, type Allocation, type Budget, type BudgetLine, type CostCategory, type Minor,
} from '@kolibri/shared';
import {
  AllocationChips, AllocationEditor, Variance, categoryKey, confidenceKey, recurrenceKey,
  useProjectNames, useRollUp,
} from './budget';
import { MoneyInput, asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet, useConfirm, useDirty } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Select, Textarea, formField, formRow } from '../../kernel/design-system/ui/field';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite, useFeature } from '../../kernel/identity/session';
import { pageBody } from '../../kernel/design-system/ui/page';
import { cn } from '../../kernel/design-system/cn';
import { DataTable, Td, Th, Tr, rowOpen } from '../../kernel/design-system/ui/data-table';

/**
 * Plan lines in the order somebody put them, with a tie-break that is not
 * chance.
 *
 * The comparator this replaced never returned 0, so eight lines that all
 * carried the schema's default key — which is what a line created over REST or
 * by an import has — came out in whatever order the sort happened to leave
 * them, and a different order on the next render. `compareOrder` is the shared
 * fractional-index comparison, and creation time settles the ties.
 */
const byOrder = (a: { sort_order?: string; created_at: number }, b: { sort_order?: string; created_at: number }) =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '') || a.created_at - b.created_at;

export function Plan({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const names = useProjectNames();
  const estate = useFeature('infrastructure');
  const [editing, setEditing] = useState<BudgetLine | 'new' | null>(null);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const components = useQuery(() => list('component'), []);
  const totals = useRollUp(budget);
  const sorted = useMemo(() => [...lines].sort(byOrder), [lines]);

  /**
   * What the register says a line's components come to, over the same period
   * the line is planned over.
   *
   * The reconciliation this whole link exists for: "we budgeted €4,500 a month
   * for hosting, and the register says the machines charged to that line cost
   * €5,200". Neither figure is authoritative — one is a plan and the other is
   * an inventory — and the useful thing is being told they disagree rather
   * than being handed one of them.
   *
   * A component is read through the same `plannedTotal` a budget line is,
   * because both carry an amount, a recurrence and a window. That is not a
   * coincidence: the component's cost fields were given the budget's
   * vocabulary so this comparison would need no conversion in between, and a
   * conversion is where two figures start quietly meaning different things.
   */
  const fromRegister = useMemo(() => {
    const out = new Map<string, Minor>();
    if (!estate || !totals) return out;
    for (const component of components) {
      if (!component.line_id) continue;
      const amount = plannedTotal(
        {
          amount: component.amount,
          recurrence: component.recurrence,
          starts_on: component.live_from,
          ends_on: component.live_until,
        },
        totals.period,
      );
      if (amount) out.set(component.line_id, (out.get(component.line_id) ?? 0) + amount);
    }
    return out;
  }, [estate, components, totals]);
  const anyRegistered = fromRegister.size > 0;

  return (
    <div className={pageBody}>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addLine')}
          </Button>
        </div>
      )}

      {!sorted.length ? (
        <Empty emoji="🧾" title={t('budget.noLines')} hint={t('budget.noLinesHint')} />
      ) : (
        <div className="table-wrap">
          <DataTable>
            <thead>
              <tr>
                <Th>{t('budget.lineName')}</Th>
                <Th>{t('budget.category')}</Th>
                <Th>{t('budget.recurrence')}</Th>
                <Th numeric>{t('budget.amountEach')}</Th>
                <Th numeric>{t('budget.total')}</Th>
                {anyRegistered && <Th numeric>{t('estate.fromRegister')}</Th>}
                <Th>{t('budget.charges')}</Th>
                <Th>{t('budget.confidence')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((line) => (
                <Tr key={line.id} onClick={() => canWrite && setEditing(line)}>
                  <Td lead>
                    {canWrite ? <button type="button" className={rowOpen}>{line.name}</button> : line.name}
                    {line.vendor && <span className="row-sub">{line.vendor}</span>}
                  </Td>
                  <Td>{t(categoryKey(line.category))}</Td>
                  <Td>{t(recurrenceKey(line.recurrence))}</Td>
                  <Td numeric>{asMoney(line.amount, budget.currency)}</Td>
                  <Td numeric>
                    {totals ? asMoney(plannedTotal(line, totals.period), budget.currency) : '—'}
                  </Td>
                  {anyRegistered && (
                    <Td numeric>
                      {fromRegister.has(line.id) ? (
                        <>
                          {asMoney(fromRegister.get(line.id)!, budget.currency)}
                          {/* Only shown when they disagree. A column of "and
                              they match" is a column nobody reads, and the
                              whole point is the row where they do not. */}
                          {totals && fromRegister.get(line.id) !== plannedTotal(line, totals.period) && (
                            <span className="row-sub">
                              <Variance
                                value={plannedTotal(line, totals.period) - fromRegister.get(line.id)!}
                                currency={budget.currency}
                              />
                            </span>
                          )}
                        </>
                      ) : <span className="text-muted">—</span>}
                    </Td>
                  )}
                  <Td><AllocationChips allocations={line.allocations} names={names} /></Td>
                  <Td><Chip>{t(confidenceKey(line.confidence))}</Chip></Td>
                  <Td>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('action.delete')}
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (await confirm(t('budget.deleteLine', { name: line.name }))) remove('budgetLine', line.id);
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

      {anyRegistered && <p className="mt-2 text-label text-muted">{t('estate.fromRegisterHint')}</p>}

      {editing && (
        <LineForm
          budget={budget}
          line={editing === 'new' ? null : editing}
          last={sorted[sorted.length - 1]?.sort_order ?? null}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function LineForm({ budget, line, last, onClose }: {
  budget: Budget;
  line: BudgetLine | null;
  last: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const saveChanges = useSaveChanges('budgetLine', line);
  const [form, setForm] = useState(() => ({
    name: line?.name ?? '',
    amount: line?.amount ?? 0,
    category: line?.category ?? ('infrastructure' as CostCategory),
    kind: line?.kind ?? 'opex',
    recurrence: line?.recurrence ?? 'once',
    starts_on: line?.starts_on ?? '',
    ends_on: line?.ends_on ?? '',
    vendor: line?.vendor ?? '',
    confidence: line?.confidence ?? 'likely',
    note: line?.note ?? '',
  }));
  const [allocations, setAllocations] = useState<Allocation[]>(line?.allocations ?? []);
  const dirty = useDirty({ form, allocations });

  const save = () => {
    const patch = {
      budget_id: budget.id,
      name: form.name.trim(),
      amount: form.amount,
      category: form.category,
      kind: form.kind,
      recurrence: form.recurrence,
      starts_on: form.starts_on || null,
      ends_on: form.ends_on || null,
      vendor: form.vendor.trim() || null,
      confidence: form.confidence,
      allocations,
      note: form.note.trim() || null,
    };
    if (line) saveChanges(patch);
    else create('budgetLine', { ...patch, sort_order: orderKey(last, null) });
    onClose();
  };

  return (
    <Sheet
      title={line ? t('budget.line') : t('budget.addLine')}
      onClose={onClose}
      dirty={dirty}
      footer={<Button variant="primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</Button>}
    >
      <div className={formField}>
        <label htmlFor="bl-name">{t('budget.lineName')}</label>
        <Input
          id="bl-name"
          autoFocus
          placeholder={t('budget.lineNamePlaceholder')}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-amount">{t('budget.amount')} ({budget.currency})</label>
          <MoneyInput
            id="bl-amount"
            currency={budget.currency}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
          />
          <span className="text-label text-muted">{t('budget.amountHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-every">{t('budget.recurrence')}</label>
          <Select
            id="bl-every"
            value={form.recurrence}
            onChange={(event) => setForm({ ...form, recurrence: event.target.value as typeof form.recurrence })}
          >
            {COST_RECURRENCES.map((every) => (
              <option key={every} value={every}>{t(recurrenceKey(every))}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-category">{t('budget.category')}</label>
          <Select
            id="bl-category"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value as CostCategory })}
          >
            {COST_CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(categoryKey(category))}</option>
            ))}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-kind">{t('budget.kind')}</label>
          <Select
            id="bl-kind"
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as typeof form.kind })}
          >
            {COST_KINDS.map((kind) => (
              <option key={kind} value={kind}>{t(`budget.kind.${kind}` as TranslationKey)}</option>
            ))}
          </Select>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-confidence">{t('budget.confidence')}</label>
          <Select
            id="bl-confidence"
            value={form.confidence}
            onChange={(event) => setForm({ ...form, confidence: event.target.value as typeof form.confidence })}
          >
            {COST_CONFIDENCE.map((level) => (
              <option key={level} value={level}>{t(confidenceKey(level))}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-from">{t('budget.periodStart')}</label>
          <Input id="bl-from" type="date" value={form.starts_on} onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="bl-to">{t('budget.periodEnd')}</label>
          <Input id="bl-to" type="date" value={form.ends_on} onChange={(event) => setForm({ ...form, ends_on: event.target.value })} />
        </div>
      </div>

      <div className={formField}>
        <label htmlFor="bl-vendor">{t('budget.vendor')}</label>
        <Input id="bl-vendor" value={form.vendor} onChange={(event) => setForm({ ...form, vendor: event.target.value })} />
      </div>

      <div className={formField} role="group" aria-labelledby="bl-charges">
        <label id="bl-charges">{t('budget.charges')}</label>
        <AllocationEditor value={allocations} projects={projects} onChange={setAllocations} />
      </div>

      <div className={formField}>
        <label htmlFor="bl-note">{t('budget.adjNote')}</label>
        <Textarea id="bl-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </div>
    </Sheet>
  );
}
