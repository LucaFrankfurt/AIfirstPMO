/**
 * The numbers and the greeting at the top of *My work*.
 *
 * Pure on purpose, like the route parsing next door: none of this needs a
 * browser, a store or a clock of its own, so all of it can be tested directly
 * and the component is left holding nothing but the lookups.
 *
 * Everything here counts tasks that are already in the local mirror. There is
 * no endpoint behind the overview and no aggregation table under it — the
 * figures are the ones the list below is drawn from, so they cannot disagree
 * with it, and they are still right on a train.
 */

/** How far ahead "coming up" looks, and how far back "done" remembers. */
export const HORIZON_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * A day, shifted. ISO dates rather than timestamps because a due date is a day
 * in the reader's calendar, not an instant — comparing the strings is both
 * correct and free, and it does not drift when somebody flies east.
 */
export function plusDays(day: string, count: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/** The little a figure needs to know about a task. */
export interface Countable {
  due_date: string | null;
  completed_at: number | null;
  /** Resolved by the caller: whether the task's state is a finished one. */
  done: boolean;
}

export interface Standing {
  /** Assigned to you and not finished. */
  open: number;
  /** Open and due between today and the horizon — overdue is its own card. */
  soon: number;
  /** Open with no due date at all. */
  unscheduled: number;
  /** Finished inside the horizon. */
  done: number;
}

/**
 * Where you stand.
 *
 * Overdue work counts as `open` but not as `soon`: it already has a card of its
 * own below, and rolling it into "the next seven days" would let a month-old
 * task hide inside a number that reads like a plan.
 */
export function summarise(tasks: Countable[], day: string, now: number): Standing {
  const horizon = plusDays(day, HORIZON_DAYS);
  const since = now - HORIZON_DAYS * DAY_MS;
  const standing: Standing = { open: 0, soon: 0, unscheduled: 0, done: 0 };
  for (const task of tasks) {
    if (task.done) {
      if ((task.completed_at ?? 0) >= since) standing.done += 1;
      continue;
    }
    standing.open += 1;
    if (!task.due_date) standing.unscheduled += 1;
    else if (task.due_date >= day && task.due_date <= horizon) standing.soon += 1;
  }
  return standing;
}

export type GreetingKey =
  | 'overview.greetNight'
  | 'overview.greetMorning'
  | 'overview.greetAfternoon'
  | 'overview.greetEvening';

/**
 * Which greeting the hour has earned.
 *
 * Four, not one per hour: a greeting is a small kindness, and a tool that tries
 * to be clever about 3pm is a tool that is wrong about 3pm somewhere.
 */
export function greetingKey(hour: number): GreetingKey {
  if (hour < 5) return 'overview.greetNight';
  if (hour < 12) return 'overview.greetMorning';
  if (hour < 18) return 'overview.greetAfternoon';
  return 'overview.greetEvening';
}

/**
 * What to call somebody.
 *
 * The first word of their name. "Good morning, Luca" is a greeting; "Good
 * morning, Luca Khaghani" is a summons. An empty result is a real answer and
 * means the greeting is left out rather than addressed to nobody.
 */
export const firstName = (name?: string | null): string => (name ?? '').trim().split(/\s+/)[0] ?? '';
