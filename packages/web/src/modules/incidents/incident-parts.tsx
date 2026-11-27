/**
 * The pieces of an incident that appear somewhere other than its own screen.
 *
 * Here rather than in `routes/incidents.tsx` because a route file is the top of
 * its module — only the shell may import one — and the start page wants the
 * list of what is still burning. `decision-parts.tsx` and `meeting-parts.tsx`
 * are the same arrangement for the same reason.
 *
 * The start page's panel is the one worth reading. It is not there when
 * nothing is active, rather than saying "no incidents" every morning: a panel
 * that is always there and almost always empty is a panel people stop looking
 * at, and the morning it is not empty is the one it exists for.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  INCIDENT_CATEGORIES, INCIDENT_IMPACTS, INCIDENT_PRIORITIES, INCIDENT_URGENCIES, byCriticality, byIncidentUrgency, formatDuration, incidentClocks, isActive,
  isCritical, parseMoney, priorityFor,
  type Application, type ApplicationCriticality, type Incident, type IncidentCategory, type IncidentImpact,
  type IncidentPriority, type IncidentResolution, type IncidentStatus, type IncidentUrgency, type User,
} from '@kolibri/shared';
import { Avatar, Icon, Sheet } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip, chipDot } from '../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../kernel/design-system/ui/field';
import { asMoney } from '../../kernel/design-system/ui/money';
import { PickChips } from '../../kernel/design-system/pick-chips';
import { useMinute } from '../../kernel/design-system/minute';
import { currentLocale, useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useFeature, useMe, useSession } from '../../kernel/identity/session';
import { now } from '../../kernel/sync/clock';

export const statusKey = (status: IncidentStatus): TranslationKey => `incident.status.${status}` as TranslationKey;
export const priorityKey = (priority: IncidentPriority): TranslationKey => `incident.priority.${priority}` as TranslationKey;
export const impactKey = (impact: IncidentImpact): TranslationKey => `incident.level.${impact}` as TranslationKey;
export const urgencyKey = (urgency: IncidentUrgency): TranslationKey => `incident.level.${urgency}` as TranslationKey;
export const categoryKey = (category: IncidentCategory): TranslationKey => `incident.category.${category}` as TranslationKey;
export const resolutionKey = (code: IncidentResolution): TranslationKey => `incident.resolution.${code}` as TranslationKey;
export const criticalityKey = (value: ApplicationCriticality): TranslationKey => `incident.criticality.${value}` as TranslationKey;

/**
 * A priority's colour, for the dot beside its name.
 *
 * Only ever a dot: the words carry the meaning and the colour is a second
 * channel for somebody scanning a list, so the contrast check has nothing to
 * say about it and a reader who cannot tell red from orange loses nothing.
 */
export const PRIORITY_TONE: Record<IncidentPriority, string> = {
  p1: 'var(--danger)',
  p2: '#f97316',
  p3: '#eab308',
  p4: 'var(--fg-muted)',
};

export function PriorityChip({ priority }: { priority: IncidentPriority }) {
  const t = useT();
  return (
    <Chip>
      <span className={chipDot} style={{ background: PRIORITY_TONE[priority] }} aria-hidden />
      {t(priorityKey(priority))}
    </Chip>
  );
}

export function StatusChip({ status }: { status: IncidentStatus }) {
  const t = useT();
  return <Chip tone={isActive({ status }) ? 'on' : 'default'}>{t(statusKey(status))}</Chip>;
}

/** `datetime-local` wants minutes in the reader's own zone, not an epoch. */
export const asLocalInput = (at: number | null | undefined): string => {
  if (!at) return '';
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const fromLocalInput = (value: string): number | null => (value ? new Date(value).getTime() : null);

/**
 * The people an incident can name: the workspace's members, and not its
 * guests — the line the server draws, so the picker never offers a name the
 * write path would take back off.
 */
export function useIncidentPeople(): User[] {
  const { workspaceId } = useSession();
  return useQuery(() => list('member', (member) => member.workspace_id === workspaceId && member.role !== 'guest')
    .map((member) => byId('user', member.user_id))
    .filter((user): user is User => !!user)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')), [workspaceId]);
}

/** The applications a dropdown offers: the live ones, most critical first. Archived ones stay readable where chosen. */
export function useApplications(): Application[] {
  return useQuery(() => list('application', (app) => !app.deleted_at).sort(byCriticality), []);
}

/** A row on any list of incidents: what, how bad, where it stands, who has it, how long. */
export function IncidentRow({ incident, compact }: { incident: Incident; compact?: boolean }) {
  useMinute(); // the running duration moves — `design-system/minute.ts`
  const t = useT();
  const manager = incident.manager_id ? byId('user', incident.manager_id) : null;
  const apps = useApplications();
  const named = new Map(apps.map((app) => [app.id, app.name]));
  // Read defensively: a row synced before the column existed has none.
  const hit = (incident.applications ?? []).map((id) => named.get(id)).filter(Boolean);
  const clocks = incidentClocks(incident, now());
  return (
    <section className={`incident-card flex flex-wrap items-center justify-between gap-3 p-3${isCritical(incident) && isActive(incident) ? ' incident-critical' : ''}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <Link to={`/incidents/${incident.id}`} className="incident-link">
          <span className="incident-number">{incident.identifier || t('incident.unnumbered')}</span>
          <span className="truncate">{incident.summary}</span>
        </Link>
        <span className="row-sub">
          {hit.length > 0 && `${hit.join(', ')} · `}
          {clocks.running
            ? t('incident.runningFor', { duration: formatDuration(clocks.impactMs) })
            : clocks.impactMs !== null ? t('incident.lasted', { duration: formatDuration(clocks.impactMs) }) : t('incident.noStart')}
          {!compact && incident.major ? ` · ${t('incident.major')}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <PriorityChip priority={incident.priority} />
        <StatusChip status={incident.status} />
        {manager && <span title={t('incident.managerIs', { name: manager.name ?? '' })}><Avatar user={manager} /></span>}
      </div>
    </section>
  );
}

/**
 * What is still burning, on the start page.
 *
 * Nothing at all when the switch is off or nothing is active — see the
 * docblock at the top. Five at most: a sixth active incident is a bad day, and
 * the heading says how many there are and links to the rest.
 */
export function ActiveIncidents() {
  const t = useT();
  const enabled = useFeature('incidents');
  const active = useQuery(() => list('incident', (row) => !row.deleted_at && isActive(row)).sort(byIncidentUrgency), []);
  if (!enabled || !active.length) return null;
  const critical = active.filter(isCritical).length;
  return (
    <section className="mb-[18px]" aria-labelledby="active-incidents">
      <div className="mb-1.5 flex items-center gap-2">
        <Icon name="alert" size={15} />
        <h2 id="active-incidents" className="text-sm">{t('incident.activeTitle')}</h2>
        <span className="text-muted text-[12px]">
          {t('incident.activeCount', { count: active.length })}
          {critical > 0 && ` · ${t('incident.criticalCount', { count: critical })}`}
        </span>
        <Link to="/incidents" className="ml-auto inline-flex min-h-6 items-center text-[12px]">{t('incident.showAll')}</Link>
      </div>
      <div className="flex flex-col gap-2">
        {active.slice(0, 5).map((incident) => <IncidentRow key={incident.id} incident={incident} compact />)}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ forms */

/**
 * An amount that may be nobody's figure yet.
 *
 * Not `MoneyInput`, which reads an empty box as zero — right for a budget line,
 * where an empty amount is a line nobody priced yet and zero is what it adds,
 * and wrong here, where "nobody costed it" and "it cost nothing" are the two
 * answers a review must not confuse.
 */
export function ImpactInput({ value, currency, onChange, id }: {
  value: number | null;
  currency: string;
  onChange: (minor: number | null) => void;
  id?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null
    ? ''
    : new Intl.NumberFormat(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(value / 100));
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={shown}
      title={currency}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onChange(draft.trim() ? parseMoney(draft) : null);
        setDraft(null);
      }}
    />
  );
}

/**
 * The fields of an incident, the same on a new one and an existing one.
 *
 * `onImpactOrUrgency` is how the new-incident form moves the priority with the
 * matrix until somebody picks one themselves; an existing incident passes
 * nothing, and changing its impact leaves its priority alone — see
 * `priorityFor` for why the suggestion is only ever a suggestion.
 */
export function IncidentFields({ incident, onChange, disabled }: {
  incident: Partial<Incident>;
  onChange: (patch: Partial<Incident>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const people = useIncidentPeople();
  const apps = useApplications();
  const chosenApps = incident.applications ?? [];
  const offered = apps.filter((app) => !app.archived || chosenApps.includes(app.id));
  return (
    <div className="flex flex-col gap-3">
      <Label label={t('incident.summary')}>
        <Input
          value={incident.summary ?? ''}
          placeholder={t('incident.summaryPlaceholder')}
          disabled={disabled}
          onChange={(event) => onChange({ summary: event.target.value })}
        />
      </Label>
      <Label label={t('incident.description')}>
        <Textarea
          rows={3}
          value={incident.description ?? ''}
          placeholder={t('incident.descriptionPlaceholder')}
          disabled={disabled}
          onChange={(event) => onChange({ description: event.target.value || null })}
        />
      </Label>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label label={t('incident.impact')} hint={t('incident.impactHint')}>
          <Select
            value={incident.impact ?? 'medium'}
            disabled={disabled}
            onChange={(event) => onChange({ impact: event.target.value as IncidentImpact })}
          >
            {INCIDENT_IMPACTS.map((one) => <option key={one} value={one}>{t(impactKey(one))}</option>)}
          </Select>
        </Label>
        <Label label={t('incident.urgency')} hint={t('incident.urgencyHint')}>
          <Select
            value={incident.urgency ?? 'medium'}
            disabled={disabled}
            onChange={(event) => onChange({ urgency: event.target.value as IncidentUrgency })}
          >
            {INCIDENT_URGENCIES.map((one) => <option key={one} value={one}>{t(urgencyKey(one))}</option>)}
          </Select>
        </Label>
        <Label label={t('incident.priority')}>
          <Select
            value={incident.priority ?? 'p3'}
            disabled={disabled}
            onChange={(event) => onChange({ priority: event.target.value as IncidentPriority })}
          >
            {INCIDENT_PRIORITIES.map((one) => <option key={one} value={one}>{t(priorityKey(one))}</option>)}
          </Select>
        </Label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label label={t('incident.category')}>
          <Select
            value={incident.category ?? 'other'}
            disabled={disabled}
            onChange={(event) => onChange({ category: event.target.value as IncidentCategory })}
          >
            {INCIDENT_CATEGORIES.map((one) => <option key={one} value={one}>{t(categoryKey(one))}</option>)}
          </Select>
        </Label>
        <Label label={t('incident.manager')} hint={t('incident.managerHint')}>
          <Select
            value={incident.manager_id ?? ''}
            disabled={disabled}
            onChange={(event) => onChange({ manager_id: event.target.value || null })}
          >
            <option value="">{t('incident.nobody')}</option>
            {people.map((user) => <option key={user.id} value={user.id}>{user.name ?? user.email}</option>)}
          </Select>
        </Label>
      </div>
      <label className="check-row">
        {/* In a 24px box, as the task checkbox is: the label carries the
            click, but a target is measured on its own. */}
        <span className="select-box">
          <input
            type="checkbox"
            checked={!!incident.major}
            disabled={disabled}
            onChange={(event) => onChange({ major: event.target.checked ? 1 : 0 })}
          />
        </span>
        <span>
          <span>{t('incident.majorLabel')}</span>
          <span className="text-[12px] text-muted">{t('incident.majorHint')}</span>
        </span>
      </label>
      <Label label={t('incident.applications')} hint={apps.length ? undefined : t('incident.applicationsNone')}>
        <PickChips
          chosen={chosenApps}
          options={offered.map((app) => ({ id: app.id, label: app.name }))}
          onChange={(next) => onChange({ applications: next })}
          addLabel={t('incident.addApplication')}
          removeLabel={(name) => t('incident.removeItem', { name })}
          disabled={disabled}
        />
      </Label>
      <Label label={t('incident.responders')}>
        <PickChips
          chosen={incident.responders ?? []}
          options={people.map((user) => ({ id: user.id, label: user.name ?? user.email ?? user.id }))}
          onChange={(next) => onChange({ responders: next })}
          addLabel={t('incident.addResponder')}
          removeLabel={(name) => t('incident.removeItem', { name })}
          disabled={disabled}
        />
      </Label>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label label={t('incident.startedAt')} hint={t('incident.startedAtHint')}>
          <Input
            type="datetime-local"
            value={asLocalInput(incident.started_at)}
            disabled={disabled}
            onChange={(event) => onChange({ started_at: fromLocalInput(event.target.value) })}
          />
        </Label>
        <Label label={t('incident.detectedAt')}>
          <Input
            type="datetime-local"
            value={asLocalInput(incident.detected_at)}
            disabled={disabled}
            onChange={(event) => onChange({ detected_at: fromLocalInput(event.target.value) })}
          />
        </Label>
        <Label label={t('incident.endedAt')} hint={t('incident.endedAtHint')}>
          <Input
            type="datetime-local"
            value={asLocalInput(incident.ended_at)}
            disabled={disabled}
            onChange={(event) => onChange({ ended_at: fromLocalInput(event.target.value) })}
          />
        </Label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label label={t('incident.financialImpact')} hint={t('incident.financialImpactHint')}>
          <ImpactInput
            value={incident.financial_impact ?? null}
            currency={incident.currency ?? 'EUR'}
            onChange={(minor) => onChange({ financial_impact: minor })}
          />
        </Label>
        <Label label={t('incident.currency')}>
          <Input
            value={incident.currency ?? 'EUR'}
            maxLength={3}
            disabled={disabled}
            onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
          />
        </Label>
        <Label label={t('incident.affectedUsers')}>
          <Input
            type="number"
            min={0}
            value={incident.affected_users ?? ''}
            disabled={disabled}
            onChange={(event) => onChange({ affected_users: event.target.value === '' ? null : Math.max(0, Math.round(Number(event.target.value))) })}
          />
        </Label>
      </div>
      <Label label={t('incident.reportedBy')}>
        <Input
          value={incident.reported_by ?? ''}
          placeholder={t('incident.reportedByPlaceholder')}
          disabled={disabled}
          onChange={(event) => onChange({ reported_by: event.target.value || null })}
        />
      </Label>
    </div>
  );
}

/**
 * A new incident.
 *
 * Started and detected both default to now: somebody opening the form has
 * noticed it by now at the latest, and the start is usually "a few minutes
 * ago" — a field already filled with the right hour is corrected, an empty one
 * is skipped and leaves every duration on the record unanswerable. The
 * priority follows impact × urgency until somebody picks one.
 */
export function IncidentForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const me = useMe();
  const [chosePriority, setChosePriority] = useState(false);
  const [draft, setDraft] = useState<Partial<Incident>>(() => {
    // The server's clock, not this device's: a laptop five minutes fast would
    // otherwise open every incident five minutes in the future.
    const at = now();
    return {
      summary: '',
      description: null,
      status: 'new',
      impact: 'medium',
      urgency: 'medium',
      priority: priorityFor('medium', 'medium'),
      category: 'other',
      major: 0,
      applications: [],
      manager_id: me,
      responders: [],
      reported_by: null,
      started_at: at,
      detected_at: at,
      ended_at: null,
      financial_impact: null,
      currency: 'EUR',
      affected_users: null,
    };
  });

  const change = (patch: Partial<Incident>) => {
    if (patch.priority) setChosePriority(true);
    const next = { ...draft, ...patch };
    if (!chosePriority && !patch.priority && (patch.impact || patch.urgency)) {
      next.priority = priorityFor(next.impact ?? 'medium', next.urgency ?? 'medium');
    }
    setDraft(next);
  };

  return (
    <Sheet
      title={t('incident.new')}
      onClose={onClose}
      dirty={!!draft.summary?.trim()}
      wide
      footer={(
        <Button
          variant="primary"
          disabled={!draft.summary?.trim()}
          onClick={() => {
            const id = create('incident', { ...draft, summary: draft.summary?.trim() || t('incident.untitled') });
            onSaved(id);
          }}
        >
          {t('incident.open')}
        </Button>
      )}
    >
      <IncidentFields incident={draft} onChange={change} />
    </Sheet>
  );
}

/** A financial impact as a person reads it, or the honest "not costed". */
export function useImpactWords(): (incident: Pick<Incident, 'financial_impact' | 'currency'>) => string {
  const t = useT();
  return (incident) => (incident.financial_impact === null || incident.financial_impact === undefined
    ? t('incident.notCosted')
    : asMoney(incident.financial_impact, incident.currency));
}

