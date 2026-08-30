/**
 * The one thing in Kolibri that happens because time passed.
 *
 * Everything else is a reaction to somebody doing something: a write fires the
 * rules, a comment sends a notification. Three things cannot work that way —
 * a reminder before a due date, a rule that fires *n* days before one, and the
 * next occurrence of a repeating task — so they get a sweep.
 *
 * It runs once an hour and is idempotent by construction: every effect records
 * that it happened, and the sweep skips what it already did. A restart, a
 * double tick or a clock jump therefore cost nothing.
 */
import { all, get, run, type Row } from '../db/index.ts';
import { serverClock } from './bootstrap.ts';
import { uid } from './ids.ts';
import { translatorFor } from './i18n.ts';
import { createNotification } from './notify.ts';
import { canSeeProject, writeEntity } from './repo.ts';
import { runAutomationsForDue } from './automation.ts';
import { applyRetention } from './trash.ts';
import { expireLinks as expireTelegramLinks, retryPending as retryPendingTelegram } from './telegram.ts';
import { flushDeliveries, pruneDeliveries } from './webhooks.ts';
import { sweepBackups } from './backups.ts';

const HOUR = 3_600_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Today as the server sees it. Dates on tasks are plain days, not instants. */
export const todayISO = (at = Date.now()): string => new Date(at).toISOString().slice(0, 10);

const addDays = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/* --------------------------------------------------------- due reminders */

/** How many days ahead is "soon". Short on purpose: a reminder people ignore is noise. */
const SOON_DAYS = 2;

/**
 * Tell assignees about a task that is due soon, once.
 *
 * The `due_soon` notification kind has been reserved since the first release
 * and nothing emitted it. Once per task per due date: moving a due date is a
 * new deadline and worth a new reminder, missing one is not worth a daily
 * repeat of the same sentence.
 */
export function remindAboutDueTasks(now = Date.now()): number {
  const today = todayISO(now);
  const limit = addDays(today, SOON_DAYS);
  const due = all<Row>(
    `SELECT t.*, p.name AS project_name FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE t.deleted_at IS NULL AND t.archived = 0
        AND t.due_date IS NOT NULL AND t.due_date <= ? AND t.completed_at IS NULL
        AND EXISTS (SELECT 1 FROM states s WHERE s.id = t.state_id AND s.group_key NOT IN ('completed','cancelled'))`,
    limit,
  );

  let sent = 0;
  for (const task of due) {
    const audience = new Set<string>([...parse(task.assignees), ...parse(task.subscribers)]);
    for (const userId of audience) {
      if (!userId) continue;
      // The due date is part of the key, so moving a deadline earns one more
      // reminder and leaving it alone does not.
      const marker = `due:${task.id}:${task.due_date}`;
      if (get(`SELECT marker FROM reminders WHERE marker = ? AND user_id = ?`, marker, userId)) continue;
      if (!canSeeProject(userId, String(task.project_id))) continue;

      const t = translatorFor(userId);
      const overdue = String(task.due_date) < today;
      createNotification({
        workspaceId: String(task.workspace_id),
        userId,
        kind: 'due_soon',
        title: t(overdue ? 'notify.overdue' : 'notify.dueSoon', { identifier: task.identifier, title: task.title, date: task.due_date }),
        taskId: String(task.id),
      });
      run(`INSERT OR IGNORE INTO reminders (marker, user_id, created_at) VALUES (?, ?, ?)`, marker, userId, Date.now());
      sent++;
    }
  }
  return sent;
}

/* -------------------------------------------------------------- recurrence */

/** `weekly:2` → two weeks. A bare unit means every one. */
export function nextDueDate(from: string, recurrence: string): string | null {
  const [unit, every] = String(recurrence).split(':');
  const step = Math.max(1, Number(every) || 1);
  if (unit === 'daily') return addDays(from, step);
  if (unit === 'weekly') return addDays(from, 7 * step);
  if (unit === 'monthly') {
    const date = new Date(`${from}T00:00:00Z`);
    const day = date.getUTCDate();
    date.setUTCMonth(date.getUTCMonth() + step);
    // The 31st of a 30-day month lands on the 1st without this; a monthly task
    // set for the 31st should be the last day of the month, not the next one.
    if (date.getUTCDate() !== day) date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Create the next occurrence of a finished repeating task.
 *
 * Driven by *completion*, not by the calendar. A weekly task nobody did four
 * times is one task that is late, not four tasks nobody will do.
 */
export function rollRecurringTasks(): number {
  const finished = all<Row>(
    `SELECT t.* FROM tasks t
      WHERE t.deleted_at IS NULL AND t.recurrence IS NOT NULL AND t.recurrence <> ''
        AND t.completed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks n WHERE n.recurred_from = t.id AND n.deleted_at IS NULL)`,
  );

  let made = 0;
  for (const task of finished) {
    const base = String(task.due_date || todayISO(Number(task.completed_at)));
    const next = nextDueDate(base, String(task.recurrence));
    if (!next) continue;

    const state = get<Row>(
      `SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL
        AND group_key NOT IN ('completed','cancelled') ORDER BY sort_order LIMIT 1`,
      task.project_id,
    );
    writeEntity('task', uid(), {
      workspace_id: task.workspace_id,
      project_id: task.project_id,
      title: task.title,
      description: task.description,
      state_id: state?.id ?? null,
      priority: task.priority,
      assignees: parse(task.assignees),
      labels: parse(task.labels),
      estimate: task.estimate,
      due_date: next,
      recurrence: task.recurrence,
      recurred_from: task.id,
      created_by: task.created_by,
    }, { workspaceId: String(task.workspace_id), actorId: String(task.created_by), hlc: serverClock.now(), system: true });
    made++;
  }
  return made;
}

/* ------------------------------------------------------------------ sweep */

export function sweep(now = Date.now()): { reminders: number; recurred: number; rules: number; purged: number; codes: number } {
  // Telegram messages that failed on the way out get another go, and the
  // link codes nobody used are dropped. Both are deliberately fire-and-forget:
  // the sweep's own result is about the work it did to the database, and an
  // unreachable chat service is not a reason for it to report a failure.
  void retryPendingTelegram(now);
  // The same arrangement for calls out: a delivery waiting on its backoff is
  // picked up by an in-process timer, and by this sweep if the process was
  // restarted in the middle of one. Fire-and-forget for the same reason —
  // somebody else's endpoint being down is not this sweep failing.
  void flushDeliveries(now);
  pruneDeliveries(now);
  return {
    reminders: remindAboutDueTasks(now),
    recurred: rollRecurringTasks(),
    rules: runAutomationsForDue(todayISO(now)),
    // Off unless somebody set a window. It runs on the hourly tick rather than
    // on a daily one because the cutoff is an age, not a date: running it
    // twice in one day purges nothing the first pass did not already take.
    purged: applyRetention(now),
    codes: expireTelegramLinks(now),
  };
}

export function startScheduler(): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = () => {
    try {
      const done = sweep();
      if (done.reminders || done.recurred || done.rules || done.purged) {
        console.log(`[scheduler] ${done.reminders} reminders, ${done.recurred} repeats, ${done.rules} rules, ${done.purged} purged`);
      }
    } catch (error) {
      console.error('[scheduler] sweep failed', error);
    }
    /* The backup is its own attempt, on purpose: a sweep that threw before
       reaching it would be a night with no snapshot, and the whole point of
       this being here rather than in somebody's crontab is that it does not
       depend on anything else having gone well. It is also the one part of the
       sweep that waits on a network, so it is not inside the try above. */
    void sweepBackups().then((result) => {
      if (!result) return;
      if (result.problem) console.error(`[backup] ${result.problem}`);
      else {
        console.log(`[backup] took ${result.taken}${result.pruned.length ? `, removed ${result.pruned.join(', ')}` : ''}${result.copied ? `, copied ${result.copied} object(s) offsite` : ''}`);
      }
    }).catch((error) => console.error('[backup] failed', error));
  };
  timer = setInterval(tick, HOUR);
  timer.unref?.();
  // Once at boot, so an instance that is restarted daily still reminds anybody.
  setTimeout(tick, 5_000).unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

const parse = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};
