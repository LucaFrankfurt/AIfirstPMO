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
import type { WebhookEvent } from '@kolibri/shared';
import { all, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { BlockedAddress, send } from './outbound.ts';

// The list itself is in `@kolibri/shared`: the screen that offers the
// checkboxes and the code that fires them have to agree, and they used to
// agree by having been typed twice.
export { WEBHOOK_EVENTS, type WebhookEvent } from '@kolibri/shared';

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
      WHERE workspace_id = ? AND enabled = 1 AND direction = 'out' AND deleted_at IS NULL`,
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

/**
 * What the message looks like on the other side.
 *
 * Slack and Discord will not read our envelope: they render one field and
 * ignore everything else. So the *transport* stays the same and only the body
 * changes — which is the whole of what "a named integration" means here, and a
 * great deal less than one client library per service.
 */
function bodyFor(hook: Row, event: WebhookEvent, payload: Record<string, unknown>): string {
  const format = String(hook.format ?? 'kolibri');
  if (format === 'kolibri') {
    return JSON.stringify({ event, at: Date.now(), instance: env.publicUrl || null, data: payload });
  }

  const title = String(payload.title ?? payload.name ?? '');
  const identifier = payload.identifier ? `${payload.identifier} ` : '';
  const link = payload.id && env.publicUrl ? `${env.publicUrl}/t/${payload.id}` : '';
  const who = payload.actor ? ` — ${payload.actor}` : '';
  const text = `*${LABEL[event] ?? event}*: ${identifier}${title}${who}${link ? `\n${link}` : ''}`;

  // Slack and Mattermost read `text`; Discord reads `content`. Both ignore the
  // other, so one object suits both and neither needs a special case.
  return JSON.stringify(format === 'discord' ? { content: text } : { text });
}

/** How each event reads to a human in a chat window. */
const LABEL: Partial<Record<WebhookEvent, string>> = {
  'task.created': 'New task',
  'task.updated': 'Task updated',
  'task.moved': 'Task moved',
  'task.completed': 'Task finished',
  'task.deleted': 'Task deleted',
  'comment.created': 'New comment',
  'page.created': 'New page',
  'page.updated': 'Page updated',
  'cycle.created': 'New cycle',
  'cycle.updated': 'Cycle updated',
  'module.created': 'New module',
  'module.updated': 'Module updated',
  'time.logged': 'Time logged',
  'intake.created': 'New report',
};

async function deliver(hook: Row, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  const body = bodyFor(hook, event, payload);

  try {
    // `send` rather than `fetch`: the URL on this row is somebody's typing, and
    // the address it resolves to is checked before a packet goes anywhere near
    // it. See `outbound.ts` for why that check has to happen here and not in
    // the form that saved the row.
    const response = await send(String(hook.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Kolibri-Webhook/1',
        'x-kolibri-event': event,
        ...(hook.secret ? { 'x-kolibri-signature': sign(String(hook.secret), body) } : {}),
      },
      body,
      timeoutMs: TIMEOUT_MS,
    });
    const ok = response.status >= 200 && response.status < 300;
    record(hook.id, response.status, ok ? null : `HTTP ${response.status}`);
  } catch (error) {
    // Abort, DNS failure, refused connection — all the same to us: the last
    // attempt is written down and the next event tries again. A refused
    // *address* is said plainly, because "connection failed" would send
    // somebody hunting a firewall for a rule this instance made up.
    const message = error instanceof BlockedAddress
      ? `Refused: ${error.message}`
      : error instanceof Error ? error.message : 'failed';
    record(hook.id, null, message.slice(0, 200));
  }
}

const record = (id: unknown, status: number | null, error: string | null): void => {
  run(
    `UPDATE webhooks SET last_status = ?, last_error = ?, last_sent_at = ? WHERE id = ?`,
    status, error, Date.now(), id,
  );
};
