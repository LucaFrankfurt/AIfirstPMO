/**
 * Full-text search across everything, as one function.
 *
 * The route is a thin caller and so is MCP's `search` tool; the visibility
 * rules below are the interesting part and there must be exactly one of them.
 * It used to live in `routes/search.ts`, which meant `lib/mcp.ts` imported a
 * route — see `docs/modules.md` for why a library may not reach up into one.
 */
import { all, type Row } from '../db/index.ts';
import { canSeeBudget, canSeeProject } from './repo.ts';

export interface SearchHit {
  kind: string;
  id: string;
  project_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

/**
 * FTS5 expects a query language; users type prose. We turn each word into a
 * prefix term so "des rev" already finds "Design review", and quote everything
 * so stray operators cannot blow up the query.
 */
export function toMatchQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!terms.length) return '';
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

export function searchWorkspace(workspaceId: string, userId: string, query: string, limit = 30, kinds?: string[]): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  // The kind goes into the query rather than into a filter over its result:
  // asking for pages and cutting the list afterwards means a page ranked
  // thirty-first is never seen, however few pages there are.
  const wanted = kinds?.filter(Boolean) ?? [];
  const kindClause = wanted.length ? ` AND kind IN (${wanted.map(() => '?').join(', ')})` : '';
  const rows = all<Row>(
    `SELECT kind, ref_id, project_id, title, snippet(search_index, 5, '', '', '…', 12) AS snippet, bm25(search_index) AS rank
       FROM search_index
      WHERE search_index MATCH ? AND (workspace_id = ? OR workspace_id IS NULL)${kindClause}
      ORDER BY rank LIMIT ?`,
    match, workspaceId, ...wanted, Math.min(limit * 3, 200),
  );
  // The index also holds rows belonging to no workspace: a direct conversation
  // is between two people rather than inside an organisation, and it would be
  // odd for it to be findable from one workspace and not another. Only
  // messages are ever in that state, and the membership check below is what
  // makes including them safe.
  //
  // A message's visibility is its channel's, and the index does not carry the
  // channel. Resolved in one query for the whole page of hits rather than one
  // per row — and *before* the slice, so a private conversation cannot push a
  // readable result off the end of the list either.
  const readable = visibleMessages(userId, rows.filter((row) => row.kind === 'message').map((row) => String(row.ref_id)));

  return rows
    .filter((row) => canSeeProject(userId, row.project_id)
      && (row.kind !== 'message' || readable.has(String(row.ref_id)))
      // A budget covering several projects has no single `project_id`, so the
      // clause above reads it as workspace-wide and lets it through. Asked of
      // the one function that knows the scoping rule — see `canSeeBudget`.
      && (row.kind !== 'budget' || canSeeBudget(userId, String(row.ref_id))))
    .slice(0, limit)
    .map((row) => ({
      kind: row.kind,
      id: row.ref_id,
      project_id: row.project_id ?? null,
      title: row.title || row.snippet || '',
      snippet: row.snippet ?? '',
      rank: Number(row.rank ?? 0),
    }));
}

/**
 * Which of these messages this person may read.
 *
 * The same rule the sync filter and `canSeeChannel` apply, asked once for a
 * whole page of hits. A message in a channel that has since been deleted is
 * not readable either — the join drops it.
 */
function visibleMessages(userId: string, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = all<Row>(
    `SELECT m.id, c.project_id, c.is_private, c.members
       FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE m.id IN (${placeholders}) AND c.deleted_at IS NULL`,
    ...ids,
  );
  const allowed = new Set<string>();
  for (const row of rows) {
    if (!canSeeProject(userId, row.project_id)) continue;
    if (Number(row.is_private) && !memberIds(row.members).includes(userId)) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

const memberIds = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};
