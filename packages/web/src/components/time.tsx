/**
 * Time actually spent, next to the estimate that guessed it.
 *
 * A timer is a row in the database, not a piece of interface state: it has a
 * `started_at` and no minutes yet. That is what makes it survive a reload, a
 * second device and a tunnel — and what makes "I forgot to stop it yesterday"
 * a thing you can fix by editing a row rather than a thing you lose.
 *
 * Only one timer runs at a time, per person. Two stopwatches on two tasks is
 * not a feature, it is a bug you find out about on Friday.
 */
import { useEffect, useState } from 'react';
import type { TimeEntry } from '@kolibri/shared';
import { duration, parseDuration } from '@kolibri/shared';
import { useT } from '../lib/i18n';
import { shortDate, today } from '../lib/format';
import { create, remove, update } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useMe, useMemberMap, useSession } from '../session';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/field';
import { Avatar, Icon, useConfirm, useToast } from './ui';

/** Minutes on the clock right now, for a row that is still running. */
export const runningMinutes = (entry: TimeEntry, now: number): number =>
  entry.started_at ? Math.floor((now - entry.started_at) / 60_000) : 0;

/**
 * A clock that ticks once a minute, so a running timer counts up on screen.
 *
 * A minute is the resolution the entries are stored in; a second-by-second
 * counter would be a re-render a second for a number that does not change.
 */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The one entry this person has running, anywhere. */
export function useRunningEntry(): TimeEntry | undefined {
  const me = useMe();
  return useQuery(
    () => list('timeEntry', (entry) => entry.user_id === me && !!entry.started_at)[0],
    [me],
  );
}

export function useTaskTime(taskId: string): { entries: TimeEntry[]; total: number } {
  const entries = useQuery(
    () => list('timeEntry', (entry) => entry.task_id === taskId)
      .sort((a, b) => (a.spent_on < b.spent_on ? 1 : a.spent_on > b.spent_on ? -1 : b.created_at - a.created_at)),
    [taskId],
  );
  return { entries, total: entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0) };
}

/** Start, stop, log by hand, and the list of what is already logged. */
export function TaskTime({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const t = useT();
  const me = useMe();
  const { workspaceId } = useSession();
  const members = useMemberMap();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const { entries, total } = useTaskTime(taskId);
  const running = useRunningEntry();
  const runningHere = running?.task_id === taskId ? running : undefined;
  const now = useMinuteTick(!!runningHere);
  const elapsed = runningHere ? runningMinutes(runningHere, now) : 0;

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const [open, setOpen] = useState(false);

  const start = () => {
    // Starting somewhere else stops what was running, rather than leaving two
    // clocks going and a wrong total on Friday.
    if (running) stop(running);
    create('timeEntry', {
      workspace_id: workspaceId,
      project_id: projectId,
      task_id: taskId,
      user_id: me,
      minutes: 0,
      spent_on: today(),
      note: null,
      started_at: Date.now(),
      billable: 1,
    });
  };

  const stop = (entry: TimeEntry) => {
    const minutes = Math.max(1, runningMinutes(entry, Date.now()));
    update('timeEntry', entry.id, { minutes, started_at: null });
    toast(t('time.stopped', { amount: duration(minutes) }));
  };

  const log = () => {
    const minutes = parseDuration(amount);
    if (minutes === null || minutes <= 0) return;
    create('timeEntry', {
      workspace_id: workspaceId,
      project_id: projectId,
      task_id: taskId,
      user_id: me,
      minutes,
      spent_on: date,
      note: note.trim() || null,
      started_at: null,
      billable: 1,
    });
    setAmount('');
    setNote('');
    setOpen(false);
    toast(t('time.logged', { amount: duration(minutes) }));
  };

  return (
    <section className="mb-[18px]">
      <div className="flex items-center gap-2 gap-2 mb-2">
        <strong className="text-[13.5px]">{t('time.title')}</strong>
        {/* Logged time only. `tasks.estimate` is points, not hours — the app
            calls them "estimate points" — so putting the two side by side would
            be comparing a guess at size with a measurement of time. Showing
            spent against estimated needs the estimate to carry a unit first. */}
        <span className="chip">{duration(total + elapsed)}</span>
        <span className="flex-1 min-w-0" />
        {runningHere ? (
          <Button variant="danger" size="sm" onClick={() => stop(runningHere)}>
            <Icon name="pause" size={14} /> {t('time.stop')}
          </Button>
        ) : (
          <Button size="sm" onClick={start} title={running ? t('time.switchHint') : undefined}>
            <Icon name="play" size={14} /> {t('time.start')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>{t('time.log')}</Button>
      </div>

      {runningHere && (
        <p className="text-muted text-[12.5px] mb-2" aria-live="polite">
          {t('time.runningFor', { amount: duration(elapsed) })}
        </p>
      )}
      {running && !runningHere && (
        // Saying where the clock is beats a person hunting for it.
        <p className="text-[12px] text-danger mb-2">{t('time.runningElsewhere')}</p>
      )}

      {open && (
        <div className="flex items-center gap-2 flex-wrap gap-1.5 mb-2.5">
          <Input style={{ width: 90 }} autoFocus
            placeholder={t('time.amountPlaceholder')}
            aria-label={t('time.amount')}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && log()}
          />
          <Input type="date" style={{ width: 148 }}
            aria-label={t('time.date')}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <Input
            className="flex-1 min-w-0" style={{ minWidth: 120 }}
            placeholder={t('time.notePlaceholder')}
            aria-label={t('time.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && log()}
          />
          <Button variant="primary" size="sm" disabled={!parseDuration(amount)} onClick={log}>{t('action.save')}</Button>
        </div>
      )}

      {entries.map((entry) => (
        <div className="flex items-center gap-2" key={entry.id} style={{ gap: 8, fontSize: 12.5, padding: '5px 0', borderTop: '1px solid var(--line)' }}>
          <Avatar user={members.get(entry.user_id)} size={18} />
          <span style={{ minWidth: 62 }}>
            {entry.started_at ? `${duration(runningMinutes(entry, now))} ${t('time.running')}` : duration(entry.minutes)}
          </span>
          <span className="text-muted">{shortDate(entry.spent_on)}</span>
          <span className="flex-1 min-w-0 truncate">{entry.note ?? ''}</span>
          {entry.user_id === me && !entry.started_at && (
            <Button variant="ghost" size="iconSm"
              aria-label={t('time.deleteEntry')}
              onClick={async () => {
                if (await confirm(t('time.deleteConfirm', { amount: duration(entry.minutes) }))) remove('timeEntry', entry.id);
              }}
            >
              <Icon name="trash" size={13} />
            </Button>
          )}
        </div>
      ))}
      {dialog}
    </section>
  );
}

/** Everything logged against a project, and by whom. */
export function ProjectTime({ projectId }: { projectId: string }) {
  const t = useT();
  const members = useMemberMap();
  const entries = useQuery(() => list('timeEntry', (entry) => entry.project_id === projectId), [projectId]);

  const total = entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0);
  const byPerson = new Map<string, number>();
  for (const entry of entries) byPerson.set(entry.user_id, (byPerson.get(entry.user_id) ?? 0) + (entry.minutes ?? 0));
  const people = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);

  if (!entries.length) return <p className="text-muted text-[12.5px]">{t('time.noneYet')}</p>;

  return (
    <div className="flex flex-col gap-2 gap-1.5">
      <div className="flex items-center gap-2 text-[13.5px]">
        <strong className="flex-1 min-w-0">{t('time.total')}</strong>
        <span>{duration(total)}</span>
      </div>
      {people.map(([userId, minutes]) => (
        <div className="flex items-center gap-2" key={userId} style={{ fontSize: 12.5, gap: 7 }}>
          <Avatar user={members.get(userId)} size={18} />
          <span className="flex-1 min-w-0 truncate">{members.get(userId)?.name ?? t('common.someone')}</span>
          <span className="text-muted">{duration(minutes)}</span>
        </div>
      ))}
    </div>
  );
}
