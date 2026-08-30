/**
 * The endpoints that exist because this instance sends email.
 *
 * Unsubscribing, the diagnostics an operator needs when nothing arrives, and
 * the bounce reports the relay sends back. All of it used to be inside
 * `auth.ts`, which is why `adapter/mail` had no route file and the module map
 * counted these seven endpoints as identity.
 *
 * Two of them are reachable without a session on purpose — an unsubscribe link
 * is followed from an inbox, and a bounce report is posted by a relay — so each
 * carries its own proof instead: a signature over the user id, and a shared
 * secret in a header.
 */
import { get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { requireAuth, secretEquals } from '../lib/auth.ts';
import {
  badRequest, forbidden, notFound, readJson, unauthorized, type Ctx, type Router,
} from '../lib/http.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';
import {
  pendingCount, queueTestMail, suppress, suppressions, unsuppress, verifyUnsubscribe,
} from '../lib/mail.ts';

export function registerMailRoutes(router: Router): void {
  /**
   * One-click unsubscribe. Signed with the instance secret so the link works
   * from an inbox without a session, and cannot be guessed for someone else.
   */
  const unsubscribe = (ctx: Ctx) => {
    if (!verifyUnsubscribe(ctx.params.userId, ctx.params.token)) throw forbidden('This unsubscribe link is not valid');
    run(`UPDATE users SET email_prefs = 'none' WHERE id = ?`, ctx.params.userId);
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    ctx.res.end(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>
       <body style="font-family:system-ui;padding:48px;max-width:36em;margin:0 auto;line-height:1.6">
       <h1 style="font-size:20px">Email notifications are off</h1>
       <p>You will still see everything in your Kolibri inbox. You can turn email back on
       under Settings → Notifications.</p>
       <p><a href="${env.publicUrl || '/'}">Back to Kolibri</a></p>`,
    );
    return undefined;
  };
  router.get('/api/unsubscribe/:userId/:token', unsubscribe);
  router.post('/api/unsubscribe/:userId/:token', unsubscribe);

  /** Admin diagnostics: is mail configured, and does the relay actually accept? */
  router.get('/api/mail/status', (ctx) => {
    const auth = requireAuth(ctx);
    const user = get<Row>(`SELECT email_prefs FROM users WHERE id = ?`, auth.userId);
    return {
      enabled: env.mailEnabled,
      mode: env.mailMode,
      transport: env.mailTransport,
      // Where it goes, whichever way it goes. Never the credentials — this is
      // readable by any signed-in account, not only an admin.
      host: env.mailTransport === 'scaleway'
        ? new URL(env.mail.scaleway.url).host
        : env.mailEnabled ? `${env.mail.host}:${env.mail.port}` : null,
      encryption: env.mailTransport === 'smtp' ? env.mail.encryption : null,
      from: env.mail.from,
      batchSeconds: env.mail.batchSeconds,
      pending: pendingCount(),
      preference: user?.email_prefs ?? 'important',
    };
  });

  router.post('/api/mail/test', async (ctx) => {
    const auth = requireAuth(ctx);
    if (!env.mailEnabled) throw badRequest('No mail transport is configured on this instance');
    const user = get<Row>(`SELECT email, locale FROM users WHERE id = ?`, auth.userId);
    queueTestMail(user!.email, user!.locale ?? undefined);
    const { flushQueue } = await import('../lib/mail.ts');
    const result = await flushQueue(5);
    if (!result.sent) {
      const failure = get<Row>(
        `SELECT last_error FROM email_queue WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1`,
      );
      throw badRequest(failure?.last_error ?? 'The relay did not accept the message');
    }
    return { sent: true, to: user!.email };
  });

  /* --------------------------------------------------------- bounces */

  /**
   * Bounce and complaint reports from a mail provider.
   *
   * Guarded by a shared secret rather than a per-provider signature, because
   * every provider signs differently and this endpoint does one thing: it
   * reads an address and stops writing to it. The shapes below are Postmark's
   * and Amazon SES's, plus the obvious generic one.
   */
  router.post('/api/mail/bounces', async (ctx) => {
    if (!env.bounceToken) throw notFound('Bounce reporting is not configured');
    // A shared secret in a header, from a relay we do not control the network
    // to: limited like any other credential, and compared without reporting
    // how much of it was right. It was `!==`, which does both.
    enforce(ctx, byAddress(ctx, LIMITS.login, 'bounces'));
    const offered = String(ctx.req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (!secretEquals(offered, env.bounceToken)) throw unauthorized('Wrong token');

    const body = await readJson<any>(ctx, 512 * 1024);
    const reports = readBounces(body);
    for (const report of reports) suppress(report.email, report.reason, report.detail);
    return { ok: true, suppressed: reports.length };
  });

  /** What is being refused, and a way to allow an address again. */
  router.get('/api/mail/suppressions', (ctx) => {
    requireAuth(ctx);
    return suppressions();
  });

  router.delete('/api/mail/suppressions/:email', (ctx) => {
    const auth = requireAuth(ctx);
    // Anybody may un-suppress their own address; an admin may clear any of
    // them. A bounce is usually a full mailbox, and the person it happened to
    // is the one who knows it is fixed.
    const address = decodeURIComponent(ctx.params.email).toLowerCase();
    const me = get<Row>(`SELECT email FROM users WHERE id = ?`, auth.userId);
    const mine = String(me?.email ?? '').toLowerCase() === address;
    if (!mine && !auth.isAdmin && ![...auth.memberships.values()].some((role) => role === 'owner' || role === 'admin')) {
      throw forbidden('Only an admin can clear somebody else’s address');
    }
    unsuppress(address);
    return { ok: true };
  });
}

/**
 * The address and the verdict, out of whichever shape arrived.
 *
 * Only *hard* bounces and complaints suppress: a full mailbox or a greylisting
 * is a bad afternoon, and cutting somebody off for one is worse than the
 * retry.
 */
function readBounces(body: any): { email: string; reason: 'bounce' | 'complaint'; detail?: string }[] {
  const out: { email: string; reason: 'bounce' | 'complaint'; detail?: string }[] = [];
  const add = (email: unknown, reason: 'bounce' | 'complaint', detail?: unknown) => {
    if (typeof email === 'string' && email.includes('@')) {
      out.push({ email, reason, detail: typeof detail === 'string' ? detail : undefined });
    }
  };

  // Postmark: one object, `RecordType` and `Type`.
  if (typeof body?.Type === 'string' || typeof body?.RecordType === 'string') {
    const type = String(body.Type ?? body.RecordType);
    if (/spam|complaint/i.test(type)) add(body.Email ?? body.Recipient, 'complaint', body.Description);
    else if (/hardbounce|bademail|blocked|unsubscribe/i.test(type)) add(body.Email ?? body.Recipient, 'bounce', body.Description);
    return out;
  }

  // Amazon SES via SNS: the interesting part is a JSON string inside `Message`.
  if (typeof body?.Message === 'string') {
    try {
      const inner = JSON.parse(body.Message);
      const kind = String(inner?.notificationType ?? '');
      if (kind === 'Complaint') {
        for (const entry of inner?.complaint?.complainedRecipients ?? []) add(entry?.emailAddress, 'complaint');
      } else if (kind === 'Bounce' && String(inner?.bounce?.bounceType) === 'Permanent') {
        for (const entry of inner?.bounce?.bouncedRecipients ?? []) {
          add(entry?.emailAddress, 'bounce', entry?.diagnosticCode);
        }
      }
    } catch {
      // Not JSON after all. Nothing to do, and nothing worth failing over.
    }
    return out;
  }

  // The obvious shape, for anybody wiring this up by hand.
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const kind = String(entry?.type ?? entry?.event ?? 'bounce');
    if (/soft|transient|deferred/i.test(kind)) continue;
    add(entry?.email ?? entry?.recipient, /complaint|spam/i.test(kind) ? 'complaint' : 'bounce', entry?.reason);
  }
  return out;
}
