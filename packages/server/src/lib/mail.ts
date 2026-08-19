/**
 * Email notifications.
 *
 * Three rules shape this:
 *   1. Nothing is sent inline — mail goes into a queue table, so a slow relay
 *      can never make a request hang, and a failure is retried with backoff.
 *   2. Notifications are batched. A burst of activity waits `batchSeconds` and
 *      becomes one message, because an inbox with twelve "task updated" mails
 *      is worse than none.
 *   3. Every message carries a working unsubscribe link.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { sendMail, type SmtpConfig } from './smtp.ts';
import { uid } from './ids.ts';
import { isLocale, defaultLocale, translate, type Locale } from './i18n.ts';
import { isImportantFor } from '@kolibri/shared';

export type EmailPreference = 'all' | 'important' | 'none';

/**
 * Kinds a user on the "important only" setting still wants in their inbox.
 *
 * Defined once in `@kolibri/shared` alongside the instant channels' answer, so
 * the two cannot drift apart again — a chat message counts as important there
 * and deliberately not here, because this channel is batched and a chat message
 * in a two-hour digest is one answered too late to matter.
 */
const important = (kind: string): boolean => isImportantFor('email', kind);

const smtp = (): SmtpConfig => ({
  host: env.mail.host,
  port: env.mail.port,
  secure: env.mail.secure,
  user: env.mail.user,
  pass: env.mail.pass,
  allowInvalidCerts: env.mail.allowInvalidCerts,
});

const link = (path: string): string => `${env.publicUrl || 'http://localhost:4000'}${path}`;

/* ------------------------------------------------------------ unsubscribe */

export const unsubscribeToken = (userId: string): string =>
  createHmac('sha256', env.secret).update(`unsubscribe:${userId}`).digest('hex').slice(0, 32);

export function verifyUnsubscribe(userId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(token ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const unsubscribeUrl = (userId: string): string => link(`/api/unsubscribe/${userId}/${unsubscribeToken(userId)}`);

/* ------------------------------------------------------------------ queue */

export interface QueuedMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  userId?: string;
  workspaceId?: string;
  kind?: string;
  /** Delay before the worker may pick it up. */
  delaySeconds?: number;
  headers?: Record<string, string>;
}

export function queueMail(mail: QueuedMail): string | null {
  if (!env.mailEnabled) return null;
  if (!mail.to?.includes('@')) return null;
  // An address that hard-bounced or complained is not written to again. Sending
  // anyway is how a domain's reputation goes, and it is not as if the message
  // would arrive.
  if (isSuppressed(mail.to)) return null;
  const id = uid();
  run(
    `INSERT INTO email_queue (id, user_id, workspace_id, to_email, subject, body_text, body_html, headers, kind, send_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, mail.userId ?? null, mail.workspaceId ?? null, mail.to, mail.subject, mail.text, mail.html ?? null,
    JSON.stringify(mail.headers ?? {}), mail.kind ?? 'notification',
    Date.now() + (mail.delaySeconds ?? 0) * 1000, Date.now(),
  );
  return id;
}

/* --------------------------------------------------------- bounce handling */

export type SuppressionReason = 'bounce' | 'complaint' | 'manual';

/** Stop writing to this address, and say why. */
export function suppress(email: string, reason: SuppressionReason, detail?: string): void {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return;
  run(
    `INSERT INTO email_suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail`,
    address, reason, detail?.slice(0, 300) ?? null, Date.now(),
  );
  // Anything already queued for that address is abandoned rather than retried
  // until it gives up on its own.
  run(
    `UPDATE email_queue SET failed_at = ?, last_error = ? WHERE lower(to_email) = ? AND sent_at IS NULL AND failed_at IS NULL`,
    Date.now(), `suppressed: ${reason}`, address,
  );
}

export const isSuppressed = (email: string): boolean =>
  !!get<Row>(`SELECT email FROM email_suppressions WHERE email = ?`, email.trim().toLowerCase());

export const unsuppress = (email: string): void => {
  run(`DELETE FROM email_suppressions WHERE email = ?`, email.trim().toLowerCase());
};

export const suppressions = (): Row[] =>
  all<Row>(`SELECT * FROM email_suppressions ORDER BY created_at DESC LIMIT 500`);

/**
 * Whether a relay's refusal is final.
 *
 * A 5xx reply means "this address, this message, never" — retrying it five more
 * times only tells the receiving domain that nobody here is listening. A 4xx is
 * a bad moment, and those are exactly what the backoff is for.
 */
export const isPermanent = (message: string): boolean => /\b5\d\d\b/.test(message);

export function pendingCount(): number {
  return Number(get<Row>(`SELECT count(*) c FROM email_queue WHERE sent_at IS NULL AND failed_at IS NULL`)?.c ?? 0);
}

/** One worker pass: send everything that is due. */
export async function flushQueue(limit = 20): Promise<{ sent: number; failed: number }> {
  if (!env.mailEnabled) return { sent: 0, failed: 0 };
  const due = all<Row>(
    `SELECT * FROM email_queue
      WHERE sent_at IS NULL AND failed_at IS NULL AND send_after <= ?
      ORDER BY send_after LIMIT ?`,
    Date.now(), limit,
  );

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await sendMail(smtp(), {
        from: env.mail.from,
        fromName: env.mail.fromName,
        replyTo: env.mail.replyTo,
        to: row.to_email,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html ?? undefined,
        headers: safeHeaders(row.headers),
      });
      run(`UPDATE email_queue SET sent_at = ?, attempts = attempts + 1 WHERE id = ?`, Date.now(), row.id);
      sent++;
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const message = error instanceof Error ? error.message : 'send failed';
      const permanent = isPermanent(message);
      const giveUp = permanent || attempts >= env.mail.maxAttempts;
      // A permanent refusal is the address's problem, not this message's: the
      // address stops being written to at all.
      if (permanent) suppress(String(row.to_email), 'bounce', message);
      run(
        `UPDATE email_queue SET attempts = ?, last_error = ?, send_after = ?, failed_at = ? WHERE id = ?`,
        attempts, message.slice(0, 500),
        // 1min, 2, 4, 8, 16 … so a relay that is down for a while still catches up.
        Date.now() + Math.min(2 ** attempts, 60) * 60_000,
        giveUp ? Date.now() : null,
        row.id,
      );
      failed++;
    }
  }
  return { sent, failed };
}

const safeHeaders = (raw: string): Record<string, string> => {
  try {
    return JSON.parse(raw ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

/* --------------------------------------------------------------- batching */

/**
 * Turn in-app notifications into at most one email per user per window.
 * Runs on the same worker tick as the queue flush.
 */
export function batchNotifications(now = Date.now()): number {
  if (!env.mailEnabled) return 0;
  const cutoff = now - env.mail.batchSeconds * 1000;

  const users = all<Row>(
    `SELECT DISTINCT n.user_id FROM notifications n
      WHERE n.emailed_at IS NULL AND n.deleted_at IS NULL AND n.read_at IS NULL
        AND n.created_at <= ?`,
    cutoff,
  );

  let queued = 0;
  for (const { user_id: userId } of users) {
    const user = get<Row>(`SELECT id, email, name, email_prefs, locale, digest FROM users WHERE id = ? AND deleted_at IS NULL`, userId);
    // Somebody on a digest waits a day or a week rather than the batching
    // window — except for the things that are worth interrupting for, which
    // still go out on the normal window.
    const digest = String(user?.digest ?? 'off');
    const holdFor = digest === 'daily' ? 86_400_000 : digest === 'weekly' ? 7 * 86_400_000 : 0;
    const own = holdFor ? now - holdFor : cutoff;
    const pending = all<Row>(
      `SELECT * FROM notifications
        WHERE user_id = ? AND emailed_at IS NULL AND deleted_at IS NULL AND read_at IS NULL
          AND (created_at <= ? OR (kind IN ('mention','assigned') AND created_at <= ?))
        ORDER BY created_at`,
      userId, own, cutoff,
    );
    if (!pending.length) continue;

    // Mark them either way: a user who opted out should not accumulate a
    // backlog that lands in their inbox the day they opt back in.
    const stamp = () => run(
      `UPDATE notifications SET emailed_at = ? WHERE id IN (${pending.map(() => '?').join(',')})`,
      now, ...pending.map((row) => row.id),
    );

    const preference = (user?.email_prefs ?? 'important') as EmailPreference;
    if (!user?.email || preference === 'none') {
      stamp();
      continue;
    }
    const relevant = preference === 'all' ? pending : pending.filter((row) => important(String(row.kind)));
    stamp();
    if (!relevant.length) continue;

    const { subject, text, html } = renderDigest(user, relevant);
    queueMail({
      to: user.email,
      userId: user.id,
      workspaceId: relevant[0].workspace_id,
      kind: 'notification',
      subject,
      text,
      html,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl(user.id)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    queued++;
  }
  return queued;
}

/* -------------------------------------------------------------- templates */

const escape = (value: string): string =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * One plain layout, inline styles only. Mail clients strip <style> blocks and
 * external CSS, and half of them are still rendering with Word's engine.
 */
function layout(title: string, bodyHtml: string, footerHtml = ''): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e6eb;border-radius:12px">
    <tr><td style="padding:22px 24px 8px">
      <div style="font-size:13px;color:#8b909b;letter-spacing:.02em">KOLIBRI</div>
      <h1 style="margin:6px 0 0;font-size:18px;font-weight:600">${escape(title)}</h1>
    </td></tr>
    <tr><td style="padding:8px 24px 20px;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>
  </table>
  <div style="max-width:560px;margin:14px auto 0;font-size:12px;color:#8b909b;text-align:center">${footerHtml}</div>
</body></html>`;
}

const button = (href: string, label: string): string =>
  `<a href="${escape(href)}" style="display:inline-block;background:#5b5bd6;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${escape(label)}</a>`;

/** Every message is written in the recipient's language, not the instance's. */
const localeOfRow = (row: Row | undefined): Locale => (isLocale(row?.locale) ? row.locale : defaultLocale());

function renderDigest(user: Row, notifications: Row[]): { subject: string; text: string; html: string } {
  const locale = localeOfRow(user);
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const first = notifications[0];
  const subject = notifications.length === 1
    ? first.title
    : t('mail.digestSubject', { count: notifications.length });

  const rows = notifications.map((notification) => {
    const href = notification.task_id
      ? link(`/t/${notification.task_id}`)
      : notification.page_id ? link(`/pages/${notification.page_id}`) : link('/inbox');
    const actor = notification.actor_id
      ? get<Row>(`SELECT name FROM users WHERE id = ?`, notification.actor_id)?.name
      : null;
    return { ...notification, href, actor } as Row & { href: string; actor: string | null };
  });

  const text = [
    t('mail.greeting', { name: user.name ?? '' }),
    '',
    ...rows.map((row) => [
      `• ${row.title}`,
      row.actor ? `  ${t('mail.by', { name: row.actor })}` : '',
      row.body ? `  ${String(row.body).slice(0, 200)}` : '',
      `  ${row.href}`,
    ].filter(Boolean).join('\n')),
    '',
    t('mail.openInbox', { url: link('/inbox') }),
    t('mail.turnOff', { url: unsubscribeUrl(user.id) }),
  ].join('\n');

  const html = layout(
    subject,
    `${rows.map((row) => `
      <div style="padding:12px 0;border-top:1px solid #eceef2">
        <div style="font-weight:600"><a href="${escape(row.href)}" style="color:#14161c;text-decoration:none">${escape(row.title)}</a></div>
        ${row.actor ? `<div style="color:#8b909b;font-size:12.5px">${escape(t('mail.by', { name: row.actor }))}</div>` : ''}
        ${row.body ? `<div style="color:#4a4f5a;margin-top:4px">${escape(String(row.body).slice(0, 300))}</div>` : ''}
      </div>`).join('')}
     <div style="padding-top:16px">${button(link('/inbox'), t('mail.openKolibri'))}</div>`,
    `${escape(t('mail.why'))}<br />
     <a href="${escape(unsubscribeUrl(user.id))}" style="color:#8b909b">${escape(t('mail.turnOffLabel'))}</a>`,
  );

  return { subject, text, html };
}

export function queueInvite(invite: {
  code: string; email: string; workspaceName: string; inviterName: string; workspaceId: string;
  /** The inviter's language: an invitee has no account yet, so nothing better exists. */
  locale?: string;
}): void {
  const url = link(`/invite/${invite.code}`);
  const locale = isLocale(invite.locale) ? invite.locale : defaultLocale();
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  queueMail({
    to: invite.email,
    workspaceId: invite.workspaceId,
    kind: 'invite',
    subject: t('mail.inviteSubject', { inviter: invite.inviterName, workspace: invite.workspaceName }),
    text: [
      t('mail.inviteBody', { inviter: invite.inviterName, workspace: invite.workspaceName }),
      '',
      t('mail.inviteAcceptLink', { url }),
      '',
      t('mail.inviteIgnore'),
    ].join('\n'),
    html: layout(
      t('mail.inviteTitle', { workspace: invite.workspaceName }),
      `<p>${escape(t('mail.inviteBody', { inviter: invite.inviterName, workspace: invite.workspaceName }))}</p>
       <div style="padding-top:8px">${button(url, t('mail.inviteAccept'))}</div>
       <p style="color:#8b909b;font-size:12.5px;margin-top:14px">${escape(t('mail.inviteIgnore'))}</p>`,
    ),
  });
}

export function queueTestMail(to: string, locale?: string): string | null {
  const chosen = isLocale(locale) ? locale : defaultLocale();
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(chosen, key, vars);
  const relay = `${env.mail.host}:${env.mail.port}${env.mail.secure ? ' (TLS)' : ''}`;
  return queueMail({
    to,
    kind: 'test',
    subject: t('mail.testSubject'),
    text: `${t('mail.testText')}\n\n${link('/settings')}`,
    html: layout(
      t('mail.testTitle'),
      `<p>${escape(t('mail.testBody'))}</p>
       <p style="color:#4a4f5a">${escape(t('mail.testRelay', { relay }))}</p>
       <div style="padding-top:8px">${button(link('/settings'), t('mail.backToSettings'))}</div>`,
    ),
  });
}

/* ----------------------------------------------------------------- worker */

let timer: ReturnType<typeof setInterval> | null = null;

export function startMailWorker(): void {
  if (timer || !env.mailEnabled) return;
  const tick = async () => {
    try {
      batchNotifications();
      await flushQueue();
    } catch (error) {
      console.error('[mail] worker failed', error);
    }
  };
  timer = setInterval(() => void tick(), env.mail.pollSeconds * 1000);
  timer.unref?.();
  void tick();
}

export function stopMailWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
