/**
 * Triage: what people outside the workspace have reported.
 *
 * A report is deliberately not a task. An anonymous form that wrote straight
 * into the backlog would point a stranger's keyboard at the thing the team
 * reads every morning; here it waits in one queue, and becomes a task when
 * somebody says it is one.
 *
 * The queue is an ordinary synced entity, so it reads offline like everything
 * else. Accepting and declining are server calls, because accepting *creates*
 * a task — numbered, defaulted and announced — and none of that is a patch.
 */
import { useState } from 'react';
import type { Intake } from '@kolibri/shared';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { list, useQuery } from '../lib/store';
import { pull } from '../lib/sync';
import { useCanWrite, useMemberMap } from '../session';
import { ShareSheet } from './share';
import { useStates, useTypes } from './task-parts';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input, Select } from '../components/ui/field';
import { Chip } from './ui/chip';
import { Empty, Icon, Sheet, useConfirm, useToast } from './ui';

/** Everything reported to this project, newest first. */
export const useIntakes = (projectId: string, status?: Intake['status']) =>
  useQuery(
    () => list('intake', (row) => row.project_id === projectId && (!status || row.status === status))
      .sort((a, b) => b.created_at - a.created_at),
    [projectId, status],
  );

/** How many are still waiting — for the tab's badge. */
export const useNewIntakeCount = (projectId: string): number => useIntakes(projectId, 'new').length;

export function Triage({ projectId }: { projectId: string }) {
  const t = useT();
  const toast = useToast();
  const canWrite = useCanWrite();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [tab, setTab] = useState<'new' | 'handled'>('new');
  const [accepting, setAccepting] = useState<Intake | null>(null);
  const [linking, setLinking] = useState(false);

  const waiting = useIntakes(projectId, 'new');
  const handled = useQuery(
    () => list('intake', (row) => row.project_id === projectId && row.status !== 'new')
      .sort((a, b) => (b.handled_at ?? b.created_at) - (a.handled_at ?? a.created_at)),
    [projectId],
  );
  const shown = tab === 'new' ? waiting : handled;

  const decline = async (intake: Intake) => {
    if (!await confirm(t('intake.declineConfirm', { title: intake.title }), t('intake.decline'))) return;
    try {
      await api.post(`/api/intakes/${intake.id}/decline`, {});
      await pull();
      toast(t('intake.declined'));
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('intake.failed'));
    }
  };

  return (
    <div className="page">
      <div className="flex items-center gap-2 flex-wrap gap-1.5 mb-3.5">
        <div className="flex items-center gap-2 gap-0.5" style={{ border: '1px solid var(--line-strong)', borderRadius: 7, padding: 2 }}>
          {(['new', 'handled'] as const).map((which) => (
            <button
              key={which}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), tab === which && 'bg-active text-fg')}
              style={tab === which ? { background: 'var(--bg-active)' } : undefined}
              aria-pressed={tab === which}
              onClick={() => setTab(which)}
            >
              {t(which === 'new' ? 'intake.tabNew' : 'intake.tabHandled')}
              {which === 'new' && waiting.length > 0 && ` ${waiting.length}`}
            </button>
          ))}
        </div>
        <span className="flex-1 min-w-0" />
        {canWrite && (
          <Button size="sm" onClick={() => setLinking(true)}>
            <Icon name="link" size={13} /> {t('intake.linkAction')}
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty
          emoji="📥"
          title={t(tab === 'new' ? 'intake.emptyNew' : 'intake.emptyHandled')}
          hint={t('intake.emptyHint')}
        />
      ) : (
        <div className="grid gap-2.5">
          {shown.map((intake) => (
            <article className="rounded-[var(--radius)] border border-line bg-raised p-3.5" key={intake.id}>
              <div className="flex items-center gap-2 gap-2" style={{ alignItems: 'flex-start' }}>
                <div className="flex-1 min-w-0">
                  <strong style={{ fontSize: 14.5 }}>{intake.title}</strong>
                  <div className="text-muted text-[12.5px] mt-0.5">
                    {/* Neither the name nor the address was verified, and saying
                        so once is better than a screen that quietly implies it. */}
                    {intake.reporter || intake.email
                      ? t('intake.from', { who: [intake.reporter, intake.email].filter(Boolean).join(' · ') })
                      : t('intake.anonymous')}
                    {' · '}{relativeTime(intake.created_at)}
                  </div>
                </div>
                {intake.status !== 'new' && (
                  <Chip>
                    {t(intake.status === 'accepted' ? 'intake.accepted' : 'intake.wasDeclined')}
                    {intake.handled_by && members.get(intake.handled_by) ? ` · ${members.get(intake.handled_by)!.name}` : ''}
                  </Chip>
                )}
              </div>
              {intake.body && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{intake.body}</p>
              )}
              {intake.status === 'new' && canWrite && (
                <div className="flex items-center gap-2 gap-1.5 mt-3">
                  <Button variant="primary" size="sm" onClick={() => setAccepting(intake)}>
                    <Icon name="check" size={13} /> {t('intake.accept')}
                  </Button>
                  <Button size="sm" onClick={() => void decline(intake)}>{t('intake.decline')}</Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {linking && (
        <ShareSheet
          target={{ kind: 'intake', project_id: projectId, name: t('intake.linkName') }}
          onClose={() => setLinking(false)}
        />
      )}
      {accepting && (
        <AcceptSheet
          intake={accepting}
          projectId={projectId}
          onClose={() => setAccepting(null)}
          onDone={(title) => { setAccepting(null); toast(t('intake.acceptedAs', { title })); }}
        />
      )}
      {dialog}
    </div>
  );
}

/**
 * Accepting one.
 *
 * The title is editable here on purpose: what somebody outside calls a problem
 * and what the team calls the work are rarely the same sentence, and rewriting
 * it later loses the moment when both are on screen at once.
 */
function AcceptSheet({
  intake, projectId, onClose, onDone,
}: { intake: Intake; projectId: string; onClose: () => void; onDone: (title: string) => void }) {
  const t = useT();
  const toast = useToast();
  const states = useStates(projectId);
  const types = useTypes(projectId);
  const [title, setTitle] = useState(intake.title);
  const [stateId, setStateId] = useState(states[0]?.id ?? '');
  const [typeId, setTypeId] = useState('');
  const [working, setWorking] = useState(false);

  const accept = async () => {
    setWorking(true);
    try {
      await api.post(`/api/intakes/${intake.id}/accept`, {
        title: title.trim() || intake.title,
        state_id: stateId || undefined,
        type_id: typeId || undefined,
      });
      await pull();
      onDone(title.trim() || intake.title);
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : t('intake.failed'));
      setWorking(false);
    }
  };

  return (
    <Sheet
      title={t('intake.accept')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={working || !title.trim()} onClick={() => void accept()}>
            {working ? t('action.working') : t('intake.acceptAction')}
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="intake-title">{t('task.title')}</label>
        <Input id="intake-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        <span className="text-[12px] text-muted">{t('intake.titleHint')}</span>
      </div>
      <div className="grid two">
        <div className="field">
          <label htmlFor="intake-state">{t('view.groupState')}</label>
          <Select id="intake-state" value={stateId} onChange={(event) => setStateId(event.target.value)}>
            {states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
          </Select>
        </div>
        <div className="field">
          <label htmlFor="intake-type">{t('type.label')}</label>
          <Select id="intake-type" value={typeId} onChange={(event) => setTypeId(event.target.value)}>
            <option value="">{t('type.none')}</option>
            {types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </Select>
        </div>
      </div>
      {intake.body && (
        <div className="field">
          <label>{t('intake.whatTheySaid')}</label>
          <p className="text-muted text-[13.5px] m-0" style={{ whiteSpace: 'pre-wrap' }}>{intake.body}</p>
          <span className="text-[12px] text-muted">{t('intake.bodyHint')}</span>
        </div>
      )}
    </Sheet>
  );
}
