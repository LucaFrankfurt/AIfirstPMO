/**
 * The way out.
 *
 * Rules act inwards — they file tasks in Kolibri. A webhook is the other
 * direction: something happened, tell a machine somewhere else. It is the
 * generic answer to "integrate with GitHub / Slack / whatever", and it is a
 * hundred lines rather than one integration per service.
 *
 * Deliberately fire-and-forget with a short timeout. A slow receiver must not
 * slow down the person who pressed the button, and a webhook that blocks a
 * write is a webhook that takes the app down when somebody's endpoint dies.
 */
import { createHmac } from 'node:crypto';
import { all, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';

/** What a receiver can subscribe to. Kept short; each one is a promise. */
export const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.completed',
  'comment.created', 'page.updated',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const TIMEOUT_MS = 5_000;

/** Sent so a receiver can verify the body really came from this instance. */
export const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Deliver one event to whoever asked for it.
 *
 * Not awaited by the caller: the write path returns as soon as the row is
 * saved, and delivery happens after. Failures are recorded on the webhook row
 * rather than thrown, because a broken endpoint is the endpoint owner's
 * problem, not a reason to refuse somebody's edit.
 */
export function dispatch(workspaceId: string, event: WebhookEvent, payload: Record<string, unknown>): void {
  const hooks = all<Row>(
    `SELECT * FROM webhooks
      WHERE workspace_id = ? AND enabled = 1 AND deleted_at IS NULL`,
    workspaceId,
  ).filter((hook) => String(hook.events ?? '').split(',').map((name) => name.trim()).includes(event));
  if (!hooks.length) return;

  const projectId = payload.project_id;
  for (const hook of hooks) {
    // A hook scoped to a project only hears about that project.
    if (hook.project_id && hook.project_id !== projectId) continue;
    void deliver(hook, event, payload);
  }
}

async function deliver(hook: Row, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ event, at: Date.now(), instance: env.publicUrl || null, data: payload });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(String(hook.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Kolibri-Webhook/1',
        'x-kolibri-event': event,
        ...(hook.secret ? { 'x-kolibri-signature': sign(String(hook.secret), body) } : {}),
      },
      body,
      signal: controller.signal,
    });
    record(hook.id, response.status, response.ok ? null : `HTTP ${response.status}`);
  } catch (error) {
    // Abort, DNS failure, refused connection — all the same to us: the last
    // attempt is written down and the next event tries again.
    record(hook.id, null, error instanceof Error ? error.message.slice(0, 200) : 'failed');
  } finally {
    clearTimeout(timer);
  }
}

const record = (id: unknown, status: number | null, error: string | null): void => {
  run(
    `UPDATE webhooks SET last_status = ?, last_error = ?, last_sent_at = ? WHERE id = ?`,
    status, error, Date.now(), id,
  );
};
