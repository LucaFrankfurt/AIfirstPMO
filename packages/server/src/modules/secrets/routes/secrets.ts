/**
 * The two things you can do to a secret that you cannot do to any other row:
 * put a value in it, and take one back out.
 *
 * Everything else about a secret — creating it, renaming it, moving it, listing
 * it, deleting it — is the ordinary collection surface every entity gets, and
 * that is deliberate. The label is a row like any other: it syncs, it merges
 * per field, it works offline, it appears in the audit log. Only the value is
 * special, and it is special in exactly one way: it is never in a row.
 *
 * So there are two routes here and they are both about that one column.
 *
 * **A reveal is a POST**, which is the one piece of REST pedantry worth
 * breaking a rule for. A GET is a thing browsers prefetch, proxies cache, and
 * servers write into an access log with its full path; a reveal is an act with
 * a consequence and it should look like one on the wire. It also writes an
 * audit row, and a GET that writes is worse than a POST that reads.
 *
 * **What this protects, precisely.** The value is sealed with a key derived
 * from the instance secret, which lives in `.secret` beside the database and
 * not in it. A copied database, a copied backup, a workspace export, a stolen
 * device mirror and an over-broad API token all come away with nothing. An
 * operator with the whole data directory has both halves and always will — that
 * is what self-hosting means, and the honest thing is to say so on the screen
 * rather than to imply a vault this is not. See `docs/secrets.md`.
 */

import { maskSecret } from '@kolibri/shared';
import { all, get, nextSeq, run, type Row } from '../../../kernel/platform/db/index.ts';
import { requireAuth, requireWorkspace } from '../../../kernel/identity/auth.ts';
import { badRequest, forbidden, notFound, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { seal, unseal } from '../../../kernel/platform/seal.ts';
import { serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { serverClock } from '../../../kernel/write-path/bootstrap.ts';
import { canSeeSecret } from '../rules/secrets.ts';

/**
 * The purpose string this module seals under.
 *
 * Its own, and not the one settings or a mailbox uses: `seal.ts` derives a
 * different key per purpose so that a ciphertext lifted out of one table cannot
 * be opened as a value from another. A vault sharing a key with the SMTP
 * password would be the one place that mattered.
 */
const PURPOSE = 'secret';

/** The largest value worth keeping here. A certificate fits; a file does not. */
const MAX_VALUE = 64 * 1024;

/**
 * The secret this request is about, refused as `not found` where the caller
 * should not know it exists.
 *
 * Not `forbidden`, and the difference is the whole of what a name gives away.
 * "You may not read *Stripe live key*" tells somebody the team has a Stripe
 * account and which environment it is for; "no such secret" tells them nothing
 * they did not bring.
 */
function reachable(ctx: Ctx, userId: string): Row {
  const row = get<Row>(`SELECT * FROM secrets WHERE id = ? AND deleted_at IS NULL`, ctx.params.id);
  if (!row) throw notFound('Secret not found');
  const role = requireWorkspace(ctx, String(row.workspace_id), 'member');
  if (!canSeeSecret(row, userId, role)) throw notFound('Secret not found');
  return row;
}

/**
 * Write down that somebody looked.
 *
 * The point of a vault over a page is not the encryption — it is that reading a
 * credential leaves a mark. Without this, "who has our production key" is
 * answered by asking around.
 *
 * A **private** secret's name is not recorded, only that one was read. The
 * audit log is an admin's screen, and a private secret is the one thing an
 * admin was promised they cannot see; recording `Personal recovery codes` in a
 * log they read every Monday would give away by the back door exactly what the
 * front door refuses.
 */
function audit(secret: Row, actorId: string, verb: string): void {
  run(
    `INSERT INTO activities (id, workspace_id, project_id, secret_id, actor_id, verb, field, old_value, new_value, created_at, updated_at, seq, clocks)
     VALUES (?, ?, ?, ?, ?, ?, 'secret', NULL, ?, ?, ?, ?, '{}')`,
    uid(), secret.workspace_id, secret.project_id ?? null, secret.id, actorId, verb,
    secret.access === 'private' ? null : String(secret.name ?? ''),
    Date.now(), Date.now(), nextSeq(),
  );
}

export function registerSecretRoutes(router: Router): void {
  /**
   * Keep one: the row and its value, in a single call.
   *
   * This is the one entity whose creation cannot be the ordinary collection
   * POST, and the reason is worth writing down because the two-call version was
   * built first and looked right. Every other row is created *optimistically*
   * on the device — the store writes it, the outbox syncs it later, and the
   * screen never waits. So a client that created the row and then asked the
   * server to seal a value for it was asking about a row the server had not
   * heard of yet: `Secret not found`, every time, and a fresh orphan row on
   * every retry.
   *
   * That is not a race to paper over. A secret's value cannot be written
   * offline at all — it has to be sealed with a key that only the server has —
   * so creating one is an act that needs the network, and the honest shape is
   * one request that either happens or does not. The label is still an ordinary
   * row afterwards: it syncs, it merges, it is edited offline like anything
   * else. Only its birth is different.
   */
  router.post('/api/workspaces/:ws/secrets', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');

    const body = await readJson<Record<string, unknown>>(ctx);
    const value = String(body.value ?? '');
    if (!String(body.name ?? '').trim()) throw badRequest('A secret needs a name');
    if (!value) throw badRequest('A secret needs a value');
    if (value.length > MAX_VALUE) throw badRequest('That value is too long to keep here');

    const id = uid();
    /*
     * Two writes, and the split is the whole of what this comment is for.
     *
     * The label is an ordinary write, so the rules see it: a name that
     * collides with another in the same project and environment is refused,
     * and so is an environment the writer may not open. This was one write
     * with `system: true` — needed so `rotated_at` could be set, since it is
     * `serverOnly` — and `system` skips the `guards` hook by design. Which
     * meant the one route that creates secrets was the one route no guard ran
     * on, and every rule written for a secret only ever fired on edits.
     *
     * The rotation stamp is the second write, and that one is genuinely the
     * server's: a client that could backdate it could make an overdue
     * credential look fresh, which is the one number on this screen anybody
     * would want to lie about. The rotate route beside this one has always
     * been shaped that way.
     */
    writeEntity('secret', id, {
      workspace_id: ctx.params.ws,
      project_id: body.project_id ?? null,
      environment_id: body.environment_id ?? null,
      name: String(body.name).trim(),
      description: body.description ?? null,
      kind: body.kind ?? 'password',
      access: body.access ?? 'workspace',
      rotate_after_days: body.rotate_after_days ?? 0,
      created_by: auth.userId,
      archived: 0,
    }, { workspaceId: ctx.params.ws, actorId: auth.userId, hlc: serverClock.now() });
    // After the row exists, so a failure here cannot leave a sealed value
    // hanging off nothing.
    run(`UPDATE secrets SET value = ? WHERE id = ?`, seal(PURPOSE, value), id);
    const { row } = writeEntity('secret', id, { rotated_at: Date.now() }, {
      workspaceId: ctx.params.ws, actorId: auth.userId, hlc: serverClock.now(), system: true,
    });
    audit(row, auth.userId, 'set');
    return { ...serialize('secret', row), preview: maskSecret(value) };
  });

  /**
   * Set the value, or replace it.
   *
   * The same route for both, because they are the same act and the difference
   * is only whether there was something there before — and a separate "rotate"
   * endpoint would be a second place to forget the audit row.
   *
   * `rotated_at` goes through `writeEntity` rather than the `UPDATE` below, so
   * the change reaches every device the way any other field change does: the
   * list can say "rotated an hour ago" without anybody fetching anything. The
   * value goes through the `UPDATE`, because `writeEntity` refuses to write a
   * field the registry does not list, which is exactly the protection wanted.
   */
  router.put('/api/secrets/:id/value', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const secret = reachable(ctx, auth.userId);
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');
    requireWorkspace(ctx, String(secret.workspace_id), 'member');

    const body = await readJson<{ value?: unknown }>(ctx);
    const value = String(body.value ?? '');
    if (!value) throw badRequest('A secret needs a value');
    if (value.length > MAX_VALUE) throw badRequest('That value is too long to keep here');

    run(`UPDATE secrets SET value = ? WHERE id = ?`, seal(PURPOSE, value), secret.id);
    const { row } = writeEntity('secret', String(secret.id), { rotated_at: Date.now() }, {
      workspaceId: String(secret.workspace_id),
      actorId: auth.userId,
      hlc: serverClock.now(),
      system: true,
    });
    audit(secret, auth.userId, secret.value ? 'rotated' : 'set');
    return { ...serialize('secret', row), preview: maskSecret(value) };
  });

  /**
   * Read it back, once, and say so.
   *
   * The response is the value and nothing else that could be cached: no
   * `Last-Modified`, no entity body to re-render from. What the client does with
   * it — show it for thirty seconds, copy it, forget it — is the client's
   * decision, and none of it is a security property. The security property is
   * that it took a request, that the request is in the log, and that the log
   * says who made it.
   *
   * `last_used_at` is written through the entity so it syncs: a secret nobody
   * has touched in a year is the most interesting row in the list.
   */
  router.post('/api/secrets/:id/reveal', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const secret = reachable(ctx, auth.userId);
    // A read scope is enough. Revealing does not change the secret, and a
    // read-only token that could not read the thing it is for would be a token
    // with no purpose.
    if (!secret.value) throw notFound('That secret has no value yet');

    const value = unseal(PURPOSE, String(secret.value));
    // Null means the instance secret changed under it — a restore without the
    // `.secret` file, or `KOLIBRI_SECRET` set after the fact. Said plainly,
    // because the alternative is somebody pasting an empty string into
    // production and wondering.
    if (value === null) throw badRequest('This value cannot be opened with the current instance secret');

    writeEntity('secret', String(secret.id), { last_used_at: Date.now(), last_used_by: auth.userId }, {
      workspaceId: String(secret.workspace_id),
      actorId: auth.userId,
      hlc: serverClock.now(),
      system: true,
      silent: true,
    });
    audit(secret, auth.userId, 'revealed');
    return { value };
  });

  /**
   * Who has read this one, and when.
   *
   * On the secret rather than only in the workspace audit log, because the
   * question is asked about a credential — "who has our production key" — and
   * asking it should not mean paging back through everything that happened in
   * the workspace since. Anybody who may read the secret may read its history:
   * a shared credential is shared, and knowing your colleagues have it is the
   * point.
   */
  router.get('/api/secrets/:id/history', (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const secret = reachable(ctx, auth.userId);
    return {
      entries: all<Row>(
        `SELECT a.id, a.verb, a.actor_id, a.created_at, u.name AS actor_name
           FROM activities a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.secret_id = ? AND a.deleted_at IS NULL
          ORDER BY a.created_at DESC LIMIT 200`,
        secret.id,
      ),
    };
  });
}
