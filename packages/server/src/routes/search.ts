import { all, type Row } from '../db/index.ts';
import { requireAuth, requireWorkspace } from '../lib/auth.ts';
import { canSeeProject } from '../lib/repo.ts';
import type { Ctx, Router } from '../lib/http.ts';

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
  const rows = all<Row>(
    `SELECT kind, ref_id, project_id, title, snippet(search_index, 5, '', '', '…', 12) AS snippet, bm25(search_index) AS rank
       FROM search_index
      WHERE search_index MATCH ? AND workspace_id = ?
      ORDER BY rank LIMIT ?`,
    match, workspaceId, Math.min(limit * 3, 200),
  );
  // A message's visibility is its channel's, and the index does not carry the
  // channel. Resolved in one query for the whole page of hits rather than one
  // per row — and *before* the slice, so a private conversation cannot push a
  // readable result off the end of the list either.
  const readable = visibleMessages(userId, rows.filter((row) => row.kind === 'message').map((row) => String(row.ref_id)));

  return rows
    .filter((row) => (!kinds?.length || kinds.includes(row.kind))
      && canSeeProject(userId, row.project_id)
      && (row.kind !== 'message' || readable.has(String(row.ref_id))))
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

export function registerSearchRoutes(router: Router): void {
  router.get('/api/workspaces/:ws/search', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws);
    const query = ctx.query.get('q') ?? '';
    const kinds = ctx.query.get('kind')?.split(',').filter(Boolean);
    const limit = Math.min(Number(ctx.query.get('limit') ?? 30) || 30, 100);
    return { query, results: searchWorkspace(ctx.params.ws, auth.userId, query, limit, kinds) };
  });
}
