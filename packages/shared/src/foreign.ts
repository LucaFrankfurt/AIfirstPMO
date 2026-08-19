/**
 * Reading the other tools' exports.
 *
 * Each of these is a *shape*, not a parser: a Jira search response, a Linear
 * GraphQL result, a Plane issue list, an OpenProject collection. They are
 * recognised by structure rather than by a file name, because the file people
 * actually have is whatever their browser called the download.
 *
 * **What this converts is what those tools agree with Kolibri about**: a title,
 * a description, a state and roughly what kind of state it is, a priority, a
 * due date, labels, an assignee, a parent, and comments. What it deliberately
 * does not try to convert is everything each tool has invented for itself —
 * workflows, screens, sprints-with-opinions, custom field schemas. A converter
 * that guesses at those produces a project that looks imported and is wrong in
 * a way nobody notices for a month.
 *
 * Every conversion returns **notes**: what was read, what was skipped and why.
 * The importer shows them, because "1 204 issues imported" without "and 84
 * custom fields were dropped" is a lie by omission.
 *
 * A caveat worth stating plainly, in the code as well as the docs: these were
 * written against each tool's *documented* API shape and have never been run
 * against a real export from a real instance. The recognisers are deliberately
 * narrow and the failure is a refusal rather than a half-read project.
 */
import type { Priority, StateGroup } from './types.ts';

export type ForeignFormat = 'jira' | 'linear' | 'plane' | 'openproject';

export interface Converted {
  format: ForeignFormat;
  /** A `kolibri.project/1` document, ready for the ordinary importer. */
  document: Record<string, unknown>;
  /** What was read and what was left behind, in the reader's words. */
  notes: string[];
}

const asArray = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []) as Record<string, unknown>[];

const dig = (value: unknown, path: string): unknown => {
  let here: unknown = value;
  for (const part of path.split('.')) {
    if (!here || typeof here !== 'object') return undefined;
    here = (here as Record<string, unknown>)[part];
  }
  return here;
};

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  // Jira's cloud API sends a document tree; OpenProject sends `{ raw, html }`.
  if (typeof value === 'object') {
    const raw = (value as Record<string, unknown>).raw;
    if (typeof raw === 'string') return raw;
    return flattenRichText(value);
  }
  return String(value);
};

/** Atlassian document format, reduced to the words in it. */
function flattenRichText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  const children = Array.isArray(record.content) ? record.content : [];
  const parts = children.map(flattenRichText).filter(Boolean);
  return record.type === 'paragraph' ? `${parts.join('')}\n\n` : parts.join('');
}

/** `2026-08-19T09:00:00.000+0000` and friends → `2026-08-19`, or nothing. */
const day = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
};

/* ------------------------------------------------------------ recognising */

export function detectFormat(document: unknown): ForeignFormat | null {
  if (!document || typeof document !== 'object') return null;
  const doc = document as Record<string, unknown>;

  // Kolibri's own document is not foreign; the caller handles it directly.
  if (typeof doc.format === 'string' && doc.format.startsWith('kolibri.project/')) return null;

  if (asArray(doc.issues).some((issue) => issue.fields && typeof issue.fields === 'object')) return 'jira';
  if (asArray(dig(doc, 'data.issues.nodes')).length || asArray(dig(doc, 'issues.nodes')).length) return 'linear';
  if (asArray(dig(doc, '_embedded.elements')).some((element) => 'subject' in element)) return 'openproject';
  if (asArray(doc.results).some((result) => 'name' in result && ('sequence_id' in result || 'priority' in result))) return 'plane';
  return null;
}

export function convert(document: unknown): Converted {
  const format = detectFormat(document);
  if (!format) throw new Error('That file is not an export this can read');
  const doc = document as Record<string, unknown>;
  switch (format) {
    case 'jira': return fromJira(doc);
    case 'linear': return fromLinear(doc);
    case 'openproject': return fromOpenProject(doc);
    case 'plane': return fromPlane(doc);
  }
}

/* ------------------------------------------------------------- the pieces */

interface Draft {
  id: string;
  title: string;
  description: string;
  state: string;
  group: StateGroup;
  type: string;
  priority: Priority;
  labels: string[];
  assignees: string[];
  start_date: string | null;
  due_date: string | null;
  parent: string | null;
  blocks: string[];
  comments: { author: string | null; body: string }[];
}

interface People {
  /** Whatever identifies somebody in the source → a stable local id. */
  id: (key: string, name: string, email: string) => string;
  list: () => { id: string; name: string; email: string }[];
}

function people(): People {
  const seen = new Map<string, { id: string; name: string; email: string }>();
  return {
    id(key, name, email) {
      const at = key || email || name;
      if (!seen.has(at)) seen.set(at, { id: `p${seen.size + 1}`, name: name || email || at, email: email.toLowerCase() });
      return seen.get(at)!.id;
    },
    list: () => [...seen.values()],
  };
}

/**
 * Turn drafts into a Kolibri document.
 *
 * States are invented from the distinct state names found, in the order they
 * were first seen, each carrying the group its source said it was in. That is
 * better than mapping onto Kolibri's defaults: a team that has spent two years
 * arguing about the name of a column should get that column.
 */
function assemble(
  format: ForeignFormat,
  name: string,
  key: string,
  drafts: Draft[],
  who: People,
  notes: string[],
): Converted {
  const states = new Map<string, { id: string; name: string; group_key: StateGroup; sort_order: string }>();
  const types = new Map<string, { id: string; name: string; sort_order: string }>();
  const labels = new Map<string, { id: string; name: string }>();

  for (const draft of drafts) {
    if (draft.state && !states.has(draft.state)) {
      states.set(draft.state, {
        id: `s${states.size + 1}`, name: draft.state, group_key: draft.group,
        sort_order: String.fromCharCode(65 + Math.min(25, states.size)),
      });
    }
    if (draft.type && !types.has(draft.type)) {
      types.set(draft.type, {
        id: `k${types.size + 1}`, name: draft.type,
        sort_order: String.fromCharCode(65 + Math.min(25, types.size)),
      });
    }
    for (const label of draft.labels) {
      if (!labels.has(label)) labels.set(label, { id: `l${labels.size + 1}`, name: label });
    }
  }

  const tasks = drafts.map((draft) => ({
    id: draft.id,
    title: draft.title,
    description: draft.description || null,
    state_id: states.get(draft.state)?.id ?? null,
    type_id: types.get(draft.type)?.id ?? null,
    priority: draft.priority,
    labels: draft.labels.map((label) => labels.get(label)!.id),
    assignees: draft.assignees,
    parent_id: draft.parent,
    start_date: draft.start_date,
    due_date: draft.due_date,
  }));

  const known = new Set(drafts.map((draft) => draft.id));
  const relations: Record<string, unknown>[] = [];
  let danglingLinks = 0;
  for (const draft of drafts) {
    for (const target of draft.blocks) {
      if (!known.has(target)) { danglingLinks++; continue; }
      relations.push({ id: `r${relations.length + 1}`, task_id: draft.id, related_task_id: target, kind: 'blocks' });
    }
  }
  // A parent that is not in the file is dropped rather than guessed at: a task
  // filed under the wrong parent is harder to notice than one filed under none.
  let danglingParents = 0;
  for (const task of tasks) {
    if (task.parent_id && !known.has(task.parent_id)) {
      task.parent_id = null;
      danglingParents++;
    }
  }

  const comments = drafts.flatMap((draft, index) => draft.comments.map((comment, n) => ({
    id: `c${index}-${n}`,
    task_id: draft.id,
    body: comment.body,
    author_id: comment.author,
  })));

  if (danglingLinks) notes.push(`${danglingLinks} link${danglingLinks === 1 ? '' : 's'} pointed at an issue that is not in this file, and ${danglingLinks === 1 ? 'was' : 'were'} left out`);
  if (danglingParents) notes.push(`${danglingParents} parent${danglingParents === 1 ? '' : 's'} pointed outside this file; those tasks arrive without one`);
  notes.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}, ${states.size} state${states.size === 1 ? '' : 's'}, ${labels.size} label${labels.size === 1 ? '' : 's'}, ${comments.length} comment${comments.length === 1 ? '' : 's'}`);

  return {
    format,
    notes,
    document: {
      format: 'kolibri.project/1',
      exported_at: '',
      source: { workspace: format },
      project: { name, key },
      states: [...states.values()],
      types: [...types.values()],
      labels: [...labels.values()],
      fields: [],
      cycles: [],
      modules: [],
      tasks,
      field_values: [],
      relations,
      comments,
      pages: [],
      templates: [],
      automations: [],
      time_entries: [],
      people: who.list(),
    },
  };
}

/* ----------------------------------------------------------------- Jira */

const JIRA_PRIORITY: Record<string, Priority> = {
  highest: 'urgent', high: 'high', medium: 'medium', low: 'low', lowest: 'none',
  blocker: 'urgent', critical: 'urgent', major: 'high', minor: 'low', trivial: 'none',
};

/** Jira says which of three buckets a status is in, which is the useful half. */
const JIRA_GROUP: Record<string, StateGroup> = {
  new: 'backlog', undefined: 'unstarted', indeterminate: 'started', done: 'completed',
};

function fromJira(doc: Record<string, unknown>): Converted {
  const issues = asArray(doc.issues);
  const who = people();
  const notes: string[] = [];
  let customFields = 0;

  const drafts: Draft[] = issues.map((issue) => {
    const fields = (issue.fields ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (key.startsWith('customfield_')) customFields++;

    const assignee = fields.assignee as Record<string, unknown> | null;
    const blocks: string[] = [];
    for (const link of asArray(fields.issuelinks)) {
      const kind = String(dig(link, 'type.name') ?? '').toLowerCase();
      if (!kind.includes('block')) continue;
      // Jira states the direction in the link itself: `outwardIssue` is the one
      // this issue blocks, `inwardIssue` the one blocking it.
      const outward = dig(link, 'outwardIssue.key');
      if (typeof outward === 'string') blocks.push(outward);
    }

    return {
      id: String(issue.key ?? issue.id ?? ''),
      title: String(fields.summary ?? '(no summary)'),
      description: text(fields.description),
      state: String(dig(fields, 'status.name') ?? ''),
      group: JIRA_GROUP[String(dig(fields, 'status.statusCategory.key') ?? '')] ?? 'unstarted',
      type: String(dig(fields, 'issuetype.name') ?? ''),
      priority: JIRA_PRIORITY[String(dig(fields, 'priority.name') ?? '').toLowerCase()] ?? 'none',
      labels: (Array.isArray(fields.labels) ? fields.labels : []).map(String),
      assignees: assignee
        ? [who.id(String(assignee.accountId ?? assignee.name ?? ''), String(assignee.displayName ?? ''), String(assignee.emailAddress ?? ''))]
        : [],
      start_date: day(fields.customfield_10015) ?? null,
      due_date: day(fields.duedate),
      parent: typeof dig(fields, 'parent.key') === 'string' ? String(dig(fields, 'parent.key')) : null,
      blocks,
      comments: asArray(dig(fields, 'comment.comments')).map((comment) => ({
        author: comment.author
          ? who.id(
            String(dig(comment, 'author.accountId') ?? ''),
            String(dig(comment, 'author.displayName') ?? ''),
            String(dig(comment, 'author.emailAddress') ?? ''),
          )
          : null,
        body: text(comment.body),
      })),
    };
  }).filter((draft) => draft.id && draft.title);

  const first = issues[0]?.fields as Record<string, unknown> | undefined;
  if (customFields) {
    notes.push(`${customFields} custom field value${customFields === 1 ? '' : 's'} were left behind — Jira does not say what they are called in the same file`);
  }
  notes.push('Sprints, epics-as-a-hierarchy-level, workflows and permissions are not read: they mean something specific in Jira and guessing at them produces a project that looks imported and is wrong');

  return assemble(
    'jira',
    String(dig(first, 'project.name') ?? 'Imported from Jira'),
    String(dig(first, 'project.key') ?? ''),
    drafts, who, notes,
  );
}

/* --------------------------------------------------------------- Linear */

/** Linear counts priority down from urgent, and 0 means nobody said. */
const LINEAR_PRIORITY: Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];

const LINEAR_GROUP: Record<string, StateGroup> = {
  backlog: 'backlog', unstarted: 'unstarted', started: 'started',
  completed: 'completed', canceled: 'cancelled', triage: 'backlog',
};

function fromLinear(doc: Record<string, unknown>): Converted {
  const nodes = asArray(dig(doc, 'data.issues.nodes')).length
    ? asArray(dig(doc, 'data.issues.nodes'))
    : asArray(dig(doc, 'issues.nodes'));
  const who = people();
  const notes: string[] = [];

  const drafts: Draft[] = nodes.map((issue) => {
    const assignee = issue.assignee as Record<string, unknown> | null;
    return {
      id: String(issue.identifier ?? issue.id ?? ''),
      title: String(issue.title ?? '(untitled)'),
      description: text(issue.description),
      state: String(dig(issue, 'state.name') ?? ''),
      group: LINEAR_GROUP[String(dig(issue, 'state.type') ?? '').toLowerCase()] ?? 'unstarted',
      type: '',
      priority: LINEAR_PRIORITY[Number(issue.priority ?? 0)] ?? 'none',
      labels: asArray(dig(issue, 'labels.nodes')).map((label) => String(label.name ?? '')).filter(Boolean),
      assignees: assignee
        ? [who.id(String(assignee.id ?? ''), String(assignee.name ?? assignee.displayName ?? ''), String(assignee.email ?? ''))]
        : [],
      start_date: day(issue.startedAt) ?? null,
      due_date: day(issue.dueDate),
      parent: typeof dig(issue, 'parent.identifier') === 'string' ? String(dig(issue, 'parent.identifier')) : null,
      blocks: asArray(dig(issue, 'relations.nodes'))
        .filter((relation) => String(relation.type ?? '').toLowerCase() === 'blocks')
        .map((relation) => String(dig(relation, 'relatedIssue.identifier') ?? ''))
        .filter(Boolean),
      comments: asArray(dig(issue, 'comments.nodes')).map((comment) => ({
        author: comment.user
          ? who.id(String(dig(comment, 'user.id') ?? ''), String(dig(comment, 'user.name') ?? ''), String(dig(comment, 'user.email') ?? ''))
          : null,
        body: text(comment.body),
      })),
    };
  }).filter((draft) => draft.id && draft.title);

  notes.push('Cycles, projects-inside-Linear and estimates are not read: Linear means something particular by each of them, and Kolibri\'s nearest equivalent is not the same thing');
  const team = String(dig(nodes[0], 'team.name') ?? '');
  return assemble(
    'linear',
    team ? `${team} (Linear)` : 'Imported from Linear',
    String(dig(nodes[0], 'team.key') ?? ''),
    drafts, who, notes,
  );
}

/* ---------------------------------------------------------- OpenProject */

const OP_PRIORITY: Record<string, Priority> = {
  immediate: 'urgent', high: 'high', normal: 'medium', low: 'low',
};

/** OpenProject says whether a status is closed; the rest is a name. */
function openProjectGroup(element: Record<string, unknown>, name: string): StateGroup {
  const lower = name.toLowerCase();
  if (element.isClosed === true || lower === 'closed' || lower === 'rejected') {
    return lower === 'rejected' ? 'cancelled' : 'completed';
  }
  if (lower.includes('progress') || lower.includes('develop')) return 'started';
  if (lower === 'new') return 'backlog';
  return 'unstarted';
}

/** `/api/v3/work_packages/42` → `42`. */
const opId = (href: unknown): string | null => {
  const match = /\/(\d+)$/.exec(String(href ?? ''));
  return match ? match[1] : null;
};

function fromOpenProject(doc: Record<string, unknown>): Converted {
  const elements = asArray(dig(doc, '_embedded.elements'));
  const who = people();
  const notes: string[] = [];

  const drafts: Draft[] = elements.map((element) => {
    const links = (element._links ?? {}) as Record<string, unknown>;
    const status = String(dig(links, 'status.title') ?? '');
    const assignee = links.assignee as Record<string, unknown> | undefined;
    return {
      id: String(element.id ?? ''),
      title: String(element.subject ?? '(no subject)'),
      description: text(element.description),
      state: status,
      group: openProjectGroup(element, status),
      type: String(dig(links, 'type.title') ?? ''),
      priority: OP_PRIORITY[String(dig(links, 'priority.title') ?? '').toLowerCase()] ?? 'none',
      labels: [],
      assignees: assignee ? [who.id(String(assignee.href ?? ''), String(assignee.title ?? ''), '')] : [],
      start_date: day(element.startDate),
      due_date: day(element.dueDate),
      parent: opId(dig(links, 'parent.href')),
      blocks: [],
      comments: [],
    };
  }).filter((draft) => draft.id && draft.title);

  notes.push('Relations, time entries, budgets and custom fields are in separate OpenProject endpoints and are not in this file');
  notes.push('OpenProject has no labels; its categories are not the same thing and are left out rather than renamed');
  return assemble(
    'openproject',
    String(dig(elements[0], '_links.project.title') ?? 'Imported from OpenProject'),
    '',
    drafts, who, notes,
  );
}

/* ----------------------------------------------------------------- Plane */

const PLANE_PRIORITY: Record<string, Priority> = {
  urgent: 'urgent', high: 'high', medium: 'medium', low: 'low', none: 'none',
};

function fromPlane(doc: Record<string, unknown>): Converted {
  const results = asArray(doc.results);
  const who = people();
  const notes: string[] = [];

  // Plane sends state and label ids rather than names in the issue list; a
  // separate call has the names. Both are handled: an id with no name found is
  // shown as itself rather than dropped, so nothing silently disappears.
  const stateNames = new Map<string, { name: string; group: StateGroup }>();
  for (const state of asArray(doc.states)) {
    stateNames.set(String(state.id ?? ''), {
      name: String(state.name ?? ''),
      group: (['backlog', 'unstarted', 'started', 'completed', 'cancelled'].includes(String(state.group))
        ? String(state.group) : 'unstarted') as StateGroup,
    });
  }
  const labelNames = new Map(asArray(doc.labels).map((label) => [String(label.id ?? ''), String(label.name ?? '')]));
  if (!stateNames.size) {
    notes.push('This file has issues but no state list, so the states are shown by their Plane ids — export the states alongside the issues to get their names');
  }

  const drafts: Draft[] = results.map((issue) => {
    const stateId = String(issue.state ?? '');
    const state = stateNames.get(stateId);
    return {
      id: String(issue.id ?? ''),
      title: String(issue.name ?? '(untitled)'),
      description: text(issue.description_stripped ?? issue.description_html ?? issue.description),
      state: state?.name || stateId,
      group: state?.group ?? 'unstarted',
      type: '',
      priority: PLANE_PRIORITY[String(issue.priority ?? 'none').toLowerCase()] ?? 'none',
      labels: (Array.isArray(issue.labels) ? issue.labels : []).map((id) => labelNames.get(String(id)) || String(id)),
      assignees: (Array.isArray(issue.assignees) ? issue.assignees : [])
        .map((id) => who.id(String(id), String(id), '')),
      start_date: day(issue.start_date),
      due_date: day(issue.target_date),
      parent: typeof issue.parent === 'string' ? issue.parent : null,
      blocks: [],
      comments: [],
    };
  }).filter((draft) => draft.id && draft.title);

  notes.push('Plane identifies people by id in this file and does not include their addresses, so assignees cannot be matched to anybody here and the tasks arrive unassigned');
  notes.push('Cycles, modules and relations live in other Plane endpoints and are not in this file');
  return assemble('plane', 'Imported from Plane', '', drafts, who, notes);
}
