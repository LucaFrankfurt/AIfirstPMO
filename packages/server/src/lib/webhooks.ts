/**
 * The way out.
 *
 * Rules act inwards — they file tasks in Kolibri. A webhook is the other
 * direction: something happened, tell a machine somewhere else. It is the
 * generic answer to "integrate with GitHub / Slack / whatever", and it is a
 * couple of hundred lines rather than one integration per service.
 *
 * Still fire-and-forget from the caller's side: a slow receiver must not slow
 * down the person who pressed the button, and a webhook that can fail a write
 * is a webhook that takes the app down when somebody else's endpoint dies.
 *
 * What changed is what happens after the first attempt. A dropped chat message
 * is a shrug; a dropped event is a workflow that quietly did not run, which is
 * the kind of failure nobody notices until the month is over. So every call out
 * is a row in `webhook_deliveries`, retried with a widening gap, and readable
 * afterwards — the same queue shape `email_queue` already uses, for the same
 * reason and with the same failure classification.
 */
import { createHmac } from 'node:crypto';
import type { WebhookEvent } from '@kolibri/shared';
import { all, get, run, type Row } from '../db/index.ts';
import { env } from '../env.ts';
import { uid } from './ids.ts';
import { BlockedAddress, send } from './outbound.ts';

// The list itself is in `@kolibri/shared`: the screen that offers the
// checkboxes and the code that fires them have to agree, and they used to
// agree by having been typed twice.
export { WEBHOOK_EVENTS, type WebhookEvent } from '@kolibri/shared';

const TIMEOUT_MS = 5_000;

/**
 * Five tries and then it stops.
 *
 * Long enough to sit out a deploy or a restart on the other end — the gaps are
 * 2, 4, 8 and 16 minutes — and short enough that a receiver which has been
 * gone all week is not still being called on Friday. Anything past that is not
 * a blip, and the row says so where somebody can read it.
 */
const MAX_ATTEMPTS = 5;

/** Doubling minutes, capped: the same curve the mail queue climbs. */
const backoff = (attempts: number): number => Math.min(2 ** attempts, 60) * 60_000;

/** Sent so a receiver can verify the body really came from this instance. */
export const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Queue one event for whoever asked for it.
 *
 * The rows are written synchronously — inside the caller's transaction, if
 * there is one, so a rollback takes the queue back with the writes — and the
 * sending starts right after, off the caller's thread.
 */
export function dispatch(workspaceId: string, event: WebhookEvent, payload: Record<string, unknown>): void {
  const hooks = all<Row>(
    `SELECT * FROM webhooks
      WHERE workspace_id = ? AND enabled = 1 AND direction = 'out' AND deleted_at IS NULL`,
    workspaceId,
  ).filter((hook) => String(hook.events ?? '').split(',').map((name) => name.trim()).includes(event));
  if (!hooks.length) return;

  const projectId = payload.project_id;
  const queued: string[] = [];
  for (const hook of hooks) {
    // A hook scoped to a project only hears about that project.
    if (hook.project_id && hook.project_id !== projectId) continue;
    const now = Date.now();
    const id = uid();
    run(
      `INSERT INTO webhook_deliveries (id, workspace_id, webhook_id, event, body, send_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, workspaceId, hook.id, event, bodyFor(hook, event, payload), now, now,
    );
    queued.push(id);
  }
  // Each one goes now and goes on its own: two receivers are two conversations,
  // and one of them being slow is not a reason the other waits five seconds.
  for (const id of queued) void sendOne(id);
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
  const link = payload.url ? `\n${payload.url}` : '';
  const who = payload.actor ? ` — ${payload.actor}` : '';
  const text = `*${LABEL[event] ?? event}*: ${identifier}${title}${who}${link}`;

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

/* ------------------------------------------------------------- the sending */

/**
 * How long an attempt may hold a row before anybody else may have it.
 *
 * A claim rather than a lock: `send_after` is pushed past the request's own
 * timeout, so two passes cannot send the same delivery twice, and a process
 * that dies mid-attempt leaves a row that becomes due again by itself instead
 * of one that is held forever by a worker that no longer exists.
 */
const CLAIM_MS = TIMEOUT_MS * 3;

/**
 * Take one delivery, or find that somebody else already has it.
 *
 * The `WHERE` clause is the whole of the mutual exclusion: SQLite applies the
 * update to one row or to none, and `changes` says which happened.
 */
function claim(id: string, now: number): Row | undefined {
  const taken = run(
    `UPDATE webhook_deliveries SET send_after = ?
      WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL AND send_after <= ?`,
    now + CLAIM_MS, id, now,
  );
  if (Number(taken.changes ?? 0) !== 1) return undefined;
  return get<Row>(`SELECT * FROM webhook_deliveries WHERE id = ?`, id);
}

/** One delivery, if it is still there to be had. */
async function sendOne(id: string, now = Date.now()): Promise<boolean> {
  const row = claim(id, now);
  return row ? attempt(row, now) : false;
}

/**
 * One worker pass: everything that is due, at the same time.
 *
 * Called by the scheduler's hourly sweep, so a process that restarted in the
 * middle of a backoff picks the retry up again. Nothing here is exclusive with
 * a delivery being sent right now — the claim above settles that.
 */
export async function flushDeliveries(now = Date.now(), limit = 50): Promise<{ sent: number; failed: number }> {
  const due = all<Row>(
    `SELECT id FROM webhook_deliveries
      WHERE sent_at IS NULL AND failed_at IS NULL AND send_after <= ?
      ORDER BY send_after LIMIT ?`,
    now, limit,
  );

  const results = await Promise.all(due.map((row) => sendOne(String(row.id), now)));
  return { sent: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
}

/** True if it arrived. Everything a caller needs to know is on the row after. */
async function attempt(row: Row, now: number): Promise<boolean> {
  const hook = get<Row>(`SELECT * FROM webhooks WHERE id = ? AND deleted_at IS NULL`, row.webhook_id);
  // The hook was deleted or switched off while this sat in the queue. Not a
  // failure — somebody decided — so the row is closed rather than retried.
  if (!hook || !hook.enabled) {
    run(`UPDATE webhook_deliveries SET failed_at = ?, last_error = ? WHERE id = ?`, now, 'Hook is gone', row.id);
    return false;
  }

  const attempts = Number(row.attempts ?? 0) + 1;
  const body = String(row.body);
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
        'x-kolibri-event': String(row.event),
        // The id is the same across retries, so a receiver can tell a second
        // attempt from a second event and act once — the whole of what makes
        // retrying safe on their side.
        'x-kolibri-delivery': String(row.id),
        ...(hook.secret ? { 'x-kolibri-signature': sign(String(hook.secret), body) } : {}),
      },
      body,
      timeoutMs: TIMEOUT_MS,
    });

    // A redirect was followed as a GET with no body, which is the only safe
    // shape and also a 404 waiting to happen: an n8n webhook node answers POST
    // and nothing else. Nobody deduces that from "HTTP 404", so the sentence
    // says where the request ended up.
    const where = response.redirectedTo ? ` after a redirect to ${response.redirectedTo}` : '';
    const ok = response.status >= 200 && response.status < 300;
    if (ok) {
      run(
        `UPDATE webhook_deliveries SET attempts = ?, status = ?, last_error = NULL, sent_at = ? WHERE id = ?`,
        attempts, response.status, Date.now(), row.id,
      );
      record(hook.id, response.status, null);
      return true;
    }
    // 4xx is this request, and it will be the same request next time: a 404 is
    // an endpoint that moved and a 401 is a secret that does not match. 429 and
    // 5xx are a bad moment on the other end, which is what retrying is for.
    return giveUpOrRetry(row, hook, attempts, response.status, `HTTP ${response.status}${where}`,
      response.status !== 429 && response.status < 500);
  } catch (error) {
    // A refused *address* is said plainly and never retried: nothing about the
    // next attempt would be different, and "connection failed" would send
    // somebody hunting a firewall for a rule this instance made up.
    const blocked = error instanceof BlockedAddress;
    const message = blocked
      ? `Refused: ${error.message}`
      : error instanceof Error ? error.message : 'failed';
    return giveUpOrRetry(row, hook, attempts, null, message, blocked);
  }
}

function giveUpOrRetry(
  row: Row,
  hook: Row,
  attempts: number,
  status: number | null,
  message: string,
  permanent: boolean,
): boolean {
  const giveUp = permanent || attempts >= MAX_ATTEMPTS;
  const nextTry = Date.now() + backoff(attempts);
  run(
    `UPDATE webhook_deliveries SET attempts = ?, status = ?, last_error = ?, send_after = ?, failed_at = ? WHERE id = ?`,
    attempts, status, message.slice(0, 200), nextTry, giveUp ? Date.now() : null, row.id,
  );
  record(hook.id, status, message.slice(0, 200));

  // Prompt where it matters and durable where it counts: the timer covers the
  // next few minutes, and the scheduler's sweep covers a restart in the middle
  // of them. `unref` so a pending retry never holds the process open.
  if (!giveUp) setTimeout(() => { void sendOne(String(row.id)); }, backoff(attempts)).unref();
  return false;
}

/** The hook's own summary line, which is what the settings screen reads. */
const record = (id: unknown, status: number | null, error: string | null): void => {
  run(
    `UPDATE webhooks SET last_status = ?, last_error = ?, last_sent_at = ? WHERE id = ?`,
    status, error, Date.now(), id,
  );
};

/* -------------------------------------------------------------- the test */

/**
 * Send a hook one message on purpose, and say what came back.
 *
 * Every other integration on that settings screen has a button beside it that
 * actually tries the thing — a message through the relay, `getMe` against the
 * token, one question to the model. A webhook had none, so the only way to
 * find out whether a URL was right was to go and change a task.
 *
 * `ping` is deliberately not a `WEBHOOK_EVENTS` name and not a delivery row:
 * nothing happened in the workspace, and a log of real events is more useful
 * for being only that. It is signed like everything else, so it also proves
 * the receiver's signature check against the secret it has.
 */
export async function testHook(hook: Row): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const body = JSON.stringify({
    event: 'ping',
    at: Date.now(),
    instance: env.publicUrl || null,
    data: { hook: hook.id, name: hook.name ?? '' },
  });

  try {
    const response = await send(String(hook.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Kolibri-Webhook/1',
        'x-kolibri-event': 'ping',
        ...(hook.secret ? { 'x-kolibri-signature': sign(String(hook.secret), body) } : {}),
      },
      body,
      timeoutMs: TIMEOUT_MS,
    });
    const where = response.redirectedTo ? ` after a redirect to ${response.redirectedTo}` : '';
    const ok = response.status >= 200 && response.status < 300;
    // The receiver's own words, when it had any: an n8n webhook that is not
    // listening says so in its body, and that sentence is worth more than the
    // status code above it.
    const said = response.body.trim().slice(0, 200);
    return {
      ok,
      status: response.status,
      detail: `HTTP ${response.status}${where}${!ok && said ? `: ${said}` : ''}`,
    };
  } catch (error) {
    const detail = error instanceof BlockedAddress
      ? `Refused: ${error.message}`
      : error instanceof Error ? error.message : 'failed';
    return { ok: false, status: null, detail };
  }
}

/* --------------------------------------------------------------- the log */

/** The last so many calls out, newest first. Admins only — see the route. */
export const deliveriesOf = (webhookId: string, limit = 20): Row[] =>
  all<Row>(
    `SELECT id, event, status, attempts, last_error, send_after, sent_at, failed_at, created_at
       FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?`,
    webhookId, Math.min(Math.max(1, limit), 100),
  );

/**
 * Send one again, on purpose.
 *
 * The stored body goes back out unchanged, which is the point: what is being
 * replayed is the event as it was, not the task as it has since become. The
 * attempt count carries on rather than resetting, so the row still says how
 * much trouble this delivery has been.
 */
export function replayDelivery(id: string): Row | undefined {
  const row = get<Row>(`SELECT * FROM webhook_deliveries WHERE id = ?`, id);
  if (!row) return undefined;
  // Due a moment ago rather than exactly now: the claim asks for `send_after <=
  // now`, and two calls to `Date.now()` a microsecond apart are not ordered the
  // way that reads.
  const now = Date.now();
  run(
    `UPDATE webhook_deliveries SET sent_at = NULL, failed_at = NULL, send_after = ?, attempts = 0 WHERE id = ?`,
    now - 1, id,
  );
  void sendOne(id, now);
  return get<Row>(`SELECT * FROM webhook_deliveries WHERE id = ?`, id);
}

/**
 * Keep the log a log rather than an archive.
 *
 * A busy workspace with a chatty hook writes thousands of these a week, and
 * none of them is worth keeping once somebody has had the chance to look. Two
 * weeks, or the hundred newest per hook, whichever leaves less.
 */
export function pruneDeliveries(now = Date.now(), days = 14, keepPerHook = 100): number {
  const before = now - days * 86_400_000;
  const cleared = run(`DELETE FROM webhook_deliveries WHERE created_at < ?`, before).changes ?? 0;
  const trimmed = run(
    `DELETE FROM webhook_deliveries WHERE id IN (
       SELECT id FROM webhook_deliveries d
        WHERE (SELECT count(*) FROM webhook_deliveries n
                WHERE n.webhook_id = d.webhook_id AND n.created_at > d.created_at) >= ?
     )`,
    keepPerHook,
  ).changes ?? 0;
  return Number(cleared) + Number(trimmed);
}
