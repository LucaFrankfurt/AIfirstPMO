/**
 * A question with options on it, and what the answers add up to.
 *
 * The shape is the one `kpi.ts` and `budget.ts` already use: a definition, the
 * rows that happened against it, and one pure function that compares them. The
 * server answers MCP from this and the browser draws the ballot from it, so the
 * two cannot disagree about who is winning — which they would, because
 * "winning" has at least three defensible definitions the moment a vote is
 * multiple-choice, and any two implementations would pick different ones.
 *
 * Two rules are worth reading before the code, because both are decisions
 * rather than mechanics:
 *
 * **A closed vote is closed on read, not by a clock.** Nothing runs when
 * `closes_at` passes. `status` is what somebody set and `closes_at` is what
 * they promised, and `isOpen` is the only place that combines them. A scheduled
 * job that flipped the column would need a workspace's timezone, would not have
 * run on an instance that was switched off over the weekend, and would leave
 * two sources for one fact.
 *
 * **A secret ballot is counted by the server, an open one by whoever is
 * looking.** In an open vote every device holds every vote row, so counting
 * them is exact and moves the instant somebody clicks — offline included. In a
 * secret one a device holds only its own vote, because the sync filter sends it
 * nothing else; there is nothing to count, so the figure comes from the
 * counters the write path maintains. `tallyOf` is the single place that knows
 * which, and `visibility` is the whole of the condition — a caller never has to
 * say what it can see.
 */
import { compareOrder } from '../../kernel/registry/order.ts';
import type {
  Decision, DecisionOption, DecisionVote, ID,
} from '../../kernel/registry/types.ts';

/**
 * The order the options are on the ballot.
 *
 * Here rather than in each of the two places that sort — the screen and the
 * MCP report — because they have to agree: a result read back over MCP that
 * lists the options in a different order from the ballot somebody voted on is
 * a report about a different question.
 *
 * `compareOrder` and not `localeCompare`, and that is the whole of this
 * function. A `sort_order` is a base-62 fraction, so it is only meaningful
 * compared byte for byte: locale collation sorts letters first and case
 * second, which puts `k` *before* `V` — and since `orderKey(null, null)` is
 * `V` and everything appended after it is lowercase, that read every ballot
 * back with its first option last. Worse, the screen that appends an option
 * asks the sorted list for its highest key, so it kept getting `V` and handing
 * out `k` again: five options added one at a time landed on two distinct keys
 * between them.
 *
 * The tie-break on `created_at` is kept for the rows that already have those
 * duplicated keys. It cannot be reached by anything written since, and it puts
 * the ones written before back in the order somebody typed them, which is a
 * repair without a migration.
 */
export const byBallotOrder = (
  a: Pick<DecisionOption, 'sort_order' | 'created_at'>,
  b: Pick<DecisionOption, 'sort_order' | 'created_at'>,
): number => compareOrder(a.sort_order, b.sort_order) || a.created_at - b.created_at;

/**
 * The id of the row holding one person's vote for one option.
 *
 * Derived from the three ids rather than random, for the reason
 * `fieldValueId` is: the same person voting for the same option from a phone
 * and a laptop while both are offline writes the *same* row twice and merges,
 * instead of two rows that both count.
 *
 * It also makes withdrawing a vote idempotent. Taking one back is a tombstone
 * on a known id, so a client never has to find the row first — which it could
 * not do anyway on a device that has been away.
 */
export const voteId = (decisionId: ID, optionId: ID, voterId: ID): string =>
  `${decisionId}.${optionId}.${voterId}`;

/**
 * Whether a vote can still be cast.
 *
 * `now` is passed rather than read so that a report can ask the question as of
 * some other moment, and so that a test does not have to wait.
 */
export const isOpen = (
  decision: Pick<Decision, 'status' | 'closes_at'>,
  now: number = Date.now(),
): boolean =>
  decision.status === 'open' && (decision.closes_at === null || decision.closes_at > now);

/** Why a vote is not being taken: because it was closed, or because time ran out. */
export const closedBecause = (
  decision: Pick<Decision, 'status' | 'closes_at'>,
  now: number = Date.now(),
): 'open' | 'closed' | 'expired' => {
  if (decision.status !== 'open') return 'closed';
  if (decision.closes_at !== null && decision.closes_at <= now) return 'expired';
  return 'open';
};

/** One option with what it got. */
export interface OptionCount {
  option: DecisionOption;
  /** Live votes for it. */
  votes: number;
  /**
   * Of the people who voted at all, 0–1.
   *
   * Of the *voters* rather than of the votes cast, which is the same figure in
   * a single-choice vote and the only defensible one in a multiple-choice vote:
   * "six of the eight who voted want this" is a sentence somebody can act on,
   * where "six of the nineteen ticks" is not.
   */
  share: number;
  /** Whether the person looking picked it. Known even in a secret ballot — of their own vote. */
  mine: boolean;
}

export interface DecisionResult {
  options: OptionCount[];
  /** People who voted for at least one option. */
  voters: number;
  /**
   * The options tied at the top, in the order the ballot lists them.
   *
   * A list rather than a winner, because a tie is the case a decision tool must
   * not paper over: two options on four votes each is the moment somebody has
   * to talk, and a screen that picks one of them by id order has hidden exactly
   * that. Empty when nobody has voted.
   */
  leading: OptionCount[];
  /** Whether the person looking has voted at all. */
  voted: boolean;
  /** Whether the count is the server's rather than counted here. See the file docblock. */
  counted: 'rows' | 'server';
}

/**
 * What the ballot adds up to.
 *
 * `votes` is whatever the caller holds — every live vote on an open decision,
 * and on a secret one just the viewer's own. It is never wrong to pass more
 * than is needed: a secret ballot reads its figures off the stored counters
 * either way, and only looks at the rows to answer "did I pick this".
 */
export function tallyOf(
  decision: Decision,
  options: readonly DecisionOption[],
  votes: readonly DecisionVote[],
  viewer: ID | null = null,
): DecisionResult {
  const live = votes.filter((vote) => !vote.deleted_at && vote.decision_id === decision.id);
  const mine = new Set(live.filter((vote) => viewer !== null && vote.voter_id === viewer).map((vote) => vote.option_id));
  const secret = decision.visibility === 'anonymous';

  const voters = secret
    ? Math.max(0, decision.voters)
    : new Set(live.map((vote) => vote.voter_id)).size;

  const ordered = [...options].filter((option) => !option.deleted_at);
  const counts: OptionCount[] = ordered.map((option) => {
    const count = secret
      ? Math.max(0, option.tally)
      : live.filter((vote) => vote.option_id === option.id).length;
    return {
      option,
      votes: count,
      share: voters > 0 ? count / voters : 0,
      mine: mine.has(option.id),
    };
  });

  const top = counts.reduce((best, row) => Math.max(best, row.votes), 0);
  return {
    options: counts,
    voters,
    leading: top > 0 ? counts.filter((row) => row.votes === top) : [],
    voted: mine.size > 0,
    counted: secret ? 'server' : 'rows',
  };
}

/**
 * What one more vote for `option` would leave this person having chosen.
 *
 * Here rather than in the component because it is the whole of what "single
 * choice" means, and both the screen and the write path have to agree on it:
 * picking a second option in a single-choice vote *replaces* the first, and
 * picking one you already hold takes it back. The server enforces the same
 * thing on the way in — a client that got this wrong would otherwise leave two
 * live votes from one person, and every figure above would then be wrong for
 * everybody.
 */
export function afterPicking(
  decision: Pick<Decision, 'mode'>,
  chosen: readonly ID[],
  option: ID,
): ID[] {
  if (chosen.includes(option)) return chosen.filter((id) => id !== option);
  return decision.mode === 'single' ? [option] : [...chosen, option];
}

/** Which options this person currently holds, in ballot order. */
export const chosenBy = (
  options: readonly DecisionOption[],
  votes: readonly DecisionVote[],
  viewer: ID | null,
): ID[] => {
  if (viewer === null) return [];
  const held = new Set(votes.filter((vote) => !vote.deleted_at && vote.voter_id === viewer).map((vote) => vote.option_id));
  return options.filter((option) => held.has(option.id)).map((option) => option.id);
};
