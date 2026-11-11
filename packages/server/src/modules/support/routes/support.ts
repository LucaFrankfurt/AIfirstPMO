/**
 * The team's side of support, beyond the rows sync already carries.
 *
 * Three things that are not a patch on a row: the widget's secret, which is
 * handed over on request and never synced; making a task out of a
 * conversation, which creates and numbers one; and "typing", which is not
 * stored at all.
 */
import { visitorLabel, type Conversation } from '@kolibri/shared';
import { get, run, type Row } from '../../../kernel/platform/db/index.ts';
import { HttpError, badRequest, forbidden, notFound, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { token, uid } from '../../../kernel/platform/ids.ts';
import { requireAuth, requireWorkspace } from '../../../kernel/identity/auth.ts';
import { serverClock } from '../../../kernel/write-path/bootstrap.ts';
import { translatorFor } from '../../../kernel/i18n/i18n.ts';
import { canSeeProject, displayName, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { env } from '../../../kernel/platform/env.ts';
import { byValue, enforce } from '../../../kernel/identity/ratelimit.ts';
import { AiError } from '../../ai-review/model.ts';
import { draftReply } from '../assistant.ts';
import { setTyping, taskTitle, transcript, typingIn } from '../support.ts';

/** The same allowance a task review has: a person clicking, paced like one. */
const SUGGEST_LIMIT = { burst: env.ai.burst, everySeconds: env.ai.everySeconds, deepens: false };

function widgetForAdmin(ctx: Ctx): Row {
  requireAuth(ctx);
  const widget = get<Row>(`SELECT * FROM widgets WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
  if (!widget) throw notFound('No such widget');
  requireWorkspace(ctx, String(widget.workspace_id), 'admin');
  return widget;
}

function conversationForMember(ctx: Ctx): Row {
  const auth = requireAuth(ctx);
  const conversation = get<Row>(`SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
  if (!conversation) throw notFound('No such conversation');
  requireWorkspace(ctx, String(conversation.workspace_id), 'member');
  if (!canSeeProject(auth.userId, String(conversation.project_id))) throw forbidden('That project is private');
  return conversation;
}

export function registerSupportRoutes(router: Router): void {
  /** The secret a host site signs its visitors' tokens with. Admins only, and only on request. */
  router.get('/api/widgets/:id/secret', (ctx: Ctx) => ({ secret: String(widgetForAdmin(ctx).secret ?? '') }));

  /**
   * A new secret, for when the old one has been somewhere it should not.
   * Every token signed with the old one stops working at once — which is the point.
   */
  router.post('/api/widgets/:id/secret', (ctx: Ctx) => {
    const widget = widgetForAdmin(ctx);
    const secret = token(32);
    // A plain UPDATE: the column is `secret` in the registry, which is what
    // keeps it out of every write a client can make — this route's included.
    run(`UPDATE widgets SET secret = ? WHERE id = ?`, secret, widget.id);
    return { secret };
  });

  /**
   * The conversation as a task in the widget's project, its transcript as the
   * description. Once: a conversation that is already a task says which —
   * unless that task has been deleted since, which leaves nothing to open.
   */
  router.post('/api/conversations/:id/task', async (ctx: Ctx) => {
    const conversation = conversationForMember(ctx);
    const auth = ctx.auth!;
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    if (conversation.task_id && get(`SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL`, conversation.task_id)) {
      throw badRequest('This conversation is already a task');
    }
    const body = await readJson<{ title?: string }>(ctx).catch(() => ({}) as { title?: string });
    const opts = { workspaceId: String(conversation.workspace_id), actorId: auth.userId, hlc: serverClock.now() };
    const { row: task } = writeEntity('task', uid(), {
      workspace_id: conversation.workspace_id,
      project_id: conversation.project_id,
      title: String(body.title ?? '').trim() || taskTitle(conversation),
      description: transcript(conversation, displayName, translatorFor(auth.userId)('support.taskFrom', {
        name: visitorLabel(conversation as Conversation),
        widget: String(get<Row>(`SELECT name FROM widgets WHERE id = ?`, conversation.widget_id)?.name ?? ''),
      })),
      created_by: auth.userId,
    }, opts);
    writeEntity('conversation', String(conversation.id), { task_id: task.id }, { ...opts, system: true });
    return {
      task: serialize('task', task),
      conversation: serialize('conversation', get<Row>(`SELECT * FROM conversations WHERE id = ?`, conversation.id)),
    };
  });

  /**
   * A draft answer from the model, for the member to read and send — or not.
   * Nothing is written: the draft comes back and goes into the member's box.
   */
  router.post('/api/conversations/:id/suggest', async (ctx: Ctx) => {
    const conversation = conversationForMember(ctx);
    const auth = ctx.auth!;
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    enforce(ctx, [byValue(SUGGEST_LIMIT, 'support-suggest', auth.userId)]);
    try {
      return await draftReply(conversation);
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      throw new HttpError(error.permanent ? 400 : 502, error.message, 'ai_failed');
    }
  });

  /** Whether the visitor is typing — asked by the open conversation every few seconds. */
  router.get('/api/conversations/:id/typing', (ctx: Ctx) => ({ visitor: typingIn(String(conversationForMember(ctx).id)).visitor }));

  /** A member is typing, or has stopped. */
  router.post('/api/conversations/:id/typing', async (ctx: Ctx) => {
    const conversation = conversationForMember(ctx);
    const body = await readJson<{ typing?: boolean }>(ctx, 1024).catch(() => ({ typing: false }));
    setTyping(String(conversation.id), 'agent', !!body?.typing);
    return { ok: true };
  });
}
