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
 */
import { get, run, type Row } from '../../kernel/platform/db/index.ts';
import { defaultLocale, translate } from '../../kernel/i18n/i18n.ts';
import { displayName, onCommitted } from '../../kernel/write-path/repo.ts';
import { queueMail } from '../mail/mail.ts';

/** Long enough that somebody still in the window reads it there first. */
export const MAIL_DELAY_SECONDS = 5 * 60;

function queueReply(entity: string, row: Row, before: Row | undefined): void {
  if (entity !== 'conversationMessage' || before || row.deleted_at || row.author !== 'agent') return;
  const conversation = get<Row>(`SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL`, row.conversation_id);
  if (!conversation?.visitor_email) return;
  if (conversation.pending_mail && get(
    `SELECT 1 FROM email_queue WHERE id = ? AND sent_at IS NULL`, conversation.pending_mail,
  )) return;
  const widget = get<Row>(`SELECT name FROM widgets WHERE id = ?`, conversation.widget_id);
  // A visitor has no account and so no language of their own; the instance's is the best guess.
  const locale = defaultLocale();
  const name = String(widget?.name ?? 'Kolibri');
  const id = queueMail({
    to: String(conversation.visitor_email),
    workspaceId: String(conversation.workspace_id),
    kind: 'support',
    delaySeconds: MAIL_DELAY_SECONDS,
    subject: translate(locale, 'mail.supportSubject', { widget: name }),
    text: [
      translate(locale, 'mail.supportBody', { agent: displayName(String(row.author_id ?? '')) }),
      '',
      String(row.body ?? ''),
      '',
      translate(locale, 'mail.supportOpen'),
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

export function installSupportMail(): void {
  onCommitted((entity, row, before) => queueReply(entity, row, before));
}
