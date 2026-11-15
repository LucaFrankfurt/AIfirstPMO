/**
 * What a browser needs to receive a push, and where it says it wants one.
 *
 * Three endpoints, moved out of `auth.ts` with the other adapters. The keys and
 * the sending are `lib/push.ts`.
 */
import { env } from '../../../kernel/platform/env.ts';
import { requireAuth } from '../../../kernel/identity/auth.ts';
import { badRequest, readJson, type Router } from '../../../kernel/platform/http.ts';
import { keys, subscribe, unsubscribe } from '../push.ts';
import { appPushEnabled, forgetAppToken, isPlatform, registerAppToken } from '../app.ts';

export function registerPushRoutes(router: Router): void {
  /**
   * What a browser needs to subscribe, and where to say it did.
   *
   * The key is public by definition — it is what the push service checks the
   * signature against — so this is readable by anybody with a session.
   */
  router.get('/api/push/key', (ctx) => {
    requireAuth(ctx);
    return {
      enabled: env.push.enabled,
      key: env.push.enabled ? keys().publicKey : null,
      // Whether the packaged app may offer its own switch: push on, and a relay
      // named. The app asks before it asks the phone for permission, so a
      // server that cannot wake it never has the phone show the prompt.
      app: appPushEnabled(),
    };
  });

  router.post('/api/push/subscribe', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.push.enabled) throw badRequest('Push is turned off on this instance');
    const body = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(ctx);
    if (!body.endpoint) throw badRequest('endpoint is required');
    subscribe(auth.userId, body as { endpoint: string });
    return { ok: true };
  });

  router.post('/api/push/unsubscribe', async (ctx) => {
    requireAuth(ctx);
    const body = await readJson<{ endpoint?: string }>(ctx);
    if (body.endpoint) unsubscribe(body.endpoint);
    return { ok: true };
  });

  /**
   * The packaged app, saying which phone it is on.
   *
   * Only on a session: the token is tied to the session that registered it, so
   * that signing out or revoking it ends the waking too — an API token has no
   * sign-out, and a script has no phone.
   */
  router.post('/api/push/app', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!appPushEnabled()) throw badRequest('This instance does not wake the app');
    if (!auth.sessionId) throw badRequest('A phone registers on the session it signed in with, not with an API token');
    const body = await readJson<{ platform?: string; token?: string }>(ctx);
    if (!isPlatform(body.platform)) throw badRequest('platform is "ios" or "android"');
    if (!registerAppToken(auth.userId, auth.sessionId, body.platform, String(body.token ?? ''))) {
      throw badRequest('token is not one Apple or Google would issue');
    }
    return { ok: true };
  });

  router.post('/api/push/app/forget', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ token?: string }>(ctx);
    if (body.token) forgetAppToken(auth.userId, String(body.token));
    return { ok: true };
  });
}
