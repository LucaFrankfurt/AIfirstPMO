/**
 * Templates and rules, in one screen.
 *
 * They are managed together because they are only useful together: a rule with
 * no template has nothing to file, and a template nobody points a rule at is
 * just a button. Both can be scoped to one project or to the whole workspace,
 * which is where "standardised" actually happens — one rule at workspace level
 * behaves the same in every project.
 *
 * The run log is not decoration. A rule that decides to do nothing — because
 * the only candidate was the person who moved the task — looks identical to a
 * broken one from the outside, so every decision it makes is readable here.
 */
import { useEffect, useState } from 'react';
import {
  FAN_OUT, PRIORITIES, RECIPIENT_KINDS, RELATION_KINDS, STATE_GROUPS, TEMPLATE_KINDS,
  type AutomationTriggerKind, type FanOut, type Priority, type Recipient, type RecipientKind,
  type RelationKind, type StateGroup, type TemplateKind, type WorkspaceRole,
} from '@kolibri/shared';
import { MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, GuideHint, Icon, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { groupKey, priorityKey, relationKey, roleKey, useT, type TranslationKey, type Translate } from '../lib/i18n';
import { byId, list, useQuery } from '../lib/store';
import { create, remove, update } from '../lib/mutations';
import { pull } from '../lib/sync';
import { useMembers, useSession } from '../session';

const KIND_KEY: Record<TemplateKind, TranslationKey> = {
  feedback: 'tpl.kindFeedback', review: 'tpl.kindReview', task: 'tpl.kindTask',
  bug: 'tpl.kindBug', checklist: 'tpl.kindChecklist',
};
const KIND_ICON: Record<TemplateKind, string> = {
  feedback: '🔍', review: '👀', task: '📋', bug: '🐞', checklist: '☑️',
};
const TRIGGER_KEY: Record<string, TranslationKey> = {
  state_entered: 'auto.triggerStateEntered',
  state_group_entered: 'auto.triggerGroupEntered',
  task_created: 'auto.triggerCreated',
};
const RECIPIENT_KEY: Record<RecipientKind, TranslationKey> = {
  user: 'auto.recipientUser', assignees: 'auto.recipientAssignees', creator: 'auto.recipientCreator',
  actor: 'auto.recipientActor', lead: 'auto.recipientLead', team: 'auto.recipientTeam', role: 'auto.recipientRole',
};
const SKIP_KEY: Record<string, TranslationKey> = {
  'no-recipients': 'auto.skipNoRecipients', 'already-run': 'auto.skipAlreadyRun',
  'generated-task': 'auto.skipGenerated', 'no-template': 'auto.skipNoTemplate',
};

/** One line describing what a rule does, for the list. */
function describe(rule: any, t: Translate): string {
  const parts: string[] = [];
  if (rule.trigger_kind === 'state_entered') {
    parts.push(byId('state', String(rule.trigger_state_id ?? ''))?.name ?? t('auto.state'));
  } else if (rule.trigger_kind === 'state_group_entered') {
    parts.push(t(groupKey(String(rule.trigger_group ?? 'backlog'))));
  } else {
    parts.push(t('auto.triggerCreated'));
  }
  parts.push(byId('template', rule.template_id)?.name ?? t('auto.skipNoTemplate'));
  parts.push((rule.recipients ?? []).map((r: Recipient) => t(RECIPIENT_KEY[r.kind])).join(', ') || '—');
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ screen */

export function AutomationSettings() {
  const t = useT();
  const { workspaceId, role } = useSession();
  const { confirm, dialog } = useConfirm();
  const [editingTemplate, setEditingTemplate] = useState<string | 'new' | null>(null);
  const [editingRule, setEditingRule] = useState<string | 'new' | null>(null);
  const [showingRuns, setShowingRuns] = useState<string | null>(null);

  const canManage = role === 'owner' || role === 'admin';
  const templates = useQuery(
    () => list('template', (row) => row.workspace_id === workspaceId && !row.archived),
    [workspaceId],
  );
  const rules = useQuery(() => list('automation', (row) => row.workspace_id === workspaceId), [workspaceId]);

  const scopeName = (projectId: string | null) =>
    (projectId ? byId('project', projectId)?.name ?? '—' : t('tpl.scopeWorkspace'));


  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>{t('auto.intro')}</p>
      <GuideHint to="automation" />

      {/* ------------------------------------------------------- templates */}
      <div className="row" style={{ margin: '20px 0 8px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{t('tpl.title')}</h3>
        <span className="grow" />
        {canManage && (
          <button className="btn sm" onClick={() => setEditingTemplate('new')}>
            <Icon name="plus" size={13} /> {t('tpl.new')}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{t('tpl.lead')}</p>

      {!templates.length && <Empty emoji="📋" title={t('tpl.empty')} hint={t('tpl.emptyHint')} guide="automation" />}
      {templates.map((template) => (
        <div className="auto-row" key={template.id}>
          <span className="auto-glyph">{template.icon ?? KIND_ICON[template.kind as TemplateKind] ?? '📋'}</span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="auto-name">{template.name}</span>
            <span className="auto-meta">
              {scopeName(template.project_id)} · {t(KIND_KEY[template.kind as TemplateKind] ?? 'tpl.kindTask')}
              {template.subtasks?.length ? ` · ${t('tpl.subtaskCount', { count: template.subtasks.length })}` : ''}
            </span>
          </span>
          <UseTemplateButton templateId={template.id} />
          {canManage && (
            <button className="btn ghost sm" onClick={() => setEditingTemplate(template.id)}>{t('action.edit')}</button>
          )}
        </div>
      ))}

      {/* ----------------------------------------------------------- rules */}
      <div className="row" style={{ margin: '26px 0 8px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{t('auto.title')}</h3>
        <span className="grow" />
        {canManage && (
          <button className="btn sm" disabled={!templates.length} onClick={() => setEditingRule('new')}>
            <Icon name="plus" size={13} /> {t('auto.new')}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        {templates.length ? t('auto.lead') : t('auto.needTemplate')}
      </p>

      {!rules.length && <Empty emoji="⚙️" title={t('auto.empty')} hint={t('auto.emptyHint')} guide="automation" />}
      {rules.map((rule) => (
        <div className={`auto-row${rule.enabled ? '' : ' off'}`} key={rule.id}>
          <button
            className={`auto-switch${rule.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={!!rule.enabled}
            aria-label={t('auto.enabled')}
            disabled={!canManage}
            onClick={() => update('automation', rule.id, { enabled: rule.enabled ? 0 : 1 })}
          >
            <i />
          </button>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="auto-name">{rule.name}</span>
            <span className="auto-meta">{scopeName(rule.project_id)} · {describe(rule, t)}</span>
          </span>
          <button className="btn ghost sm" onClick={() => setShowingRuns(rule.id)}>{t('auto.runs')}</button>
          {canManage && (
            <button className="btn ghost sm" onClick={() => setEditingRule(rule.id)}>{t('action.edit')}</button>
          )}
        </div>
      ))}

      {editingTemplate && (
        <TemplateEditor
          templateId={editingTemplate === 'new' ? undefined : editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onDelete={async (id, name) => {
            if (!(await confirm(t('tpl.deleteConfirm', { name })))) return;
            remove('template', id);
            setEditingTemplate(null);
          }}
        />
      )}
      {editingRule && (
        <RuleEditor
          ruleId={editingRule === 'new' ? undefined : editingRule}
          onClose={() => setEditingRule(null)}
          onDelete={async (id, name) => {
            if (!(await confirm(t('auto.deleteConfirm', { name })))) return;
            remove('automation', id);
            setEditingRule(null);
          }}
        />
      )}
      {showingRuns && <RunLog automationId={showingRuns} onClose={() => setShowingRuns(null)} />}
      {dialog}
    </>
  );
}

/** Files a real task from a template, the same way a rule would. */
function UseTemplateButton({ templateId }: { templateId: string }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn ghost sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const task = await api.applyTemplate(templateId, {});
          await pull();
          toast(t('tpl.used', { identifier: task.identifier }));
        } catch (error) {
          toast(error instanceof Error ? error.message : t('common.somethingWentWrong'));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('tpl.use')}
    </button>
  );
}

/* -------------------------------------------------------- template editor */

function TemplateEditor({
  templateId, onClose, onDelete,
}: { templateId?: string; onClose: () => void; onDelete: (id: string, name: string) => void }) {
  const t = useT();
  const { workspaceId } = useSession();
  const existing = useQuery(() => (templateId ? byId('template', templateId) : undefined), [templateId]);
  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived),
    [workspaceId],
  );

  const [form, setForm] = useState(() => ({
    name: existing?.name ?? '',
    kind: (existing?.kind ?? 'feedback') as TemplateKind,
    icon: existing?.icon ?? '',
    project_id: (existing?.project_id ?? projects[0]?.id ?? null) as string | null,
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    priority: (existing?.priority ?? 'none') as Priority,
    due_in_days: existing?.due_in_days ?? null,
    subtasks: (existing?.subtasks ?? []).join('\n'),
  }));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = () => {
    const payload = {
      workspace_id: workspaceId,
      project_id: form.project_id,
      name: form.name.trim() || t('tpl.new'),
      kind: form.kind,
      icon: form.icon.trim() || KIND_ICON[form.kind],
      title: form.title.trim() || form.name.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      due_in_days: form.due_in_days,
      subtasks: form.subtasks.split('\n').map((line) => line.trim()).filter(Boolean),
    };
    if (templateId) update('template', templateId, payload);
    else create('template', payload);
    onClose();
  };

  return (
    <Sheet
      wide
      title={templateId ? t('tpl.edit') : t('tpl.new')}
      onClose={onClose}
      footer={
        <>
          {templateId && existing && (
            <button className="btn danger" onClick={() => onDelete(templateId, existing.name)}>
              {t('action.delete')}
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button className="btn primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="tpl-name">{t('common.name')}</label>
        <input id="tpl-name" className="input" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div className="field" style={{ width: 96 }}>
          <label htmlFor="tpl-icon">{t('project.icon')}</label>
          <input id="tpl-icon" className="input" maxLength={4} value={form.icon} onChange={(e) => set('icon', e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="tpl-kind">{t('tpl.kind')}</label>
          <select id="tpl-kind" className="select" value={form.kind} onChange={(e) => set('kind', e.target.value as TemplateKind)}>
            {TEMPLATE_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIND_KEY[kind])}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="tpl-scope">{t('tpl.scope')}</label>
          <select
            id="tpl-scope" className="select" value={form.project_id ?? ''}
            onChange={(e) => set('project_id', e.target.value || null)}
          >
            <option value="">{t('tpl.scopeWorkspace')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="tpl-title">{t('tpl.taskTitle')}</label>
        <input id="tpl-title" className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
        <span className="hint">{t('tpl.placeholderHelp')}</span>
      </div>

      <div className="field">
        <label>{t('tpl.body')}</label>
        <MarkdownEditor value={form.description} onChange={(value) => set('description', value)} minHeight={130} />
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="tpl-priority">{t('task.priority')}</label>
          <select id="tpl-priority" className="select" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{t(priorityKey(p))}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="tpl-due">{t('tpl.dueInDays')}</label>
          <input
            id="tpl-due" className="input" type="number" min={0}
            value={form.due_in_days ?? ''}
            onChange={(e) => set('due_in_days', e.target.value === '' ? null : Number(e.target.value))}
          />
          <span className="hint">{t('tpl.dueInDaysHint')}</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="tpl-subtasks">{t('tpl.subtasks')}</label>
        <textarea
          id="tpl-subtasks" className="textarea" style={{ minHeight: 90 }}
          value={form.subtasks} onChange={(e) => set('subtasks', e.target.value)}
        />
        <span className="hint">{t('tpl.subtasksHint')}</span>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------ rule editor */

function RuleEditor({
  ruleId, onClose, onDelete,
}: { ruleId?: string; onClose: () => void; onDelete: (id: string, name: string) => void }) {
  const t = useT();
  const { workspaceId } = useSession();
  const members = useMembers();
  const existing = useQuery(() => (ruleId ? byId('automation', ruleId) : undefined), [ruleId]);
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);
  const templates = useQuery(() => list('template', (row) => row.workspace_id === workspaceId && !row.archived), [workspaceId]);
  const teams = useQuery(() => list('team', (row) => row.workspace_id === workspaceId && !row.archived), [workspaceId]);

  const [form, setForm] = useState(() => ({
    name: existing?.name ?? '',
    project_id: (existing?.project_id ?? projects[0]?.id ?? null) as string | null,
    trigger_kind: (existing?.trigger_kind ?? 'state_entered') as AutomationTriggerKind,
    trigger_state_id: (existing?.trigger_state_id ?? null) as string | null,
    trigger_group: (existing?.trigger_group ?? 'started') as StateGroup,
    template_id: existing?.template_id ?? (templates[0]?.id ?? ''),
    recipients: (existing?.recipients ?? [{ kind: 'lead' }]) as Recipient[],
    fan_out: (existing?.fan_out ?? 'single') as FanOut,
    exclude_actor: existing?.exclude_actor ?? 1,
    link_kind: (existing?.link_kind ?? 'relates_to') as RelationKind | '',
    once: existing?.once ?? 0,
    apply_to_generated: existing?.apply_to_generated ?? 0,
    enabled: existing?.enabled ?? 1,
  }));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  // A state trigger only makes sense inside one project: state ids are per project.
  const states = useQuery(
    () => (form.project_id ? list('state', (s) => s.project_id === form.project_id) : []),
    [form.project_id],
  );
  const needsState = form.trigger_kind === 'state_entered';
  const stateMissing = needsState && !form.trigger_state_id;

  const save = () => {
    const payload = {
      workspace_id: workspaceId,
      project_id: form.project_id,
      name: form.name.trim() || t('auto.new'),
      enabled: form.enabled,
      trigger_kind: form.trigger_kind,
      trigger_state_id: needsState ? form.trigger_state_id : null,
      trigger_group: form.trigger_kind === 'state_group_entered' ? form.trigger_group : null,
      template_id: form.template_id,
      recipients: form.recipients,
      fan_out: form.fan_out,
      exclude_actor: form.exclude_actor,
      link_kind: form.link_kind,
      once: form.once,
      apply_to_generated: form.apply_to_generated,
    };
    if (ruleId) update('automation', ruleId, payload);
    else create('automation', payload);
    onClose();
  };

  const setRecipient = (index: number, next: Recipient) =>
    set('recipients', form.recipients.map((r, i) => (i === index ? next : r)));

  return (
    <Sheet
      wide
      title={ruleId ? t('auto.edit') : t('auto.new')}
      onClose={onClose}
      footer={
        <>
          {ruleId && existing && (
            <button className="btn danger" onClick={() => onDelete(ruleId, existing.name)}>{t('action.delete')}</button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button
            className="btn primary" onClick={save}
            disabled={!form.name.trim() || !form.template_id || stateMissing || !form.recipients.length}
          >
            {t('action.save')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rule-name">{t('common.name')}</label>
        <input id="rule-name" className="input" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="rule-scope">{t('tpl.scope')}</label>
        <select
          id="rule-scope" className="select" value={form.project_id ?? ''}
          onChange={(e) => {
            set('project_id', e.target.value || null);
            set('trigger_state_id', null);   // state ids belong to one project
          }}
        >
          <option value="">{t('tpl.scopeWorkspace')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <h4 className="auto-h">{t('auto.trigger')}</h4>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="rule-trigger">{t('auto.event')}</label>
          <select
            id="rule-trigger" className="select" value={form.trigger_kind}
            onChange={(e) => set('trigger_kind', e.target.value as AutomationTriggerKind)}
          >
            {Object.keys(TRIGGER_KEY).map((kind) => (
              <option key={kind} value={kind}>{t(TRIGGER_KEY[kind])}</option>
            ))}
          </select>
        </div>
        {needsState && (
          <div className="field grow">
            <label htmlFor="rule-state">{t('auto.state')}</label>
            <select
              id="rule-state" className="select" value={form.trigger_state_id ?? ''}
              onChange={(e) => set('trigger_state_id', e.target.value || null)}
            >
              <option value="">—</option>
              {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
            </select>
            {!form.project_id && <span className="hint">{t('auto.stateNeedsProject')}</span>}
          </div>
        )}
        {form.trigger_kind === 'state_group_entered' && (
          <div className="field grow">
            <label htmlFor="rule-group">{t('auto.group')}</label>
            <select
              id="rule-group" className="select" value={form.trigger_group}
              onChange={(e) => set('trigger_group', e.target.value as StateGroup)}
            >
              {STATE_GROUPS.map((group) => <option key={group} value={group}>{t(groupKey(group))}</option>)}
            </select>
          </div>
        )}
      </div>

      <h4 className="auto-h">{t('auto.then')}</h4>
      <div className="field">
        <label htmlFor="rule-template">{t('tpl.one')}</label>
        <select id="rule-template" className="select" value={form.template_id} onChange={(e) => set('template_id', e.target.value)}>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </div>

      <h4 className="auto-h">{t('auto.recipients')}</h4>
      <p className="hint" style={{ marginTop: -4 }}>{t('auto.recipientsHint')}</p>
      {form.recipients.map((recipient, index) => (
        <div className="row auto-recipient" key={index} style={{ marginBottom: 6 }}>
          <select
            className="select grow"
            aria-label={t('auto.recipients')}
            value={recipient.kind}
            onChange={(e) => setRecipient(index, { kind: e.target.value as RecipientKind, ref: null })}
          >
            {RECIPIENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(RECIPIENT_KEY[kind])}</option>)}
          </select>

          {recipient.kind === 'user' && (
            <select
              className="select grow" aria-label={t('auto.recipientUser')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'user', ref: e.target.value })}
            >
              <option value="">—</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          )}
          {recipient.kind === 'team' && (
            <select
              className="select grow" aria-label={t('auto.recipientTeam')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'team', ref: e.target.value })}
            >
              <option value="">—</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          )}
          {recipient.kind === 'role' && (
            <select
              className="select grow" aria-label={t('auto.recipientRole')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'role', ref: e.target.value as WorkspaceRole })}
            >
              <option value="">—</option>
              {(['owner', 'admin', 'member'] as const).map((r) => <option key={r} value={r}>{t(roleKey(r))}</option>)}
            </select>
          )}

          <button
            className="btn ghost sm icon"
            aria-label={t('action.remove')}
            onClick={() => set('recipients', form.recipients.filter((_, i) => i !== index))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button className="btn sm" onClick={() => set('recipients', [...form.recipients, { kind: 'user', ref: null }])}>
        <Icon name="plus" size={13} /> {t('auto.addRecipient')}
      </button>

      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start', marginTop: 14 }}>
        <div className="field grow">
          <label htmlFor="rule-fanout">{t('auto.fanOut')}</label>
          <select id="rule-fanout" className="select" value={form.fan_out} onChange={(e) => set('fan_out', e.target.value as FanOut)}>
            {FAN_OUT.map((value) => (
              <option key={value} value={value}>{t(value === 'single' ? 'auto.fanOutSingle' : 'auto.fanOutEach')}</option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="rule-link">{t('auto.link')}</label>
          <select
            id="rule-link" className="select" value={form.link_kind}
            onChange={(e) => set('link_kind', e.target.value as RelationKind | '')}
          >
            <option value="">{t('auto.linkNone')}</option>
            {RELATION_KINDS.map((kind) => <option key={kind} value={kind}>{t(relationKey(kind))}</option>)}
          </select>
        </div>
      </div>

      <Toggle label="auto.excludeActor" value={form.exclude_actor} onChange={(v) => set('exclude_actor', v)} />
      <Toggle label="auto.once" hint="auto.onceHint" value={form.once} onChange={(v) => set('once', v)} />
      <Toggle
        label="auto.applyToGenerated" hint="auto.applyToGeneratedHint"
        value={form.apply_to_generated} onChange={(v) => set('apply_to_generated', v)}
      />
    </Sheet>
  );
}

function Toggle({
  label, hint, value, onChange,
}: { label: TranslationKey; hint?: TranslationKey; value: number; onChange: (value: number) => void }) {
  const t = useT();
  return (
    <label className="auto-toggle">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
      <span>
        <span>{t(label)}</span>
        {hint && <span className="hint">{t(hint)}</span>}
      </span>
    </label>
  );
}

/* --------------------------------------------------------------- run log */

function RunLog({ automationId, onClose }: { automationId: string; onClose: () => void }) {
  const t = useT();
  const [runs, setRuns] = useState<any[] | null>(null);
  const members = useMembers();

  useEffect(() => {
    api.automationRuns(automationId).then(setRuns).catch(() => setRuns([]));
  }, [automationId]);

  return (
    <Sheet title={t('auto.runs')} onClose={onClose}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{t('auto.runsLead')}</p>
      {runs && !runs.length && <p className="muted">{t('auto.noRuns')}</p>}
      {runs?.map((entry) => {
        const actor = members.find((member) => member.id === entry.actor_id);
        return (
          <div className="auto-run" key={entry.id}>
            <span className={`auto-run-dot${entry.skipped ? ' skipped' : ''}`} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="auto-name">
                {entry.task_identifier} {entry.task_title}
              </span>
              <span className="auto-meta">
                {entry.skipped
                  ? t(SKIP_KEY[entry.skipped] ?? 'auto.skipNoTemplate')
                  : t('auto.filed', { identifier: entry.created_identifier ?? '—' })}
              </span>
            </span>
            <span className="auto-when">
              {actor && <Avatar user={actor} size={18} />}
              {relativeTime(entry.created_at)}
            </span>
          </div>
        );
      })}
    </Sheet>
  );
}
