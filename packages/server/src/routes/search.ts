import { requireAuth, requireWorkspace } from '../lib/auth.ts';
import { searchWorkspace } from '../lib/search.ts';
import type { Ctx, Router } from '../lib/http.ts';

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
