/**
 * The endpoints that exist because messages are not entities.
 *
 * A mailbox syncs like anything else — the client gets the row, the settings
 * screen lists it, the sync filter decides who sees it. Its *messages* do not,
 * and that is a deliberate decision written down in the registry: forty
 * thousand rows per mailbox into every device's mirror is the largest storage
 * cost in the product paid for a search. So there is a search endpoint, a read
 * endpoint and an attachment endpoint, and they all start the same way: resolve
 * which mailboxes this person may read, then constrain on that list.
 *
 * The three writes are here rather than on the generic entity route because
 * none of them is a field. Setting a password is a secret arriving at a route
 * that seals it; testing a connection opens a socket; syncing now is a job. The
 * write path takes patches, and none of these three is one.
 */
import { parseMailQuery, type MailFilter } from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { requireAuth, requireWorkspace } from '../../../kernel/identity/auth.ts';
import { badRequest, forbidden, notFound, readJson, type Ctx, type Router } from '../../../kernel/platform/http.ts';
import { checkMailbox } from '../../../kernel/mail/mailbox.ts';
import { credentialsFor, findMailbox, mailboxView, setPassword, visibleMailboxes } from '../mailboxes.ts';
import { attachmentsOf } from '../store.ts';
import { countMail, narrow, readMessage, searchMail, threadOf } from '../search.ts';
import { mailStats, responseTimes } from '../analytics.ts';
import { rankDocuments } from '../documents.ts';
import { hasMailFetcher, mailFetcher, pollById } from '../poll.ts';

export function registerMailboxRoutes(router: Router): void {
  /** Which mailboxes this person may read, with what the poller last made of each. */
  router.get('/api/workspaces/:ws/mailboxes', (ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    return { mailboxes: visibleMailboxes(auth.userId, ctx.params.ws).map(mailboxView) };
  });

  /**
   * Search, across every mailbox this person may read unless told otherwise.
   *
   * A GET with query parameters rather than a POST with a body, because a
   * search is a thing you link somebody to. `q` takes the same dialect the box
   * on screen does — `from:stripe seit:2024-01 rechnung` — and the named
   * parameters override it, so a saved link and a filled-in form produce the
   * same request.
   */
  router.get('/api/workspaces/:ws/mail', (ctx) => {
    const { auth, workspaceId, mailboxes } = scope(ctx);
    const filter = filterFrom(ctx);
    const ids = narrow(mailboxes, filter.mailboxes);
    const options = { workspaceId, mailboxIds: ids, filter };
    return {
      total: countMail(options),
      messages: searchMail({
        ...options,
        limit: Number(ctx.query.get('limit') ?? 25),
        offset: Number(ctx.query.get('offset') ?? 0),
      }).map(messageView),
      // Which mailboxes were actually searched, so a caller can tell "nothing
      // there" from "you cannot see the mailbox you named".
      searched: mailboxes.filter((row) => ids.includes(String(row.id))).map((row) => String(row.address)),
      actor: auth.userId,
    };
  });

  /**
   * The document hunt: the same ranking `find_documents` returns over MCP.
   *
   * The same call rather than a similar one, because the screen is how somebody
   * checks the assistant's answer — and a ranking that differs between the two
   * is a check that proves nothing.
   */
  router.get('/api/workspaces/:ws/mail-documents', (ctx) => {
    const { workspaceId, mailboxes } = scope(ctx);
    const filter = filterFrom(ctx);
    const mailboxIds = narrow(mailboxes, filter.mailboxes);
    const { considered, ranked } = rankDocuments({
      workspaceId, mailboxIds, filter, limit: Number(ctx.query.get('limit') ?? 50),
    });
    return {
      considered,
      candidates: ranked.map((one) => ({
        ...messageView(one.message),
        score: one.score,
        why: one.why,
        documents: one.documents,
        other_files: one.files.filter((name) => !one.documents.includes(name)),
      })),
    };
  });

  /** One message, with its body and what was attached to it. */
  router.get('/api/workspaces/:ws/mail/:id', (ctx) => {
    const { workspaceId, mailboxes } = scope(ctx);
    const message = readMessage(workspaceId, mailboxes.map((row) => String(row.id)), ctx.params.id);
    if (!message) throw notFound('No such message');
    const attachments = attachmentsOf([String(message.id)]).get(String(message.id)) ?? [];
    return {
      ...messageView(message),
      body: String(message.body ?? ''),
      attachments: attachments.map(attachmentView),
    };
  });

  /** The whole conversation, across every mailbox it touched. */
  router.get('/api/workspaces/:ws/mail/:id/thread', (ctx) => {
    const { workspaceId, mailboxes } = scope(ctx);
    const ids = mailboxes.map((row) => String(row.id));
    const message = readMessage(workspaceId, ids, ctx.params.id);
    if (!message) throw notFound('No such message');
    return { messages: threadOf(workspaceId, ids, String(message.thread_key)).map(messageView) };
  });

  /**
   * The bytes of one attachment, fetched from the mail server now.
   *
   * Not stored here — see the note on `mail_attachments`. Which means this
   * endpoint is as slow as the mail server is and can fail when it is down,
   * and both of those are better than holding a second copy of every invoice
   * anybody has ever been sent.
   */
  router.get('/api/workspaces/:ws/mail/:id/attachments/:attachmentId', async (ctx) => {
    const { workspaceId, mailboxes } = scope(ctx);
    const message = readMessage(workspaceId, mailboxes.map((row) => String(row.id)), ctx.params.id);
    if (!message) throw notFound('No such message');
    const attachment = get<Row>(
      `SELECT * FROM mail_attachments WHERE id = ? AND message_id = ?`,
      ctx.params.attachmentId, String(message.id),
    );
    if (!attachment) throw notFound('No such attachment');
    const mailbox = mailboxes.find((row) => String(row.id) === String(message.mailbox_id));
    const config = mailbox && credentialsFor(mailbox);
    if (!config || !hasMailFetcher()) throw badRequest('That mailbox cannot be reached right now');

    const bytes = await mailFetcher().fetchPart(
      config, String(message.folder), Number(message.uid), String(attachment.part),
    );
    ctx.res.writeHead(200, {
      'content-type': String(attachment.mime),
      'content-length': String(bytes.length),
      // `attachment`, always. These bytes came from a stranger's email, and an
      // HTML part rendered inline would run their script on this origin.
      'content-disposition': `attachment; filename="${String(attachment.filename).replace(/["\\\r\n]/g, '')}"`,
    });
    ctx.res.end(bytes);
    return undefined;
  });

  /** The numbers: volume, senders, months, and how fast anybody answers. */
  router.get('/api/workspaces/:ws/mail-stats', (ctx) => {
    const { workspaceId, mailboxes } = scope(ctx);
    const filter = filterFrom(ctx);
    const ids = narrow(mailboxes, filter.mailboxes);
    const options = { workspaceId, mailboxIds: ids, since: filter.since, until: filter.until };
    return {
      ...mailStats(options),
      response: responseTimes(
        options,
        mailboxes.filter((row) => ids.includes(String(row.id))).map((row) => String(row.address)),
      ),
    };
  });

  /**
   * The password, on its way in and never on its way out.
   *
   * Admin-only, and a separate route from the mailbox row for the reason the
   * registry gives: `password` is a `secret`, so the generic write path will
   * not accept it, and that refusal is what keeps a credential off the sync
   * feed. Setting it also clears any recorded failure — the common case is
   * exactly "the password changed", and leaving the mailbox in its backoff
   * after somebody has fixed it makes the fix look like it did not work.
   */
  router.post('/api/workspaces/:ws/mailboxes/:id/password', async (ctx) => {
    const { auth, mailbox } = admin(ctx);
    const body = await readJson<{ password?: string }>(ctx);
    const password = String(body.password ?? '');
    if (!password) throw badRequest('A password is needed to sign in to a mailbox');
    const wrong = checkMailbox({ ...rowConfig(mailbox), password });
    if (wrong) throw badRequest(wrong);
    setPassword(String(mailbox.id), password, auth.userId);
    return { ok: true };
  });

  /** Sign in and hang up, so somebody knows before they wait five minutes. */
  router.post('/api/workspaces/:ws/mailboxes/:id/test', async (ctx) => {
    const { mailbox } = admin(ctx);
    const config = credentialsFor(mailbox);
    if (!config) throw badRequest('No password stored for this mailbox');
    if (!hasMailFetcher()) throw badRequest('This build has no mail transport');
    try {
      await mailFetcher().check(config);
      return { ok: true };
    } catch (error) {
      // The provider's own words, which are the useful part: "AUTHENTICATIONFAILED"
      // and "application password required" are two different afternoons.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /** Poll now rather than in five minutes. */
  router.post('/api/workspaces/:ws/mailboxes/:id/sync', async (ctx) => {
    const { mailbox } = admin(ctx);
    if (!hasMailFetcher()) throw badRequest('This build has no mail transport');
    return pollById(String(mailbox.id));
  });
}

/* ----------------------------------------------------------------- helpers */

/** Signed in, a member, and the mailboxes they may read. Every read starts here. */
function scope(ctx: Ctx): { auth: ReturnType<typeof requireAuth>; workspaceId: string; mailboxes: Row[] } {
  const auth = requireAuth(ctx);
  const workspaceId = ctx.params.ws;
  requireWorkspace(ctx, workspaceId, 'member');
  return { auth, workspaceId, mailboxes: visibleMailboxes(auth.userId, workspaceId) };
}

/**
 * The three writes, which are an admin's and are also *readable* by them.
 *
 * `findMailbox` goes through the visibility rule, so an admin who is not on a
 * restricted mailbox's member list cannot set its password or sync it either.
 * That is the same line the entity rule draws and it is drawn on purpose: an
 * admin may remove themselves from a mailbox, and what that has to mean is that
 * they are out of it — including out of the part that would let them quietly
 * point it somewhere they can read.
 */
function admin(ctx: Ctx): { auth: ReturnType<typeof requireAuth>; mailbox: Row } {
  const auth = requireAuth(ctx);
  const role = requireWorkspace(ctx, ctx.params.ws, 'admin');
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace owner or admin may change a mailbox');
  const mailbox = findMailbox(ctx.params.id, auth.userId, ctx.params.ws);
  if (!mailbox) throw notFound('No such mailbox');
  return { auth, mailbox };
}

const rowConfig = (row: Row) => ({
  host: String(row.host ?? ''),
  port: Number(row.port ?? 993),
  encryption: String(row.encryption ?? 'tls') as 'none' | 'starttls' | 'tls',
  username: String(row.username ?? ''),
});

/** `?q=` in the box's own dialect, with named parameters winning over it. */
function filterFrom(ctx: Ctx): MailFilter {
  const filter = parseMailQuery(ctx.query.get('q') ?? '');
  for (const [param, key] of [['from', 'from'], ['to', 'to'], ['subject', 'subject'], ['since', 'since'], ['until', 'until'], ['file', 'filename']] as const) {
    const value = ctx.query.get(param);
    if (value) (filter as Record<string, unknown>)[key] = value;
  }
  const mailbox = ctx.query.getAll('mailbox');
  if (mailbox.length) filter.mailboxes = mailbox;
  if (ctx.query.get('attachments') === 'true') filter.hasAttachment = true;
  if (ctx.query.get('unread') === 'true') filter.unread = true;
  return filter;
}

/** A row as a result-list entry: the JSON columns parsed, the body left behind. */
export function messageView(row: Row) {
  return {
    id: String(row.id),
    mailbox_id: String(row.mailbox_id),
    mailbox: String(row.mailbox_address ?? ''),
    folder: String(row.folder ?? 'INBOX'),
    message_id: String(row.message_id ?? ''),
    thread_key: String(row.thread_key ?? ''),
    subject: String(row.subject ?? ''),
    from_name: String(row.from_name ?? ''),
    from_address: String(row.from_address ?? ''),
    to_addresses: jsonList(row.to_addresses),
    cc_addresses: jsonList(row.cc_addresses),
    sent_at: Number(row.sent_at ?? 0),
    seen: Number(row.seen ?? 0),
    has_attachments: Number(row.has_attachments ?? 0),
    size: Number(row.size ?? 0),
    snippet: String(row.snippet ?? ''),
  };
}

export const attachmentView = (row: Row) => ({
  id: String(row.id),
  message_id: String(row.message_id),
  filename: String(row.filename ?? ''),
  mime: String(row.mime ?? 'application/octet-stream'),
  size: Number(row.size ?? 0),
  part: String(row.part ?? '1'),
});

const jsonList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};
