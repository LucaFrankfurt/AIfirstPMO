/**
 * Questions the team is being asked, and what it answered.
 *
 * The one thing worth reading before the tools: `decision_result` reports a
 * secret ballot's counts and never its voters, and it does that by asking
 * `tallyOf` — the same function the browser draws the bars with — rather than
 * by remembering to leave a field out. An assistant that could list who voted
 * in a secret ballot would have broken the promise the ballot was cast under,
 * and a rule enforced by remembering is a rule that gets forgotten in the next
 * tool somebody adds.
 */
import {
  DECISION_MODES, DECISION_VISIBILITY, byBallotOrder, closedBecause, isOpen, orderKey, tallyOf, voteId,
  type Decision, type DecisionOption, type DecisionVote,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { canSeeProject, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import {
  findProject, findTask, McpError, requireFeature, requireWrite, str,
  type McpCtx, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

const asDecision = (row: Row): Decision => serialize('decision', row) as unknown as Decision;
const asOption = (row: Row): DecisionOption => serialize('decisionOption', row) as unknown as DecisionOption;
const asVote = (row: Row): DecisionVote => serialize('decisionVote', row) as unknown as DecisionVote;

/** Every decision this caller may see: the project rule, and nothing else. */
const visibleDecisions = (workspaceId: string, ctx: McpCtx): Row[] =>
  all<Row>(`SELECT * FROM decisions WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, workspaceId)
    .filter((row) => !row.project_id || canSeeProject(ctx.auth.userId, String(row.project_id)));

function findDecision(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const wanted = ref.trim().toLowerCase();
  const found = visibleDecisions(workspaceId, ctx)
    .find((row) => row.id === ref || String(row.question).toLowerCase() === wanted);
  if (!found) throw new McpError(`No decision "${ref}" in this workspace`);
  return found;
}

const optionsOf = (decisionId: string): DecisionOption[] =>
  all<Row>(`SELECT * FROM decision_options WHERE decision_id = ? AND deleted_at IS NULL`, decisionId)
    .map(asOption)
    .sort(byBallotOrder);

const votesOf = (decisionId: string): DecisionVote[] =>
  all<Row>(`SELECT * FROM decision_votes WHERE decision_id = ? AND deleted_at IS NULL`, decisionId).map(asVote);

/**
 * One decision as an assistant reads it.
 *
 * The names come off the votes only when the ballot is open, and `tallyOf`
 * decides the numbers either way. A secret ballot answers `voters: null` rather
 * than an empty list — "nobody voted" and "you may not know who" are different
 * facts and an empty array says the first one.
 */
function decisionReport(row: Row, viewer: string) {
  const decision = asDecision(row);
  const options = optionsOf(decision.id);
  const votes = votesOf(decision.id);
  const result = tallyOf(decision, options, votes, viewer);
  const secret = decision.visibility === 'anonymous';
  const nameOf = (userId: string) => String(get<Row>(`SELECT name FROM users WHERE id = ?`, userId)?.name ?? userId);

  return {
    id: decision.id,
    question: decision.question,
    description: decision.description,
    mode: decision.mode,
    visibility: decision.visibility,
    state: closedBecause(decision),
    closes_at: decision.closes_at,
    project_id: decision.project_id,
    task_id: decision.task_id,
    turnout: result.voters,
    options: result.options.map((count) => ({
      id: count.option.id,
      label: count.option.label,
      description: count.option.description,
      votes: count.votes,
      share_pct: Math.round(count.share * 100),
      voters: secret ? null : votes.filter((vote) => vote.option_id === count.option.id).map((vote) => nameOf(vote.voter_id)),
    })),
    /* A list, not a winner: two options level is the moment somebody has to
       talk, and reporting one of them would hide exactly that. */
    leading: result.leading.map((count) => count.option.label),
  };
}

export const decisionTools: ToolDef[] = [
  {
    name: 'list_decisions',
    title: 'List decisions',
    description:
      'Every decision in the workspace with where it stands: what is being asked, how many may be '
      + 'picked, whether the ballot is secret, and who is leading. `state` is the answer — "open" '
      + 'still takes votes, "expired" means the deadline passed and nobody closed it, "closed" '
      + 'means somebody did. An expired vote is not a decision nobody made; it is one nobody '
      + 'wrote down, which is worth saying differently.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only decisions taken in this project, by key, id or name' },
        task: { type: 'string', description: 'Only decisions about this task, by identifier or id' },
        state: { type: 'string', enum: ['open', 'closed', 'expired'], description: 'Only decisions in this state' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'decisions');

      let rows = visibleDecisions(workspaceId, ctx);
      if (args.project) {
        const project = findProject(String(args.project), workspaceId, ctx);
        rows = rows.filter((row) => String(row.project_id ?? '') === String(project.id));
      }
      if (args.task) {
        const task = findTask(String(args.task), workspaceId, ctx);
        rows = rows.filter((row) => String(row.task_id ?? '') === String(task.id));
      }

      const reports = rows.map((row) => decisionReport(row, ctx.auth.userId));
      const wanted = str(args.state);
      return {
        decisions: wanted ? reports.filter((report) => report.state === wanted) : reports,
        open: reports.filter((report) => report.state === 'open').length,
      };
    },
  },
  {
    name: 'decision_result',
    title: 'One decision in full',
    description:
      'One decision with every option, its count and its share of the people who voted. `share_pct` '
      + 'is of the voters rather than of the ticks, which is the same figure in a single-choice '
      + 'vote and the only readable one when several may be picked. `voters` on an option lists who '
      + 'chose it, and is null — not empty — when the ballot is secret: that is a fact you may not '
      + 'have, not an option nobody wanted. `leading` is a list because a tie is the finding.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'Its id, or the question verbatim' },
        workspace_id: { type: 'string' },
      },
      required: ['decision'],
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'decisions');
      return decisionReport(findDecision(String(args.decision), workspaceId, ctx), ctx.auth.userId);
    },
  },
  {
    name: 'create_decision',
    title: 'Ask the team something',
    description:
      'A question with at least two options. `mode` is whether one option may be held or several; '
      + '`visibility` "anonymous" is a secret ballot, and it cannot be turned back afterwards once '
      + 'anybody has voted — votes cast on that promise would be published by the change. '
      + '`closes_at` is epoch milliseconds and optional; nothing runs when it passes, the vote '
      + 'simply stops being taken.',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'At least two, in ballot order' },
        description: { type: 'string' },
        mode: { type: 'string', enum: [...DECISION_MODES] },
        visibility: { type: 'string', enum: [...DECISION_VISIBILITY] },
        closes_at: { type: 'number', description: 'Epoch milliseconds' },
        project: { type: 'string', description: 'Where it is taken, by key, id or name' },
        task: { type: 'string', description: 'The task it is about, by identifier or id' },
        workspace_id: { type: 'string' },
      },
      required: ['question', 'options'],
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'decisions');
      requireWrite(ctx, workspaceId);

      const labels = (Array.isArray(args.options) ? args.options : []).map((one: unknown) => String(one).trim()).filter(Boolean);
      if (labels.length < 2) throw new McpError('A decision needs at least two options');

      const task = args.task ? findTask(String(args.task), workspaceId, ctx) : null;
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const opts = writeOpts(workspaceId, ctx);
      const id = uid();
      writeEntity('decision', id, {
        question: String(args.question).trim(),
        description: str(args.description) ?? null,
        mode: str(args.mode) ?? 'single',
        visibility: str(args.visibility) ?? 'open',
        status: 'open',
        closes_at: typeof args.closes_at === 'number' ? args.closes_at : null,
        task_id: task ? task.id : null,
        project_id: task ? task.project_id : (project?.id ?? null),
        sort_order: orderKey(),
      }, opts);

      let previous: string | null = null;
      for (const label of labels) {
        previous = orderKey(previous, null);
        writeEntity('decisionOption', uid(), { decision_id: id, label, description: null, sort_order: previous }, opts);
      }
      return decisionReport(get<Row>(`SELECT * FROM decisions WHERE id = ?`, id)!, ctx.auth.userId);
    },
  },
  {
    name: 'cast_vote',
    title: 'Vote',
    description:
      'Cast a vote for one option, as whoever this token belongs to — never as somebody else. '
      + 'Picking a second option in a single-choice vote withdraws the first; picking one already '
      + 'held withdraws it. A closed or expired vote is refused rather than quietly dropped, '
      + 'including a withdrawal: a result somebody can still shrink after it is quoted is not a '
      + 'result.',
    schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'Its id, or the question verbatim' },
        option: { type: 'string', description: 'The option id, or its label verbatim' },
        workspace_id: { type: 'string' },
      },
      required: ['decision', 'option'],
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'decisions');
      requireWrite(ctx, workspaceId);

      const row = findDecision(String(args.decision), workspaceId, ctx);
      const decision = asDecision(row);
      if (!isOpen(decision)) throw new McpError('That vote is closed');

      const wanted = String(args.option).trim().toLowerCase();
      const option = optionsOf(decision.id).find((one) => one.id === String(args.option) || one.label.toLowerCase() === wanted);
      if (!option) throw new McpError(`No option "${args.option}" on that decision`);

      const opts = writeOpts(workspaceId, ctx);
      const id = voteId(decision.id, option.id, ctx.auth.userId);
      const held = get<Row>(`SELECT deleted_at FROM decision_votes WHERE id = ?`, id);
      if (held && !held.deleted_at) {
        writeEntity('decisionVote', id, {}, { ...opts, op: 'delete' });
      } else {
        writeEntity('decisionVote', id, { decision_id: decision.id, option_id: option.id }, opts);
      }
      return decisionReport(get<Row>(`SELECT * FROM decisions WHERE id = ?`, decision.id)!, ctx.auth.userId);
    },
  },
  {
    name: 'close_decision',
    title: 'Close or reopen a decision',
    description:
      'Stop a vote being taken, or take it up again. Closing is what turns a ballot into a record: '
      + 'the options, the counts and who is leading stay readable, and nothing more can be cast. '
      + 'Reopening is offered because a vote closed by a deadline nobody meant is the ordinary '
      + 'mistake here.',
    schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'Its id, or the question verbatim' },
        open: { type: 'boolean', description: 'True reopens it. Default is to close it' },
        workspace_id: { type: 'string' },
      },
      required: ['decision'],
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'decisions');
      requireWrite(ctx, workspaceId);

      const row = findDecision(String(args.decision), workspaceId, ctx);
      const reopening = args.open === true;
      writeEntity('decision', String(row.id), {
        status: reopening ? 'open' : 'closed',
        // Reopening a vote the clock closed has to move the clock too, or it
        // reopens for as long as it takes to read the answer back.
        ...(reopening && row.closes_at !== null && Number(row.closes_at) <= Date.now() ? { closes_at: null } : {}),
      }, writeOpts(workspaceId, ctx));
      return decisionReport(get<Row>(`SELECT * FROM decisions WHERE id = ?`, row.id)!, ctx.auth.userId);
    },
  },
];
