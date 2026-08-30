/**
 * How deep a stack of task sheets is, and what one close should get past.
 *
 * Its own file, with no imports at all, because the rule is worth testing and
 * `navigation.ts` cannot be loaded outside a browser — it reaches the router
 * and the IndexedDB store. What is left here is arithmetic on a location, which
 * is the part that was wrong.
 *
 * **The bug this exists to prevent.** A task opens as a sheet over whatever you
 * were looking at, and opening a sub-task from it pushes a second history
 * entry. That push is right: browser Back should walk from the child to the
 * parent to the board, because that is the road that was travelled. What was
 * wrong is that the *close button* did the same thing — three sub-tasks deep,
 * ✕ had to be pressed three times, and each press revealed a sheet the person
 * had already finished with.
 *
 * So the depth rides along in the router state, and closing pops all of it at
 * once. Back still walks; close closes.
 */

/** Only the parts of a router `Location` these two rules read. */
export interface StackLocation {
  pathname: string;
  state?: unknown;
}

export interface TaskStackState {
  /** The screen the whole stack is drawn over — never the sheet below. */
  background?: unknown;
  depth?: number;
}

const read = (location: StackLocation): TaskStackState =>
  (location.state as TaskStackState | null | undefined) ?? {};

/** Whether this location is itself a task sheet. */
export const isTaskLocation = (location: StackLocation): boolean => location.pathname.startsWith('/t/');

/**
 * The router state for a task about to be opened from `location`.
 *
 * `background` is inherited rather than recomputed: the screen behind the stack
 * is the board somebody started from, not the task they opened this one out of.
 * Getting that wrong is what made closing a sub-task land on its parent.
 */
export function nextTaskState(location: StackLocation): TaskStackState {
  const state = read(location);
  const onTask = isTaskLocation(location);
  return {
    background: state.background ?? (onTask ? undefined : location),
    depth: onTask ? (state.depth ?? 1) + 1 : 1,
  };
}

/**
 * How many history entries one close has to go back.
 *
 * At least one, always — a close that navigates by zero is a close that does
 * nothing, which is a worse bug than the one being fixed.
 */
export const stackDepth = (location: StackLocation): number => Math.max(1, read(location).depth ?? 1);
