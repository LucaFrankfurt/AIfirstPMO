/**
 * A filter you can write down.
 *
 * `assignee = me AND priority in (urgent, high) AND state != Done` — the one
 * thing people leaving Jira ask for by name, and the reason is not expressive
 * power. It is that a filter made of dropdowns cannot be pasted into a message,
 * kept in a page, diffed against last week's, or read out loud. A filter that
 * is text can be all of those.
 *
 * **This is a surface over `Filters` and nothing more.** Every query parses to
 * the same structure the dropdowns produce, and every `Filters` prints back to
 * a query — so the text box and the menus are two views of one thing and can
 * never disagree. What that costs is honesty about the edges: `Filters` is a
 * conjunction of "is one of" and "is not one of", so `OR` between two different
 * fields is **not** expressible, and asking for it is an error with a sentence
 * explaining why rather than a query that quietly means something else.
 *
 * The other rule is that an unresolvable name is an error, not an empty set.
 * `state = Dnoe` filtering everything away is a query somebody stares at for
 * five minutes; `no state here is called "Dnoe"` is one they fix in five
 * seconds.
 */
import { PRIORITIES, STATE_GROUPS, type Filters, type Priority, type StateGroup } from '../../kernel/registry/types.ts';

/** What names mean, in this workspace, in this project. */
export interface QueryVocabulary {
  states?: { id: string; name: string; group_key?: string }[];
  people?: { id: string; name: string; email?: string | null }[];
  labels?: { id: string; name: string }[];
  cycles?: { id: string; name: string }[];
  modules?: { id: string; name: string }[];
  projects?: { id: string; key?: string | null; name: string }[];
  fields?: { id: string; name: string }[];
  /** Who `me` is. */
  meId?: string;
}

export interface QueryError {
  message: string;
  /** Where in the text, so an editor can point at it. */
  at: number;
  length: number;
}

export interface QueryResult {
  filters: Filters;
  errors: QueryError[];
}

/* ------------------------------------------------------------- the fields */

/** Every name a clause may start with, and the `Filters` key it writes. */
const FIELDS = {
  state: 'state', status: 'state',
  group: 'group', is: 'group',
  priority: 'priority', p: 'priority',
  assignee: 'assignee', assigned: 'assignee',
  label: 'label', tag: 'label',
  cycle: 'cycle', sprint: 'cycle',
  module: 'module', milestone: 'module',
  project: 'project',
  due: 'due',
  text: 'text', title: 'text', summary: 'text',
} as const;

type FilterKey = (typeof FIELDS)[keyof typeof FIELDS];

/** Which vocabulary list resolves a name for each field. */
const LOOKUP: Partial<Record<FilterKey, keyof QueryVocabulary>> = {
  state: 'states', assignee: 'people',
  label: 'labels', cycle: 'cycles', module: 'modules', project: 'projects',
};

const DUE_WORDS = new Set(['overdue', 'today', 'week', 'none']);

const fold = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/* ------------------------------------------------------------ the scanner */

interface Token { text: string; at: number; quoted: boolean }

/**
 * Words, quoted strings, operators and brackets.
 *
 * Written out rather than a regex with alternation, because the operator
 * characters are also the ones that end a word and getting that boundary wrong
 * makes `state!=Done` parse as a single word called `state!=Done`.
 */
function scan(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) { i++; continue; }

    if (char === '"' || char === "'") {
      const end = input.indexOf(char, i + 1);
      const stop = end === -1 ? input.length : end;
      out.push({ text: input.slice(i + 1, stop), at: i, quoted: true });
      i = stop + 1;
      continue;
    }

    if (char === '(' || char === ')' || char === ',') {
      out.push({ text: char, at: i, quoted: false });
      i++;
      continue;
    }

    // Two-character operators first, or `!=` scans as `!` then `=`.
    const two = input.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ text: two, at: i, quoted: false });
      i += 2;
      continue;
    }
    if ('=<>~:'.includes(char)) {
      out.push({ text: char, at: i, quoted: false });
      i++;
      continue;
    }

    let end = i;
    // `!` ends a word too, or `state!=Done` scans as one word called `state!`
    // and falls through to a text search — which is exactly the shape somebody
    // types when they are in a hurry.
    while (end < input.length && !/[\s(),=<>~:!"']/.test(input[end])) end++;
    out.push({ text: input.slice(i, end), at: i, quoted: false });
    i = end;
  }
  return out;
}

/* ------------------------------------------------------------- the parser */

const NEGATIVE = new Set(['!=', 'not in', 'not']);

export function parseQuery(input: string, vocabulary: QueryVocabulary = {}): QueryResult {
  const filters: Filters = {};
  const errors: QueryError[] = [];
  const tokens = scan(input);

  const fail = (message: string, token?: Token, text = token?.text ?? '') =>
    errors.push({ message, at: token?.at ?? 0, length: text.length || 1 });

  const add = (key: FilterKey, values: string[], negated: boolean) => {
    if (negated) {
      const not = (filters.not ??= {});
      const current = (not as Record<string, string[]>)[key] ?? [];
      (not as Record<string, string[]>)[key] = [...new Set([...current, ...values])];
    } else {
      const current = (filters as Record<string, unknown>)[key] as string[] | undefined;
      (filters as Record<string, unknown>)[key] = [...new Set([...(current ?? []), ...values])];
    }
  };

  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  while (i < tokens.length) {
    const start = next()!;
    const word = fold(start.text);

    if (word === 'and' || word === '&&') continue;
    if (word === 'or' || word === '||') {
      fail('OR between clauses is not something a saved view can hold — put the alternatives in one field instead, like `priority in (urgent, high)`', start);
      continue;
    }

    // A bare word with no operator after it is a text search, which is what
    // somebody typing into a filter box means nine times in ten.
    const key = FIELDS[word as keyof typeof FIELDS];
    const operator = peek();
    const isOperator = operator && !operator.quoted && ['=', '!=', ':', '<', '>', '<=', '>=', '~'].includes(operator.text);
    const isIn = operator && !operator.quoted && ['in', 'not'].includes(fold(operator.text));

    if (!key || (!isOperator && !isIn)) {
      filters.text = `${filters.text ? `${filters.text} ` : ''}${start.text}`;
      continue;
    }

    let negated = false;
    let op = next()!.text;
    if (fold(op) === 'not') {
      negated = true;
      const after = peek();
      if (after && fold(after.text) === 'in') { next(); op = 'not in'; } else op = '!=';
    } else if (NEGATIVE.has(op)) {
      negated = true;
    }

    // The values: one word, or a bracketed list.
    const values: Token[] = [];
    if (peek()?.text === '(') {
      next();
      while (i < tokens.length && peek()!.text !== ')') {
        const value = next()!;
        if (value.text === ',') continue;
        values.push(value);
      }
      if (peek()?.text === ')') next();
      else fail('This list is missing its closing bracket', start);
    } else if (peek()) {
      values.push(next()!);
    }

    if (!values.length) {
      fail(`\`${start.text}\` needs something after \`${op}\``, start);
      continue;
    }

    /* ---------------------------------------------------- the special ones */

    if (key === 'text') {
      filters.text = values.map((value) => value.text).join(' ');
      continue;
    }

    if (key === 'due') {
      const raw = fold(values[0].text);
      // `due < today` is what somebody types for overdue, and `due <= 7d` for
      // the coming week. The model holds four buckets rather than a date
      // comparison, so those are the four this can honestly mean.
      const word_ = raw === 'today' && (op === '<' || op === '<=') ? 'overdue'
        : /^(7d|1w|week)$/.test(raw) && (op === '<' || op === '<=' || op === '=' || op === ':') ? 'week'
          : DUE_WORDS.has(raw) ? raw : null;
      if (!word_) {
        fail(`\`due\` can be overdue, today, week or none — not "${values[0].text}". A date comparison is not something a saved view holds`, values[0]);
        continue;
      }
      filters.due = word_ as Filters['due'];
      continue;
    }

    if (key === 'priority') {
      const resolved: string[] = [];
      for (const value of values) {
        const priority = PRIORITIES.find((entry) => entry === fold(value.text));
        if (priority) resolved.push(priority);
        else fail(`\`${value.text}\` is not a priority — try ${PRIORITIES.join(', ')}`, value);
      }
      if (resolved.length) add('priority', resolved as Priority[], negated);
      continue;
    }

    if (key === 'group') {
      const resolved: string[] = [];
      for (const value of values) {
        const raw = fold(value.text);
        // `is:done` and `is:open` are what people type; neither is a group name.
        const group = raw === 'done' ? 'completed' : raw === 'open' ? 'unstarted'
          : STATE_GROUPS.find((entry) => entry === raw);
        if (group) resolved.push(group);
        else fail(`\`${value.text}\` is not a state group — try ${STATE_GROUPS.join(', ')}, or done / open`, value);
      }
      if (resolved.length) add('group', resolved as StateGroup[], negated);
      continue;
    }

    /* ------------------------------------------------------ the named ones */

    const list = (vocabulary[LOOKUP[key]!] ?? []) as { id: string; name: string; key?: string | null; email?: string | null }[];
    const resolved: string[] = [];
    for (const value of values) {
      const want = fold(value.text);

      if (key === 'assignee' && want === 'me') {
        if (vocabulary.meId) resolved.push(vocabulary.meId);
        else fail('`me` needs a signed-in person, and there is not one here', value);
        continue;
      }
      // "Nobody is on it" and "nothing is set" — the empty answer, which every
      // filter of this kind needs and no name can express.
      if (want === 'none' || want === 'empty' || want === 'nobody') {
        resolved.push('');
        continue;
      }

      const matches = list.filter((entry) => fold(entry.name) === want
        || (entry.key && fold(String(entry.key)) === want)
        || (entry.email && fold(String(entry.email)) === want)
        || entry.id === value.text);
      if (matches.length === 1) {
        resolved.push(matches[0].id);
      } else if (matches.length > 1) {
        fail(`More than one ${key} is called "${value.text}" — use its id, or rename one`, value);
      } else {
        fail(`No ${key} here is called "${value.text}"`, value);
        // Reported *and* kept. Dropping the clause would quietly widen the
        // filter — "everything except Done" becoming "everything" is a worse
        // answer than one that matches nothing and says why. It also makes the
        // round trip total: `printQuery` writes an id for a name that no longer
        // resolves, and this is what reads it back.
        resolved.push(value.text);
      }
    }
    if (resolved.length) add(key, resolved, negated);
  }

  return { filters, errors };
}

/* ------------------------------------------------------------ the printer */

/** A value that needs no quotes: no space, no bracket, no operator. */
const bare = (value: string): string => (/^[\w.@-]+$/.test(value) ? value : `"${value}"`);

const nameOf = (
  id: string,
  list: { id: string; name: string }[] | undefined,
  meId: string | undefined,
): string => {
  if (id === '') return 'none';
  if (id === meId) return 'me';
  return list?.find((entry) => entry.id === id)?.name ?? id;
};

/**
 * A `Filters` as text.
 *
 * The round trip is the point: what this prints must parse back to the same
 * filters, so the text box can show what the dropdowns did and a person can
 * edit either. A value whose name no longer resolves prints as its id, which
 * still parses — an id is always a valid name for itself.
 */
export function printQuery(filters: Filters, vocabulary: QueryVocabulary = {}): string {
  const clauses: string[] = [];

  const emit = (key: FilterKey, ids: string[] | undefined, negated: boolean) => {
    if (!ids?.length) return;
    const words = key === 'priority' || key === 'group'
      ? ids
      : ids.map((id) => nameOf(id, vocabulary[LOOKUP[key]!] as { id: string; name: string }[] | undefined, vocabulary.meId));
    const value = words.length === 1 ? bare(words[0]) : `(${words.map(bare).join(', ')})`;
    const operator = words.length === 1 ? (negated ? '!=' : '=') : (negated ? 'not in' : 'in');
    clauses.push(`${key} ${operator} ${value}`);
  };

  const ORDER: FilterKey[] = ['project', 'state', 'group', 'priority', 'assignee', 'label', 'cycle', 'module'];
  for (const key of ORDER) emit(key, (filters as Record<string, unknown>)[key] as string[], false);
  for (const key of ORDER) emit(key, (filters.not as Record<string, string[]> | undefined)?.[key], true);

  if (filters.due) clauses.push(`due = ${filters.due}`);

  // Custom fields have no syntax of their own yet: a field is named by an id
  // and printing `field.7f3a… = x` would be text nobody could read or retype.
  // They are kept in the filters and simply not printed, which the interface
  // says out loud rather than pretending the query is the whole picture.
  if (filters.text) clauses.push(`text ~ ${bare(filters.text)}`);

  return clauses.join(' AND ');
}

/** Whether a `Filters` holds anything the printer cannot show. */
export const hasUnprintable = (filters: Filters): boolean =>
  Object.values(filters.field ?? {}).some((values) => values?.length);
