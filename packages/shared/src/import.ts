/**
 * The pure half of importing: what a column can mean, guessing which one does,
 * and reading the values people actually put in them.
 *
 * In `shared` because the mapping screen has to guess exactly what the server
 * will use. Two implementations of "is this the title column" would disagree
 * the first time somebody exported from a tool neither of us thought of.
 */
import { PRIORITIES, type Priority } from './types.ts';

/** Fields a column can be mapped onto. `skip` is the absence of a mapping. */
export const IMPORT_FIELDS = [
  'title', 'description', 'state', 'type', 'priority', 'assignee', 'labels',
  'due_date', 'start_date', 'estimate', 'external_id',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Column name → field. Anything not listed is ignored. */
export type Mapping = Record<string, ImportField>;

export interface ImportProblem {
  /** 1-based, counting the header as row 1, so it matches what a spreadsheet shows. */
  row: number;
  column?: string;
  message: string;
}

export interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  problems: ImportProblem[];
  /** The first few rows as they will land, so a dry run can be checked by eye. */
  preview: {
    title: string;
    state: string | null;
    type: string | null;
    priority: Priority;
    assignee: string | null;
    labels: string[];
    /** Already parsed — the date is the most error-prone column, so show the result. */
    due: string | null;
  }[];
}

/** More than this and the request is refused rather than run for ten minutes. */
export const MAX_ROWS = 5000;

/* ------------------------------------------------------------- guessing */

/**
 * A first guess at the mapping, so the common export needs no clicking.
 *
 * Matches on the header name in both languages and on the names the three
 * tools people are coming from actually use: Jira's `Summary`, Plane's `Name`,
 * OpenProject's `Subject`.
 */
const HEADER_HINTS: Record<ImportField, string[]> = {
  title: ['title', 'titel', 'summary', 'subject', 'name', 'aufgabe', 'task', 'issue', 'betreff', 'zusammenfassung'],
  description: ['description', 'beschreibung', 'details', 'body', 'notes', 'notizen', 'inhalt'],
  state: ['state', 'status', 'stage', 'workflow', 'zustand', 'spalte', 'column'],
  type: ['type', 'issue type', 'work item type', 'kind', 'art', 'typ', 'aufgabenart', 'vorgangsart'],
  priority: ['priority', 'priorität', 'prioritaet', 'severity', 'dringlichkeit'],
  assignee: ['assignee', 'assigned to', 'zugewiesen', 'bearbeiter', 'owner', 'verantwortlich', 'responsible'],
  labels: ['labels', 'label', 'tags', 'tag', 'components', 'schlagworte', 'kategorie', 'category'],
  due_date: ['due', 'due date', 'duedate', 'fällig', 'faellig', 'fälligkeitsdatum', 'deadline', 'finish date', 'end date'],
  start_date: ['start', 'start date', 'startdate', 'startdatum', 'beginn'],
  estimate: ['estimate', 'story points', 'points', 'schätzung', 'schaetzung', 'aufwand', 'punkte'],
  external_id: ['id', 'key', 'issue key', 'identifier', 'nummer', 'number', 'ticket'],
};

export function guessMapping(columns: string[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<ImportField>();

  for (const column of columns) {
    const name = column.trim().toLowerCase();
    for (const field of IMPORT_FIELDS) {
      // First column to claim a field wins: a file with both `Name` and
      // `Summary` should not end up mapping the second one over the first.
      if (taken.has(field)) continue;
      if (!HEADER_HINTS[field].includes(name)) continue;
      mapping[column] = field;
      taken.add(field);
      break;
    }
  }
  return mapping;
}

/* ------------------------------------------------------------ resolving */

const PRIORITY_WORDS: Record<string, Priority> = {
  urgent: 'urgent', highest: 'urgent', critical: 'urgent', blocker: 'urgent', dringend: 'urgent', kritisch: 'urgent',
  high: 'high', hoch: 'high', major: 'high', wichtig: 'high',
  medium: 'medium', mittel: 'medium', normal: 'medium', default: 'medium',
  low: 'low', niedrig: 'low', minor: 'low', gering: 'low',
  lowest: 'low', trivial: 'low',
  none: 'none', keine: 'none', '': 'none',
};

export function readPriority(value: string): Priority | null {
  const text = value.trim().toLowerCase();
  if (!text) return 'none';
  if ((PRIORITIES as readonly string[]).includes(text)) return text as Priority;
  return PRIORITY_WORDS[text] ?? null;
}

/**
 * A date, in the two formats a person actually exports.
 *
 * ISO, and the German `31.12.2026`. Deliberately **not** `01/02/2026`: that is
 * the second of January in one country and the first of February in another,
 * and an import that guesses wrong puts a deadline five weeks out silently.
 */
export function readDate(value: string): { date: string } | { error: string } {
  const text = value.trim();
  if (!text) return { date: '' };

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) return valid(iso[1], iso[2], iso[3]);

  const german = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (german) return valid(german[3], german[2].padStart(2, '0'), german[1].padStart(2, '0'));

  if (/^\d{1,2}[/]\d{1,2}[/]\d{4}$/.test(text)) {
    return { error: `"${text}" is ambiguous — is it day/month or month/day? Use YYYY-MM-DD` };
  }
  return { error: `"${text}" is not a date this understands (use YYYY-MM-DD)` };
}

function valid(year: string, month: string, day: string): { date: string } | { error: string } {
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  // Catches 2026-02-30, which `Date` would otherwise roll forward to March.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    return { error: `"${iso}" is not a real date` };
  }
  return { date: iso };
}
