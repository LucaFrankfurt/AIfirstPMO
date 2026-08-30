/**
 * When dated work is in trouble, defined once.
 *
 * This is the answer to "what is at risk", and it used to have two of them. The
 * MCP report worked it out from SQL rows — overdue, blocked, not started,
 * nobody on it, weighted into a severity. The interface worked out something
 * else from a bare date: `due < today` painted a chip red. Neither knew about
 * the other, so an assistant and the screen could disagree about the same task,
 * and one of them did: the interface called a *finished* task overdue, because
 * a date is all it looked at.
 *
 * So the rule lives here, where both call it, and it is pure — a task's fields
 * and a day in, reasons out. No clock of its own either: the caller says what
 * today is, because "today" on a server in one timezone and on a phone in
 * another are different days and only the caller knows which one it meant.
 */
import type { StateGroup } from './types.ts';

/** A state group that means the work has stopped, one way or the other. */
export const DONE_GROUPS: readonly StateGroup[] = ['completed', 'cancelled'];

export const isDoneGroup = (group: string | null | undefined): boolean =>
  DONE_GROUPS.includes(group as StateGroup);

/**
 * Whole days from `today` to `due`, negative when the day has passed.
 *
 * Both are ISO days rather than instants, and the arithmetic is done in UTC on
 * purpose: a due date is a day in somebody's calendar, not a moment, and
 * parsing it as midnight-local would move it by one across a timezone.
 */
export function daysUntil(due: string, today: string): number {
  const DAY = 86_400_000;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

/**
 * Why a task is at risk. Several can be true at once — "overdue and blocked" is
 * a different conversation from either alone — so all of them are reported
 * rather than the first one found.
 */
export type RiskReason = 'overdue' | 'blocked' | 'not_started' | 'unassigned';

export interface AtRisk {
  /** ISO day. A task without one is not dated and cannot be late. */
  due_date: string | null | undefined;
  /** The group of the state it sits in. */
  group_key: string | null | undefined;
  /** Whoever is on it. Empty is a reason. */
  assignees: readonly string[];
  /** How many unfinished things it waits on. */
  blockedBy?: number;
  /** Archived work is a record rather than a promise, and is left out. */
  archived?: boolean;
}

export interface Risk {
  reasons: RiskReason[];
  daysUntilDue: number;
  /**
   * A number to sort and threshold on, because "worst" is otherwise a
   * judgement every caller has to re-derive from the reasons.
   */
  severity: number;
}

/** No date, no promise; finished or archived, no longer a promise either. */
export const canBeLate = (task: AtRisk): boolean =>
  !!task.due_date && !task.archived && !isDoneGroup(task.group_key);

/**
 * The reasons this task is in trouble, and how much.
 *
 * An empty `reasons` means it is fine — dated, open, on somebody's list and not
 * waiting on anything. Callers filter on that rather than on the severity,
 * which is only for ordering what is left.
 */
export function riskOf(task: AtRisk, today: string): Risk {
  if (!canBeLate(task)) return { reasons: [], daysUntilDue: 0, severity: 0 };
  const until = daysUntil(String(task.due_date), today);
  const blocked = task.blockedBy ?? 0;
  const reasons: RiskReason[] = [];
  if (until < 0) reasons.push('overdue');
  if (blocked > 0) reasons.push('blocked');
  if (until >= 0 && (task.group_key === 'backlog' || task.group_key === 'unstarted')) reasons.push('not_started');
  if (!task.assignees.length) reasons.push('unassigned');

  return {
    reasons,
    daysUntilDue: until,
    severity:
      (until < 0 ? 100 + Math.min(60, -until) : Math.max(0, 40 - until * 2))
      + (blocked > 0 ? 25 : 0)
      + (reasons.includes('not_started') ? 15 : 0)
      + (task.assignees.length ? 0 : 10),
  };
}

/**
 * What a due date should be coloured, or nothing.
 *
 * The narrow half of the same rule, for the one place the interface says
 * something about a date without saying anything else: the chip on a task row.
 * It answers `null` for finished work, which is the disagreement this file was
 * written to end — a task somebody shipped in January is not late, however far
 * its date has receded.
 */
export function dueTone(
  due: string | null | undefined,
  group: string | null | undefined,
  today: string,
): 'overdue' | 'today' | null {
  if (!due || isDoneGroup(group)) return null;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return null;
}
