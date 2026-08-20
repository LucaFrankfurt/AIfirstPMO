/**
 * Custom fields — the ones a project invents for itself.
 *
 * Two screens: the editor in project settings, and the answers on a task. A
 * field can be limited to particular work item types, which is what makes a Bug
 * ask for steps to reproduce while a Feature does not.
 */
import { useState } from 'react';
import {
  FIELD_KINDS, emptyValue, fieldValueId, fieldsForTask, orderKey, readFieldValue, writeFieldValue,
  type Field, type FieldKind, type Task,
} from '@kolibri/shared';
import { useT, type TranslationKey } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { create, remove, update } from '../lib/mutations';
import { useCanWrite, useMemberMap } from '../session';
import { Icon, useConfirm } from './ui';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { chipVariants } from './ui/chip';
import { Input, Select, Textarea } from '../components/ui/field';
import { DateField } from './task-parts';

export const kindKey = (kind: string): TranslationKey => `field.kind.${kind}` as TranslationKey;

/** The fields of one project, in order, ignoring the archived ones. */
export const useFields = (projectId: string | undefined) =>
  useQuery(
    () => list('field', (f) => f.project_id === projectId && !f.archived)
      .sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1)),
    [projectId],
  );

/* ------------------------------------------------------------- the answers */

/** One task's answers, keyed by field. */
export const useValues = (taskId: string) =>
  useQuery(() => {
    const map = new Map<string, string | null>();
    for (const row of list('fieldValue', (v) => v.task_id === taskId)) map.set(row.field_id, row.value);
    return map;
  }, [taskId]);

/**
 * Write one answer.
 *
 * The row id is derived from the task and the field, so two devices answering
 * the same field while offline write the same row and merge, rather than
 * leaving two rows and a question.
 */
export function setFieldValue(task: Task, field: Field, value: unknown): void {
  const id = fieldValueId(task.id, field.id);
  const text = writeFieldValue(field.kind, value);
  const existing = byId('fieldValue', id);
  if (existing) update('fieldValue', id, { value: text });
  else if (text !== null) {
    create('fieldValue', {
      project_id: task.project_id, task_id: task.id, field_id: field.id, value: text,
    }, id);
  }
}

function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const members = useMemberMap();
  const id = `cf-${field.id}`;

  switch (field.kind) {
    case 'long_text':
      return (
        <Textarea id={id} rows={3} value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)} />
      );
    case 'number':
      return (
        <Input id={id} type="number" style={{ width: 120 }} value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />
      );
    case 'date':
      return <DateField label={field.name} value={(value as string) || null} onChange={(next) => onChange(next ?? '')} />;
    case 'checkbox':
      return (
        <input id={id} type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} />
      );
    case 'url':
      return (
        <div className="flex items-center gap-1.5">
          <Input className="flex-1 min-w-0" id={id} type="url" placeholder="https://" value={String(value ?? '')}
            onChange={(event) => onChange(event.target.value)} />
          {!!value && (
            <a className={buttonVariants({ variant: 'ghost', size: 'iconSm' })} href={String(value)} target="_blank" rel="noreferrer noopener"
              aria-label={t('field.open')} title={t('field.open')}>
              <Icon name="link" size={13} />
            </a>
          )}
        </div>
      );
    case 'select':
      return (
        <Select id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('field.noValue')}</option>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </Select>
      );
    case 'multi_select': {
      const chosen = (value as string[]) ?? [];
      return (
        <div className="flex items-center flex-wrap gap-[5px]">
          {field.options.map((option) => (
            <button
              key={option} type="button"
              className={chipVariants({ tone: chosen.includes(option) ? 'on' : 'default', interactive: true })}
              aria-pressed={chosen.includes(option)}
              onClick={() => onChange(chosen.includes(option) ? chosen.filter((o) => o !== option) : [...chosen, option])}
            >
              {option}
            </button>
          ))}
          {!field.options.length && <span className="text-muted text-[12.5px]">{t('field.noOptions')}</span>}
        </div>
      );
    }
    case 'person':
      return (
        <Select id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('common.nobody')}</option>
          {[...members.values()].map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </Select>
      );
    default:
      return (
        <Input id={id} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
      );
  }
}

/** The custom fields on a task — only the ones its type asks for. */
export function TaskFields({ task }: { task: Task }) {
  const t = useT();
  const canWrite = useCanWrite();
  const all = useFields(task.project_id);
  const values = useValues(task.id);
  const fields = fieldsForTask(all, task.type_id);
  if (!fields.length) return null;

  return (
    <section className="mb-[18px]">
      <strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>{t('field.sectionTitle')}</strong>
      <div className="field-grid">
        {fields.map((field) => {
          const value = readFieldValue(field.kind, values.get(field.id));
          const empty = field.kind === 'multi_select'
            ? !(value as string[]).length
            : value === '' || value === null || value === false;
          return (
            <div className="field" key={field.id} style={{ marginBottom: 0 }}>
              <label htmlFor={`cf-${field.id}`}>
                {field.name}
                {/* A prompt, not a gate: the task saves either way. */}
                {!!field.required && empty && <span className="text-muted ms-[5px]">{t('field.wanted')}</span>}
              </label>
              {canWrite
                ? <FieldInput field={field} value={value} onChange={(next) => setFieldValue(task, field, next)} />
                : <span>{field.kind === 'checkbox' ? (value ? '✓' : '—') : String(value || '—')}</span>}
              {field.help && <span className="text-[12px] text-muted">{field.help}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- the editor */

export function ProjectFields({ projectId }: { projectId: string }) {
  const t = useT();
  const fields = useFields(projectId);
  const types = useQuery(
    () => list('taskType', (type) => type.project_id === projectId).sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1)),
    [projectId],
  );
  const [open, setOpen] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  return (
    <>
      <p className="text-[12px] text-muted mb-2">{t('field.settingsHint')}</p>

      {fields.map((field) => (
        <div key={field.id} className="stack-card">
          <div className="flex items-center gap-2">
            <Input
              className="flex-1 min-w-0" value={field.name} aria-label={t('field.name')}
              onChange={(event) => update('field', field.id, { name: event.target.value })}
            />
            <Select style={{ width: 150 }} value={field.kind} aria-label={t('field.kind')}
              onChange={(event) => update('field', field.id, { kind: event.target.value as FieldKind })}
            >
              {FIELD_KINDS.map((kind) => <option key={kind} value={kind}>{t(kindKey(kind))}</option>)}
            </Select>
            <Button variant="ghost" size="iconSm" aria-expanded={open === field.id} aria-label={t('field.options')}
              onClick={() => setOpen(open === field.id ? null : field.id)}
            >
              <Icon name={open === field.id ? 'chevronDown' : 'chevronRight'} size={14} />
            </Button>
            <Button variant="ghost" size="iconSm" aria-label={t('field.remove')} title={t('field.remove')}
              onClick={async () => {
                if (await confirm(t('field.removeConfirm', { name: field.name }))) remove('field', field.id);
              }}
            >
              <Icon name="trash" size={13} />
            </Button>
          </div>

          {open === field.id && (
            <div className="mt-2.5">
              {(field.kind === 'select' || field.kind === 'multi_select') && (
                <div className="field">
                  <label htmlFor={`opt-${field.id}`}>{t('field.choices')}</label>
                  <Input
                    id={`opt-${field.id}`} value={field.options.join(', ')}
                    placeholder={t('field.choicesPlaceholder')}
                    onChange={(event) => update('field', field.id, {
                      options: event.target.value.split(',').map((o) => o.trim()).filter(Boolean),
                    })}
                  />
                </div>
              )}

              <div className="field">
                <label htmlFor={`help-${field.id}`}>{t('field.help')}</label>
                <Input
                  id={`help-${field.id}`} value={field.help ?? ''}
                  onChange={(event) => update('field', field.id, { help: event.target.value || null })}
                />
              </div>

              <div className="field">
                <label>{t('field.appliesTo')}</label>
                <div className="flex items-center flex-wrap gap-[5px]">
                  <button
                    type="button" className={chipVariants({ tone: field.type_ids.length ? 'default' : 'on', interactive: true })}
                    aria-pressed={!field.type_ids.length}
                    onClick={() => update('field', field.id, { type_ids: [] })}
                  >
                    {t('field.appliesToAll')}
                  </button>
                  {types.map((type) => (
                    <button
                      key={type.id} type="button"
                      className={chipVariants({ tone: field.type_ids.includes(type.id) ? 'on' : 'default', interactive: true })}
                      aria-pressed={field.type_ids.includes(type.id)}
                      onClick={() => update('field', field.id, {
                        type_ids: field.type_ids.includes(type.id)
                          ? field.type_ids.filter((id) => id !== type.id)
                          : [...field.type_ids, type.id],
                      })}
                    >
                      {type.icon} {type.name}
                    </button>
                  ))}
                </div>
                <span className="text-[12px] text-muted">{t('field.appliesToHint')}</span>
              </div>

              <label className="flex items-center gap-2 text-[13.5px]" style={{ gap: 7 }}>
                <input
                  type="checkbox" checked={!!field.required}
                  onChange={(event) => update('field', field.id, { required: event.target.checked ? 1 : 0 })}
                />
                {t('field.required')}
              </label>
              <span className="text-[12px] text-muted mb-2" style={{ display: 'block' }}>{t('field.requiredHint')}</span>

              <label className="flex items-center gap-2 text-[13.5px]" style={{ gap: 7 }}>
                <input
                  type="checkbox" checked={!!field.show_in_table}
                  onChange={(event) => update('field', field.id, { show_in_table: event.target.checked ? 1 : 0 })}
                />
                {t('field.showInTable')}
              </label>
            </div>
          )}
        </div>
      ))}

      <Button size="sm" className="mt-2"
        onClick={() => {
          const id = create('field', {
            project_id: projectId,
            name: t('field.newName'),
            kind: 'text' as FieldKind,
            options: [],
            type_ids: [],
            help: null,
            required: 0,
            show_in_table: 0,
            archived: 0,
            sort_order: orderKey(fields[fields.length - 1]?.sort_order ?? null, null),
          });
          setOpen(id);
        }}
      >
        <Icon name="plus" size={14} /> {t('field.add')}
      </Button>
      {dialog}
    </>
  );
}

/** What a field's answer looks like in one line — used by the table view. */
export function fieldCell(kind: FieldKind, raw: string | null | undefined, people: Map<string, string>): string {
  const value = readFieldValue(kind, raw);
  if (kind === 'checkbox') return value ? '✓' : '';
  if (kind === 'multi_select') return (value as string[]).join(', ');
  if (kind === 'person') return people.get(String(value)) ?? '';
  if (value === null || value === undefined) return '';
  return String(value);
}

export { emptyValue };
