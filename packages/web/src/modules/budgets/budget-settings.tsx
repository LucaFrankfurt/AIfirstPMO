/** A budget's own fields: changing them, and making a budget in the first place. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BUDGET_STATUS, coversProject, monthOf, projectScope, type Budget } from '@kolibri/shared';
import { MoneyInput } from '../../kernel/design-system/ui/money';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Sheet, useConfirm, useDirty } from '../../kernel/design-system/ui/sheet';
import { useToast } from '../../kernel/design-system/ui/toast';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select, Textarea, checkRow, formField, formRow } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Attachments } from '../../kernel/files/Attachments';
import { today } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite } from '../../kernel/identity/session';
import { cn } from '../../kernel/design-system/cn';

export function BudgetSettings({ budget }: { budget: Budget }) {
  const t = useT();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-[720px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
      <BudgetFields budget={budget} onChange={(patch) => update('budget', budget.id, patch)} disabled={!canWrite} />

      {/* The paperwork behind the money: the approved plan, the quote, the
          invoice somebody is going to be asked about. `record_spend` writes the
          number and had nowhere to put the document the number came off. */}
      <Attachments on={{ kind: 'budget', id: budget.id }} className="mt-4 mb-4" />

      {canWrite && (
        <>
          <SectionHeading>{t('action.delete')}</SectionHeading>
          <Button
            variant="danger"
            onClick={async () => {
              if (!(await confirm(t('budget.deleteBudget', { name: budget.name })))) return;
              remove('budget', budget.id);
              toast(t('budget.deletedToast'));
              navigate('/budgets');
            }}
          >
            <Icon name="trash" size={14} /> {t('action.delete')}
          </Button>
        </>
      )}
      {dialog}
    </div>
  );
}

/** The fields a budget has, shared by the create sheet and the settings tab. */
function BudgetFields({ budget, onChange, disabled }: {
  budget: Partial<Budget>;
  onChange: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const projects = useQuery(() => list('project', (row) => !row.archived && !row.is_container), []);
  const covered = projects.filter((project) => coversProject(
    { project_id: budget.project_id ?? null, projects: budget.projects ?? [] },
    project.id,
  ));
  const workspaceWide = !budget.project_id && !(budget.projects ?? []).length;

  return (
    <>
      <div className={formField}>
        <label htmlFor="b-name">{t('budget.name')}</label>
        <Input
          id="b-name"
          disabled={disabled}
          placeholder={t('budget.namePlaceholder')}
          value={budget.name ?? ''}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>
      <div className={formField}>
        <label htmlFor="b-desc">{t('budget.description')}</label>
        <Textarea
          id="b-desc"
          rows={2}
          disabled={disabled}
          value={budget.description ?? ''}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="b-currency">{t('budget.currency')}</label>
          <Input
            id="b-currency"
            disabled={disabled}
            maxLength={3}
            value={budget.currency ?? 'EUR'}
            onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
          />
          <span className="text-label text-muted">{t('budget.currencyHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="b-approved">{t('budget.approved')}</label>
          <MoneyInput
            id="b-approved"
            currency={budget.currency ?? 'EUR'}
            value={budget.approved ?? 0}
            onChange={(approved) => onChange({ approved })}
          />
          <span className="text-label text-muted">{t('budget.approvedHint')}</span>
        </div>
      </div>
      <div className={formRow}>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="b-from">{t('budget.periodStart')}</label>
          <Input
            id="b-from"
            type="date"
            disabled={disabled}
            value={budget.period_start ?? ''}
            onChange={(event) => onChange({ period_start: event.target.value || null })}
          />
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="b-to">{t('budget.periodEnd')}</label>
          <Input
            id="b-to"
            type="date"
            disabled={disabled}
            value={budget.period_end ?? ''}
            onChange={(event) => onChange({ period_end: event.target.value || null })}
          />
          {/* What an empty field does, said out loud. It used to mean a period
              one month long, which nobody would have guessed and nothing said
              — the budget simply came out an order of magnitude small. */}
          <span className="text-label text-muted">{t('budget.periodEndHint')}</span>
        </div>
        <div className={cn(formField, 'flex-1 min-w-0')}>
          <label htmlFor="b-status">{t('budget.status')}</label>
          <Select
            id="b-status"
            disabled={disabled}
            value={budget.status ?? 'draft'}
            onChange={(event) => onChange({ status: event.target.value })}
          >
            {BUDGET_STATUS.map((status) => (
              <option key={status} value={status}>{t(`budget.status.${status}` as TranslationKey)}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className={formField} role="group" aria-labelledby="b-scope">
        <label id="b-scope">{t('budget.scope')}</label>
        <span className="text-label text-muted">{t('budget.scopeHint')}</span>
        <div className="scope-picker">
          <label className={checkRow}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={workspaceWide}
              onChange={() => onChange(projectScope({ project: null, projects: [] }))}
            />
            <span><span>{t('budget.scopeWorkspace')}</span></span>
          </label>
          {projects.map((project) => (
            <label className={checkRow} key={project.id}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={!workspaceWide && covered.some((row) => row.id === project.id)}
                onChange={(event) => {
                  const picked = new Set(covered.filter(() => !workspaceWide).map((row) => row.id));
                  if (event.target.checked) picked.add(project.id);
                  else picked.delete(project.id);
                  onChange(projectScope({ project: null, projects: [...picked] }));
                }}
              />
              <span><span>{project.name}</span></span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

/** The create sheet. Nothing is written until Save, so an abandoned one leaves nothing. */
export function BudgetForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Budget>>(() => ({
    name: '',
    description: '',
    currency: 'EUR',
    approved: 0,
    period_start: `${monthOf(today())}-01`,
    period_end: null,
    status: 'draft',
    project_id: null,
    projects: [],
  }));
  const dirty = useDirty(draft);

  return (
    <Sheet
      title={t('budget.new')}
      wide
      onClose={onClose}
      dirty={dirty}
      footer={(
        <Button
          variant="primary"
          disabled={!(draft.name ?? '').trim()}
          onClick={() => {
            const id = create('budget', {
              name: (draft.name ?? '').trim(),
              description: draft.description || null,
              currency: draft.currency ?? 'EUR',
              approved: draft.approved ?? 0,
              period_start: draft.period_start || null,
              period_end: draft.period_end || null,
              status: draft.status ?? 'draft',
              project_id: draft.project_id ?? null,
              projects: draft.projects ?? [],
              archived: 0,
            });
            onClose();
            onSaved(id);
          }}
        >
          {t('action.create')}
        </Button>
      )}
    >
      <BudgetFields budget={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
    </Sheet>
  );
}
