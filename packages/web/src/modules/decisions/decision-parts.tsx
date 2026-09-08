/**
 * The pieces of a decision that appear somewhere other than its own screen.
 *
 * Here rather than in `routes/decisions.tsx` because a route file is the top of
 * its module — only the shell may import one — and the card, the form and the
 * panel are all wanted from elsewhere: the task detail shows what is being
 * decided about a piece of work, which is most of the point of attaching a
 * decision to one.
 *
 * `page-parts.tsx` and `task-parts.tsx` are the same arrangement for the same
 * reason.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DECISION_MODES, DECISION_VISIBILITY, closedBecause, isOpen, orderKey,
  type Decision, type DecisionMode, type DecisionVisibility,
} from '@kolibri/shared';
import { Icon, Sheet } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { longDate } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create } from '../../kernel/sync/mutations';
import { list, useQuery, useRow } from '../../kernel/sync/store';
import { useCanWrite, useFeature } from '../../kernel/identity/session';
import { Ballot } from './ballot';

export const modeKey = (mode: DecisionMode): TranslationKey => `decision.mode.${mode}` as TranslationKey;
export const visibilityKey = (visibility: DecisionVisibility): TranslationKey =>
  `decision.visibility.${visibility}` as TranslationKey;

/**
 * Open first, then by when they close.
 *
 * A decision with no deadline sorts after the ones that have one, rather than
 * before: "answer by Friday" is more urgent than "answer eventually", and a
 * null sorting first would bury every dated question under every undated one.
 */
export function byUrgency(a: Decision, b: Decision): number {
  const openness = Number(isOpen(b)) - Number(isOpen(a));
  if (openness) return openness;
  if (a.closes_at !== b.closes_at) {
    if (a.closes_at === null) return 1;
    if (b.closes_at === null) return -1;
    return a.closes_at - b.closes_at;
  }
  return b.created_at - a.created_at;
}

/** One decision as it appears in a list: the question, the state, and the ballot itself. */
export function DecisionCard({ decision }: { decision: Decision }) {
  const t = useT();
  const task = useRow('task', decision.task_id);
  return (
    <section className="ballot-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Link to={`/decisions/${decision.id}`} className="ballot-question">{decision.question}</Link>
          <span className="row-sub">
            {t(modeKey(decision.mode))}
            {` · ${t(visibilityKey(decision.visibility))}`}
            {task && ` · ${task.identifier}`}
          </span>
        </div>
        <DecisionState decision={decision} />
      </div>
      <div className="mt-3"><Ballot decision={decision} compact /></div>
    </section>
  );
}

export function DecisionState({ decision }: { decision: Decision }) {
  const t = useT();
  const why = closedBecause(decision);
  if (why === 'open') {
    return (
      <Chip tone="on">
        {decision.closes_at === null ? t('decision.open') : t('decision.until', { when: longDate(decision.closes_at) })}
      </Chip>
    );
  }
  return <Chip>{why === 'expired' ? t('decision.expired') : t('decision.closed')}</Chip>;
}

/* ------------------------------------------------------------------ forms */

/**
 * The three settings that decide what a vote means.
 *
 * `locked` closes the first two once somebody has voted, and that is a product
 * rule rather than a technical one: turning a secret ballot open would publish
 * votes that were cast on a promise, and switching from several choices to one
 * would silently invalidate ballots people had already filled in. Neither is
 * something to undo afterwards, so neither is offered.
 */
export function DecisionFields({
  decision, onChange, locked = false,
}: {
  decision: Partial<Decision>;
  onChange: (patch: Partial<Decision>) => void;
  locked?: boolean;
}) {
  const t = useT();
  /** `datetime-local` wants minutes in the reader's own zone, not an epoch. */
  const asLocal = (at: number | null | undefined): string => {
    if (!at) return '';
    const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  };

  return (
    <div className="flex flex-col gap-3">
      <Label label={t('decision.question')}>
        <Input
          value={decision.question ?? ''}
          placeholder={t('decision.questionPlaceholder')}
          onChange={(event) => onChange({ question: event.target.value })}
        />
      </Label>
      <Label label={t('decision.description')}>
        <Textarea
          rows={3}
          value={decision.description ?? ''}
          onChange={(event) => onChange({ description: event.target.value || null })}
        />
      </Label>
      <Label label={t('decision.modeLabel')} hint={locked ? t('decision.lockedHint') : t('decision.modeHint')}>
        <Select
          value={decision.mode ?? 'single'}
          disabled={locked}
          onChange={(event) => onChange({ mode: event.target.value as DecisionMode })}
        >
          {DECISION_MODES.map((mode) => <option key={mode} value={mode}>{t(modeKey(mode))}</option>)}
        </Select>
      </Label>
      <Label label={t('decision.visibilityLabel')} hint={locked ? t('decision.lockedHint') : t('decision.visibilityHint')}>
        <Select
          value={decision.visibility ?? 'open'}
          disabled={locked}
          onChange={(event) => onChange({ visibility: event.target.value as DecisionVisibility })}
        >
          {DECISION_VISIBILITY.map((one) => <option key={one} value={one}>{t(visibilityKey(one))}</option>)}
        </Select>
      </Label>
      <Label label={t('decision.closesAt')} hint={t('decision.closesAtHint')}>
        <Input
          type="datetime-local"
          value={asLocal(decision.closes_at)}
          onChange={(event) => onChange({ closes_at: event.target.value ? new Date(event.target.value).getTime() : null })}
        />
      </Label>
    </div>
  );
}

/**
 * A new decision, with its first options.
 *
 * The options are typed here rather than afterwards on purpose: a question with
 * nothing to pick between is not a decision, and creating one that way makes
 * the empty ballot somebody else's problem.
 */
export function DecisionForm({
  taskId = null, projectId = null, onClose, onSaved,
}: {
  taskId?: string | null;
  projectId?: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Decision>>({
    question: '',
    description: null,
    mode: 'single',
    visibility: 'open',
    closes_at: null,
  });
  const [labels, setLabels] = useState(['', '']);
  const usable = labels.map((label) => label.trim()).filter(Boolean);

  return (
    <Sheet
      title={t('decision.new')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!draft.question?.trim() || usable.length < 2}
          onClick={() => {
            const id = create('decision', {
              question: draft.question?.trim() || t('decision.untitled'),
              description: draft.description ?? null,
              mode: draft.mode ?? 'single',
              visibility: draft.visibility ?? 'open',
              status: 'open',
              closes_at: draft.closes_at ?? null,
              task_id: taskId,
              project_id: projectId,
              sort_order: orderKey(),
            });
            let previous: string | null = null;
            for (const label of usable) {
              previous = orderKey(previous, null);
              create('decisionOption', { decision_id: id, label, description: null, sort_order: previous });
            }
            onSaved(id);
          }}
        >
          {t('action.create')}
        </Button>
      )}
    >
      <div className="flex flex-col gap-3">
        <DecisionFields decision={draft} onChange={(patch) => setDraft({ ...draft, ...patch })} />
        <Label label={t('decision.options')} hint={t('decision.optionsHint')}>
          <div className="flex flex-col gap-1.5">
            {labels.map((label, index) => (
              <Input
                key={index}
                value={label}
                placeholder={t('decision.optionPlaceholder', { n: index + 1 })}
                onChange={(event) => setLabels(labels.map((one, at) => (at === index ? event.target.value : one)))}
              />
            ))}
          </div>
        </Label>
        <div>
          <Button size="sm" onClick={() => setLabels([...labels, ''])}>{t('decision.addOption')}</Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------- on a task's page */

/**
 * What is being decided about this piece of work.
 *
 * Nothing is shown when nothing is being asked, rather than an empty frame —
 * the same rule `MilestoneKpis` follows, and for the same reason: a heading
 * over nothing teaches somebody that a feature is broken.
 */
export function TaskDecisions({ taskId, projectId }: { taskId: string; projectId: string }) {
  const t = useT();
  const enabled = useFeature('decisions');
  const canWrite = useCanWrite();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const rows = useQuery(() => list('decision', (row) => row.task_id === taskId), [taskId]);
  const sorted = useMemo(() => [...rows].sort(byUrgency), [rows]);

  if (!enabled) return null;
  if (!sorted.length && !canWrite) return null;

  return (
    <div className="mt-4 flex flex-col gap-2">
      <SectionHeading tight>{t('decision.onTask')}</SectionHeading>
      {sorted.map((decision) => <DecisionCard key={decision.id} decision={decision} />)}
      {canWrite && (
        <div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} /> {t('decision.new')}
          </Button>
        </div>
      )}
      {creating && (
        <DecisionForm
          taskId={taskId}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onSaved={(id) => navigate(`/decisions/${id}`)}
        />
      )}
    </div>
  );
}
