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

export function registerPushRoutes(router: Router): void {
  /**
   * What a browser needs to subscribe, and where to say it did.
   *
   * The key is public by definition — it is what the push service checks the
   * signature against — so this is readable by anybody with a session.
   */
  router.get('/api/push/key', (ctx) => {
    requireAuth(ctx);
    return { enabled: env.push.enabled, key: env.push.enabled ? keys().publicKey : null };
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
}
