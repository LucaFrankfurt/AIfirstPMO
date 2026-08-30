/**
 * What a reaction set becomes when somebody clicks an emoji.
 *
 * Separate from the component that draws it because this is the part with a
 * decision in it, and because it now answers for two surfaces at once: a bug
 * here is a bug on comments *and* on chat. It is a plain function for the same
 * reason `family.ts` and `task-stack.ts` are — it can be checked without a DOM.
 */

/** `{ "👍": [userId, …] }`, the shape both comments and messages store. */
export type Reacted = Record<string, string[]>;

/** The handful worth having on a work tool. A full picker is a different product. */
export const REACTIONS = ['👍', '🎉', '👀', '🙏', '😄', '🤔'] as const;

/**
 * Toggle one person's reaction, and hand back a new set.
 *
 * The emoji nobody uses any more is **deleted rather than left as an empty
 * list**. Kept, it is invisible in the row and permanent in the row's JSON, so
 * a message reacted to and un-reacted to a few times carries a growing record
 * of reactions that are not there.
 */
export function nextReactions(reactions: Reacted | null | undefined, emoji: string, me: string): Reacted {
  const current = reactions ?? {};
  const people = current[emoji] ?? [];
  const next: Reacted = {
    ...current,
    [emoji]: people.includes(me) ? people.filter((who) => who !== me) : [...people, me],
  };
  if (!next[emoji].length) delete next[emoji];
  return next;
}
