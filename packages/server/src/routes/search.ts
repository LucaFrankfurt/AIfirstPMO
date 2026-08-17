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
  return rows
    .filter((row) => (!kinds?.length || kinds.includes(row.kind)) && canSeeProject(userId, row.project_id))
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
