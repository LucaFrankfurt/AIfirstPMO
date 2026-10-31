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
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { requireAuth, requireWorkspace, hasRole } from '../../../kernel/identity/auth.ts';
import { hasFeature } from '../../../kernel/platform/features.ts';
import { badRequest, forbidden, notFound, HttpError, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { AiError } from '../../../adapters/ai/ai.ts';
import { byValue, enforce } from '../../../kernel/identity/ratelimit.ts';
import { canSeePage, canSeeProject } from '../../../kernel/write-path/repo.ts';
import { reviewTask } from '../review.ts';
import { draftBoard } from '../board.ts';

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

  /**
   * Draw a board for a canvas, or redraw one of its boards.
   *
   * The same three gates as a review, and the canvas has to be one the caller
   * may see — its other boards are sent to the model as a reference for their
   * look, and the board being redrawn is sent whole, so this is a door to
   * their contents as much as `GET /api/artboards/:id` is. Nothing is written:
   * the draft comes back, and the client puts it on the canvas as an edit of
   * its own (see `board.ts`).
   */
  router.post('/api/pages/:id/boards/draft', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    const page = get<Row>(`SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
    if (!page) throw notFound('No such page');
    const workspaceId = String(page.workspace_id);
    const role = requireWorkspace(ctx, workspaceId);
    if (!hasRole(role, 'member')) throw forbidden('Guests cannot draw boards');
    if (!canSeePage(auth.userId, String(page.id))) throw notFound('No such page');
    if (page.format !== 'canvas') throw badRequest('That page is not a canvas');
    if (!env.aiEnabled) throw badRequest('No model is configured on this server');
    if (!hasFeature(workspaceId, 'ai')) throw forbidden('Claude is switched off for this workspace');

    const body = await readJson<{ instruction?: string; board?: string; w?: number; h?: number; match?: boolean }>(ctx);
    const instruction = String(body.instruction ?? '').trim();
    if (!instruction) throw badRequest('Say what the board should be');
    if (instruction.length > 4000) throw badRequest('That is longer than a description needs to be');

    const boards = all<Row>(
      `SELECT id, title, kind, content, w, h FROM artboards WHERE page_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
      String(page.id),
    );
    const current = body.board ? boards.find((one) => one.id === body.board) : undefined;
    if (body.board && (!current || current.kind !== 'html')) throw notFound('No such board on this canvas');
    const size = (value: unknown, fallback: number, low: number, high: number): number => {
      const number = Math.round(Number(value));
      return Number.isFinite(number) && number > 0 ? Math.min(high, Math.max(low, number)) : fallback;
    };

    // Checked after the request is known to be sound, so a malformed one does
    // not spend somebody's allowance.
    enforce(ctx, [byValue(REVIEW_LIMIT, 'ai-board', auth.userId)]);

    try {
      return await draftBoard({
        instruction,
        canvas: String(page.title ?? ''),
        w: size(body.w, Number(current?.w ?? 1280), 240, 2400),
        h: size(body.h, Number(current?.h ?? 800), 240, 4000),
        current: current ? String(current.content ?? '') : null,
        // Two at most, and never the one being redrawn: enough to show a look,
        // and every board sent is somebody's content leaving the building.
        references: body.match === false ? [] : boards
          .filter((one) => one.kind === 'html' && one.id !== current?.id && String(one.content ?? '').trim())
          .slice(0, 2)
          .map((one) => ({ title: String(one.title ?? ''), html: String(one.content ?? '') })),
      });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      throw new HttpError(error.permanent ? 400 : 502, error.message, 'ai_failed');
    }
  });
}
