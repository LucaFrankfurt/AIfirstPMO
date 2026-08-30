/**
 * Connecting an account to the Telegram bot, and proving it works.
 *
 * The bot itself — long-polled updates, single-use link codes, delivery — is
 * `lib/telegram.ts`. This is only the four endpoints the settings screen calls,
 * which lived in `auth.ts` because there was no route file for the adapter to
 * put them in.
 */
import { get, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth } from '../lib/auth.ts';
import { badRequest, type Router } from '../lib/http.ts';
import { sendTest, startLink, unlink } from '../lib/telegram.ts';

export function registerTelegramRoutes(router: Router): void {
  /**
   * What this account's Telegram connection looks like right now.
   *
   * `enabled` is about the instance — whether an operator configured a bot at
   * all — and `linked` is about this person. Both are needed: "no bot token"
   * and "you have not connected yet" are different problems with different
   * people to talk to, and one message covering both helps neither.
   */
  router.get('/api/telegram/status', (ctx) => {
    const auth = requireAuth(ctx);
    const user = get<Row>(
      `SELECT telegram_chat_id, telegram_prefs, telegram_linked_at FROM users WHERE id = ?`,
      auth.userId,
    );
    return {
      enabled: env.telegramEnabled,
      linked: !!user?.telegram_chat_id,
      linkedAt: user?.telegram_linked_at ?? null,
      preference: user?.telegram_prefs ?? 'all',
    };
  });

  /**
   * Hand out a code and the link that carries it.
   *
   * The chat id never comes from the client — it arrives with the update the
   * person's own Telegram sends. So there is nothing here to forge: the worst
   * a stolen code does is connect the thief's chat to the account it was
   * issued for, which is why it lasts fifteen minutes and is used once.
   */
  router.post('/api/telegram/link', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.telegramEnabled) throw badRequest('No Telegram bot is configured on this instance');
    try {
      const link = await startLink(auth.userId);
      return { url: link.url, code: link.code, expiresAt: link.expiresAt };
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  router.post('/api/telegram/unlink', (ctx) => {
    const auth = requireAuth(ctx);
    unlink(auth.userId);
    return { ok: true };
  });

  router.post('/api/telegram/test', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.telegramEnabled) throw badRequest('No Telegram bot is configured on this instance');
    try {
      await sendTest(auth.userId);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    return { sent: true };
  });
}
