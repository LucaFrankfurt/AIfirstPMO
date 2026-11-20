/**
 * The team's side of support, beyond the rows sync already carries.
 *
 * Three things that are not a patch on a row: the widget's secret, which is
 * handed over on request and never synced; making a task out of a
 * conversation, which creates and numbers one; and "typing", which is not
 * stored at all.
 */
import { currentSeq, get, run, type Row } from '../../../kernel/platform/db/index.ts';
import { publish } from '../../../kernel/platform/bus.ts';
import { HttpError, forbidden, notFound, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { token } from '../../../kernel/platform/ids.ts';
import { requireAuth, requireWorkspace } from '../../../kernel/identity/auth.ts';
import { serverClock } from '../../../kernel/write-path/bootstrap.ts';
import { isLocale, localeOf } from '../../../kernel/i18n/i18n.ts';
import { canSeeProject, serialize } from '../../../kernel/write-path/repo.ts';
import { env } from '../../../kernel/platform/env.ts';
import { byValue, enforce } from '../../../kernel/identity/ratelimit.ts';
import { AiError } from '../../ai-review/model.ts';
import { draftReply } from '../assistant.ts';
import { conversationAsTask, sealWidgetSecret, setTyping, typingIn, widgetSecret } from '../support.ts';

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

/**
 * The widget's secret, to an admin whose credential may write.
 *
 * Both routes, reading included, and that is a deliberate difference from the
 * vault, whose reveal takes a read scope: a vault secret is a key to somebody
 * else's system, and this one is a key to this one. Whoever holds it signs any
 * visitor in as any customer and writes into the workspace as them — lines,
 * pictures, conversations — so a read-only token that could fetch it was a
 * read-only token that could write. Measured before this: such a token read
 * the secret, and rotated it, with a 200 each.
 */
function widgetForWriter(ctx: Ctx): Row {
  const widget = widgetForAdmin(ctx);
  if (!ctx.auth!.scopes.has('write')) throw forbidden('Token is read-only');
  return widget;
}

export function registerSupportRoutes(router: Router): void {
  /** The secret a host site signs its visitors' tokens with. Admins only, and only on request. */
  router.get('/api/widgets/:id/secret', (ctx: Ctx) => ({ secret: widgetSecret(widgetForWriter(ctx)) }));

  /**
   * A new secret, for when the old one has been somewhere it should not.
   * Every token signed with the old one stops working at once — which is the point.
   */
  router.post('/api/widgets/:id/secret', (ctx: Ctx) => {
    const widget = widgetForWriter(ctx);
    const secret = token(32);
    // A plain UPDATE: the column is `secret` in the registry, which is what
    // keeps it out of every write a client can make — this route's included.
    run(`UPDATE widgets SET secret = ? WHERE id = ?`, sealWidgetSecret(secret), widget.id);
    // Said on the bus, though no row a device holds has moved: a visitor's
    // stream asks again at every change whether its session still holds, and
    // without a change to hear it would go on delivering under the old key
    // until something else in the workspace happened to be written.
    publish({ workspaceId: String(widget.workspace_id), seq: currentSeq(), kind: 'widget' });
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
    const body = await readJson<{ title?: string; locale?: string }>(ctx).catch(() => ({}) as { title?: string; locale?: string });
    // The language the member is looking at, which is not always the one their
    // account has stored: a browser in German on an account never told is.
    const locale = isLocale(body.locale) ? body.locale : localeOf(auth.userId);
    const opts = { workspaceId: String(conversation.workspace_id), actorId: auth.userId, hlc: serverClock.now() };
    const made = conversationAsTask(conversation, opts, locale, body.title);
    return { task: serialize('task', made.task), conversation: serialize('conversation', made.conversation) };
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
