/**
 * What a reaction set becomes when a write arrives claiming to be one.
 *
 * Here rather than in the chat rules it was written for, because two entities
 * carry `reactions` in exactly the same shape and only one of them was being
 * reconciled. A message was safe; a comment was not, and nothing said so — the
 * rule lived next to the only caller that had it. `web`'s own
 * `modules/work/reaction-set.ts` has the matching note on its half: a bug in
 * one of these is a bug on comments *and* on chat, so there is one of each.
 */

/** `{ "👍": [userId, …] }` — the shape both comments and messages store. */
export type ReactionMap = Record<string, string[]>;

/**
 * The map a client sent, read as JSON or as an object, with anything that is
 * not a list of people dropped.
 *
 * Tolerant on purpose: this reads a column written by some older version of
 * this software and a body written by whatever is on the other end of the API.
 * A field it cannot make sense of means "no reactions", never a thrown write.
 */
export function parseReactions(value: unknown): ReactionMap {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ReactionMap = {};
  for (const [emoji, people] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(people)) out[emoji] = [...new Set(people.map(String))];
  }
  return out;
}

/**
 * A reaction is your own name in a list, and only yours is yours to move.
 *
 * The client sends the whole map because that is the field it holds, and a
 * field merges last-writer-wins — so two people reacting in the same moment
 * used to end with one of the two reactions, and an offline device could
 * arrive holding a map from before somebody else's. Worse, nothing stopped a
 * doctored map from removing everybody else's reactions, because "only the
 * reactions field changed" was the whole of the check.
 *
 * So the incoming map is not taken as the answer. It is read for one thing —
 * whether *this* person is on each emoji — and everybody else's entries are
 * carried across from the row as it stands. Concurrent reactions merge, and
 * the only reaction a write can move is the writer's own.
 */
export function reconcileReactions(incoming: unknown, existing: unknown, actorId: string): ReactionMap {
  const before = parseReactions(existing);
  const wanted = parseReactions(incoming);
  const merged: ReactionMap = {};
  for (const emoji of new Set([...Object.keys(before), ...Object.keys(wanted)])) {
    const others = (before[emoji] ?? []).filter((userId) => userId !== actorId);
    const people = (wanted[emoji] ?? []).includes(actorId) ? [...others, actorId] : others;
    // An emoji nobody uses any more leaves rather than lingering as an empty
    // list, so the row does not fill up with invisible entries.
    if (people.length) merged[emoji] = people;
  }
  return merged;
}
