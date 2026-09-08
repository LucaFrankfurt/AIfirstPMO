/**
 * The ballot: the options, the bars, and the one control that casts a vote.
 *
 * One component rather than one per screen, because it appears in three places
 * — the list of open decisions, the decision's own page, and the panel on a
 * task — and a vote that looked different in each would be three chances to
 * teach three different rules about what a click does.
 *
 * Everything is computed on render from the local mirror, so it works offline
 * and cannot disagree with what MCP answers: `tallyOf` is the same function on
 * both sides. The one thing it cannot do offline is a *secret* ballot's count,
 * which is the server's — see the note on `Counted` below, which says so on the
 * screen rather than showing a number that is quietly one behind.
 */
import {
  afterPicking, byBallotOrder, chosenBy, closedBecause, isOpen, tallyOf, voteId,
  type Decision, type DecisionOption, type DecisionVote, type OptionCount,
} from '@kolibri/shared';
import { Avatar, Icon, Progress } from '../../kernel/design-system/ui';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useMe } from '../../kernel/identity/session';

/** A decision with what has been cast on it, out of the local mirror. */
export function useBallot(decisionId: string) {
  const options = useQuery(
    () => list('decisionOption', (row) => row.decision_id === decisionId).sort(byBallotOrder),
    [decisionId],
  );
  const votes = useQuery(() => list('decisionVote', (row) => row.decision_id === decisionId), [decisionId]);
  return { options, votes };
}

/**
 * Cast or withdraw, and keep single choice single on the way.
 *
 * The client does the withdrawal as well as the server, which is not the
 * duplication it looks like: the server is the one that has to be right, and
 * this is the one that has to be *immediate*. Without it a single-choice
 * ballot would show two options ticked from the click until the next pull,
 * which reads as a bug in the rule rather than as latency.
 */
export function castVote(decision: Decision, options: readonly DecisionOption[], votes: readonly DecisionVote[], me: string, optionId: string): void {
  const held = chosenBy(options, votes, me);
  const next = new Set(afterPicking(decision, held, optionId));
  for (const id of held) {
    if (!next.has(id)) remove('decisionVote', voteId(decision.id, id, me));
  }
  for (const id of next) {
    if (!held.includes(id)) {
      create('decisionVote', { decision_id: decision.id, option_id: id }, voteId(decision.id, id, me));
    }
  }
}

/** Who picked this option — in an open vote, which is the only one that has an answer. */
function Voters({ decision, option, votes }: { decision: Decision; option: DecisionOption; votes: readonly DecisionVote[] }) {
  if (decision.visibility === 'anonymous') return null;
  const people = votes
    .filter((vote) => vote.option_id === option.id)
    .map((vote) => byId('user', vote.voter_id))
    .filter((user): user is NonNullable<typeof user> => !!user);
  if (!people.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {people.map((user) => <Avatar key={user.id} user={user} size={18} />)}
    </span>
  );
}

function Option({
  decision, count, votes, disabled, onPick,
}: {
  decision: Decision;
  count: OptionCount;
  votes: readonly DecisionVote[];
  disabled: boolean;
  onPick: () => void;
}) {
  const t = useT();
  const { option, mine, share } = count;
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="ballot-pick"
          aria-pressed={mine}
          disabled={disabled}
          onClick={onPick}
          title={disabled ? t('decision.closedHint') : undefined}
        >
          {/* A round mark for one choice and a square one for several: the
              shape says how many you may hold before you have found out by
              clicking. The same convention every radio and checkbox uses. */}
          <span className={decision.mode === 'single' ? 'ballot-mark ballot-mark-one' : 'ballot-mark'}>
            {mine && <Icon name="check" size={12} />}
          </span>
          <span className="ballot-label">{option.label}</span>
        </button>
        <span className="ballot-count">{count.votes}</span>
      </div>
      {option.description && <p className="ballot-note">{option.description}</p>}
      <Progress value={Math.round(share * 100)} total={100} />
      <Voters decision={decision} option={option} votes={votes} />
    </li>
  );
}

/**
 * Where the number came from, said out loud on a secret ballot.
 *
 * A device holding a secret ballot has only its own vote, so the figures are
 * the server's and are as old as the last pull. That is worth one line under
 * the bars rather than a footnote in the manual: somebody who has just voted
 * offline and sees the bar unmoved should be told which of the two things
 * happened.
 */
function Counted({ result }: { result: { counted: 'rows' | 'server'; voters: number } }) {
  const t = useT();
  return (
    <p className="text-[12px] text-muted">
      {t('decision.turnout', { count: result.voters })}
      {result.counted === 'server' && ` · ${t('decision.countedByServer')}`}
    </p>
  );
}

export function Ballot({ decision, compact = false }: { decision: Decision; compact?: boolean }) {
  const t = useT();
  const me = useMe();
  const { options, votes } = useBallot(decision.id);
  const result = tallyOf(decision, options, votes, me);
  const open = isOpen(decision);
  const why = closedBecause(decision);

  if (!options.length) {
    return <p className="ballot-note">{t('decision.noOptions')}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <ul className="flex list-none flex-col gap-3 p-0">
        {result.options.map((count) => (
          <Option
            key={count.option.id}
            decision={decision}
            count={count}
            votes={votes}
            disabled={!open || !me}
            onPick={() => castVote(decision, options, votes, me, count.option.id)}
          />
        ))}
      </ul>
      {!compact && <Counted result={result} />}
      {why !== 'open' && (
        <p className="text-[12px] text-muted">
          {why === 'expired' ? t('decision.expired') : t('decision.closed')}
          {/* The leaders rather than the winner: two options level is the
              moment somebody has to talk, and a screen that picked one of them
              would have hidden exactly that. */}
          {result.leading.length > 0 && ` · ${result.leading.map((row) => row.option.label).join(' · ')}`}
        </p>
      )}
    </div>
  );
}
