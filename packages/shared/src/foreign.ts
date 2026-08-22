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

export type ForeignFormat = 'jira' | 'linear' | 'plane' | 'openproject' | 'trello' | 'todoist';

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
  // A Trello board export: cards that name the list they sit in, and the lists.
  if (asArray(doc.cards).some((card) => 'idList' in card) && Array.isArray(doc.lists)) return 'trello';
  // Todoist: items with `content` rather than a title, filed under a project.
  if (asArray(doc.items).some((item) => 'content' in item && ('project_id' in item || 'checked' in item))) return 'todoist';
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
    case 'trello': return fromTrello(doc);
    case 'todoist': return fromTodoist(doc);
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
  /** `weekly:2` and friends. Only Todoist carries one; see `scheduler.ts`. */
  recurrence?: string | null;
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
  const labels = new Map<string, { id: string; name: string }>();

  // An issue type from the other tool arrives as a label. Kolibri has one way
  // of saying what sort of thing a task is, and throwing "Bug" away because it
  // was called a type over there would lose the most useful word in the file.
  // Keyed by name, so a "Bug" type and a "bug" label become one label.
  const remember = (name: string) => {
    if (name && !labels.has(name)) labels.set(name, { id: `l${labels.size + 1}`, name });
  };

  for (const draft of drafts) {
    if (draft.state && !states.has(draft.state)) {
      states.set(draft.state, {
        id: `s${states.size + 1}`, name: draft.state, group_key: draft.group,
        sort_order: String.fromCharCode(65 + Math.min(25, states.size)),
      });
    }
    remember(draft.type);
    for (const label of draft.labels) remember(label);
  }

  const tasks = drafts.map((draft) => ({
    id: draft.id,
    title: draft.title,
    description: draft.description || null,
    state_id: states.get(draft.state)?.id ?? null,
    priority: draft.priority,
    labels: [...new Set([draft.type, ...draft.labels])]
      .map((name) => labels.get(name)?.id)
      .filter((id): id is string => !!id),
    assignees: draft.assignees,
    parent_id: draft.parent,
    start_date: draft.start_date,
    due_date: draft.due_date,
    recurrence: draft.recurrence ?? null,
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

/* --------------------------------------------------------------- Trello */

/**
 * A Trello board, exported as JSON from the board menu.
 *
 * The interesting difference from the other four: a Trello list is a *column*
 * and nothing else. It carries no notion of "this column means finished", so
 * the group has to be guessed from the name — and guessing wrong here matters,
 * because a column read as `completed` makes every card in it look done.
 *
 * So the guess is narrow and says so in the notes: a handful of words in the
 * three languages this app speaks, and `unstarted` for everything else. A
 * column called "Blocked" is not finished and is not cancelled; it is a column.
 */
const TRELLO_DONE = /^(done|complete[d]?|finished|shipped|closed|fertig|erledigt|abgeschlossen|termin[ée]|fini)\b/i;
const TRELLO_CANCELLED = /^(cancel(l)?ed|won'?t ?do|abgebrochen|verworfen|annul[ée])\b/i;
const TRELLO_BACKLOG = /^(backlog|ideas?|icebox|someday|ideen|später|id[ée]es)\b/i;

/** Trello's own colour names, for the labels people never named. */
const TRELLO_COLOUR: Record<string, string> = {
  green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red', purple: 'Purple',
  blue: 'Blue', sky: 'Sky', lime: 'Lime', pink: 'Pink', black: 'Black',
};

function fromTrello(doc: Record<string, unknown>): Converted {
  const who = people();
  const notes: string[] = [];

  const lists = new Map<string, { name: string; group: StateGroup; closed: boolean }>();
  for (const list of asArray(doc.lists)) {
    const name = String(list.name ?? '').trim() || 'List';
    lists.set(String(list.id ?? ''), {
      name,
      group: TRELLO_CANCELLED.test(name) ? 'cancelled'
        : TRELLO_DONE.test(name) ? 'completed'
          : TRELLO_BACKLOG.test(name) ? 'backlog' : 'unstarted',
      closed: list.closed === true,
    });
  }

  const members = new Map<string, { name: string; username: string }>();
  for (const member of asArray(doc.members)) {
    members.set(String(member.id ?? ''), {
      name: String(member.fullName ?? member.username ?? ''),
      username: String(member.username ?? ''),
    });
  }

  // A checklist is the closest thing Trello has to a sub-task, and Kolibri's
  // sub-tasks are whole tasks with their own state — which a three-word
  // checklist item is not. So they become a markdown checklist in the
  // description, which renders as one and can be ticked where it is read.
  const checklists = new Map<string, string[]>();
  let checklistItems = 0;
  for (const list of asArray(doc.checklists)) {
    const card = String(list.idCard ?? '');
    const items = asArray(list.checkItems)
      .map((item) => `- [${item.state === 'complete' ? 'x' : ' '}] ${String(item.name ?? '').trim()}`)
      .filter((line) => line.length > 6);
    if (!card || !items.length) continue;
    checklistItems += items.length;
    const title = String(list.name ?? '').trim();
    checklists.set(card, [...(checklists.get(card) ?? []), ...(title ? [`**${title}**`] : []), ...items]);
  }

  // Comments are actions, mixed in with every move, rename and archive.
  const comments = new Map<string, { author: string | null; body: string }[]>();
  for (const action of asArray(doc.actions)) {
    if (action.type !== 'commentCard') continue;
    const data = (action.data ?? {}) as Record<string, unknown>;
    const card = String((data.card as Record<string, unknown>)?.id ?? '');
    const body = String(data.text ?? '').trim();
    if (!card || !body) continue;
    const creator = (action.memberCreator ?? {}) as Record<string, unknown>;
    const author = creator.id
      ? who.id(String(creator.id), String(creator.fullName ?? creator.username ?? ''), '')
      : null;
    comments.set(card, [...(comments.get(card) ?? []), { author, body }]);
  }

  let archived = 0;
  const drafts: Draft[] = asArray(doc.cards).flatMap((card) => {
    // An archived card is not a task somebody is going to do. Counted and left
    // out rather than imported into a board it would clutter.
    if (card.closed === true) { archived++; return []; }
    const id = String(card.id ?? '');
    const list = lists.get(String(card.idList ?? ''));
    const extra = checklists.get(id);
    const description = [String(card.desc ?? '').trim(), ...(extra ? ['', ...extra] : [])]
      .filter((part, index) => index === 0 || part !== undefined).join('\n').trim();
    return [{
      id,
      title: String(card.name ?? '(untitled)'),
      description,
      state: list?.name ?? 'Imported',
      group: list?.group ?? 'unstarted',
      type: '',
      // Trello has no priority at all. Inventing one from a label would be a
      // guess about somebody else's convention.
      priority: 'none' as Priority,
      labels: (Array.isArray(card.labels) ? card.labels : []).map((label) => {
        const entry = label as Record<string, unknown>;
        return String(entry.name ?? '').trim() || TRELLO_COLOUR[String(entry.color ?? '')] || 'Label';
      }),
      assignees: (Array.isArray(card.idMembers) ? card.idMembers : [])
        .map((memberId) => {
          const member = members.get(String(memberId));
          return who.id(String(memberId), member?.name ?? String(memberId), '');
        }),
      start_date: day(card.start),
      due_date: day(card.due),
      parent: null,
      blocks: [],
      comments: comments.get(id) ?? [],
    }];
  }).filter((draft) => draft.id && draft.title);

  const closedLists = [...lists.values()].filter((list) => list.closed).length;
  notes.push('A Trello list is a column and says nothing about whether the work in it is finished, so the state group is guessed from the column name — check the states after importing, because a column read as "done" makes every card in it look done');
  if (checklistItems) notes.push(`${checklistItems} checklist item${checklistItems === 1 ? '' : 's'} became a markdown checklist in the description rather than sub-tasks, because a Kolibri sub-task is a whole task and a checklist item is not`);
  if (archived) notes.push(`${archived} archived card${archived === 1 ? '' : 's'} left out`);
  if (closedLists) notes.push(`${closedLists} archived list${closedLists === 1 ? '' : 's'} still appear${closedLists === 1 ? 's' : ''} as a state, because cards in them were not archived themselves`);
  notes.push('Trello has no priority, no estimates and no relations between cards, so none of those come across');
  notes.push('Attachments, cover images and Power-Up data are not in this file and are not fetched');

  return assemble('trello', String(doc.name ?? '').trim() || 'Imported from Trello', '', drafts, who, notes);
}

/* -------------------------------------------------------------- Todoist */

/**
 * Todoist, from the Sync API's JSON or a backup of it.
 *
 * The awkward part is the opposite of Trello's: Todoist has no columns at all.
 * A task is open or it is checked, so exactly two states are invented — and
 * saying that plainly in the notes is better than inventing a workflow nobody
 * asked for.
 *
 * Priorities are upside down: Todoist's `4` is its P1, the urgent one.
 */
const TODOIST_PRIORITY: Record<number, Priority> = { 4: 'urgent', 3: 'high', 2: 'medium', 1: 'none' };

/**
 * `every week`, `every 2 days`, `jeden Monat` → what `scheduler.ts` reads.
 *
 * Deliberately only the three shapes Kolibri can actually repeat on. Todoist's
 * recurrence language is far richer — `every 3rd friday`, `every workday` —
 * and a rule this cannot honour is better left off the task than approximated
 * into one that fires on the wrong day.
 */
export function todoistRecurrence(phrase: string): string | null {
  const text = phrase.toLowerCase().trim();
  if (!/^(every|each|jede[nrs]?|alle|chaque|tous les|toutes les)\b/.test(text)) return null;
  const every = Number(/\b(\d{1,3})\b/.exec(text)?.[1] ?? 1);
  if (!Number.isFinite(every) || every < 1) return null;
  const unit = /\b(day|days|tag|tage|tagen|jour|jours)\b/.test(text) ? 'daily'
    : /\b(week|weeks|woche|wochen|semaine|semaines)\b/.test(text) ? 'weekly'
      : /\b(month|months|monat|monate|monaten|mois)\b/.test(text) ? 'monthly'
        : null;
  if (!unit) return null;
  return every === 1 ? unit : `${unit}:${every}`;
}

function fromTodoist(doc: Record<string, unknown>): Converted {
  const who = people();
  const notes: string[] = [];

  const projects = new Map(asArray(doc.projects).map((project) => [String(project.id ?? ''), String(project.name ?? '')]));
  // v2 hands back label names on the item; the Sync API hands back ids.
  const labelNames = new Map(asArray(doc.labels).map((label) => [String(label.id ?? ''), String(label.name ?? '')]));

  for (const person of asArray(doc.collaborators)) {
    who.id(String(person.id ?? ''), String(person.full_name ?? ''), String(person.email ?? ''));
  }

  const notesFor = new Map<string, { author: string | null; body: string }[]>();
  for (const note of [...asArray(doc.notes), ...asArray(doc.item_notes)]) {
    const item = String(note.item_id ?? '');
    const body = String(note.content ?? '').trim();
    if (!item || !body) continue;
    const author = note.posted_uid ? who.id(String(note.posted_uid), '', '') : null;
    notesFor.set(item, [...(notesFor.get(item) ?? []), { author, body }]);
  }

  let recurring = 0;
  let unreadableRecurrence = 0;
  const drafts: Draft[] = asArray(doc.items).map((item) => {
    const due = (item.due ?? null) as Record<string, unknown> | null;
    const phrase = String(due?.string ?? '');
    const repeat = due?.is_recurring === true ? todoistRecurrence(phrase) : null;
    if (due?.is_recurring === true) {
      if (repeat) recurring++; else unreadableRecurrence++;
    }
    const done = item.checked === true || item.checked === 1 || item.is_completed === true;
    return {
      id: String(item.id ?? ''),
      title: String(item.content ?? '(untitled)'),
      description: String(item.description ?? '').trim(),
      state: done ? 'Done' : 'Open',
      group: (done ? 'completed' : 'unstarted') as StateGroup,
      type: '',
      priority: TODOIST_PRIORITY[Number(item.priority ?? 1)] ?? 'none',
      labels: (Array.isArray(item.labels) ? item.labels : [])
        .map((label) => labelNames.get(String(label)) || String(label))
        .filter(Boolean),
      assignees: item.responsible_uid ? [who.id(String(item.responsible_uid), '', '')] : [],
      start_date: null,
      due_date: day(due?.date),
      parent: item.parent_id ? String(item.parent_id) : null,
      blocks: [],
      comments: notesFor.get(String(item.id ?? '')) ?? [],
      recurrence: repeat,
    };
  }).filter((draft) => draft.id && draft.title);

  // Everything lands in one Kolibri project, so the Todoist project a task came
  // from would otherwise be lost — it becomes a label, which is the closest
  // thing that survives and can be filtered on.
  let filed = 0;
  for (const draft of drafts) {
    const item = asArray(doc.items).find((entry) => String(entry.id ?? '') === draft.id);
    const project = projects.get(String(item?.project_id ?? ''));
    if (project && !draft.labels.includes(project)) {
      draft.labels.unshift(project);
      filed++;
    }
  }

  notes.push('Todoist has no columns, so two states are invented — Open and Done — rather than a workflow nobody asked for');
  if (filed) notes.push(`Everything arrives in one project, so the ${projects.size} Todoist project${projects.size === 1 ? '' : 's'} became labels on the ${filed} task${filed === 1 ? '' : 's'} that were in them`);
  if (recurring) notes.push(`${recurring} repeating task${recurring === 1 ? '' : 's'} kept ${recurring === 1 ? 'its rule' : 'their rules'}`);
  if (unreadableRecurrence) {
    notes.push(`${unreadableRecurrence} repeating task${unreadableRecurrence === 1 ? '' : 's'} used a rule Kolibri cannot express — it repeats daily, weekly or monthly and nothing else — so ${unreadableRecurrence === 1 ? 'it arrives' : 'they arrive'} with the due date and no repeat, rather than repeating on the wrong day`);
  }
  notes.push('A due *time* is not kept: Kolibri due dates are days');
  notes.push('Reminders, sections, filters and karma are not read');

  return assemble('todoist', 'Imported from Todoist', '', drafts, who, notes);
}
