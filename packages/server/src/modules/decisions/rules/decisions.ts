/**
 * The rules a decision, its options and its votes live by.
 *
 * Three of them are the whole feature, and each is here rather than in a screen
 * because a client that got it wrong would corrupt the count *for everybody*,
 * not just for itself:
 *
 * **Single choice means one live vote.** Picking a second option withdraws the
 * first, here, inside the same transaction. A client does the same thing
 * optimistically so the ballot moves under the finger, but the server does not
 * take its word for it: two live votes from one person would make every share
 * on every device wrong, and nothing would report an error.
 *
 * **A closed vote refuses.** A refusal rather than a correction, which is the
 * opposite of what the budget and KPI invariants do — and the reason is that a
 * vote is not a figure being tidied up. Silently dropping one tells the person
 * they voted. `closes_at` is evaluated on the way in rather than by a clock; see
 * `isOpen` for why nothing runs when it passes.
 *
 * **The counters are recounted, never adjusted.** `decision.voters` and
 * `option.tally` are written by counting the rows, in the transaction that
 * changed one of them. Incrementing would have been cheaper and would drift the
 * first time a vote arrived twice from two devices — which is the ordinary case
 * here, not the exotic one, because the id is derived and sync replays.
 */

import {
  DECISION_MODES, DECISION_STATUS, DECISION_VISIBILITY, isOpen, voteId,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

/** A decision, read raw. Tombstoned rows come back — the callers below care. */
const decisionRow = (id: unknown): Row | undefined =>
  (id ? get<Row>(`SELECT * FROM decisions WHERE id = ?`, String(id)) : undefined);

/**
 * A ballot is taken where the work is.
 *
 * A decision that names a task takes that task's project, whatever the client
 * said. The sync filter scopes a decision by `project_id` alone, so a row whose
 * two answers disagree is a vote that reaches the people who cannot see what it
 * is about — and, worse, does not reach the ones who can.
 */
function followTaskProject(values: Record<string, unknown>, existing: Row | undefined): void {
  const taskId = (values.task_id ?? existing?.task_id) as string | null | undefined;
  if (!taskId) return;
  const task = get<Row>(`SELECT project_id FROM tasks WHERE id = ?`, String(taskId));
  if (task) values.project_id = task.project_id;
}

/** An option and a vote live where their decision lives. The `kpiTarget` rule, verbatim in shape. */
function followDecisionWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const decision = decisionRow(values.decision_id ?? existing?.decision_id);
  if (decision) values.workspace_id = decision.workspace_id;
}

function applyDecisionInvariants(
  entity: string,
  values: Record<string, unknown>,
  forced: Record<string, unknown>,
): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  const oneOf = (field: string, allowed: readonly string[], fallback: string) => {
    if (values[field] === undefined) return;
    if (!allowed.includes(String(values[field] ?? ''))) settle(field, fallback);
  };

  if (entity === 'decision') {
    oneOf('mode', DECISION_MODES, 'single');
    oneOf('visibility', DECISION_VISIBILITY, 'open');
    oneOf('status', DECISION_STATUS, 'open');
    if (values.closes_at !== undefined && values.closes_at !== null) {
      const at = Math.round(Number(values.closes_at));
      // Null rather than zero for a deadline that is not a number: zero is a
      // real instant in 1970, and `isOpen` would read it as "closed since",
      // which is the wrong way for a typo to fail.
      settle('closes_at', Number.isFinite(at) && at > 0 ? at : null);
    }
  }
}

/**
 * A vote arrives as the person casting it, or not at all.
 *
 * `voter_id` is `serverOnly`, so it is already unwritable from outside — this
 * sets it. The id check is the other half and matters as much: the id is
 * derived from the voter, so a client sending somebody else's derived id with
 * its own `voter_id` filled in here would still be writing over that person's
 * row. Refused rather than corrected, because there is no honest way to guess
 * what was meant.
 */
function guardVote(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  const decisionId = String(values.decision_id ?? existing?.decision_id ?? '');
  const optionId = String(values.option_id ?? existing?.option_id ?? '');
  const decision = decisionRow(decisionId);
  if (!decision || decision.deleted_at) throw badRequest('That decision is not here');

  if (id !== voteId(decisionId, optionId, opts.actorId)) {
    throw forbidden('A vote is written under the id of whoever casts it');
  }
  if (existing && String(existing.voter_id) !== opts.actorId) {
    throw forbidden('That vote belongs to somebody else');
  }

  const option = get<Row>(`SELECT decision_id, deleted_at FROM decision_options WHERE id = ?`, optionId);
  if (!option || option.deleted_at) throw badRequest('That option is not here');
  if (String(option.decision_id) !== decisionId) throw badRequest('That option is on another decision');

  /*
   * Withdrawing from a closed vote is refused as well as casting into one, and
   * that is deliberate rather than an oversight in the condition. A result
   * somebody can still shrink after it is quoted is not a result.
   */
  if (!isOpen({
    status: String(decision.status) as 'open' | 'closed',
    closes_at: decision.closes_at === null ? null : Number(decision.closes_at),
  })) {
    throw badRequest('That vote is closed');
  }
}

/** Every live vote for one option, and every live voter on one decision. Recounted, never adjusted. */
function recount(decisionId: string, opts: WriteOpts): void {
  const decision = decisionRow(decisionId);
  // Not for a decision that is itself on the way out: `tombstoneBallot` deletes
  // every vote on it, and counting the survivors down to zero one write at a
  // time would spend a `seq` per option to describe a row nobody will read.
  if (!decision || decision.deleted_at) return;

  for (const option of all<Row>(`SELECT id, tally FROM decision_options WHERE decision_id = ?`, decisionId)) {
    const counted = Number(get<Row>(
      `SELECT COUNT(*) AS n FROM decision_votes WHERE option_id = ? AND deleted_at IS NULL`,
      String(option.id),
    )?.n ?? 0);
    // Only when it moved: a no-op write would still take a `seq` and send every
    // option of every decision down every pull each time anybody voted.
    if (counted !== Number(option.tally)) {
      writeEntity('decisionOption', String(option.id), { tally: counted }, { ...opts, op: undefined, system: true, silent: true });
    }
  }

  const voters = Number(get<Row>(
    `SELECT COUNT(DISTINCT voter_id) AS n FROM decision_votes WHERE decision_id = ? AND deleted_at IS NULL`,
    decisionId,
  )?.n ?? 0);
  if (voters !== Number(decision.voters)) {
    writeEntity('decision', decisionId, { voters }, { ...opts, op: undefined, system: true, silent: true });
  }
}

/** In a single-choice vote, picking one option withdraws whatever else this person held. */
function withdrawOthers(vote: Row, opts: WriteOpts): void {
  const decision = decisionRow(vote.decision_id);
  if (!decision || String(decision.mode) !== 'single') return;
  const others = all<Row>(
    `SELECT id FROM decision_votes
      WHERE decision_id = ? AND voter_id = ? AND id <> ? AND deleted_at IS NULL`,
    String(vote.decision_id), String(vote.voter_id), String(vote.id),
  );
  for (const row of others) {
    writeEntity('decisionVote', String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
}

/** Deleting the question takes the ballot and everything cast on it. */
function tombstoneBallot(decision: Row, opts: WriteOpts): void {
  for (const [entity, table] of [['decisionVote', 'decision_votes'], ['decisionOption', 'decision_options']] as const) {
    for (const row of all<Row>(`SELECT id FROM ${table} WHERE decision_id = ? AND deleted_at IS NULL`, String(decision.id))) {
      writeEntity(entity, String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
    }
  }
}

/** Deleting an option takes the votes for it — they cannot be reassigned to another. */
function tombstoneVotesFor(option: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM decision_votes WHERE option_id = ? AND deleted_at IS NULL`, String(option.id))) {
    writeEntity('decisionVote', String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
}

/**
 * A task that is gone leaves the decision standing, undated from the work.
 *
 * The same direction the KPI target takes when its milestone goes, and for the
 * same reason: deleting the ticket does not unmake the choice the team took on
 * it. The decision keeps its project — `followTaskProject` already settled that
 * — so it stays where the people who voted can still read it.
 */
function detachDecisionsFrom(task: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM decisions WHERE task_id = ? AND deleted_at IS NULL`, String(task.id))) {
    writeEntity('decision', String(row.id), { task_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
}

export const decisionRules = {
  entities: ['decision', 'decisionOption', 'decisionVote', 'task'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'decision') {
      // Who asked. The one line of provenance a ballot has, and not the
      // client's to claim — the same reason an invoice records who filed it.
      if (!values.created_by) setForced('created_by', opts.actorId);
      if (!values.question) setForced('question', 'Untitled decision');
      setForced('voters', 0);
    }
    if (entity === 'decisionOption') setForced('tally', 0);
    if (entity === 'decisionVote') setForced('voter_id', opts.actorId);
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'decisionVote') guardVote(id, values, existing, opts);
  },
  invariants(entity, id, values, existing, forced) {
    applyDecisionInvariants(entity, values, forced);
    if (entity === 'decision') followTaskProject(values, existing);
    if (entity === 'decisionOption' || entity === 'decisionVote') followDecisionWorkspace(values, existing);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'decision' && row.deleted_at && !before?.deleted_at) tombstoneBallot(row, opts);
    if (entity === 'decisionOption' && row.deleted_at && !before?.deleted_at) tombstoneVotesFor(row, opts);
    if (entity === 'task' && row.deleted_at && !before?.deleted_at) detachDecisionsFrom(row, opts);
    if (entity === 'decisionVote') {
      // Order matters: withdraw first, then count what is left. The other way
      // round counts the vote this one replaces.
      if (!row.deleted_at) withdrawOthers(row, opts);
      recount(String(row.decision_id), opts);
    }
    /*
     * There is deliberately no recount for an option.
     *
     * A new one starts at zero and changes nothing underneath the others; a
     * deleted one goes through `tombstoneVotesFor`, and each of those deletions
     * recounts on its own way through here. Recounting on every option write as
     * well would recurse — `recount` writes tallies, and a tally is an option
     * write — for no figure that is not already right.
     */
  },
} satisfies EntityRule;
