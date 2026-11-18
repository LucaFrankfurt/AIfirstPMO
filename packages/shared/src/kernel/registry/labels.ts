/**
 * Which labels belong on what.
 *
 * One function rather than a comparison written at every picker, because the
 * column is newer than the rows: a label a device synced before `applies_to`
 * existed has no value at all, and that has to mean `all` everywhere or a
 * label vanishes from one menu and not the next.
 */
import type { Label, LabelScope } from './types.ts';

export const scopeOf = (label: Pick<Label, 'applies_to'>): LabelScope =>
  label.applies_to === 'tasks' || label.applies_to === 'pages' ? label.applies_to : 'all';

/** Whether a label may be offered on a task or on a page. */
export const labelApplies = (label: Pick<Label, 'applies_to'>, to: 'task' | 'page'): boolean => {
  const scope = scopeOf(label);
  return scope === 'all' || scope === (to === 'task' ? 'tasks' : 'pages');
};

/**
 * The labels a page is offered: those that apply to pages and are either
 * workspace-wide or its own project's — and whatever it already carries, so a
 * label can always be taken off again.
 *
 * Not every label in the workspace, which is what it was. Every project is
 * seeded with its own `Bug`, `Feature`, `Documentation` and `Improvement`, so
 * on the first real instance a handbook page's label menu held eight of each,
 * told apart only by a project name in grey. A page in no project is offered
 * the workspace's labels; a page in a project, that project's as well.
 */
export function labelsForPage<L extends Pick<Label, 'id' | 'project_id' | 'applies_to'>>(
  page: { project_id?: string | null; labels?: string[] | null },
  labels: readonly L[],
): L[] {
  const on = new Set(page.labels ?? []);
  return labels.filter((label) => on.has(label.id)
    || (labelApplies(label, 'page') && (!label.project_id || label.project_id === (page.project_id ?? null))));
}
