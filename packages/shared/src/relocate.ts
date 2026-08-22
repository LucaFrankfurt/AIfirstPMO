/**
 * Moving a task from one project to another.
 *
 * Almost everything on a task that is not text belongs to the project it is
 * filed in. The columns are the project's, so are the kinds of work and the
 * labels, and a cycle or a module exists inside exactly one project. Changing
 * `project_id` on its own therefore does not move a task — it produces one that
 * sits in a column its board does not have, wearing labels nothing can render.
 *
 * So the move is this: re-resolve everything scoped to the old project against
 * the new one, and drop what has no counterpart.
 *
 * Written here rather than in either caller because there are two. The
 * interface performs the move itself so the board reacts before any round trip,
 * and the server applies the same rule to a move that arrives over REST, over
 * MCP, from an import or from an automation. Two copies of a rule like this
 * drift; one copy cannot.
 *
 * What is deliberately *not* touched:
 *
 * - **The identifier.** `WEB-3` stays `WEB-3` after it moves to the API
 *   project. It is the address somebody pasted into a commit message or a chat,
 *   and an address that stops pointing at what it pointed at is worse than one
 *   whose prefix no longer matches its folder.
 * - **`parent_id` and relations.** A task may already block a task in another
 *   project — the model has always allowed that, and it is useful. Moving a
 *   task is a filing decision, not a statement about what depends on it.
 * - **Assignees.** People belong to the workspace, not to a project.
 */
import { compareOrder } from './order.ts';
import type { ID, StateGroup } from './types.ts';

/** Everything on a task that is scoped to its project. */
export interface Scoped {
  state_id: ID | null;
  type_id: ID | null;
  labels: ID[];
  cycle_id: ID | null;
  module_id: ID | null;
}

/** What one project offers, in the order it offers it. */
export interface ProjectVocabulary {
  states: { id: ID; group_key: StateGroup; sort_order: string }[];
  types: { id: ID; name: string; is_default?: number | boolean | null; sort_order: string }[];
  labels: { id: ID; name: string }[];
  /** The column the project says new work lands in, when it names one. */
  defaultStateId?: ID | null;
}

const byOrder = (a: { sort_order: string }, b: { sort_order: string }) => compareOrder(a.sort_order, b.sort_order);

/** Names are matched the way a person would match them, not the way bytes do. */
const fold = (value: string): string => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * The column the task lands in.
 *
 * By group first: a task that was in progress stays in progress, because that
 * is the fact the two projects agree on even when they disagree about what to
 * call it. "In Arbeit" and "Doing" are the same column as far as anybody
 * reading the board is concerned, and dumping every moved task into the first
 * column instead would quietly undo whatever progress it had.
 */
function landingState(group: StateGroup | undefined, to: ProjectVocabulary): ID | null {
  const ordered = [...to.states].sort(byOrder);
  const sameGroup = group ? ordered.find((state) => state.group_key === group) : undefined;
  if (sameGroup) return sameGroup.id;
  const named = to.defaultStateId && ordered.find((state) => state.id === to.defaultStateId);
  return named ? named.id : ordered[0]?.id ?? null;
}

/**
 * The kind of work it lands as.
 *
 * By name, because two projects that both have a "Bug" mean the same thing by
 * it. Otherwise whatever the project starts new work as — the same order the
 * create path uses, so a moved task and a new one agree.
 */
function landingType(name: string | undefined, to: ProjectVocabulary): ID | null {
  if (name) {
    const wanted = fold(name);
    const match = to.types.find((type) => fold(type.name) === wanted);
    if (match) return match.id;
  }
  const ordered = [...to.types].sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default) || byOrder(a, b));
  return ordered[0]?.id ?? null;
}

/**
 * What changes about a task when it is filed somewhere else.
 *
 * `project_id` is the caller's to set — this answers everything that has to
 * change *with* it.
 */
export function relocate(task: Scoped, from: ProjectVocabulary, to: ProjectVocabulary): Scoped {
  const group = from.states.find((state) => state.id === task.state_id)?.group_key;
  const typeName = from.types.find((type) => type.id === task.type_id)?.name;

  // Labels carried across by name. A label is a word a team uses, and two
  // projects that both have a "regression" mean the same word — keeping it is
  // the answer somebody expects. One with no counterpart is dropped rather
  // than created, because inventing labels in a project from a drag is a
  // bigger decision than the drag was.
  const had = new Set(
    (task.labels ?? [])
      .map((id) => from.labels.find((label) => label.id === id)?.name)
      .filter((name): name is string => !!name)
      .map(fold),
  );
  const labels = had.size ? to.labels.filter((label) => had.has(fold(label.name))).map((label) => label.id) : [];

  return {
    state_id: landingState(group, to),
    type_id: landingType(typeName, to),
    labels,
    // A cycle and a module live inside one project and have no counterpart in
    // another. Cleared rather than guessed at: a task quietly appearing in a
    // sprint nobody put it in is worse than one that arrives unplanned.
    cycle_id: null,
    module_id: null,
  };
}
