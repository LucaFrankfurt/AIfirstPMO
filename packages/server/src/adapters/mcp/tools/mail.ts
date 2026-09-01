/**
 * The eight tools that make four shared inboxes answerable.
 *
 * The scenario these were built against: `support@`, `info@` and `admin@` on
 * one domain, and the question "find everything the accountant needs for 2024".
 * Answering it by hand means signing in to three mailboxes, searching each
 * with a different idea of what a date is, and hoping. What it needs instead is
 * one search across all three, a way to rank what came back, and the numbers to
 * say when the answer is incomplete.
 *
 * Three decisions shape the group:
 *
 * **Every tool starts from `visibleMailboxes`.** Not one of them takes a
 * mailbox id and trusts it. A restricted mailbox is invisible to a token whose
 * account is not on its list, including to a workspace admin's — the same line
 * the sync filter and the REST routes draw, drawn once more here rather than
 * assumed to have been drawn already.
 *
 * **Nothing writes to a mail server.** There is no send, no reply, no mark-as-
 * read and no delete, and the IMAP session is opened with `EXAMINE` so the
 * server itself would refuse them. An assistant that can search an inbox is
 * useful; one that can answer from it is a different product with a different
 * consent conversation. What `file_mail_as_task` does instead is the Kolibri
 * half: the message becomes work, in a project, where somebody decides.
 *
 * **`find_documents` ranks and does not filter.** It returns a score and the
 * evidence behind it and leaves the judgement to the model that asked, because
 * what counts as tax-relevant is a question about a business — see
 * `scoreDocument`, where the argument is made at length.
 */
import { parseMailQuery, type MailFilter } from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { mailboxView, visibleMailboxes } from '../../../modules/mail/mailboxes.ts';
import { hasMailFetcher, pollById } from '../../../modules/mail/poll.ts';
import { attachmentsOf } from '../../../modules/mail/store.ts';
import { countMail, narrow, readMessage, searchMail, threadOf } from '../../../modules/mail/search.ts';
import { rankDocuments } from '../../../modules/mail/documents.ts';
import { mailStats, responseTimes } from '../../../modules/mail/analytics.ts';
import { findProject, McpError, requireFeature, requireWrite, str, taskView, type ToolDef, workspaceOf } from '../kit.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { serverClock } from '../../../kernel/write-path/bootstrap.ts';
import { writeEntity } from '../../../kernel/write-path/repo.ts';

/** The mailboxes this call may read, having checked the feature is on. */
function mailScope(args: Record<string, any>, ctx: Parameters<ToolDef['run']>[1]) {
  const workspaceId = workspaceOf(args, ctx);
  requireFeature(workspaceId, 'mail');
  const mailboxes = visibleMailboxes(ctx.auth.userId, workspaceId);
  if (!mailboxes.length) {
    throw new McpError(
      'No mailbox is connected that this account may read (Settings → Mailboxes)',
      -32000,
    );
  }
  return { workspaceId, mailboxes };
}

/**
 * The filter, from named arguments and from a query string, with named winning.
 *
 * Both are offered because an assistant relaying somebody's words has a
 * sentence — "everything from the Steuerberater since January" — and an
 * assistant that has already decided has fields. `query` takes the same dialect
 * the box on screen does, German prefixes included, so a person can paste what
 * they typed there.
 */
function filterOf(args: Record<string, any>): MailFilter {
  const filter = parseMailQuery(str(args.query) ?? '');
  if (str(args.from)) filter.from = str(args.from);
  if (str(args.to)) filter.to = str(args.to);
  if (str(args.subject)) filter.subject = str(args.subject);
  if (str(args.since)) filter.since = str(args.since);
  if (str(args.until)) filter.until = str(args.until);
  if (str(args.filename)) filter.filename = str(args.filename);
  if (str(args.text)) filter.text = str(args.text);
  if (args.has_attachment === true) filter.hasAttachment = true;
  if (args.unread === true) filter.unread = true;
  const named = Array.isArray(args.mailboxes) ? args.mailboxes.map(String) : str(args.mailbox) ? [str(args.mailbox)!] : [];
  if (named.length) filter.mailboxes = named;
  return filter;
}

/** The compact shape a result list uses. Never the body — see `get_mail`. */
const hitView = (row: Row) => ({
  id: String(row.id),
  mailbox: String(row.mailbox_address ?? ''),
  subject: String(row.subject ?? ''),
  from: String(row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address ?? ''),
  to: safeList(row.to_addresses),
  sent_at: new Date(Number(row.sent_at ?? 0)).toISOString(),
  has_attachments: !!Number(row.has_attachments),
  seen: !!Number(row.seen),
  snippet: String(row.snippet ?? ''),
  thread_key: String(row.thread_key ?? ''),
});

const safeList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** The filter arguments every searching tool shares. */
const FILTER_PROPERTIES = {
  query: { type: 'string', description: 'The search box dialect: `from:stripe seit:2024-01 rechnung`. German prefixes work too (von, betreff, seit, bis, anhang).' },
  text: { type: 'string', description: 'Words to find in the subject, body or attachment names.' },
  from: { type: 'string', description: 'Sender, as a substring of the address or the display name.' },
  to: { type: 'string', description: 'Any recipient, To or Cc, as a substring.' },
  subject: { type: 'string', description: 'Subject substring.' },
  since: { type: 'string', description: 'ISO date, inclusive. A bare year or month works: 2024, 2024-03.' },
  until: { type: 'string', description: 'ISO date, inclusive to the end of that day.' },
  filename: { type: 'string', description: 'Attachment filename substring, e.g. `.pdf` or `rechnung`.' },
  has_attachment: { type: 'boolean', description: 'Only messages carrying a file.' },
  unread: { type: 'boolean', description: 'Only messages unread as of the last poll.' },
  mailboxes: { type: 'array', items: { type: 'string' }, description: 'Addresses or ids. Omitted, every mailbox this account may read.' },
  workspace_id: { type: 'string' },
} as const;

export const mailTools: ToolDef[] = [
  {
    name: 'list_mailboxes',
    title: 'Connected mailboxes',
    description:
      'Which mail accounts this workspace has connected and this account may read, with how fresh each copy is. Worth calling first: a search covers only these, and a mailbox that last synced three weeks ago will not have last week\'s invoice.',
    readOnly: true,
    schema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const { mailboxes } = mailScope(args, ctx);
      return {
        mailboxes: mailboxes.map(mailboxView).map((box) => ({
          address: box.address,
          name: box.name,
          messages: box.message_count,
          access: box.access,
          enabled: !!box.enabled,
          last_sync_at: box.last_sync_at ? new Date(box.last_sync_at).toISOString() : null,
          status: box.last_status,
          // The error verbatim. "AUTHENTICATIONFAILED" and "application
          // password required" are two different afternoons, and paraphrasing
          // them into "sync failed" loses the half that says what to do.
          error: box.last_error,
        })),
      };
    },
  },
  {
    name: 'search_mail',
    title: 'Search the mailboxes',
    description:
      'One search across every connected mailbox, or the ones named. Returns the newest matches with a snippet each and the total behind them — ask for the body with get_mail once you know which message you want.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        limit: { type: 'number', description: 'Up to 200. Default 25.' },
        offset: { type: 'number', description: 'For walking a long result set.' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const filter = filterOf(args);
      const mailboxIds = narrow(mailboxes, filter.mailboxes);
      const options = { workspaceId, mailboxIds, filter };
      const total = countMail(options);
      const messages = searchMail({ ...options, limit: Number(args.limit) || 25, offset: Number(args.offset) || 0 });
      return {
        total,
        showing: messages.length,
        // Named rather than counted, so an answer can say *which* inboxes were
        // covered. "Nothing found" and "you cannot see the inbox you asked
        // about" are different answers and this is what tells them apart.
        searched: mailboxes.filter((row) => mailboxIds.includes(String(row.id))).map((row) => String(row.address)),
        messages: messages.map(hitView),
      };
    },
  },
  {
    name: 'get_mail',
    title: 'Read one message',
    description: 'The full text of one message, with its recipients and what was attached. Attachment bytes are not returned — list_mail_attachments gives the link a person can download them from.',
    readOnly: true,
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const message = readMessage(workspaceId, mailboxes.map((row) => String(row.id)), String(args.id));
      if (!message) throw new McpError('No such message, or it is in a mailbox this account may not read');
      const attachments = attachmentsOf([String(message.id)]).get(String(message.id)) ?? [];
      return {
        ...hitView(message),
        cc: safeList(message.cc_addresses),
        folder: String(message.folder),
        body: String(message.body ?? ''),
        attachments: attachments.map((row) => ({
          id: String(row.id),
          filename: String(row.filename),
          mime: String(row.mime),
          size: Number(row.size),
        })),
      };
    },
  },
  {
    name: 'mail_thread',
    title: 'The whole conversation',
    description:
      'Every message in the same thread as this one, oldest first, across every mailbox it touched — a conversation that started in info@ and was forwarded to admin@ comes back as one, which is what a mail client cannot do.',
    readOnly: true,
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const ids = mailboxes.map((row) => String(row.id));
      const message = readMessage(workspaceId, ids, String(args.id));
      if (!message) throw new McpError('No such message, or it is in a mailbox this account may not read');
      const thread = threadOf(workspaceId, ids, String(message.thread_key));
      return {
        // A message whose sender gave it no `Message-ID` and no `References` is
        // a thread of one, and saying so is better than returning it alone and
        // letting the caller believe nobody ever replied.
        threaded: !!message.thread_key,
        messages: (thread.length ? thread : [message]).map(hitView),
      };
    },
  },
  {
    name: 'find_documents',
    title: 'Find invoices, receipts and statements',
    description:
      'The tax-folder search: ranks messages by how likely they are to carry a document worth filing — invoices, receipts, credit notes, bank statements, VAT — in German and English, and returns the evidence for each so you can judge rather than trust the score. Narrow it with since/until to a financial year. This ranks; it does not decide. Read the ones it returns.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        limit: { type: 'number', description: 'How many candidates to rank. Default 50, up to 200.' },
        attachments_only: { type: 'boolean', description: 'Skip messages with nothing attached. Off by default — a payment confirmation with the figures in the body is a document too.' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const filter = filterOf(args);
      if (args.attachments_only === true) filter.hasAttachment = true;
      const mailboxIds = narrow(mailboxes, filter.mailboxes);
      const { considered, ranked } = rankDocuments({
        workspaceId, mailboxIds, filter, limit: Number(args.limit) || 50,
      });
      return {
        considered,
        searched: mailboxes.filter((row) => mailboxIds.includes(String(row.id))).map((row) => String(row.address)),
        // Said out loud rather than left to be inferred: the copy only goes as
        // far back as the poller has reached, so an empty 2019 is as likely to
        // mean "not fetched" as "nothing there".
        note: 'Ranked by heuristic, not decided. The copy reaches only as far back as each mailbox has been polled — check list_mailboxes if a period looks empty.',
        candidates: ranked.map((one) => ({
          ...hitView(one.message),
          score: one.score,
          why: one.why,
          documents: one.documents,
          other_files: one.files.filter((name) => !one.documents.includes(name)),
        })),
      };
    },
  },
  {
    name: 'list_mail_attachments',
    title: 'Files across the mailboxes',
    description:
      'Every attachment matching a filter, as a flat list rather than one message at a time — "every PDF from the Steuerberater in 2024" in one call. The bytes stay on the mail server; each entry carries the message it is in so a person can open it.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: { ...FILTER_PROPERTIES, limit: { type: 'number', description: 'Default 100, up to 500.' } },
    },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const filter = filterOf(args);
      filter.hasAttachment = true;
      const mailboxIds = narrow(mailboxes, filter.mailboxes);
      const messages = searchMail({ workspaceId, mailboxIds, filter, limit: 200 });
      const byMessage = attachmentsOf(messages.map((row) => String(row.id)));
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);

      const files: Record<string, unknown>[] = [];
      for (const message of messages) {
        for (const file of byMessage.get(String(message.id)) ?? []) {
          if (files.length >= limit) break;
          files.push({
            filename: String(file.filename),
            mime: String(file.mime),
            size: Number(file.size),
            mailbox: String(message.mailbox_address ?? ''),
            subject: String(message.subject ?? ''),
            from: String(message.from_address ?? ''),
            sent_at: new Date(Number(message.sent_at ?? 0)).toISOString(),
            message_id: String(message.id),
            attachment_id: String(file.id),
          });
        }
      }
      return { total: files.length, files };
    },
  },
  {
    name: 'mail_stats',
    title: 'The numbers over the mailboxes',
    description:
      'Volume by mailbox, by month, by weekday; who writes most and from which companies; and how fast anybody answers. Every figure covers only what has been polled — the window it actually spans comes back with it.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        since: FILTER_PROPERTIES.since,
        until: FILTER_PROPERTIES.until,
        mailboxes: FILTER_PROPERTIES.mailboxes,
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      const filter = filterOf(args);
      const mailboxIds = narrow(mailboxes, filter.mailboxes);
      const options = { workspaceId, mailboxIds, since: filter.since, until: filter.until };
      const covered = mailboxes.filter((row) => mailboxIds.includes(String(row.id)));
      return {
        ...mailStats(options),
        response: responseTimes(options, covered.map((row) => String(row.address))),
        searched: covered.map((row) => String(row.address)),
      };
    },
  },
  {
    name: 'sync_mailbox',
    title: 'Fetch new mail now',
    description:
      'Poll one mailbox immediately instead of waiting for the next five-minute round, and report how many messages that brought in. Worth calling before answering "did it arrive yet" — every other tool here reads a copy, and the copy is as old as list_mailboxes says it is. It fetches; it still cannot send, reply or delete.',
    schema: {
      type: 'object',
      required: ['mailbox'],
      properties: {
        mailbox: { type: 'string', description: 'Address or id, from list_mailboxes.' },
        workspace_id: { type: 'string' },
      },
    },
    run: async (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      // A write scope, even though nothing in Kolibri changes and nothing on
      // the mail server does either. What it does do is make this instance open
      // a connection to somebody else's server on demand — which is an outbound
      // effect a read-only token should not be able to trigger at will.
      requireWrite(ctx, workspaceId);
      const wanted = String(args.mailbox).trim().toLowerCase();
      const mailbox = mailboxes.find(
        (row) => String(row.id) === String(args.mailbox) || String(row.address).toLowerCase() === wanted,
      );
      if (!mailbox) throw new McpError('No such mailbox, or this account may not read it');
      if (!hasMailFetcher()) throw new McpError('This build has no mail transport', -32000);

      const result = await pollById(String(mailbox.id));
      return {
        mailbox: result.mailbox,
        fetched: result.fetched,
        // Reported rather than thrown: a mailbox that will not sign in is a
        // fact about that mailbox, and an answer covering three others should
        // still come back.
        error: result.error ?? null,
      };
    },
  },
  {
    name: 'file_mail_as_task',
    title: 'Turn a message into work',
    description:
      'Create a task from a message, carrying its subject, sender, date and a link back. The one write in this group, and it writes to Kolibri rather than to the mail server — nothing here can send, reply, delete or mark as read.',
    schema: {
      type: 'object',
      required: ['id', 'project'],
      properties: {
        id: { type: 'string', description: 'The message id, from search_mail.' },
        project: { type: 'string', description: 'Project key or name.' },
        title: { type: 'string', description: 'Overrides the subject.' },
        assignee_id: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'] },
        due_date: { type: 'string', description: 'ISO date.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, mailboxes } = mailScope(args, ctx);
      requireWrite(ctx, workspaceId);
      const message = readMessage(workspaceId, mailboxes.map((row) => String(row.id)), String(args.id));
      if (!message) throw new McpError('No such message, or it is in a mailbox this account may not read');
      const project = findProject(String(args.project), workspaceId, ctx);
      const state = get<Row>(
        `SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`,
        project.id,
      );
      if (!state) throw new McpError('That project has no states yet');

      const sent = new Date(Number(message.sent_at ?? 0)).toISOString().slice(0, 10);
      // The description quotes the message rather than linking to it alone. A
      // link is only good while the mailbox is connected, and the reason
      // somebody filed this is usually in the first paragraph.
      const description = [
        `From: ${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}`,
        `Mailbox: ${message.mailbox_address}`,
        `Sent: ${sent}`,
        '',
        String(message.body ?? message.snippet ?? '').slice(0, 4000),
      ].join('\n');

      const id = uid();
      const { row } = writeEntity('task', id, {
        project_id: String(project.id),
        title: str(args.title) ?? (String(message.subject) || '(no subject)'),
        description,
        state_id: String(state.id),
        priority: str(args.priority) ?? 'none',
        due_date: str(args.due_date) ?? null,
        assignees: str(args.assignee_id) ? [str(args.assignee_id)] : [],
      }, { workspaceId, actorId: ctx.auth.userId, hlc: serverClock.now() });
      return taskView(row);
    },
  },
];
