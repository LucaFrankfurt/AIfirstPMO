/**
 * What happens in a support conversation, apart from how it arrives.
 *
 * The widget adapter speaks HTTP to a stranger's browser; this is what it asks
 * for once it knows who that stranger is. The same calls serve a signed-in
 * customer and an anonymous visitor — the difference between them is settled
 * at the door, not in here.
 */
import { SUPPORT_MESSAGE_MAX, SUPPORT_TYPING_MS, excerpt, visitorLabel, type Conversation, type ConversationFile } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { hasFeature } from '../../kernel/platform/features.ts';
import { badRequest } from '../../kernel/platform/http.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { translatorFor } from '../../kernel/i18n/i18n.ts';
import { serverClock } from '../../kernel/write-path/bootstrap.ts';
import { canSeeProject, parseIds, writeEntity, type WriteOpts } from '../../kernel/write-path/repo.ts';
import { createNotification } from '../notifications/notify.ts';

/** The widget's maker acts for the visitor: a stranger is nobody's user id. */
const asWidget = (widget: Row): WriteOpts => ({
  workspaceId: String(widget.workspace_id),
  actorId: String(widget.created_by ?? ''),
  hlc: serverClock.now(),
  system: true,
});

/**
 * A widget somebody may talk to right now.
 *
 * Switched off, deleted, or in a workspace that turned support off: all three
 * read as "no such widget", because a visitor has no use for the difference.
 */
export function liveWidget(id: string): Row | undefined {
  const widget = get<Row>(`SELECT * FROM widgets WHERE id = ? AND deleted_at IS NULL`, id);
  if (!widget || !Number(widget.enabled) || !hasFeature(String(widget.workspace_id), 'support')) return undefined;
  return widget;
}

export interface Visitor {
  id: string;
  name: string | null;
  email: string | null;
  verified: boolean;
}

/**
 * The visitor's conversation with this widget, opened if there is none yet.
 *
 * A signed visitor's name and address are refreshed from every token, because
 * the host site is the authority on them and people do change their email.
 */
export function conversationFor(widget: Row, visitor: Visitor): Row {
  const find = () => get<Row>(`SELECT * FROM conversations WHERE widget_id = ? AND visitor_id = ?`, widget.id, visitor.id);
  const found = find();
  if (found) {
    const patch: Record<string, unknown> = {};
    if (visitor.verified && visitor.name !== found.visitor_name) patch.visitor_name = visitor.name;
    if (visitor.verified && visitor.email !== found.visitor_email) patch.visitor_email = visitor.email;
    if (Object.keys(patch).length) writeEntity('conversation', String(found.id), patch, asWidget(widget));
    return find()!;
  }
  try {
    writeEntity('conversation', uid(), {
      workspace_id: widget.workspace_id,
      project_id: widget.project_id,
      widget_id: widget.id,
      visitor_id: visitor.id,
      visitor_name: visitor.name,
      visitor_email: visitor.email,
      verified: visitor.verified ? 1 : 0,
      status: 'open',
    }, asWidget(widget));
  } catch (error) {
    // Two tabs opening the same visitor's first conversation at once: the
    // unique index lets one through, and the other finds it.
    if (!find()) throw error;
  }
  return find()!;
}

/** The thread, oldest first. Deleted messages are left out; the visitor never saw a tombstone. */
export const messagesOf = (conversationId: string, limit = 200): Row[] =>
  all<Row>(
    `SELECT * FROM (
       SELECT * FROM conversation_messages
        WHERE conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT ?
     ) ORDER BY created_at ASC`,
    conversationId, limit,
  );

/** What a visitor sends: words, files, or both — never neither. */
export function postVisitorMessage(conversation: Row, body: string, files: ConversationFile[] = []): Row {
  const text = String(body ?? '').trim().slice(0, SUPPORT_MESSAGE_MAX);
  if (!text && !files.length) throw badRequest('Write something first');
  const widget = get<Row>(`SELECT * FROM widgets WHERE id = ?`, conversation.widget_id)!;
  const { row } = writeEntity('conversationMessage', uid(), {
    workspace_id: conversation.workspace_id,
    conversation_id: conversation.id,
    author: 'visitor',
    author_id: null,
    body: text,
    files,
  }, asWidget(widget));
  setTyping(String(conversation.id), 'visitor', false);
  // A system write tells no listeners — see `afterWrite` — so the team is told
  // here, the way an intake form tells it.
  try {
    tellTeam(widget, get<Row>(`SELECT * FROM conversations WHERE id = ?`, conversation.id)!, row);
  } catch (error) {
    console.error('[support] could not tell the team about a message', error);
  }
  return row;
}

/** The visitor has seen everything up to now. */
export function markVisitorRead(conversation: Row): void {
  const widget = get<Row>(`SELECT * FROM widgets WHERE id = ?`, conversation.widget_id)!;
  writeEntity('conversation', String(conversation.id), { visitor_read_at: Date.now() }, asWidget(widget));
}

/**
 * Who hears about a visitor's message.
 *
 * Whoever it is assigned to; otherwise the widget's agents; otherwise the
 * workspace's owners and admins, so that a widget nobody configured still
 * reaches somebody who can configure it. Never anybody who cannot see the
 * project, whatever the list says.
 */
export function teamOf(widget: Row, conversation: Row): string[] {
  const named = conversation.assignee_id ? [String(conversation.assignee_id)] : parseIds(widget.agents);
  const people = named.length
    ? named
    : all<Row>(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
      widget.workspace_id,
    ).map((member) => String(member.user_id));
  return [...new Set(people)].filter((userId) => canSeeProject(userId, String(conversation.project_id)));
}

/**
 * How long a visitor's burst of messages counts as one.
 *
 * People write a support message the way they write a chat message: three
 * lines in a row. A notification for each is a phone buzzing three times about
 * one question, which teaches the team to mute it.
 */
const BURST_MS = 5 * 60_000;

function tellTeam(widget: Row, conversation: Row, message: Row): void {
  const previous = get<Row>(
    `SELECT author, created_at FROM conversation_messages
      WHERE conversation_id = ? AND id <> ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    conversation.id, message.id,
  );
  if (previous?.author === 'visitor' && Number(message.created_at) - Number(previous.created_at) < BURST_MS) return;
  const files = parseFiles(message.files);
  const body = String(message.body ?? '') ? excerpt(String(message.body), 280) : files.map((file) => file.name).join(', ');
  for (const userId of teamOf(widget, conversation)) {
    createNotification({
      workspaceId: String(conversation.workspace_id),
      userId,
      kind: 'support',
      title: translatorFor(userId)('notify.support', { name: visitorLabel(conversation as Conversation), widget: String(widget.name) }),
      body,
      projectId: String(conversation.project_id),
    });
  }
}

export function parseFiles(value: unknown): ConversationFile[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- typing */

/**
 * Who is typing in which conversation, in memory and nowhere else.
 *
 * A signal that is stale in six seconds has no business in a table, a sync
 * feed or a backup. It is lost on a restart, which costs one dot.
 */
const typing = new Map<string, { visitor: number; agent: number }>();
const typingListeners = new Set<(conversationId: string) => void>();

export function setTyping(conversationId: string, who: 'visitor' | 'agent', on: boolean): void {
  const entry = typing.get(conversationId) ?? { visitor: 0, agent: 0 };
  const until = on ? Date.now() + SUPPORT_TYPING_MS : 0;
  if (entry[who] === until) return;
  entry[who] = until;
  if (!entry.visitor && !entry.agent) typing.delete(conversationId);
  else typing.set(conversationId, entry);
  for (const listener of typingListeners) listener(conversationId);
}

export function typingIn(conversationId: string): { visitor: boolean; agent: boolean } {
  const entry = typing.get(conversationId);
  const now = Date.now();
  return { visitor: (entry?.visitor ?? 0) > now, agent: (entry?.agent ?? 0) > now };
}

export function onTyping(listener: (conversationId: string) => void): () => void {
  typingListeners.add(listener);
  return () => typingListeners.delete(listener);
}

/* ------------------------------------------------------------ into a task */

/**
 * A conversation as a task description: who said what, oldest first.
 *
 * The visitor's name is prose, not a user — the same as an intake reporter.
 */
export function transcript(conversation: Row, names: (userId: string) => string): string {
  const visitor = visitorLabel(conversation as Conversation);
  return messagesOf(String(conversation.id), 100).map((message) => {
    const who = message.author === 'visitor' ? visitor : names(String(message.author_id ?? ''));
    const at = new Date(Number(message.created_at)).toISOString().slice(0, 16).replace('T', ' ');
    const files = parseFiles(message.files).map((file) => `[${file.name}]`).join(' ');
    return `**${who}** · ${at}\n\n${[String(message.body ?? ''), files].filter(Boolean).join('\n\n')}`;
  }).join('\n\n---\n\n');
}

/** A title from the visitor's first words, or their name when they sent only a picture. */
export function taskTitle(conversation: Row): string {
  const first = get<Row>(
    `SELECT body FROM conversation_messages
      WHERE conversation_id = ? AND author = 'visitor' AND deleted_at IS NULL AND body <> ''
      ORDER BY created_at ASC LIMIT 1`,
    conversation.id,
  );
  const words = first ? excerpt(String(first.body), 80) : '';
  return words || `Support: ${visitorLabel(conversation as Conversation)}`;
}
