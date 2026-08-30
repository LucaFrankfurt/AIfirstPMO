/**
 * Which projects a thing covers.
 *
 * Two entities are scoped this way — a cycle and a module — and they are
 * scoped identically, so this is one pair of functions rather than two. Each
 * is one of three things, and the difference is worth stating once here rather
 * than inferring it at fifteen call sites:
 *
 * | `project_id` | `projects` | Means |
 * |---|---|---|
 * | set | `[]` | That one project's own. The ordinary case |
 * | `null` | `[]` | Every project in the workspace |
 * | `null` | `[a, b]` | Exactly those projects |
 *
 * The empty list meaning *everything* rather than *nothing* is the same rule
 * `channels.members` follows, and for the same reason: writing every project
 * into every shared row would mean keeping that list correct as projects are
 * created and deleted, forever, for no gain.
 *
 * The fourth combination — an owner *and* a list — is never written. The server
 * normalises on the way in (see `projectScope`), so no reader has to decide
 * which of two fields wins.
 */

/** The scope fields, as they sit on the row or come off the wire. */
export interface ProjectScope {
  project_id?: string | null;
  projects?: string[] | null;
}

/** Does this cover that project? The one place that question is answered. */
export function coversProject(scope: ProjectScope, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  const listed = scope.projects ?? [];
  if (listed.length) return listed.includes(projectId);
  if (scope.project_id) return scope.project_id === projectId;
  return true;
}

/**
 * The canonical pair to store, from whatever a caller asked for.
 *
 * Two normalisations, both closing an ambiguity at the boundary rather than
 * leaving every reader to resolve it:
 *
 * - **A list of exactly one collapses to an owner.** `projects: ["a"]` and
 *   `project_id: "a"` describe the same thing, and storing both spellings
 *   would mean two rows that are equal and do not compare equal.
 * - **A list of two or more clears the owner.** Nothing can both belong to one
 *   project and cover three.
 *
 * Neither field given is the request for one that every project shares.
 */
export function projectScope(
  input: { project?: string | null; projects?: readonly string[] | null },
): { project_id: string | null; projects: string[] } {
  const listed = [...new Set((input.projects ?? []).filter(Boolean))];
  if (listed.length === 1) return { project_id: listed[0]!, projects: [] };
  if (listed.length > 1) return { project_id: null, projects: listed };
  return { project_id: input.project ?? null, projects: [] };
}
