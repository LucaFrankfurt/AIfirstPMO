/**
 * The half of "live and asynchronous" that is not live.
 *
 * When a member answers and the visitor has gone, the answer follows them by
 * email — after a few minutes, and only if they have not read it in the window
 * by then. Reading it withdraws the email, so a visitor who is still there is
 * never sent a copy of what is on their screen.
 *
 * One pending email per conversation: three quick answers are one email about
 * the first, not three. Once that one has gone out, the next answer may queue
 * another.
 *
 * **And back.** When the widget names a reply address — an inbox the workspace
 * has connected under Mail — the email's Reply-To is that inbox and its
 * subject carries a signed tag, `[#a1b2c3d4-9f8e7d]`. The mail poller hands
 * every new message to `takeReply`, which finds the conversation by the tag,
 * believes it only from the address the conversation already has, cuts off
 * the quoted email underneath, and posts what is left as the visitor's line.
 *
 * A tag in the subject rather than the `Message-ID` chain: the transports
 * write their own Message-ID and keep no record of it, and the subject is what
 * every mail client carries back with "Re:" in front — which is why helpdesks
 * do it this way.
 */
import { createHmac } from 'node:crypto';
import { get, run, type Row } from '../../kernel/platform/db/index.ts';
import { env } from '../../kernel/platform/env.ts';
import { defaultLocale, translate } from '../../kernel/i18n/i18n.ts';
import { displayName, onCommitted } from '../../kernel/write-path/repo.ts';
import { onMailArrival } from '../../modules/mail/poll.ts';
import type { FetchedMessage } from '../../modules/mail/store.ts';
import { liveWidget, postVisitorMessage } from '../../modules/support/support.ts';
import { queueMail } from '../mail/mail.ts';

/** Long enough that somebody still in the window reads it there first. */
export const MAIL_DELAY_SECONDS = 5 * 60;

/** Six hex characters of HMAC: enough that a tag cannot be guessed, short enough to sit in a subject. */
const signatureOf = (conversationId: string): string =>
  createHmac('sha256', env.secret).update(`support-mail:${conversationId}`).digest('hex').slice(0, 6);

/** The tag a support email's subject carries, and a reply's subject brings back. */
export const replyTag = (conversationId: string): string => `[#${conversationId.slice(0, 8)}-${signatureOf(conversationId)}]`;

const TAG = /\[#([0-9a-f]{8})-([0-9a-f]{6})\]/i;

function queueReply(entity: string, row: Row, before: Row | undefined): void {
  if (entity !== 'conversationMessage' || before || row.deleted_at || row.author !== 'agent') return;
  const conversation = get<Row>(`SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL`, row.conversation_id);
  if (!conversation?.visitor_email) return;
  if (conversation.pending_mail && get(
    `SELECT 1 FROM email_queue WHERE id = ? AND sent_at IS NULL`, conversation.pending_mail,
  )) return;
  const widget = get<Row>(`SELECT name, reply_to FROM widgets WHERE id = ?`, conversation.widget_id);
  // A visitor has no account and so no language of their own; the instance's is the best guess.
  const locale = defaultLocale();
  const name = String(widget?.name ?? 'Kolibri');
  const replyTo = widget?.reply_to ? String(widget.reply_to) : undefined;
  const id = queueMail({
    to: String(conversation.visitor_email),
    workspaceId: String(conversation.workspace_id),
    kind: 'support',
    delaySeconds: MAIL_DELAY_SECONDS,
    replyTo,
    subject: `${translate(locale, 'mail.supportSubject', { widget: name })}${replyTo ? ` ${replyTag(String(conversation.id))}` : ''}`,
    text: [
      translate(locale, 'mail.supportBody', { agent: displayName(String(row.author_id ?? '')) }),
      '',
      String(row.body ?? ''),
      '',
      translate(locale, replyTo ? 'mail.supportAnswer' : 'mail.supportOpen'),
    ].join('\n'),
  });
  if (id) run(`UPDATE conversations SET pending_mail = ? WHERE id = ?`, id, conversation.id);
}

/** The visitor has read the answer in the window: the email waiting behind it is not needed. */
export function withdrawMail(conversationId: string): void {
  const conversation = get<Row>(`SELECT pending_mail FROM conversations WHERE id = ?`, conversationId);
  if (!conversation?.pending_mail) return;
  run(`DELETE FROM email_queue WHERE id = ? AND sent_at IS NULL`, conversation.pending_mail);
  run(`UPDATE conversations SET pending_mail = NULL WHERE id = ?`, conversationId);
}

/**
 * What somebody wrote above the quoted email they were answering.
 *
 * Every client quotes differently, and none of them marks where the new text
 * ends. These are the shapes that cover nearly all of it: a `>` line, the
 * "On … wrote:" line in the three languages the app speaks, and the header
 * block Outlook pastes in. Cutting too early loses the end of an answer;
 * cutting too late puts the team's own words back into the thread — so the
 * cut is at the first sign of a quote, and the visitor's words are all that
 * is kept.
 */
export function replyText(body: string): string {
  const kept: string[] = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) break;
    // "On …, Kolibri <a@b.c> wrote:" — and German puts the verb first: "Am … schrieb Kolibri <a@b.c>:".
    if (/(wrote|schrieb|a écrit)\b[^\n]*:$/i.test(trimmed)) break;
    if (/^-{2,}\s*(original message|ursprüngliche nachricht|message d.origine)/i.test(trimmed)) break;
    if (/^(from|von|de)\s*:\s/i.test(trimmed) && kept.some((one) => one.trim())) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * A message that arrived in one of the workspace's inboxes, if it is a
 * visitor's answer to a support email. Returns whether it was taken.
 */
export function takeReply(workspaceId: string, message: Pick<FetchedMessage, 'subject' | 'fromAddress' | 'body'>): boolean {
  const tag = TAG.exec(message.subject ?? '');
  if (!tag) return false;
  const conversation = get<Row>(
    `SELECT * FROM conversations WHERE workspace_id = ? AND id LIKE ? AND deleted_at IS NULL`,
    workspaceId, `${tag[1].toLowerCase()}%`,
  );
  if (!conversation || signatureOf(String(conversation.id)) !== tag[2].toLowerCase()) return false;
  // Only from the address the conversation already has. A forwarded copy, or
  // somebody who found the subject line, is not the visitor.
  if (!conversation.visitor_email || String(message.fromAddress ?? '').toLowerCase() !== String(conversation.visitor_email).toLowerCase()) {
    return false;
  }
  // A widget switched off, or support switched off, takes nothing in.
  if (!liveWidget(String(conversation.widget_id))) return false;
  const text = replyText(String(message.body ?? ''));
  if (!text) return false;
  postVisitorMessage(conversation, text);
  return true;
}

export function installSupportMail(): void {
  onCommitted((entity, row, before) => queueReply(entity, row, before));
  onMailArrival((workspaceId, message) => { takeReply(workspaceId, message); });
}
