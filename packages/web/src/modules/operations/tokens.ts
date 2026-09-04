/**
 * Which workspace an API token is for.
 *
 * The list of tokens showed a name, a prefix and the scopes, and nothing about
 * *where* the token points. That is not cosmetic: `createToken` pins every new
 * token to whichever workspace was open when the button was pressed, and a
 * pinned token is what decides the answer for every call that does not name a
 * workspace itself — the whole MCP surface, among others.
 *
 * So two tokens in that list, indistinguishable except by a name their owner
 * chose in a hurry, could read two different workspaces. A report built on one
 * of them quietly changed subject when it was swapped for the other: same
 * layout, same headings, other numbers, no error anywhere. This is the missing
 * half of that page.
 *
 * A pure function rather than a branch inside the component, so the three cases
 * can be held to in a test instead of by looking at them.
 */

/** Enough of a workspace to name it; the session carries more. */
export interface NamedWorkspace {
  id: string;
  name: string;
}

export type TokenScope =
  /** No default: a call that names no workspace falls back to the first membership. */
  | { kind: 'all' }
  /**
   * Defaults to a workspace this person can see, and here is its name.
   *
   * A default, measured — not a boundary. A call that names `workspace_id`
   * itself is answered for *that* workspace, and the only gate is the owner's
   * membership (`workspaceOf` in the MCP kit). So this label says where the
   * token points, never what it is confined to.
   */
  | { kind: 'named'; id: string; name: string }
  /**
   * Pinned to a workspace this person is not (or no longer) a member of.
   *
   * It stays in the list on purpose — it is still a live credential, and the
   * one thing its owner may want to do with it is revoke it. Naming it "a
   * workspace you are not in" is honest; hiding the row would be a token
   * nobody can find.
   */
  | { kind: 'other'; id: string };

export function tokenScope(
  workspaceId: string | null | undefined,
  known: readonly NamedWorkspace[],
): TokenScope {
  if (!workspaceId) return { kind: 'all' };
  const found = known.find((workspace) => workspace.id === workspaceId);
  return found ? { kind: 'named', id: found.id, name: found.name } : { kind: 'other', id: workspaceId };
}
