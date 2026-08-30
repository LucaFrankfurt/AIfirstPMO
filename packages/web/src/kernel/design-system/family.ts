/**
 * Which tasks may be a task's parent.
 *
 * A task tree that loops is not a tree: `A` under `B` under `A` makes a cycle,
 * and every walk over it — the breadcrumb, a roll-up, anything that asks "and
 * what is that one under" — runs until it runs out of stack. Nothing offered to
 * build one by hand until the parent became something a person could set, so
 * nothing had to say no.
 *
 * Kept apart from the store lookup, like the route parsing next door, because
 * this is the half with the edge cases and the half worth testing without a
 * browser: a task is not its own parent, nor its child's, nor its
 * grandchild's — and a tree that already loops, because two devices each made a
 * legal move offline, has to terminate rather than hang the screen that finds
 * it.
 */

/** The least a task has to say for the walk to work. */
export interface Node {
  id: string;
  parent_id: string | null;
}

/**
 * Everything at or under `rootId`, the task itself included.
 *
 * Breadth-first over a `parent → children` index rather than a filter per
 * level, so a deep tree costs one pass. `seen` is what makes an already-looped
 * tree terminate instead of spinning.
 */
export function descendants(rootId: string, tasks: Node[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parent_id) continue;
    const siblings = children.get(task.parent_id);
    if (siblings) siblings.push(task.id);
    else children.set(task.parent_id, [task.id]);
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/**
 * Whether making `parentId` the parent of `taskId` would close a loop.
 *
 * Asked from the parent's side and walking upwards, so it costs the depth of
 * the tree rather than its size — and it answers `true` for a task offered
 * itself, which is the case somebody actually clicks.
 */
export function wouldLoop(taskId: string, parentId: string | null, tasks: Node[]): boolean {
  if (!parentId) return false;
  if (parentId === taskId) return true;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  let at: string | null | undefined = parentId;
  while (at && !seen.has(at)) {
    if (at === taskId) return true;
    seen.add(at);
    at = byId.get(at)?.parent_id;
  }
  return false;
}

/**
 * The chain from the top down to this task, the task itself last.
 *
 * Bounded by `seen` for the same reason as the others: a row that arrived
 * already in a loop should draw a short breadcrumb, not freeze the sheet.
 */
export function ancestry(taskId: string, tasks: Node[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chain: string[] = [taskId];
  const seen = new Set<string>([taskId]);
  // A parent that names nothing in the list ends the walk rather than joining
  // it: an archived parent, or one in a project this screen never loaded. The
  // trail comes out short, which is true, instead of carrying an id nobody can
  // draw.
  let at = byId.get(taskId)?.parent_id;
  while (at && byId.has(at) && !seen.has(at)) {
    seen.add(at);
    chain.unshift(at);
    at = byId.get(at)!.parent_id;
  }
  return chain;
}
