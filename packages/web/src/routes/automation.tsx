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
import { Button } from '../components/ui/button';
import { Input, Select, Textarea } from '../components/ui/field';
import { SectionHeading } from '../components/ui/section';
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
  due_in: 'auto.triggerDueIn',
  page_changed: 'auto.triggerPageChanged',
  comment_added: 'auto.triggerCommentAdded',
};

const ACTION_KEY: Record<string, TranslationKey> = {
  file_template: 'auto.actionFileTemplate',
  set_fields: 'auto.actionSetFields',
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
      <p className="text-muted text-[13.5px]">{t('auto.intro')}</p>
      <GuideHint to="automation" />

      {/* ------------------------------------------------------- templates */}
      <div className="flex items-center gap-2" style={{ margin: '20px 0 8px' }}>
        <SectionHeading tight>{t('tpl.title')}</SectionHeading>
        <span className="flex-1 min-w-0" />
        {canManage && (
          <Button size="sm" onClick={() => setEditingTemplate('new')}>
            <Icon name="plus" size={13} /> {t('tpl.new')}
          </Button>
        )}
      </div>
      <p className="text-muted text-[12.5px]" style={{ marginTop: 0 }}>{t('tpl.lead')}</p>

      {!templates.length && <Empty emoji="📋" title={t('tpl.empty')} hint={t('tpl.emptyHint')} guide="automation" />}
      {templates.map((template) => (
        <div className="auto-row" key={template.id}>
          <span className="auto-glyph">{template.icon ?? KIND_ICON[template.kind as TemplateKind] ?? '📋'}</span>
          <span className="flex-1 min-w-0 min-w-0">
            <span className="auto-name">{template.name}</span>
            <span className="auto-meta">
              {scopeName(template.project_id)} · {t(KIND_KEY[template.kind as TemplateKind] ?? 'tpl.kindTask')}
              {template.subtasks?.length ? ` · ${t('tpl.subtaskCount', { count: template.subtasks.length })}` : ''}
            </span>
          </span>
          <UseTemplateButton templateId={template.id} />
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(template.id)}>{t('action.edit')}</Button>
          )}
        </div>
      ))}

      {/* ----------------------------------------------------------- rules */}
      <div className="flex items-center gap-2" style={{ margin: '26px 0 8px' }}>
        <SectionHeading tight>{t('auto.title')}</SectionHeading>
        <span className="flex-1 min-w-0" />
        {canManage && (
          <Button size="sm" disabled={!templates.length} onClick={() => setEditingRule('new')}>
            <Icon name="plus" size={13} /> {t('auto.new')}
          </Button>
        )}
      </div>
      <p className="text-muted text-[12.5px]" style={{ marginTop: 0 }}>
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
          <span className="flex-1 min-w-0 min-w-0">
            <span className="auto-name">{rule.name}</span>
            <span className="auto-meta">{scopeName(rule.project_id)} · {describe(rule, t)}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShowingRuns(rule.id)}>{t('auto.runs')}</Button>
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => setEditingRule(rule.id)}>{t('action.edit')}</Button>
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
    <Button variant="ghost" size="sm"
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
    </Button>
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
            <Button variant="danger" onClick={() => onDelete(templateId, existing.name)}>
              {t('action.delete')}
            </Button>
          )}
          <span className="flex-1 min-w-0" />
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!form.name.trim()}>{t('action.save')}</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="tpl-name">{t('common.name')}</label>
        <Input id="tpl-name" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="flex items-center gap-2 gap-2.5" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ width: 96 }}>
          <label htmlFor="tpl-icon">{t('project.icon')}</label>
          <Input id="tpl-icon" maxLength={4} value={form.icon} onChange={(e) => set('icon', e.target.value)} />
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="tpl-kind">{t('tpl.kind')}</label>
          <Select id="tpl-kind" value={form.kind} onChange={(e) => set('kind', e.target.value as TemplateKind)}>
            {TEMPLATE_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIND_KEY[kind])}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="tpl-scope">{t('tpl.scope')}</label>
          <Select
            id="tpl-scope" value={form.project_id ?? ''}
            onChange={(e) => set('project_id', e.target.value || null)}
          >
            <option value="">{t('tpl.scopeWorkspace')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="tpl-title">{t('tpl.taskTitle')}</label>
        <Input id="tpl-title" value={form.title} onChange={(e) => set('title', e.target.value)} />
        <span className="text-[12px] text-muted">{t('tpl.placeholderHelp')}</span>
      </div>

      <div className="field">
        <label>{t('tpl.body')}</label>
        <MarkdownEditor value={form.description} onChange={(value) => set('description', value)} minHeight={130} />
      </div>

      <div className="flex items-center gap-2 gap-2.5" style={{ alignItems: 'flex-start' }}>
        <div className="field flex-1 min-w-0">
          <label htmlFor="tpl-priority">{t('task.priority')}</label>
          <Select id="tpl-priority" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{t(priorityKey(p))}</option>)}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="tpl-due">{t('tpl.dueInDays')}</label>
          <Input
            id="tpl-due" type="number" min={0}
            value={form.due_in_days ?? ''}
            onChange={(e) => set('due_in_days', e.target.value === '' ? null : Number(e.target.value))}
          />
          <span className="text-[12px] text-muted">{t('tpl.dueInDaysHint')}</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="tpl-subtasks">{t('tpl.subtasks')}</label>
        <Textarea
          id="tpl-subtasks" style={{ minHeight: 90 }}
          value={form.subtasks} onChange={(e) => set('subtasks', e.target.value)}
        />
        <span className="text-[12px] text-muted">{t('tpl.subtasksHint')}</span>
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
    trigger_days: Number(existing?.trigger_days ?? 1),
    action_kind: (existing?.action_kind ?? 'file_template') as 'file_template' | 'set_fields',
    action_priority: String((existing?.action_patch as any)?.priority ?? ''),
    action_label: String((existing?.action_patch as any)?.add_labels?.[0] ?? ''),
    action_assignee: String((existing?.action_patch as any)?.assignees?.[0] ?? ''),
    action_due_in: String((existing?.action_patch as any)?.due_in_days ?? ''),
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
  // Labels a rule may add: this project's, plus the workspace-wide ones.
  const actionLabels = useQuery(
    () => list('label', (label) => !label.project_id || label.project_id === form.project_id),
    [form.project_id],
  );
  // Only what was filled in. An empty control is "leave it alone", not a value.
  const actionPatch: Record<string, unknown> = {};
  if (form.action_priority) actionPatch.priority = form.action_priority;
  if (form.action_label) actionPatch.add_labels = [form.action_label];
  if (form.action_assignee) actionPatch.assignees = [form.action_assignee];
  if (form.action_due_in !== '' && Number.isFinite(Number(form.action_due_in))) {
    actionPatch.due_in_days = Number(form.action_due_in);
  }

  const needsState = form.trigger_kind === 'state_entered';
  const stateMissing = needsState && !form.trigger_state_id;
  const filesTemplate = form.action_kind === 'file_template';

  const save = () => {
    const payload = {
      workspace_id: workspaceId,
      project_id: form.project_id,
      name: form.name.trim() || t('auto.new'),
      enabled: form.enabled,
      trigger_kind: form.trigger_kind,
      trigger_state_id: needsState ? form.trigger_state_id : null,
      trigger_group: form.trigger_kind === 'state_group_entered' ? form.trigger_group : null,
      trigger_days: form.trigger_days,
      action_kind: form.action_kind,
      action_patch: form.action_kind === 'set_fields' ? actionPatch : {},
      template_id: filesTemplate ? form.template_id : '',
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
            <Button variant="danger" onClick={() => onDelete(ruleId, existing.name)}>{t('action.delete')}</Button>
          )}
          <span className="flex-1 min-w-0" />
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={save}
            disabled={!form.name.trim() || !form.template_id || stateMissing || !form.recipients.length}
          >
            {t('action.save')}
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rule-name">{t('common.name')}</label>
        <Input id="rule-name" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="rule-scope">{t('tpl.scope')}</label>
        <Select
          id="rule-scope" value={form.project_id ?? ''}
          onChange={(e) => {
            set('project_id', e.target.value || null);
            set('trigger_state_id', null);   // state ids belong to one project
          }}
        >
          <option value="">{t('tpl.scopeWorkspace')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>

      <h4 className="auto-h">{t('auto.trigger')}</h4>
      <div className="flex items-center gap-2 flex-wrap gap-2.5" style={{ alignItems: 'flex-start' }}>
        <div className="field flex-1 min-w-0">
          <label htmlFor="rule-trigger">{t('auto.event')}</label>
          <Select
            id="rule-trigger" value={form.trigger_kind}
            onChange={(e) => set('trigger_kind', e.target.value as AutomationTriggerKind)}
          >
            {Object.keys(TRIGGER_KEY).map((kind) => (
              <option key={kind} value={kind}>{t(TRIGGER_KEY[kind])}</option>
            ))}
          </Select>
        </div>
        {needsState && (
          <div className="field flex-1 min-w-0">
            <label htmlFor="rule-state">{t('auto.state')}</label>
            <Select
              id="rule-state" value={form.trigger_state_id ?? ''}
              onChange={(e) => set('trigger_state_id', e.target.value || null)}
            >
              <option value="">—</option>
              {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
            </Select>
            {!form.project_id && <span className="text-[12px] text-muted">{t('auto.stateNeedsProject')}</span>}
          </div>
        )}
        {form.trigger_kind === 'due_in' && (
          <div className="field flex-1 min-w-0">
            <label htmlFor="rule-days">{t('auto.daysBefore')}</label>
            <Input
              id="rule-days" type="number" min={0} max={90} style={{ width: 90 }}
              value={form.trigger_days}
              onChange={(e) => set('trigger_days', Math.max(0, Number(e.target.value) || 0))}
            />
            <span className="text-[12px] text-muted">{t('auto.daysBeforeHint')}</span>
          </div>
        )}
        {form.trigger_kind === 'state_group_entered' && (
          <div className="field flex-1 min-w-0">
            <label htmlFor="rule-group">{t('auto.group')}</label>
            <Select
              id="rule-group" value={form.trigger_group}
              onChange={(e) => set('trigger_group', e.target.value as StateGroup)}
            >
              {STATE_GROUPS.map((group) => <option key={group} value={group}>{t(groupKey(group))}</option>)}
            </Select>
          </div>
        )}
      </div>

      <h4 className="auto-h">{t('auto.then')}</h4>
      <div className="field">
        <label htmlFor="rule-action">{t('auto.action')}</label>
        <Select id="rule-action" value={form.action_kind}
          onChange={(e) => set('action_kind', e.target.value as 'file_template' | 'set_fields')}>
          {Object.keys(ACTION_KEY).map((kind) => <option key={kind} value={kind}>{t(ACTION_KEY[kind])}</option>)}
        </Select>
      </div>
      {filesTemplate ? (
        <div className="field">
          <label htmlFor="rule-template">{t('tpl.one')}</label>
          <Select id="rule-template" value={form.template_id} onChange={(e) => set('template_id', e.target.value)}>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </Select>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap gap-2.5">
            <div className="field">
              <label htmlFor="rule-priority">{t('task.priority')}</label>
              <Select id="rule-priority" style={{ width: 150 }} value={form.action_priority}
                onChange={(e) => set('action_priority', e.target.value)}>
                <option value="">{t('auto.actionLeave')}</option>
                {PRIORITIES.map((priority) => <option key={priority} value={priority}>{t(priorityKey(priority))}</option>)}
              </Select>
            </div>
            <div className="field">
              <label htmlFor="rule-label">{t('auto.actionAddLabel')}</label>
              <Select id="rule-label" style={{ width: 170 }} value={form.action_label}
                onChange={(e) => set('action_label', e.target.value)}>
                <option value="">{t('auto.actionLeave')}</option>
                {actionLabels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
              </Select>
            </div>
            <div className="field">
              <label htmlFor="rule-assignee">{t('auto.actionAssign')}</label>
              <Select id="rule-assignee" style={{ width: 170 }} value={form.action_assignee}
                onChange={(e) => set('action_assignee', e.target.value)}>
                <option value="">{t('auto.actionLeave')}</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </Select>
            </div>
            <div className="field">
              <label htmlFor="rule-due">{t('auto.actionDueIn')}</label>
              <Input
                id="rule-due" type="number" style={{ width: 96 }} placeholder="—"
                value={form.action_due_in} onChange={(e) => set('action_due_in', e.target.value)}
              />
            </div>
          </div>
          {/* Still never the state: a rule that moves a task can trigger a rule
              that moves it back, and two rules editing one row is a merge
              problem rather than a feature flag. */}
          <span className="text-[12px] text-muted">{t('auto.actionSetFieldsHint')}</span>
        </>
      )}

      <h4 className="auto-h">{t('auto.recipients')}</h4>
      <p className="text-[12px] text-muted" style={{ marginTop: -4 }}>{t('auto.recipientsHint')}</p>
      {form.recipients.map((recipient, index) => (
        <div className="flex items-center gap-2 auto-recipient mb-1.5" key={index}>
          <Select
            className="flex-1 min-w-0"
            aria-label={t('auto.recipients')}
            value={recipient.kind}
            onChange={(e) => setRecipient(index, { kind: e.target.value as RecipientKind, ref: null })}
          >
            {RECIPIENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(RECIPIENT_KEY[kind])}</option>)}
          </Select>

          {recipient.kind === 'user' && (
            <Select
              className="flex-1 min-w-0" aria-label={t('auto.recipientUser')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'user', ref: e.target.value })}
            >
              <option value="">—</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </Select>
          )}
          {recipient.kind === 'team' && (
            <Select
              className="flex-1 min-w-0" aria-label={t('auto.recipientTeam')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'team', ref: e.target.value })}
            >
              <option value="">—</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </Select>
          )}
          {recipient.kind === 'role' && (
            <Select
              className="flex-1 min-w-0" aria-label={t('auto.recipientRole')} value={recipient.ref ?? ''}
              onChange={(e) => setRecipient(index, { kind: 'role', ref: e.target.value as WorkspaceRole })}
            >
              <option value="">—</option>
              {(['owner', 'admin', 'member'] as const).map((r) => <option key={r} value={r}>{t(roleKey(r))}</option>)}
            </Select>
          )}

          <Button variant="ghost" size="iconSm"
            aria-label={t('action.remove')}
            onClick={() => set('recipients', form.recipients.filter((_, i) => i !== index))}
          >
            <Icon name="close" size={13} />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => set('recipients', [...form.recipients, { kind: 'user', ref: null }])}>
        <Icon name="plus" size={13} /> {t('auto.addRecipient')}
      </Button>

      <div className="flex items-center gap-2 flex-wrap gap-2.5 mt-3.5" style={{ alignItems: 'flex-start' }}>
        <div className="field flex-1 min-w-0">
          <label htmlFor="rule-fanout">{t('auto.fanOut')}</label>
          <Select id="rule-fanout" value={form.fan_out} onChange={(e) => set('fan_out', e.target.value as FanOut)}>
            {FAN_OUT.map((value) => (
              <option key={value} value={value}>{t(value === 'single' ? 'auto.fanOutSingle' : 'auto.fanOutEach')}</option>
            ))}
          </Select>
        </div>
        <div className="field flex-1 min-w-0">
          <label htmlFor="rule-link">{t('auto.link')}</label>
          <Select
            id="rule-link" value={form.link_kind}
            onChange={(e) => set('link_kind', e.target.value as RelationKind | '')}
          >
            <option value="">{t('auto.linkNone')}</option>
            {RELATION_KINDS.map((kind) => <option key={kind} value={kind}>{t(relationKey(kind))}</option>)}
          </Select>
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
    <label className="check-row">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
      <span>
        <span>{t(label)}</span>
        {hint && <span className="text-[12px] text-muted">{t(hint)}</span>}
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
      <p className="text-muted text-[12.5px]" style={{ marginTop: 0 }}>{t('auto.runsLead')}</p>
      {runs && !runs.length && <p className="text-muted">{t('auto.noRuns')}</p>}
      {runs?.map((entry) => {
        const actor = members.find((member) => member.id === entry.actor_id);
        return (
          <div className="auto-run" key={entry.id}>
            <span className={`auto-run-dot${entry.skipped ? ' skipped' : ''}`} />
            <span className="flex-1 min-w-0 min-w-0">
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
