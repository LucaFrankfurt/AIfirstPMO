/**
 * What a `Filters` *means*, against one task.
 *
 * `query.ts` beside this turns text into a `Filters`; this turns a `Filters`
 * into an answer about a row. They were written years apart and in different
 * rings, which is how the two screens that both claim to filter work came to
 * disagree: the task list read every key of `Filters`, and the search screen
 * read three of them by hand — a person, a label, a project — because that was
 * all its own box could produce. Making the two boxes speak one language is
 * only half a promise if the two screens then mean different things by it.
 *
 * Deliberately **not** here: the free text, and the custom fields.
 *
 * - **The text** is `parseTerms` either way, but what an exclusion *on its own*
 *   means is not the same question on the two screens, and the comment at each
 *   call site says which it is answering. Folding that in would have forced one
 *   of them to be wrong quietly.
 * - **A custom field** is a work concept (`fieldMatches` lives in that
 *   capability), and the query language has no syntax for one — `query.help`
 *   says so and `hasUnprintable` carries them across untouched. Typed text can
 *   therefore never produce `filters.field`, so only the menus can, and only
 *   the screen with the menus has to answer for it.
 */
import type { Filters, StateGroup, Task } from '../registry/types.ts';

/**
 * How far ahead `due = week` looks, and how far back *My work* remembers what
 * was done. It lived beside that screen's figures, which was right while the
 * browser was the only thing that asked; a shared link and a calendar feed ask
 * the same question on the server now, and two sevens are one too many.
 */
export const HORIZON_DAYS = 7;

/** What the filters ask about that a task does not carry itself. */
export interface FilterLookup {
  /** The group a state belongs to — what `is: open` and `group` ask. */
  groupOf: (stateId: string) => StateGroup | undefined;
  /** Today, as the reader's own clock sees it. */
  day: string;
  /** The last day of `due = week`. The caller owns the horizon; see below. */
  horizon: string;
}

/**
 * Whether a field that holds a list answers any of `wanted`.
 *
 * `''` is the empty answer — nobody on it, no label — and asks whether the
 * list is empty. `query.ts` has written it for `assignee = none` since the
 * language was written, and nothing here read it: an empty list never holds
 * `''`, so "nobody" filtered every task away and `!= none` filtered none. The
 * single-valued fields never had the problem, because `cycle_id ?? ''` *is*
 * the empty answer; a list has to be asked.
 */
const holdsAny = (values: string[] | undefined, wanted: string[]): boolean =>
  wanted.some((id) => (id === '' ? !(values ?? []).length : (values ?? []).includes(id)));

export function passesFilters(task: Task, filters: Filters, at: FilterLookup): boolean {
  const group = at.groupOf(task.state_id);

  if (filters.state?.length && !filters.state.includes(task.state_id)) return false;
  if (filters.group?.length && !filters.group.includes(group as StateGroup)) return false;
  if (filters.priority?.length && !filters.priority.includes(task.priority)) return false;
  if (filters.project?.length && !filters.project.includes(task.project_id)) return false;
  if (filters.cycle?.length && !filters.cycle.includes(task.cycle_id ?? '')) return false;
  if (filters.module?.length && !filters.module.includes(task.module_id ?? '')) return false;
  if (filters.assignee?.length && !holdsAny(task.assignees, filters.assignee)) return false;
  if (filters.label?.length && !holdsAny(task.labels, filters.label)) return false;

  // The same questions the other way round. Written out beside the positive
  // ones rather than derived from them: a loop over field names would be
  // shorter and would not survive the next field that needs a rule of its own,
  // the way `assignee` and `label` already do.
  const not = filters.not;
  if (not) {
    if (not.state?.includes(task.state_id)) return false;
    if (not.group?.includes(group as StateGroup)) return false;
    if (not.priority?.includes(task.priority)) return false;
    if (not.project?.includes(task.project_id)) return false;
    if (not.cycle?.includes(task.cycle_id ?? '')) return false;
    if (not.module?.includes(task.module_id ?? '')) return false;
    // A list: excluded when *any* of the task's values is named. "Not assigned
    // to Ada" means the ones Ada is not on, including the ones she shares.
    if (not.assignee && holdsAny(task.assignees, not.assignee)) return false;
    if (not.label && holdsAny(task.labels, not.label)) return false;
  }

  if (filters.due === 'overdue' && !(task.due_date && task.due_date < at.day)) return false;
  if (filters.due === 'today' && task.due_date !== at.day) return false;
  if (filters.due === 'none' && task.due_date) return false;
  // `due <= 7d` parsed to this bucket from the day the query language was
  // written and nothing ever acted on it: the filter was accepted, the chip
  // appeared, and every task stayed on screen. Overdue work is its own bucket
  // and stays out of this one — "the coming week" is what somebody asking for
  // it means, and a task from last month is not an answer to it.
  //
  // The horizon is passed in rather than counted here, because the figure on
  // *My work*'s tile and the rows this opens have to be the same seven days;
  // the tile owns the number and lends it.
  if (filters.due === 'week' && !(task.due_date && task.due_date >= at.day && task.due_date <= at.horizon)) return false;

  return true;
}
