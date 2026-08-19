/**
 * Dependency scheduling.
 *
 * A Gantt chart is not a layout, it is a promise: move a task and everything
 * waiting on it moves too. That promise is the whole of this file, and it is
 * shared rather than living in the view, because the server applies exactly the
 * same rule when a date arrives over the API.
 *
 * The rule is deliberately one sentence: **a task may not start before
 * everything that blocks it has finished.** Nothing here invents durations,
 * levels resources or optimises a critical path — a scheduler that silently
 * rewrites a plan is one nobody trusts twice.
 */

export const DAY = 86_400_000;

/** `2026-08-19` → epoch millis at UTC midnight. */
export const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** Epoch millis → `2026-08-19`. */
export const isoDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => isoDay(dayOf(date) + days * DAY);

/** Whole days between two dates; negative if `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((dayOf(to) - dayOf(from)) / DAY);

export interface Scheduled {
  id: string;
  start_date: string | null;
  due_date: string | null;
}

export interface Dependency {
  /** The task that has to finish first. */
  from: string;
  /** The task that waits. */
  to: string;
  /**
   * Working days of breathing room between the two — "the paint has to dry".
   *
   * Never negative. A lead time would say a task may start *before* its blocker
   * finishes, which is the one sentence this file exists to enforce; somebody
   * who means that has two tasks, not one with a clever number on it.
   */
  lag?: number;
}

/**
 * Which weekdays are working days, as `Date.getUTCDay()` numbers — 0 is Sunday.
 *
 * Monday to Friday unless a project says otherwise. An empty or missing list
 * means every day counts, which is also what every caller written before this
 * existed gets, so nothing changes for a plan nobody has told about weekends.
 */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export interface ScheduleOptions {
  /**
   * The weekdays that count — or a lookup by task, for a plan that spans
   * projects. The team planner needs the second: two projects in one company
   * can genuinely disagree about whether Saturday is a working day, and the
   * task's own project is the one that decides for it.
   */
  workingDays?: number[] | null | ((taskId: string) => number[] | null | undefined);
}

const workdaysOf = (options: ScheduleOptions | undefined, taskId: string): number[] => {
  const asked = options?.workingDays;
  const days = typeof asked === 'function' ? asked(taskId) : asked;
  return days && days.length && days.length < 7 ? days : EVERY_DAY;
};

export const isWorkingDay = (date: string, days: number[]): boolean =>
  days.includes(new Date(dayOf(date)).getUTCDay());

/** This day if it is a working one, otherwise the next that is. */
export function nextWorkingDay(date: string, days: number[]): string {
  if (days.length === 7) return date;
  let day = date;
  // Seven is enough by construction: a non-empty set contains some weekday.
  for (let i = 0; i < 7 && !isWorkingDay(day, days); i++) day = addDays(day, 1);
  return day;
}

/** `n` working days after `date`, landing on a working day. */
export function addWorkingDays(date: string, n: number, days: number[]): string {
  if (days.length === 7) return addDays(date, n);
  let day = nextWorkingDay(date, days);
  for (let i = 0; i < n; i++) day = nextWorkingDay(addDays(day, 1), days);
  return day;
}

/**
 * Working days from `from` to `to` inclusive — a Monday to a Friday is five.
 *
 * Bounded, because two dates a century apart is a typo rather than a plan and
 * counting it a day at a time would be a hung tab.
 */
export function workingDaysBetween(from: string, to: string, days: number[]): number {
  if (days.length === 7) return daysBetween(from, to) + 1;
  const span_ = Math.min(Math.abs(daysBetween(from, to)), 3650);
  let count = 0;
  for (let i = 0; i <= span_; i++) if (isWorkingDay(addDays(from, i), days)) count++;
  return count;
}

export interface Shift {
  id: string;
  start_date: string | null;
  due_date: string | null;
}

/**
 * Both ends of a task, filled in when only one is known.
 *
 * A task with only a due date is a one-day task on that day; a task with only a
 * start is a one-day task on that day. Guessing a length would be inventing a
 * plan somebody did not make.
 */
export function span(task: Scheduled): { start: string; end: string } | null {
  const start = task.start_date ?? task.due_date;
  const end = task.due_date ?? task.start_date;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * Push whatever is waiting on `changed` far enough forward that nothing starts
 * before its blocker ends.
 *
 * Returns only the tasks that actually move, so a caller can write exactly
 * those and no more. Nothing is ever pulled *earlier*: a plan that snaps
 * backwards the moment a dependency finishes early is a plan that argues with
 * whoever wrote it.
 */
export function reschedule(
  changed: string[],
  tasks: Scheduled[],
  dependencies: Dependency[],
  options?: ScheduleOptions,
): Shift[] {
  const byId = new Map(tasks.map((task) => [task.id, { ...task }]));
  const successors = new Map<string, Dependency[]>();
  for (const link of dependencies) {
    if (!successors.has(link.from)) successors.set(link.from, []);
    successors.get(link.from)!.push(link);
  }

  const moved = new Map<string, Shift>();
  const queue = [...changed];
  // A dependency cycle is a plan somebody has to fix by hand; this bound means
  // it costs a moment rather than a hung tab.
  let guard = tasks.length * 8 + 64;

  while (queue.length && guard-- > 0) {
    const id = queue.shift()!;
    const blocker = byId.get(id);
    const blockerSpan = blocker && span(blocker);
    if (!blockerSpan) continue;

    for (const link of successors.get(id) ?? []) {
      const next = link.to;
      const task = byId.get(next);
      const taskSpan = task && span(task);
      if (!task || !taskSpan) continue;
      // The waiting task's own calendar, not its blocker's.
      const days = workdaysOf(options, next);

      // The working day after the blocker ends, plus whatever lag the link
      // asks for, is the earliest this may start.
      const earliest = addWorkingDays(blockerSpan.end, 1 + Math.max(0, Math.round(link.lag ?? 0)), days);
      if (taskSpan.start >= earliest) continue;

      // The task keeps its *length in working days* rather than its length in
      // calendar days: three days of work pushed across a weekend is still
      // three days of work, and stretching it to five would be the schedule
      // inventing effort nobody planned.
      const length = Math.max(1, workingDaysBetween(taskSpan.start, taskSpan.end, days));
      const end = addWorkingDays(earliest, length - 1, days);
      // A task with only one of the two dates keeps having only that one —
      // `span` filled the other in to do the arithmetic, not to write it back.
      const next_start = task.start_date ? earliest : null;
      const next_due = task.due_date ? end : null;
      task.start_date = next_start;
      task.due_date = next_due;
      moved.set(next, { id: next, start_date: next_start, due_date: next_due });
      queue.push(next);
    }
  }

  return [...moved.values()];
}

/**
 * What a move would do, without doing it: the task itself plus everything that
 * follows. Used by the Gantt to write one batch after a drag.
 */
export function moveTask(
  id: string,
  start: string | null,
  due: string | null,
  tasks: Scheduled[],
  dependencies: Dependency[],
  options?: ScheduleOptions,
): Shift[] {
  const next = tasks.map((task) => (task.id === id ? { ...task, start_date: start, due_date: due } : task));
  // The dragged task lands exactly where it was dropped, weekend or not: the
  // scheduler avoids non-working days when *it* moves something, and somebody
  // who deliberately drags a bar onto a Saturday has said what they meant.
  return [{ id, start_date: start, due_date: due }, ...reschedule([id], next, dependencies, options)];
}

/* ------------------------------------------------------------- packing */

/**
 * Stack overlapping work into as few rows as it takes.
 *
 * First fit by start date: an item goes on the first row whose last item has
 * already finished. That is what makes a week of three parallel jobs legible
 * instead of one bar with two hidden behind it. Used by the team planner.
 */
export function packRows(items: Scheduled[]): { row: Map<string, number>; rows: number } {
  const row = new Map<string, number>();
  const endOf: string[] = [];
  const ordered = [...items].filter((item) => span(item)).sort((a, b) => span(a)!.start.localeCompare(span(b)!.start));
  for (const item of ordered) {
    const bounds = span(item)!;
    let index = endOf.findIndex((end) => end < bounds.start);
    if (index === -1) index = endOf.length;
    endOf[index] = bounds.end;
    row.set(item.id, index);
  }
  return { row, rows: Math.max(1, endOf.length) };
}

/* ------------------------------------------------------- transition rules */

const ROLE_RANK: Record<string, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * Whether somebody with this role may move a task into this column.
 *
 * Empty means anybody who can write. A role that outranks every role named is
 * allowed too: naming "member" and meaning "but not an owner" is not what
 * anybody writes down. The server enforces the same rule — this exists so the
 * interface never offers a move that will be refused.
 */
export function mayEnter(allowed: string[] | null | undefined, role: string | undefined): boolean {
  if (!allowed?.length) return true;
  if (!role || role === 'guest') return false;
  if (allowed.includes(role)) return true;
  const bar = Math.min(...allowed.map((name) => ROLE_RANK[name] ?? 99));
  return (ROLE_RANK[role] ?? -1) >= bar;
}
