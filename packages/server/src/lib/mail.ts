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

export type EmailPreference = 'all' | 'important' | 'none';

/** Kinds a user on the "important only" setting still wants in their inbox. */
const IMPORTANT = new Set(['assigned', 'mention', 'invite', 'due_soon']);

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
      const giveUp = attempts >= env.mail.maxAttempts;
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
    const user = get<Row>(`SELECT id, email, name, email_prefs FROM users WHERE id = ? AND deleted_at IS NULL`, userId);
    const pending = all<Row>(
      `SELECT * FROM notifications
        WHERE user_id = ? AND emailed_at IS NULL AND deleted_at IS NULL AND read_at IS NULL AND created_at <= ?
        ORDER BY created_at`,
      userId, cutoff,
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
    const relevant = preference === 'all' ? pending : pending.filter((row) => IMPORTANT.has(row.kind));
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

function renderDigest(user: Row, notifications: Row[]): { subject: string; text: string; html: string } {
  const first = notifications[0];
  const subject = notifications.length === 1
    ? first.title
    : `${notifications.length} updates in Kolibri`;

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
    `Hello ${user.name ?? ''},`.trim(),
    '',
    ...rows.map((row) => [
      `• ${row.title}`,
      row.actor ? `  by ${row.actor}` : '',
      row.body ? `  ${String(row.body).slice(0, 200)}` : '',
      `  ${row.href}`,
    ].filter(Boolean).join('\n')),
    '',
    `Open your inbox: ${link('/inbox')}`,
    `Turn these emails off: ${unsubscribeUrl(user.id)}`,
  ].join('\n');

  const html = layout(
    subject,
    `${rows.map((row) => `
      <div style="padding:12px 0;border-top:1px solid #eceef2">
        <div style="font-weight:600"><a href="${escape(row.href)}" style="color:#14161c;text-decoration:none">${escape(row.title)}</a></div>
        ${row.actor ? `<div style="color:#8b909b;font-size:12.5px">by ${escape(row.actor)}</div>` : ''}
        ${row.body ? `<div style="color:#4a4f5a;margin-top:4px">${escape(String(row.body).slice(0, 300))}</div>` : ''}
      </div>`).join('')}
     <div style="padding-top:16px">${button(link('/inbox'), 'Open Kolibri')}</div>`,
    `You are receiving this because you are involved in this work.<br />
     <a href="${escape(unsubscribeUrl(user.id))}" style="color:#8b909b">Turn these emails off</a>`,
  );

  return { subject, text, html };
}

export function queueInvite(invite: { code: string; email: string; workspaceName: string; inviterName: string; workspaceId: string }): void {
  const url = link(`/invite/${invite.code}`);
  queueMail({
    to: invite.email,
    workspaceId: invite.workspaceId,
    kind: 'invite',
    subject: `${invite.inviterName} invited you to ${invite.workspaceName} on Kolibri`,
    text: [
      `${invite.inviterName} invited you to join "${invite.workspaceName}" on Kolibri.`,
      '',
      `Accept the invitation: ${url}`,
      '',
      'If you were not expecting this, you can ignore this message.',
    ].join('\n'),
    html: layout(
      `Join ${invite.workspaceName}`,
      `<p><strong>${escape(invite.inviterName)}</strong> invited you to join
        <strong>${escape(invite.workspaceName)}</strong> on Kolibri.</p>
       <div style="padding-top:8px">${button(url, 'Accept the invitation')}</div>
       <p style="color:#8b909b;font-size:12.5px;margin-top:14px">If you were not expecting this, ignore this message.</p>`,
    ),
  });
}

export function queueTestMail(to: string): string | null {
  return queueMail({
    to,
    kind: 'test',
    subject: 'Kolibri test email',
    text: `This is a test message from Kolibri.\n\nIf you can read it, SMTP is configured correctly.\n\n${link('/settings')}`,
    html: layout(
      'SMTP is working',
      `<p>This is a test message from your Kolibri instance.</p>
       <p style="color:#4a4f5a">Relay: ${escape(env.mail.host)}:${env.mail.port}${env.mail.secure ? ' (TLS)' : ''}</p>
       <div style="padding-top:8px">${button(link('/settings'), 'Back to settings')}</div>`,
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
