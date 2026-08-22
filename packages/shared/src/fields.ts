/**
 * Custom fields: what a value means, and how it is written down.
 *
 * Values are stored as text, one row per task-and-field pair. Text because a
 * column that holds numbers, dates, booleans and lists is a column with no
 * type at all — the field says what it means, and these functions do the two
 * conversions in one place so the client, the server and the API agree.
 */
import type { Field, FieldKind, ID } from './types.ts';

/** The id of the row holding one task's answer to one field.
 *
 * Derived from the pair rather than random: two devices answering the same
 * field while offline then write the *same* row and merge, instead of creating
 * two rows and leaving somebody to wonder which is real.
 */
export const fieldValueId = (taskId: ID, fieldId: ID): string => `${taskId}.${fieldId}`;

/** Nothing chosen, in whatever shape this kind of field expects. */
export function emptyValue(kind: FieldKind): unknown {
  switch (kind) {
    case 'multi_select': return [];
    case 'checkbox': return false;
    case 'number': return null;
    default: return '';
  }
}

/** Text on the wire → the value a form component can use. */
export function readFieldValue(kind: FieldKind, raw: string | null | undefined): any {
  if (raw === null || raw === undefined || raw === '') return emptyValue(kind);
  switch (kind) {
    case 'number': {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'checkbox':
      return raw === 'true' || raw === '1';
    case 'multi_select':
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        // A value written before the field became a multi-select is one choice.
        return [raw];
      }
    default:
      return raw;
  }
}

/** A form value → the text that is stored. `null` means "no answer". */
export function writeFieldValue(kind: FieldKind, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'multi_select': {
      const list = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
      return list.length ? JSON.stringify(list) : null;
    }
    case 'checkbox':
      return value ? 'true' : null;
    case 'number':
      return value === '' || Number.isNaN(Number(value)) ? null : String(Number(value));
    default: {
      const text = String(value).trim();
      return text ? text : null;
    }
  }
}

/**
 * The fields a task actually shows, in order.
 *
 * Every live field of the project, because a project's fields are the project's
 * questions. They used to be askable per work item type — a Bug asking for
 * steps to reproduce while a Feature did not — and that scoping went when types
 * did: a task now carries labels, of which it may have several, and "which of
 * this task's four labels decides the form" has no honest answer.
 */
export function fieldsForTask<T extends Pick<Field, 'archived' | 'sort_order'>>(fields: T[]): T[] {
  return fields
    .filter((field) => !field.archived)
    .sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : 0));
}

/** A value shown as one line of text — for a table cell, an export, an API. */
export function formatFieldValue(
  kind: FieldKind,
  raw: string | null | undefined,
  people?: Map<ID, string>,
): string {
  const value = readFieldValue(kind, raw);
  switch (kind) {
    case 'checkbox': return value ? '✓' : '';
    case 'multi_select': return (value as string[]).join(', ');
    case 'person': return people?.get(String(value)) ?? (value ? String(value) : '');
    case 'number': return value === null ? '' : String(value);
    default: return String(value ?? '');
  }
}

/* ------------------------------------------------ filtering and grouping */

/**
 * Two reserved answers, so a filter can ask a question of a field that has no
 * list of options to offer.
 *
 * `''` is safe as "nothing here": a blank answer is deleted rather than stored,
 * so no task can have it. `'*'` is safe as "something here" for a happier
 * reason — a field whose answer is literally an asterisk does, in fact, have
 * an answer, so the one collision possible gives the right result anyway.
 */
export const FIELD_EMPTY = '';
export const FIELD_ANSWERED = '*';

/**
 * The values one stored answer counts as.
 *
 * A multi-select counts as every choice it names — it belongs in each of those
 * groups and matches a filter naming any of them. Everything else is one value,
 * and a missing answer is no values at all rather than an empty-string one.
 */
export function fieldKeys(kind: FieldKind, raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return [];
  const value = readFieldValue(kind, raw);
  if (kind === 'multi_select') return (value as string[]).map(String);
  if (kind === 'checkbox') return value ? ['true'] : [];
  return value === null || value === '' ? [] : [String(value)];
}

/**
 * Does a task's answer pass this field's filter?
 *
 * Several wanted values on one field are an OR, matching every other filter in
 * this app; two fields are an AND, applied by the caller.
 */
export function fieldMatches(kind: FieldKind, raw: string | null | undefined, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const keys = fieldKeys(kind, raw);
  if (wanted.includes(FIELD_EMPTY) && !keys.length) return true;
  if (wanted.includes(FIELD_ANSWERED) && keys.length) return true;
  return keys.some((key) => wanted.includes(key));
}

/**
 * The kinds worth grouping by: the ones whose answers come from a short list
 * somebody wrote down. Grouping by a free-text field, a date or a number makes
 * one group per task, which is a list with headings in the way.
 */
export const GROUPABLE_KINDS: FieldKind[] = ['select', 'multi_select', 'checkbox', 'person'];
export const isGroupable = (kind: FieldKind): boolean => GROUPABLE_KINDS.includes(kind);

/**
 * The answers a filter can offer for a field, before the reserved two.
 * Person is missing on purpose: its choices are the workspace's members, which
 * this package does not know about.
 */
export function fieldChoices(field: Pick<Field, 'kind' | 'options'>): string[] {
  if (field.kind === 'checkbox') return ['true'];
  if (field.kind === 'select' || field.kind === 'multi_select') return field.options ?? [];
  return [];
}
