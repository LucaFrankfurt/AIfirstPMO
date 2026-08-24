/**
 * Asking for a review, which is a thing that happens rather than a field.
 *
 * A route rather than an entity, for the reason accepting an intake is a route
 * (`entities.ts`): nothing here is a patch on a row. Nothing is stored either
 * — the review is handed back to the person who asked and lives as long as the
 * panel does. What survives is whatever they choose to apply, which goes
 * through the ordinary write path and is indistinguishable from having typed
 * it, because that is what it is.
 *
 * Three gates, and each one is a different person's decision:
 *
 *   - the operator put a key in the environment (`env.aiProvider`);
 *   - a workspace admin switched it on (`features.ai`);
 *   - the caller is a member with a writing token.
 *
 * A guest is refused before the request is built. They could not apply a word
 * of the answer, and this is the one endpoint in the app where a click spends
 * somebody's money.
 */
import { get, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth, requireWorkspace, hasRole } from '../lib/auth.ts';
import { hasFeature } from '../lib/features.ts';
import { badRequest, forbidden, notFound, HttpError, type Ctx, type Router } from '../lib/http.ts';
import { AiError } from '../lib/ai.ts';
import { byValue, enforce } from '../lib/ratelimit.ts';
import { canSeeProject } from '../lib/repo.ts';
import { reviewTask } from '../lib/review.ts';

/** Small and slow: nobody reviews ten tasks a minute by hand, and a loop does. */
const REVIEW_LIMIT = { burst: env.ai.burst, everySeconds: env.ai.everySeconds };

export function registerAiRoutes(router: Router): void {
  router.post('/api/tasks/:id/review', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');

    const task = get<Row>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
    if (!task) throw notFound('No such task');

    const workspaceId = String(task.workspace_id);
    const role = requireWorkspace(ctx, workspaceId);
    if (!hasRole(role, 'member')) throw forbidden('Guests cannot ask for a review');
    if (!canSeeProject(auth.userId, String(task.project_id))) throw notFound('No such task');

    // Both switches, and they are told apart on purpose: "nobody configured a
    // model" and "this workspace has it switched off" are different problems
    // with different people to talk to.
    if (!env.aiEnabled) throw badRequest('No model is configured on this server');
    if (!hasFeature(workspaceId, 'ai')) throw forbidden('Reviews are switched off for this workspace');

    enforce(ctx, [byValue(REVIEW_LIMIT, 'ai-review', auth.userId)]);

    try {
      return await reviewTask(task);
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      // 502 for a bad moment, 400 for a request that will never work. The
      // sentence is the model's or the adapter's, and it is shown as it is:
      // "the key was refused" is the whole of what somebody needs to hear.
      throw new HttpError(error.permanent ? 400 : 502, error.message, 'ai_failed');
    }
  });
}
