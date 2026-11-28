/** A project's settings tab: everything the create form sets, and the rest. */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_WORKING_DAYS, orderKey, STATE_GROUPS } from '@kolibri/shared';
import type { MarkdownEditor } from '../pages/Markdown';
import { Icon } from '../../kernel/design-system/ui/icon';
import { useConfirm } from '../../kernel/design-system/ui/sheet';
import { byOrder, create, remove, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../kernel/sync/store';
import { useCanWrite, useMembers } from '../../kernel/identity/session';
import { groupKey, roleKey, useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { CopyProjectSheet } from './copy-project';
import { Button, buttonVariants } from '../../kernel/design-system/ui/button';
import { cn } from '../../kernel/design-system/cn';
import { Input, Select, checkRow, formField, formRow } from '../../kernel/design-system/ui/field';
import { EmojiPicker } from '../../kernel/design-system/ui/emoji-picker';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { chipDot, chipVariants } from '../../kernel/design-system/ui/chip';
import { Attachments } from '../../kernel/files/Attachments';
import { pageBody } from '../../kernel/design-system/ui/page';

/** Monday first, because a working week starts on one. `day` is getUTCDay. */
const WEEKDAYS: { day: number; key: TranslationKey }[] = [
  { day: 1, key: 'view.weekdayMon' }, { day: 2, key: 'view.weekdayTue' }, { day: 3, key: 'view.weekdayWed' },
  { day: 4, key: 'view.weekdayThu' }, { day: 5, key: 'view.weekdayFri' }, { day: 6, key: 'view.weekdaySat' },
  { day: 0, key: 'view.weekdaySun' },
];

/**
 * What the settings tab shows of other capabilities, handed in by the route
 * that composes it.
 *
 * This tab was part of the project route, and a route may reach into any
 * capability — that is what composing a screen is. Moved out on its own it is
 * a planning file, and a planning file reaching for the markdown editor, a
 * guide link, a task field list, the time panel and an import adapter added
 * five edges the module map did not have, one of them a cycle with `work` and
 * one of them pointing outward at an adapter. So the route still does the
 * reaching and this receives what it found. The editor is a type here only:
 * `import type` is erased, and the value comes from the route.
 */
export interface SettingsSlots {
  /** The markdown editor, as `pages` writes a page: a description is written the same way. */
  Editor: typeof MarkdownEditor;
  /** The guide's way into how projects, cycles and states fit together. */
  hierarchyHint: ReactNode;
  /** The project's own task fields, from `work`. */
  fields: ReactNode;
  /** Time on this project, from `time`. */
  time: ReactNode;
  /** Importing into and exporting the project, from the transfer adapter. */
  transfer: ReactNode;
}

export function ProjectSettings({ projectId, slots }: { projectId: string; slots: SettingsSlots }) {
  const t = useT();
  const project = useRow('project', projectId);
  const navigate = useNavigate();
  const members = useMembers();
  const { confirm, dialog } = useConfirm();
  const canWrite = useCanWrite();
  const states = useQuery(
    () => list('state', (s) => s.project_id === projectId).sort(byOrder),
    [projectId],
  );
  const labels = useQuery(() => list('label', (l) => l.project_id === projectId), [projectId]);
  const [newLabel, setNewLabel] = useState('');
  const [copying, setCopying] = useState(false);

  // A project cannot be its own parent, and the server refuses a longer loop —
  // this list only keeps the obvious case out of the menu.
  const siblings = useQuery(
    () => list('project', (other) => other.id !== projectId && !other.archived && other.parent_id !== projectId),
    [projectId],
  );
  // Why the container box may be refused, said before it is clicked.
  const taskCount = useQuery(() => list('task', (task) => task.project_id === projectId).length, [projectId]);
  // Which project already holds this key, if any — the same comparison the
  // server makes, so the two agree about what a collision is.
  const keyTaken = useQuery(() => {
    const key = (byId('project', projectId)?.key ?? '').trim().toUpperCase();
    if (!key) return '';
    return list('project', (other) => other.id !== projectId && !other.archived
      && (other.key ?? '').trim().toUpperCase() === key)[0]?.name ?? '';
  }, [projectId, project?.key]);
  if (!project) return null;

  return (
    <div className={pageBody} style={{ maxWidth: 620 }}>
      {/* Icon beside name, the shape the create form uses — the screen that
          makes a project and the screen that changes one should not lay the
          same two fields out differently. A guest reads them, disabled (UX-09). */}
      <fieldset disabled={!canWrite} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className="flex items-start gap-2.5">
          <div className={formField} style={{ width: 60 }}>
            <label htmlFor="s-icon">{t('project.icon')}</label>
            <EmojiPicker
              id="s-icon" value={project.icon} fallback="🚀"
              onChange={(next) => update('project', projectId, { icon: next })}
            />
          </div>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="s-name">{t('project.name')}</label>
            <Input id="s-name" value={project.name} onChange={(event) => update('project', projectId, { name: event.target.value })} />
          </div>
        </div>
        <div className={formField}>
          <label htmlFor="s-desc">{t('project.description')}</label>
          <slots.Editor
            id="s-desc" value={project.description ?? ''} minHeight={110}
            attachTo={{ kind: 'project', id: projectId }}
            onChange={(value) => update('project', projectId, { description: value })}
          />
        </div>
      </fieldset>

      {/* The project's own papers — the statement of work, the brief, the
          signed quote. Under the description because that is the other place
          the project describes itself, and in Settings rather than on the task
          list because a contract is read twice a year and the board is read
          twice an hour. */}
      <Attachments on={{ kind: 'project', id: projectId }} className="mb-4" />

      {/*
        Both of these could only ever be chosen once, at the moment the project
        was created, and never again — so a project made private by accident
        stayed private, and one whose name changed kept a key that no longer
        matched it.

        The key is the sharper of the two, because changing it does not go back
        and rewrite the identifiers already minted from it: BUS-39 stays BUS-39
        while the next task becomes NEW-40. That is the honest behaviour — a
        pasted identifier has to keep pointing at what it pointed at — but it is
        only honest if it is said, so it is said under the field.
      */}
      <fieldset disabled={!canWrite} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className={formRow}>
          <div className={formField}>
            <label htmlFor="s-key">{t('project.key')}</label>
            <Input className="mono font-mono" id="s-key" value={project.key ?? ''} maxLength={6}
              onChange={(event) => update('project', projectId, { key: event.target.value.toUpperCase() })} />
            {/* The server bounces a taken key back, which on its own is a field
                that refuses to be typed in for no stated reason. This is the
                reason, said while it is being typed. */}
            {keyTaken
              ? <span className="text-label" style={{ color: 'var(--danger)' }}>{t('project.keyTaken', { name: keyTaken })}</span>
              : <span className="text-label text-muted">{t('project.keyChangeHint')}</span>}
          </div>
          <div className={formField}>
            <label htmlFor="s-vis">{t('project.visibility')}</label>
            <Select id="s-vis" value={project.visibility ?? 'public'}
              onChange={(event) => update('project', projectId, { visibility: event.target.value })}>
              <option value="public">{t('project.visibilityPublic')}</option>
              <option value="private">{t('project.visibilityPrivate')}</option>
            </Select>
          </div>
        </div>
        {/*
          A container is refused by the server while the project still has tasks,
          and `forced` sends the old value back — so the box un-ticks itself. The
          sentence under it is why, said before somebody clicks rather than after.
        */}
        <label className={checkRow}>
          <input
            type="checkbox"
            checked={!!project.is_container}
            onChange={(event) => update('project', projectId, { is_container: event.target.checked ? 1 : 0 })}
          />
          <span>
            {t('project.isContainer')}
            <span className="block text-label text-muted">
              {taskCount > 0 ? t('project.isContainerBusy', { count: taskCount }) : t('project.isContainerHint')}
            </span>
          </span>
        </label>

        <div className={formRow}>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="s-parent">{t('project.parent')}</label>
            <Select
              id="s-parent" value={project.parent_id ?? ''}
              onChange={(event) => update('project', projectId, { parent_id: event.target.value || null })}
            >
              <option value="">{t('project.parentNone')}</option>
              {siblings.map((other) => <option key={other.id} value={other.id}>{other.icon} {other.name}</option>)}
            </Select>
            <span className="text-label text-muted">{t('project.parentHint')}</span>
          </div>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="s-start">{t('project.startDate')}</label>
            <Input id="s-start" type="date" value={project.start_date ?? ''}
              onChange={(event) => update('project', projectId, { start_date: event.target.value || null })} />
          </div>
        </div>

        <div className={formRow}>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="s-lead">{t('project.lead')}</label>
            <Select id="s-lead" value={project.lead_id ?? ''} onChange={(event) => update('project', projectId, { lead_id: event.target.value || null })}>
              <option value="">{t('common.nobody')}</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </Select>
          </div>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="s-target">{t('project.targetDate')}</label>
            <Input id="s-target" type="date" value={project.target_date ?? ''}
              onChange={(event) => update('project', projectId, { target_date: event.target.value || null })} />
          </div>
        </div>

        {/* Which days the *scheduler* counts. Not a lock: a bar dragged onto a
            Saturday stays there, because somebody who did that meant it. */}
        <div className={formField}>
          <label id="s-days">{t('project.workingDays')}</label>
          <div className="flex items-center flex-wrap gap-1" role="group" aria-labelledby="s-days">
            {WEEKDAYS.map(({ day, key }) => {
              const days = project.working_days ?? DEFAULT_WORKING_DAYS;
              const on = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), on && 'bg-active text-fg')}
                  style={on ? { background: 'var(--bg-active)' } : undefined}
                  aria-pressed={on}
                  onClick={() => update('project', projectId, {
                    working_days: on ? days.filter((d) => d !== day) : [...days, day].sort(),
                  })}
                >
                  {t(key)}
                </button>
              );
            })}
          </div>
          <span className="text-label text-muted">{t('project.workingDaysHint')}</span>
        </div>

        <div className="flex items-center gap-2" style={{ margin: '18px 0 8px' }}>
          <SectionHeading tight>{t('project.workflowStates')}</SectionHeading>
          <span className="flex-1 min-w-0" />
          {slots.hierarchyHint}
        </div>
        {states.map((state, at) => (
          <div className="stack-card" key={state.id}>
            {/* The name and the two ways to be rid of the state: everything that
                fits on one line at any width, on one line. */}
            <div className="flex items-center gap-2">
              <input
                type="color" value={state.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
                aria-label={t('project.stateColour')}
                onChange={(event) => update('state', state.id, { color: event.target.value })}
              />
              <Input className="flex-1 min-w-0" value={state.name} aria-label={t('project.name')}
                onChange={(event) => update('state', state.id, { name: event.target.value })} />
              {/* The order here is the order of the board's columns — the same
                  fractional keys the cards use, applied one level up. */}
              <Button variant="ghost" size="icon" aria-label={t('state.moveUp')} disabled={at === 0}
                onClick={() => update('state', state.id, {
                  sort_order: orderKey(states[at - 2]?.sort_order ?? null, states[at - 1]?.sort_order ?? null),
                })}>
                <Icon name="chevronUp" size={14} />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('state.moveDown')} disabled={at === states.length - 1}
                onClick={() => update('state', state.id, {
                  sort_order: orderKey(states[at + 1]?.sort_order ?? null, states[at + 2]?.sort_order ?? null),
                })}>
                <Icon name="chevronDown" size={14} />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('project.deleteState')} onClick={async () => {
                if (states.length <= 1) return;
                if (await confirm(t('project.deleteStateConfirm', { name: state.name }))) remove('state', state.id);
              }}>
                <Icon name="trash" size={14} />
              </Button>
            </div>
            {/*
              The three settings were a 140px select and two labels sitting to the
              left of their own controls — so on a phone "Limit" put its box at one
              indent, "Who may move work here" wrapped onto two lines and put its
              box at another, and both selects cut their longest option in half.
              The same rows the form above uses fix all of it: label over control,
              one column when there is no room for two.
            */}
            <div className={cn(formRow, 'mt-2')}>
              <div className={formField}>
                <label htmlFor={`st-group-${state.id}`}>{t('view.groupState')}</label>
                <Select id={`st-group-${state.id}`} value={state.group_key}
                  onChange={(event) => update('state', state.id, { group_key: event.target.value })}>
                  {STATE_GROUPS.map((group) => (
                    <option key={group} value={group}>{t(groupKey(group))}</option>
                  ))}
                </Select>
              </div>
              <div className={formField}>
                <label htmlFor={`st-wip-${state.id}`}>{t('state.wipLimit')}</label>
                {/* Two digits never need a full column; the label above it still
                    starts on the same edge as its neighbours, which is the part
                    that has to line up. */}
                <Input id={`st-wip-${state.id}`} type="number" min={0} max={99} style={{ maxWidth: 110 }}
                  value={state.wip_limit || ''} placeholder="0"
                  onChange={(event) => update('state', state.id, { wip_limit: Number(event.target.value) || 0 })}
                />
              </div>
              <div className={formField}>
                <label htmlFor={`st-roles-${state.id}`}>{t('state.allowedRoles')}</label>
                <Select id={`st-roles-${state.id}`}
                  value={state.allowed_roles?.[0] ?? ''}
                  onChange={(event) => update('state', state.id, { allowed_roles: event.target.value ? [event.target.value] : [] })}
                >
                  <option value="">{t('state.allowedAnyone')}</option>
                  {(['member', 'admin', 'owner'] as const).map((role) => (
                    <option key={role} value={role}>{t(roleKey(role))}</option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        ))}
        <p className="text-label text-muted mt-1">{t('state.wipLimitHint')}</p>
        <p className="text-label text-muted mb-2">{t('state.allowedHint')}</p>
        <Button size="sm" className="mt-1.5"
          onClick={() => create('state', {
            project_id: projectId, name: t('project.newStateName'), group_key: 'unstarted', color: '#64748b',
            sort_order: orderKey(states[states.length - 1]?.sort_order ?? null, null),
          })}
        >
          <Icon name="plus" size={14} /> {t('project.addState')}
        </Button>

        <SectionHeading>{t('field.settingsTitle')}</SectionHeading>
        {slots.fields}

        <SectionHeading>{t('project.labels')}</SectionHeading>
        <div className="flex items-center flex-wrap gap-1.5 mb-2">
          {labels.map((label) => (
            <button
              type="button" className={chipVariants({ interactive: true })} key={label.id} title={t('project.labelRemoveHint')}
              onClick={async () => { if (await confirm(t('project.deleteLabelConfirm', { name: label.name }))) remove('label', label.id); }}
            >
              <span className={chipDot} style={{ background: label.color }} /> {label.name} ✕
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newLabel.trim()) return;
            create('label', { project_id: projectId, name: newLabel.trim(), color: '#6366f1' });
            setNewLabel('');
          }}
        >
          <Input placeholder={t('project.newLabel')} aria-label={t('project.newLabel')} value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
          <Button type="submit" title={t('action.add')}><Icon name="plus" size={14} /></Button>
        </form>
      </fieldset>

      <SectionHeading>{t('time.title')}</SectionHeading>
      {slots.time}

      {slots.transfer}

      {canWrite && (
        <>
          <SectionHeading>{t('copy.title')}</SectionHeading>
          <Button onClick={() => setCopying(true)}>
            <Icon name="copy" size={14} /> {t('copy.action')}
          </Button>
        </>
      )}
      {copying && (
        <CopyProjectSheet
          projectId={projectId}
          onClose={() => setCopying(false)}
          onCopied={(id) => navigate(`/projects/${id}`)}
        />
      )}

      {canWrite && (
        <>
          <div className="my-2 h-px bg-line" style={{ margin: '22px 0' }} />
          <div className="flex items-center gap-2">
            <Button onClick={() => update('project', projectId, { archived: project.archived ? 0 : 1 })}>
              <Icon name="archive" size={14} /> {project.archived ? t('project.unarchive') : t('project.archive')}
            </Button>
            <Button variant="danger"
              onClick={async () => {
                if (await confirm(t('project.deleteConfirm', { name: project.name }))) {
                  remove('project', projectId);
                  navigate('/');
                }
              }}
            >
              <Icon name="trash" size={14} /> {t('project.delete')}
            </Button>
          </div>
        </>
      )}
      {dialog}
    </div>
  );
}
