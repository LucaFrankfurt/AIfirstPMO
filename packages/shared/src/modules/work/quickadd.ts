/**
 * Typing a whole task on one line.
 *
 * `Redraw the empty state !high @ada #WEB *design due:friday` files a task with
 * a priority, an assignee, a project, a label and a date, without the form
 * being opened. It is the one feature people who have used it will not give up,
 * and it costs a parser.
 *
 * **Dates need `due:`, and that is deliberate.** The obvious next step is to
 * read a bare `tomorrow` or `monday` out of the middle of a sentence, which is
 * what makes the feature magical right up until *Meeting Monday* becomes a task
 * called "Meeting" and nobody can see where the word went. A prefix is two
 * characters and never wrong. The exception is a relative offset — `+3d`, `+2w`
 * — which is not a word in any of the three languages this app speaks and so
 * cannot be eaten out of anybody's sentence.
 *
 * **A token that matches nothing stays in the title.** `!important` is a word
 * and `!urgent` is a priority; the difference is whether the vocabulary
 * recognises it, and a token silently deleted because it looked like a sigil is
 * worse than one left where it was typed.
 *
 * Everything here is pure and takes `today` as an argument, so the whole thing
 * is testable without a clock, a browser or a database — which is also why the
 * MCP `create_task` tool can use it for nothing.
 */
import { PRIORITIES, type Priority } from '../../kernel/registry/types.ts';

/** What the caller knows exists, so a token can be recognised or left alone. */
export interface Vocabulary {
  people?: { id: string; name: string }[];
  projects?: { id: string; key?: string | null; name: string }[];
  labels?: { id: string; name: string }[];
  /** `YYYY-MM-DD`. Passed in rather than read, so a test can pick a Wednesday. */
  today: string;
  /** `en`, `de`, `fr`. Anything else reads the English words. */
  locale?: string;
  /** Who "me" is, for `@me`. */
  meId?: string;
}

export type FoundKind = 'priority' | 'assignee' | 'project' | 'label' | 'due' | 'repeat';

export interface QuickAddToken {
  /** Exactly as typed, so the interface can point at it. */
  token: string;
  kind: FoundKind;
  /** What it resolved to, in words. */
  label: string;
}

export interface QuickAdd {
  /** The line with every recognised token taken out. */
  title: string;
  priority?: Priority;
  assignees: string[];
  projectId?: string;
  labels: string[];
  dueDate?: string;
  recurrence?: string;
  found: QuickAddToken[];
}

/* --------------------------------------------------------------- the words */

/** `!1` is the urgent one, the way every tool that numbers them does it. */
const PRIORITY_NUMBER: Record<string, Priority> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

const PRIORITY_WORD: Record<string, Priority> = {
  urgent: 'urgent', dringend: 'urgent', urgente: 'urgent',
  high: 'high', hoch: 'high', haute: 'high',
  medium: 'medium', mittel: 'medium', moyenne: 'medium',
  low: 'low', niedrig: 'low', basse: 'low',
  none: 'none', keine: 'none', aucune: 'none',
};

const TODAY = new Set(['today', 'heute', "aujourd'hui", 'aujourdhui']);
const TOMORROW = new Set(['tomorrow', 'morgen', 'demain']);
/** Sunday first, because `getUTCDay()` counts that way. */
const WEEKDAYS: string[][] = [
  ['sunday', 'sun', 'sonntag', 'so', 'dimanche', 'dim'],
  ['monday', 'mon', 'montag', 'mo', 'lundi', 'lun'],
  ['tuesday', 'tue', 'dienstag', 'di', 'mardi', 'mar'],
  ['wednesday', 'wed', 'mittwoch', 'mi', 'mercredi', 'mer'],
  ['thursday', 'thu', 'donnerstag', 'do', 'jeudi', 'jeu'],
  ['friday', 'fri', 'freitag', 'fr', 'vendredi', 'ven'],
  ['saturday', 'sat', 'samstag', 'sa', 'samedi', 'sam'],
];

const UNITS: Record<string, 'daily' | 'weekly' | 'monthly'> = {
  d: 'daily', day: 'daily', days: 'daily', t: 'daily', tag: 'daily', tage: 'daily', j: 'daily', jour: 'daily', jours: 'daily',
  w: 'weekly', week: 'weekly', weeks: 'weekly', woche: 'weekly', wochen: 'weekly', s: 'weekly', semaine: 'weekly', semaines: 'weekly',
  m: 'monthly', month: 'monthly', months: 'monthly', monat: 'monthly', monate: 'monthly', mois: 'monthly',
};

const DAYS_IN = { daily: 1, weekly: 7, monthly: 0 } as const;

const shift = (from: string, days: number): string => {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const addMonths = (from: string, months: number): string => {
  const date = new Date(`${from}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  // The 31st of a 30-day month otherwise lands on the 1st. Same rule as
  // `nextDueDate` in the scheduler, for the same reason.
  if (date.getUTCDate() !== day) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
};

/**
 * A date word, or nothing.
 *
 * A weekday always means the *next* one — `due:friday` typed on a Friday is
 * next Friday, not today. Somebody typing the name of today's day means the one
 * coming, or they would have typed `today`.
 */
export function readQuickDate(raw: string, today: string): string | null {
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) return Number.isNaN(Date.parse(`${word}T00:00:00Z`)) ? null : word;
  if (TODAY.has(word)) return today;
  if (TOMORROW.has(word)) return shift(today, 1);

  const relative = /^\+(\d{1,4})\s*([a-z]+)$/.exec(word);
  if (relative) {
    const unit = UNITS[relative[2]];
    const count = Number(relative[1]);
    if (!unit || !Number.isFinite(count)) return null;
    return unit === 'monthly' ? addMonths(today, count) : shift(today, count * DAYS_IN[unit]);
  }

  const index = WEEKDAYS.findIndex((names) => names.includes(word));
  if (index >= 0) {
    const from = new Date(`${today}T00:00:00Z`).getUTCDay();
    // Modulo, then `|| 7`: the first wraps the week round, the second turns
    // "zero days ahead" into next week, because `due:wednesday` typed on a
    // Wednesday means the one coming.
    const ahead = ((index - from + 7) % 7) || 7;
    return shift(today, ahead);
  }
  return null;
}

/** `weekly`, `2w`, `every 2 weeks` → what `scheduler.ts` reads, or nothing. */
export function readRepeat(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/^every\s+|^jede[nrs]?\s+|^alle\s+|^chaque\s+|^tous les\s+/, '');
  if (!text) return null;
  const direct = /^(daily|weekly|monthly|täglich|taeglich|wöchentlich|woechentlich|monatlich|quotidien|hebdomadaire|mensuel)$/.exec(text);
  if (direct) {
    const word = direct[1];
    if (/^(daily|täglich|taeglich|quotidien)$/.test(word)) return 'daily';
    if (/^(weekly|wöchentlich|woechentlich|hebdomadaire)$/.test(word)) return 'weekly';
    return 'monthly';
  }
  const counted = /^(\d{1,3})\s*([a-z]+)$/.exec(text);
  if (!counted) {
    const bare = UNITS[text];
    return bare ?? null;
  }
  const unit = UNITS[counted[2]];
  const every = Number(counted[1]);
  if (!unit || !Number.isFinite(every) || every < 1) return null;
  return every === 1 ? unit : `${unit}:${every}`;
}

/* -------------------------------------------------------------- the parser */

/** `@"Ada Lovelace"` as well as `@ada`, for the names with a space in them. */
const TOKEN = /(^|\s)([!@#*])(?:"([^"]{1,80})"|([^\s"]{1,80}))|(^|\s)(due|every|repeat|fällig|faellig|échéance|echeance):(?:"([^"]{1,40})"|([^\s"]{1,40}))|(^|\s)(\+\d{1,4}[a-z]{1,8})(?=\s|$)/gi;

const fold = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Somebody by the handle typed after `@`.
 *
 * Full name first, then the first word of it, then a run-together form — so
 * `@ada`, `@Ada`, `@"Ada Lovelace"` and `@adalovelace` all find the same
 * person. An ambiguous first name matches nobody rather than the first of them:
 * quietly assigning work to the wrong Alex is worse than not assigning it.
 */
function findPerson(handle: string, people: { id: string; name: string }[]): string | null {
  const want = fold(handle);
  const exact = people.filter((person) => fold(person.name) === want
    || fold(person.name).replace(/\s+/g, '') === want);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const first = people.filter((person) => fold(person.name).split(/\s+/)[0] === want);
  return first.length === 1 ? first[0].id : null;
}

function findProject(handle: string, projects: NonNullable<Vocabulary['projects']>): string | null {
  const want = fold(handle);
  const byKey = projects.filter((project) => project.key && fold(project.key) === want);
  if (byKey.length === 1) return byKey[0].id;
  const byName = projects.filter((project) => fold(project.name) === want
    || fold(project.name).replace(/\s+/g, '') === want);
  return byName.length === 1 ? byName[0].id : null;
}

/**
 * Read one line.
 *
 * Nothing is ever guessed: every field comes back set only if a token said so,
 * so the caller can tell "no priority was typed" from "priority none was
 * typed", and a form built on top of this can leave its own defaults alone.
 */
export function parseQuickAdd(input: string, vocabulary: Vocabulary): QuickAdd {
  const people = vocabulary.people ?? [];
  const projects = vocabulary.projects ?? [];
  const labels = vocabulary.labels ?? [];

  const result: QuickAdd = { title: '', assignees: [], labels: [], found: [] };
  const eaten: [start: number, end: number][] = [];

  for (const match of input.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    const lead = (match[1] ?? match[5] ?? match[9] ?? '').length;
    const start = at + lead;
    const whole = match[0].slice(lead);
    const take = (kind: FoundKind, label: string) => {
      result.found.push({ token: whole, kind, label });
      eaten.push([start, start + whole.length]);
    };

    // `!`, `@`, `#`, `*`
    const sigil = match[2];
    if (sigil) {
      const value = match[3] ?? match[4] ?? '';
      if (!value) continue;
      if (sigil === '!') {
        const priority = PRIORITY_NUMBER[value] ?? PRIORITY_WORD[fold(value)];
        // Not a priority we know: `!important` is a word somebody typed.
        if (!priority || !PRIORITIES.includes(priority)) continue;
        result.priority = priority;
        take('priority', priority);
      } else if (sigil === '@') {
        const id = value.toLowerCase() === 'me' && vocabulary.meId
          ? vocabulary.meId
          : findPerson(value, people);
        if (!id || result.assignees.includes(id)) continue;
        result.assignees.push(id);
        take('assignee', people.find((person) => person.id === id)?.name ?? value);
      } else if (sigil === '#') {
        const id = findProject(value, projects);
        if (!id) continue;
        result.projectId = id;
        take('project', projects.find((project) => project.id === id)?.name ?? value);
      } else {
        const want = fold(value);
        const label = labels.filter((entry) => fold(entry.name) === want
          || fold(entry.name).replace(/\s+/g, '') === want);
        if (label.length !== 1 || result.labels.includes(label[0].id)) continue;
        result.labels.push(label[0].id);
        take('label', label[0].name);
      }
      continue;
    }

    // `due:` / `every:`
    const word = match[6];
    if (word) {
      const value = match[7] ?? match[8] ?? '';
      if (/^(every|repeat)$/i.test(word)) {
        const repeat = readRepeat(value);
        if (!repeat) continue;
        result.recurrence = repeat;
        take('repeat', repeat);
      } else {
        const date = readQuickDate(value, vocabulary.today);
        if (!date) continue;
        result.dueDate = date;
        take('due', date);
      }
      continue;
    }

    // A bare `+3d`, which cannot be a word in anybody's sentence.
    const offset = match[10];
    if (offset) {
      const date = readQuickDate(offset, vocabulary.today);
      if (!date) continue;
      result.dueDate = date;
      take('due', date);
    }
  }

  // Cut from the end, so an earlier token's offsets are still true.
  let title = input;
  for (const [start, end] of eaten.slice().sort((a, b) => b[0] - a[0])) {
    title = title.slice(0, start) + title.slice(end);
  }
  result.title = title.replace(/\s{2,}/g, ' ').trim();
  return result;
}

/** The syntax, for a hint under the box. Not translated: the sigils are not words. */
export const QUICK_ADD_SYNTAX = '!high  @name  #PROJECT  *label  due:friday  every:weekly';
