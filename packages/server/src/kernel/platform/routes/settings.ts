/**
 * Instance settings, over HTTP.
 *
 * Three verbs and one rule: only the account that holds the instance may read
 * or write any of this. Not a workspace owner — see `requireInstanceAdmin` —
 * because on an instance where anybody may sign up, everybody owns a
 * workspace, and the relay the whole server sends through is not theirs.
 *
 * The test is the half that makes the rest usable. Configuration you cannot
 * try is configuration you find out about when somebody says they never got
 * the invite, so each group answers the one question worth asking of it: does
 * a message actually arrive, is the token a bot, does the model answer.
 */
import { get, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireInstanceAdmin } from '../../identity/auth.ts';
import { badRequest, readJson, type Ctx, type Router } from '../http.ts';
import { flushQueue, queueTestMail } from '../../../adapters/mail/mail.ts';
import { applySettings, describeSettings, instanceStatus, writeSettings } from '../settings.ts';
import { call, linkedChat, sendTest } from '../../../adapters/telegram/telegram.ts';
import { reviewer } from '../../../modules/ai-review/review.ts';
import { AiError } from '../../../adapters/ai/ai.ts';
import { places, testDestinations } from '../../../modules/operations/backups.ts';

/**
 * Where backups go, for the group's chip — and what is set up halfway.
 *
 * Asked of the backups module rather than added to `instanceStatus`, because
 * which places exist is decided by the adapters that fill its port, and the
 * kernel does not know them.
 */
const backupStatus = () => {
  const everywhere = places();
  return {
    dir: !!env.backup.dir,
    places: everywhere.filter((place) => place.configured).map((place) => ({ kind: place.kind, where: place.where })),
    problems: everywhere.flatMap((place) => (place.problem ? [place.problem] : [])),
  };
};

/** Everything the screen draws itself from, in one answer. */
const state = () => ({ settings: describeSettings(), status: { ...instanceStatus(), backup: backupStatus() } });


export function registerSettingsRoutes(router: Router): void {
  router.get('/api/instance/settings', (ctx: Ctx) => {
    requireInstanceAdmin(ctx);
    return state();
  });

  router.post('/api/instance/settings', async (ctx: Ctx) => {
    const auth = requireInstanceAdmin(ctx);
    const body = await readJson<{ settings?: Record<string, string | null> }>(ctx, 64 * 1024);
    writeSettings(body.settings ?? {}, auth.userId);
    // The mail worker and the Telegram poller follow — see `onSettingsChange`.
    applySettings();
    return state();
  });

  /**
   * Try it, and say what happened in one sentence.
   *
   * Every failure here is somebody's typo, so the message is whatever the
   * relay, Telegram or the model actually said rather than "test failed" —
   * "authentication failed" and "connection refused" send you to two different
   * places.
   */
  router.post('/api/instance/test/:group', async (ctx: Ctx) => {
    const auth = requireInstanceAdmin(ctx);
    const me = get<Row>(`SELECT email, locale FROM users WHERE id = ?`, auth.userId)!;

    if (ctx.params.group === 'mail') {
      if (!env.mailEnabled) throw badRequest('No mail transport is configured');
      queueTestMail(String(me.email), me.locale ?? undefined);
      const result = await flushQueue(5);
      if (!result.sent) {
        const failure = get<Row>(
          `SELECT last_error FROM email_queue WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1`,
        );
        throw badRequest(String(failure?.last_error ?? 'The relay did not accept the message'));
      }
      return { ok: true, detail: String(me.email) };
    }

    if (ctx.params.group === 'telegram') {
      if (!env.telegramEnabled) throw badRequest('No bot token is configured');
      let bot: { username?: string };
      try {
        bot = await call<{ username?: string }>('getMe');
      } catch (error) {
        throw badRequest((error as Error).message);
      }
      // A message, not just a handshake, whenever there is somewhere to send
      // it: the admin's own chat. Without one the token check is the whole of
      // the test, and the answer says so rather than implying a delivery.
      const chat = linkedChat(auth.userId);
      if (chat) {
        try {
          await sendTest(auth.userId);
        } catch (error) {
          throw badRequest((error as Error).message);
        }
      }
      return { ok: true, detail: `@${bot.username ?? ''}`, delivered: !!chat };
    }

    if (ctx.params.group === 'ai') {
      const chosen = reviewer();
      if (!chosen) throw badRequest('No model is configured');
      try {
        await chosen.ask({
          system: 'You are a connection test. Answer with the single word OK.',
          user: 'Answer with the single word OK.',
          // Room for a word, and for the thinking a current model does before
          // it says one. A budget that only fits the answer fails the test on
          // a working key and sends an operator hunting for the wrong problem.
          maxTokens: 256,
        });
      } catch (error) {
        throw badRequest(error instanceof AiError ? error.message : (error as Error).message);
      }
      return { ok: true, detail: chosen.model };
    }

    /*
     * Every place a backup goes, tried the way a backup would use it: an object
     * written to the bucket and read back, a message with an attachment sent
     * to the address. The attachment is the point — a provider that refuses a
     * .zip says so now rather than at three in the morning.
     */
    if (ctx.params.group === 'backup') {
      const tried = await testDestinations();
      if (!tried.length) throw badRequest('No bucket or address is set up to test');
      const failed = tried.filter((one) => !one.ok);
      if (failed.length) throw badRequest(failed.map((one) => one.detail).join(' — '));
      return {
        ok: true,
        detail: tried.map((one) => one.detail).join(', '),
        bucket: tried.find((one) => one.kind === 's3')?.detail,
        email: tried.find((one) => one.kind === 'email')?.detail,
      };
    }

    throw badRequest(`There is nothing called ${ctx.params.group} to test`);
  });
}
