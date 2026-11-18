/**
 * Dated entries of one recurring document, written on the server.
 *
 * The minutes of a weekly, a scorecard per week, a report per sprint: on the
 * first real wiki those were 14 pages of 77, in three places, under six naming
 * patterns and seven ways of writing a date. A series is a page whose
 * sub-pages are those entries, and this is the one place that knows what an
 * entry inherits and what it is called — MCP's `new_series_entry` and filing a
 * meeting's minutes both come here, and the app's button does the same with
 * the same shared functions (`seriesEntryTitle`, `findSeries`).
 */
import { findSeries, localDay, pageKey, seriesAbove, seriesEntryTitle, type PageFormat } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { writeEntity, type WriteOpts } from '../../kernel/write-path/repo.ts';

/** Every title in the workspace as a link would fold it, so an entry never takes one that is in use. */
const takenTitles = (workspaceId: string): Set<string> => new Set(
  all<Row>(`SELECT title FROM pages WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
    .map((row) => pageKey(String(row.title ?? ''))),
);

/** The day an entry is for, in the writer's own time zone when they have one. */
export function dayFor(at: number, actorId: string): string {
  const zone = get<Row>(`SELECT timezone FROM users WHERE id = ?`, actorId)?.timezone;
  return localDay(at, typeof zone === 'string' ? zone : null);
}

/**
 * The next entry of `series`.
 *
 * It inherits what makes it part of the series — the project, the type, the
 * labels, who may read it, the icon — and nothing about its text, which is the
 * caller's: a template, the minutes, or nothing. Copying the previous entry's
 * text was the other option and is how the first real wiki got a scorecard for
 * week 44 that was an untouched copy of week 43's.
 */
export function addSeriesEntry(
  series: Row,
  input: {
    day: string; base?: string; content?: string; format?: PageFormat; icon?: string | null; typeId?: string | null;
    /** Who may read it, when that is not the series' to decide — minutes are everybody's. */
    access?: string;
  },
  opts: WriteOpts,
): Row {
  const workspaceId = String(series.workspace_id);
  const title = seriesEntryTitle(input.base ?? String(series.title ?? ''), input.day, takenTitles(workspaceId));
  return writeEntity('page', uid(), {
    workspace_id: workspaceId,
    parent_id: String(series.id),
    project_id: series.project_id ?? null,
    type_id: input.typeId !== undefined ? input.typeId : series.type_id ?? null,
    labels: series.labels ? JSON.parse(String(series.labels)) : [],
    access: input.access ?? series.access ?? 'workspace',
    title,
    icon: input.icon !== undefined ? input.icon : series.icon ?? null,
    content: input.content ?? '',
    format: input.format ?? 'markdown',
    created_by: opts.actorId,
  }, opts).row;
}

/**
 * The series earlier entries hang under, or the one a title names, made if
 * there is neither.
 *
 * Only series everybody in the workspace can read — open, and in no project
 * or a public one: minutes are a workspace page, and filing them under
 * somebody's private page made them private to whoever filed them, under a
 * parent the rest of the workspace could not see.
 *
 * At the top level and in no project, because a meeting belongs to none — the
 * series is a page like any other afterwards, to be moved, typed and filed by
 * whoever looks after the wiki, and every later entry follows it there.
 */
export function seriesFor(
  workspaceId: string,
  wanted: { title: string; icon: string | null; earlier: string[] },
  opts: WriteOpts,
): Row {
  // Readable by everybody means in no project or in a public one as well: an
  // entry takes its series' project, and a series moved into a private project
  // would file the next minutes where only that project's members see them.
  const pages = all<Row>(
    `SELECT p.id, p.title, p.series, p.archived, p.is_template, p.created_at, p.parent_id, p.access FROM pages p
      WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.access = 'workspace'
        AND (p.project_id IS NULL
             OR EXISTS (SELECT 1 FROM projects j WHERE j.id = p.project_id AND j.visibility = 'public' AND j.deleted_at IS NULL))`,
    workspaceId,
  ).map((row) => ({
    id: String(row.id), title: String(row.title ?? ''), series: Number(row.series ?? 0),
    archived: Number(row.archived ?? 0), is_template: Number(row.is_template ?? 0), created_at: Number(row.created_at ?? 0),
    parent_id: (row.parent_id as string | null) ?? null,
  }));
  const found = seriesAbove(pages, wanted.earlier) ?? findSeries(pages, wanted.title);
  if (found) return get<Row>(`SELECT * FROM pages WHERE id = ?`, found.id)!;
  const { title, icon } = wanted;
  return writeEntity('page', uid(), {
    workspace_id: workspaceId, title, icon, series: 1, content: '', format: 'markdown',
    access: 'workspace', project_id: null, parent_id: null, created_by: opts.actorId,
  }, opts).row;
}
