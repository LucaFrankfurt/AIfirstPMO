/**
 * Reading a task back to whoever wrote it.
 *
 * The useful half of this file is not the prompt, it is `parseReview`. A model
 * asked for JSON will sometimes send prose, sometimes JSON wearing a code
 * fence, and sometimes perfectly valid JSON with a field nobody asked for and
 * a `field: "assignee"` it has decided it may rewrite. So exactly one function
 * in this system trusts a model, it is that one, and everything downstream —
 * the route, the panel, `update()` — sees a `TaskReview` that has already been
 * argued with.
 *
 * The other half worth stating is what the prompt forbids. A review that
 * invents which export was meant, which customer complained, or which release
 * this blocks is worse than no review: it reads as confident, it is wrong, and
 * a click puts it in the description under somebody else's name. Anything the
 * task does not say has to come back as a question instead.
 */
import type { ReviewField, ReviewFinding, ReviewKind, TaskReview } from '@kolibri/shared';
import { REVIEW_FIELDS } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { AiError, modelFor, type AiRequest, type Model } from './model.ts';
import { env } from '../../kernel/platform/env.ts';

/** Long enough for a rewritten description, short enough to bound the bill. */
const MAX_TOKENS = 1500;

/** Descriptions are trimmed before they are sent. A novel is not a task. */
const MAX_DESCRIPTION = 6000;

const KINDS: ReviewKind[] = ['title', 'description', 'acceptance', 'scope', 'other'];

export const SYSTEM = `You review tasks in a project tracker, so that the next person to
open one can start work without asking anybody a question first.

Judge the task on four things:
- The title names an outcome, not a component. "Export times out on big projects" is a
  title; "Export" is not.
- Somebody who was not in the conversation can tell what to do from the description.
- The acceptance criteria are things you could check. This tracker writes them as a
  "## Acceptance" section of checkboxes under a "## Context" section.
- It is one task. Three unrelated pieces of work under one title is the finding.

Rules that matter more than the findings:
- Never invent a fact the task does not contain. If you cannot tell which export, which
  customer, or which release is meant, that is a question, not a rewrite.
- Every finding that names a field must carry the finished replacement text for it, ready
  to use unedited. Advice to write something better is not a finding.
- Say nothing about who it is assigned to, when it is due, or what it is worth in points.
- If the task is already clear, say so with an empty findings list. A review that always
  finds three things is noise.

Answer with JSON and nothing else, in this shape:
{"verdict":"clear"|"needs-work","summary":"one sentence","findings":[{"kind":"title"|"description"|"acceptance"|"scope"|"other","problem":"one sentence","field":"title"|"description"|null,"replacement":"the finished text, or null"}],"questions":["only what a person can answer"]}`;

/* --------------------------------------------------------------- the task */

/**
 * The task as the model sees it.
 *
 * Assignees, dates and estimates are left out on purpose. None of them makes a
 * task easier to understand, and every one of them is a person or a commitment
 * being sent to a company that does not need it — see `docs/security.md`.
 */
export function describeTask(row: Row): string {
  const project = get<Row>(`SELECT name FROM projects WHERE id = ?`, row.project_id);
  const state = get<Row>(`SELECT name FROM states WHERE id = ?`, row.state_id);
  const ids = ((): string[] => {
    try {
      const parsed = JSON.parse(String(row.labels ?? '[]'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  })();
  const labels = ids.length
    ? all<Row>(
      `SELECT name FROM labels WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
      ...ids,
    ).map((label) => String(label.name))
    : [];

  const description = String(row.description ?? '').trim();
  const lines = [
    `Project: ${project?.name ?? 'unknown'}`,
    `Column: ${state?.name ?? 'unknown'}`,
    ...(labels.length ? [`Labels: ${labels.join(', ')}`] : []),
    '',
    `Title: ${String(row.title ?? '')}`,
    '',
    'Description:',
    description
      ? description.slice(0, MAX_DESCRIPTION)
      : '(empty)',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------- the answer */

/** `{...}` out of a reply that may be fenced, prefaced, or both. */
function outerObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

const sentence = (value: unknown, limit: number): string =>
  (typeof value === 'string' ? value : '').trim().slice(0, limit);

/**
 * One finding, or nothing.
 *
 * A finding is dropped rather than repaired when it makes no sense: a field
 * this app will not let a review write, a replacement that is missing, a
 * replacement identical to what is already there. Dropping is the right
 * direction — a review with two findings instead of three is a smaller review,
 * and a review offering to write an empty title is a bug somebody has to
 * notice at the worst possible moment.
 */
function readFinding(raw: unknown, task: Row): ReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const problem = sentence(source.problem, 400);
  if (!problem) return null;

  const kind = KINDS.includes(source.kind as ReviewKind) ? source.kind as ReviewKind : 'other';
  const field = REVIEW_FIELDS.includes(source.field as ReviewField)
    ? source.field as ReviewField
    : undefined;
  const replacement = typeof source.replacement === 'string' ? source.replacement.trim() : '';

  // Both or neither: a finding whose button would write nothing is shown as an
  // observation instead, and a replacement with no field has nowhere to go.
  if (!field || !replacement) return { kind, problem };
  if (field === 'title' && replacement.length > 200) return { kind, problem };
  if (replacement === String(task[field] ?? '').trim()) return { kind, problem };
  return { kind, problem, field, replacement };
}

/**
 * The model's reply, argued with.
 *
 * Throws rather than returning a half-built review: a panel showing three
 * fields of a five-field answer is a bug that looks like a model being terse.
 */
export function parseReview(text: string, model: string, task: Row): TaskReview {
  const json = outerObject(text);
  if (!json) throw new AiError('The model answered with something that was not a review', false);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new AiError('The model answered with something that was not a review', false);
  }

  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .map((entry) => readFinding(entry, task))
    .filter((entry): entry is ReviewFinding => !!entry)
    .slice(0, 8);

  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((entry) => sentence(entry, 300))
    .filter(Boolean)
    .slice(0, 6);

  // The verdict is derived when it disagrees with itself. A model that finds
  // four problems and calls the task clear has answered two questions and got
  // one of them wrong; the findings are the evidence, so they win.
  const claimed = raw.verdict === 'clear' || raw.verdict === 'needs-work' ? raw.verdict : null;
  const verdict = findings.length || questions.length ? 'needs-work' : claimed ?? 'clear';

  const summary = sentence(raw.summary, 300)
    || (verdict === 'clear' ? 'This one reads clearly.' : 'A few things could be clearer.');

  return {
    verdict,
    summary,
    findings,
    questions,
    reviewed_at: Number(task.updated_at ?? 0),
    model,
  };
}

/* ------------------------------------------------------------ the whole of it */

/** Whose model answers, and under what name. See `model.ts` for who offers. */
export const reviewer = (): Model | null => modelFor(env.aiProvider);

export async function reviewTask(task: Row): Promise<TaskReview> {
  const chosen = reviewer();
  if (!chosen) throw new AiError('No model is configured', true);
  const request: AiRequest = { system: SYSTEM, user: describeTask(task), maxTokens: MAX_TOKENS };
  return parseReview(await chosen.ask(request), chosen.model, task);
}
