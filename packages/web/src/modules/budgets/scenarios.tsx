/** Scenarios: the argument somebody makes about a budget, written as adjustments to its plan. */
import { useMemo, useState } from 'react';
import {
  COST_CATEGORIES, COST_CONFIDENCE, FULL_SHARE, rollUp, type Budget, type BudgetLine,
  type BudgetScenario, type CostCategory, type ScenarioAdjustment,
} from '@kolibri/shared';
import { categoryKey, confidenceKey } from './budget';
import { asMoney } from '../../kernel/design-system/ui/money';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select, Textarea, checkRow, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { useCanWrite } from '../../kernel/identity/session';
import { pageBody } from '../../kernel/design-system/ui/page';
import { cn } from '../../kernel/design-system/cn';

export function Scenarios({ budget, showing, onShow }: {
  budget: Budget;
  showing: string | null;
  onShow: (id: string | null) => void;
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<BudgetScenario | 'new' | null>(null);
  const scenarios = useQuery(() => list('budgetScenario', (row) => row.budget_id === budget.id), [budget.id]);
  const lines = useQuery(() => list('budgetLine', (row) => row.budget_id === budget.id), [budget.id]);
  const actuals = useQuery(() => list('budgetActual', (row) => row.budget_id === budget.id), [budget.id]);
  const plan = useMemo(() => rollUp({ budget, lines, actuals }), [budget, lines, actuals]);

  return (
    <div className={pageBody}>
      <p className="text-label text-muted">{t('budget.scenarioHint')}</p>
      {canWrite && (
        <div className="mb-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> {t('budget.addScenario')}
          </Button>
        </div>
      )}

      {!scenarios.length ? (
        <Empty emoji="🔀" title={t('budget.noScenarios')} hint={t('budget.noScenariosHint')} />
      ) : (
        <div className="scenario-list">
          <div className="scenario-card baseline">
            <div className="flex-1 min-w-0">
              <strong>{t('budget.scenarioPlan')}</strong>
              <span className="row-sub">{asMoney(plan.planned, plan.currency)}</span>
            </div>
            {showing && <Button size="sm" onClick={() => onShow(null)}>{t('budget.clearScenario')}</Button>}
          </div>
          {scenarios.map((scenario) => {
            const rolled = rollUp({ budget, lines, actuals, scenario });
            const delta = rolled.planned - plan.planned;
            return (
              <div className={`scenario-card${showing === scenario.id ? ' showing' : ''}`} key={scenario.id}>
                <div className="flex-1 min-w-0">
                  <strong>{scenario.name}</strong>
                  <span className="row-sub">
                    {asMoney(rolled.planned, rolled.currency)} · {t('budget.scenarioDelta', {
                      amount: `${delta > 0 ? '+' : ''}${asMoney(delta, rolled.currency)}`,
                    })}
                  </span>
                  {scenario.description && <span className="row-sub">{scenario.description}</span>}
                </div>
                <Button size="sm" onClick={() => onShow(scenario.id)} disabled={showing === scenario.id}>
                  {t('budget.apply')}
                </Button>
                {canWrite && (
                  <>
                    <Button variant="ghost" size="icon" aria-label={t('action.edit')} onClick={() => setEditing(scenario)}>
                      <Icon name="pencil" size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('action.delete')}
                      onClick={async () => {
                        if (await confirm(t('budget.deleteScenario', { name: scenario.name }))) {
                          if (showing === scenario.id) onShow(null);
                          remove('budgetScenario', scenario.id);
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ScenarioForm
          budget={budget}
          scenario={editing === 'new' ? null : editing}
          lines={lines}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

function ScenarioForm({ budget, scenario, lines, onClose }: {
  budget: Budget;
  scenario: BudgetScenario | null;
  lines: BudgetLine[];
  onClose: () => void;
}) {
  const t = useT();
  const saveChanges = useSaveChanges('budgetScenario', scenario);
  const [name, setName] = useState(scenario?.name ?? '');
  const [description, setDescription] = useState(scenario?.description ?? '');
  const [adjustments, setAdjustments] = useState<ScenarioAdjustment[]>(scenario?.adjustments ?? []);
  const [weights, setWeights] = useState(() => ({
    committed: scenario?.weights?.committed ?? FULL_SHARE,
    likely: scenario?.weights?.likely ?? FULL_SHARE,
    possible: scenario?.weights?.possible ?? FULL_SHARE,
  }));

  const set = (index: number, patch: Partial<ScenarioAdjustment>) =>
    setAdjustments(adjustments.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const save = () => {
    const patch = {
      budget_id: budget.id,
      name: name.trim(),
      description: description.trim() || null,
      adjustments,
      // Written only when it says something. A weights object that carries
      // everything at 100% is the plan as written, and storing it would make
      // every scenario look like it had an opinion about confidence.
      weights: Object.values(weights).every((value) => value === FULL_SHARE) ? null : weights,
    };
    if (scenario) saveChanges(patch);
    else create('budgetScenario', patch);
    onClose();
  };

  return (
    <Sheet
      title={scenario ? t('budget.scenario') : t('budget.addScenario')}
      wide
      onClose={onClose}
      footer={<Button variant="primary" onClick={save} disabled={!name.trim()}>{t('action.save')}</Button>}
    >
      <div className={formField}>
        <label htmlFor="bs-name">{t('budget.scenarioName')}</label>
        <Input
          id="bs-name"
          autoFocus
          placeholder={t('budget.scenarioNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className={formField}>
        <label htmlFor="bs-desc">{t('budget.description')}</label>
        <Textarea id="bs-desc" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>

      <SectionHeading tight>{t('budget.weights')}</SectionHeading>
      <p className="text-label text-muted">{t('budget.weightsHint')}</p>
      <div className={formRow}>
        {COST_CONFIDENCE.map((level) => (
          <div className={cn(formField, 'flex-1 min-w-0')} key={level}>
            <label htmlFor={`bs-w-${level}`}>{t(confidenceKey(level))}</label>
            <Input
              id={`bs-w-${level}`}
              type="number"
              min={0}
              max={100}
              value={Math.round(weights[level] / 100)}
              onChange={(event) => setWeights({ ...weights, [level]: Math.max(0, Number(event.target.value) || 0) * 100 })}
            />
          </div>
        ))}
      </div>

      <SectionHeading tight>{t('budget.adjustment')}</SectionHeading>
      {adjustments.map((adjustment, index) => (
        <div className="adjustment" key={index}>
          <div className={formRow}>
            <div className={cn(formField, 'flex-1 min-w-0')}>
              <label htmlFor={`bs-a-${index}`}>{t('budget.adjApplies')}</label>
              <Select
                id={`bs-a-${index}`}
                value={adjustment.line_id ?? (adjustment.category ? `cat:${adjustment.category}` : '')}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith('cat:')) set(index, { line_id: null, category: value.slice(4) as CostCategory });
                  else set(index, { line_id: value || null, category: null });
                }}
              >
                <option value="">{t('budget.adjEveryLine')}</option>
                {COST_CATEGORIES.map((category) => (
                  <option key={category} value={`cat:${category}`}>{t(categoryKey(category))}</option>
                ))}
                {lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
              </Select>
            </div>
            <div className={cn(formField, 'flex-1 min-w-0')}>
              <label htmlFor={`bs-f-${index}`}>{t('budget.adjFactor')} %</label>
              <Input
                id={`bs-f-${index}`}
                type="number"
                min={0}
                value={Math.round((adjustment.factor ?? FULL_SHARE) / 100)}
                onChange={(event) => set(index, { factor: Math.max(0, Number(event.target.value) || 0) * 100 })}
              />
            </div>
            <div className={cn(formField, 'flex-1 min-w-0')}>
              <label htmlFor={`bs-s-${index}`}>{t('budget.adjShift')}</label>
              <Input
                id={`bs-s-${index}`}
                type="number"
                value={adjustment.shift_months ?? 0}
                onChange={(event) => set(index, { shift_months: Number(event.target.value) || 0 })}
              />
            </div>
          </div>
          <div className={cn(formRow, 'items-center')}>
            <label className={cn(checkRow, 'flex-1 min-w-0')}>
              <input
                type="checkbox"
                checked={!!adjustment.drop}
                onChange={(event) => set(index, { drop: event.target.checked })}
              />
              <span><span>{t('budget.adjDrop')}</span></span>
            </label>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('action.remove')}
              onClick={() => setAdjustments(adjustments.filter((_, at) => at !== index))}
            >
              <Icon name="close" size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button size="sm" onClick={() => setAdjustments([...adjustments, { factor: FULL_SHARE }])}>
        <Icon name="plus" size={13} /> {t('budget.addAdjustment')}
      </Button>
    </Sheet>
  );
}
