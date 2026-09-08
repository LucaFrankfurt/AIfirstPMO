/**
 * The decision screens: what is being asked, what the team said, and what was
 * settled.
 *
 * The index leads with what is still open, soonest deadline first, because a
 * vote is only useful before it closes — a list sorted by creation date would
 * put the thing everybody has to answer today underneath a settled argument
 * from March. Closed ones stay on the same screen rather than in an archive:
 * the record of what was decided is the half of this feature that is still
 * worth something a year later.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { isOpen, orderKey, tallyOf } from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { Empty, Icon, useConfirm } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Input } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { useT } from '../../../kernel/i18n/i18n';
import { create, remove, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCanWrite, useFeature, useMe } from '../../../kernel/identity/session';
import { Ballot, useBallot } from '../ballot';
import {
  DecisionCard, DecisionFields, DecisionForm, DecisionState, byUrgency, modeKey, visibilityKey,
} from '../decision-parts';

function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('decision.offTitle')} hint={t('decision.offHint')} />;
}

/* ------------------------------------------------------------------ index */

export function DecisionIndex() {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('decisions');
  const [creating, setCreating] = useState(false);
  const decisions = useQuery(() => list('decision'), []);
  const rows = useMemo(() => [...decisions].sort(byUrgency), [decisions]);

  if (!enabled) return <><Header title={t('decision.title')} /><SwitchedOff /></>;

  return (
    <>
      <Header title={t('decision.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('decision.new')}</span>
          </Button>
        )}
      </Header>

      {!rows.length ? (
        <Empty emoji="🗳️" title={t('decision.emptyTitle')} hint={t('decision.emptyHint')} />
      ) : (
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
          {rows.map((decision) => <DecisionCard key={decision.id} decision={decision} />)}
        </div>
      )}

      {creating && <DecisionForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/decisions/${id}`)} />}
    </>
  );
}

/* ----------------------------------------------------------------- detail */

export function DecisionDetail() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('decisions');
  const me = useMe();
  const decision = useRow('decision', id);
  const { options, votes } = useBallot(id);
  const { confirm, dialog } = useConfirm();
  const [adding, setAdding] = useState('');

  const result = useMemo(
    () => (decision ? tallyOf(decision, options, votes, me) : null),
    [decision, options, votes, me],
  );

  if (!enabled) return <><Header title={t('decision.title')} /><SwitchedOff /></>;
  if (!decision) {
    return (
      <>
        <Header title={t('decision.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/decisions', label: t('decision.title'), icon: <Icon name="check" size={13} /> }]} />
        </div>
        <Empty
          emoji="🗳️" title={t('decision.gone')}
          action={<Button onClick={() => navigate('/decisions')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const open = isOpen(decision);

  return (
    <>
      <Header title={decision.question}>
        {canWrite && (
          <Button
            size="sm"
            onClick={() => update('decision', decision.id, { status: decision.status === 'open' ? 'closed' : 'open' })}
          >
            {decision.status === 'open' ? t('decision.close') : t('decision.reopen')}
          </Button>
        )}
      </Header>

      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <Trail parts={[{ to: '/decisions', label: t('decision.title'), icon: <Icon name="check" size={13} /> }]} />

        <div className="flex flex-wrap items-center gap-2">
          <DecisionState decision={decision} />
          <Chip>{t(modeKey(decision.mode))}</Chip>
          <Chip>{t(visibilityKey(decision.visibility))}</Chip>
          {decision.task_id && <Link to={`/t/${decision.task_id}`} className="text-[12px]">{byId('task', decision.task_id)?.identifier}</Link>}
        </div>

        {decision.description && <p className="text-[13px]">{decision.description}</p>}

        <Ballot decision={decision} />

        {/*
          * The options are editable while the vote is open and not after.
          * Changing the ballot under a result somebody has already read is the
          * one edit that makes the record worthless, and the write path refuses
          * the votes either way — so the screen does not offer it.
          */}
        {canWrite && open && (
          <>
            <SectionHeading>{t('decision.options')}</SectionHeading>
            <ul className="flex list-none flex-col gap-1.5 p-0">
              {options.map((option) => (
                <li key={option.id} className="flex items-center gap-2">
                  <Input
                    inputSize="sm"
                    className="flex-1"
                    value={option.label}
                    onChange={(event) => update('decisionOption', option.id, { label: event.target.value })}
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (await confirm(t('decision.removeOptionConfirm', { label: option.label }))) {
                        remove('decisionOption', option.id);
                      }
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </Button>
                </li>
              ))}
            </ul>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const label = adding.trim();
                if (!label) return;
                create('decisionOption', {
                  decision_id: decision.id,
                  label,
                  description: null,
                  sort_order: orderKey(options[options.length - 1]?.sort_order ?? null, null),
                });
                setAdding('');
              }}
            >
              <Input
                inputSize="sm"
                className="flex-1"
                value={adding}
                placeholder={t('decision.addOption')}
                onChange={(event) => setAdding(event.target.value)}
              />
              <Button size="sm" type="submit" disabled={!adding.trim()}>{t('action.add')}</Button>
            </form>
          </>
        )}

        {canWrite && (
          <>
            <SectionHeading>{t('project.tabSettings')}</SectionHeading>
            <DecisionFields decision={decision} onChange={(patch) => update('decision', decision.id, patch)} locked={result !== null && result.voters > 0} />
            <div>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  if (await confirm(t('decision.deleteConfirm'))) {
                    remove('decision', decision.id);
                    navigate('/decisions');
                  }
                }}
              >
                {t('action.delete')}
              </Button>
            </div>
          </>
        )}
      </div>
      {dialog}
    </>
  );
}

