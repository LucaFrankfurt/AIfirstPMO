/**
 * What happens in a support conversation, apart from how it arrives.
 *
 * The widget adapter speaks HTTP to a stranger's browser; this is what it asks
 * for once it knows who that stranger is. The same calls serve a signed-in
 * customer and an anonymous visitor — the difference between them is settled
 * at the door, not in here.
 */
import {
  SUPPORT_MESSAGE_MAX, SUPPORT_TYPING_MS, cleanContextFields, excerpt, pickContext, visitorLabel,
  type Conversation, type ConversationFile, type WidgetContextField,
} from '@kolibri/shared';
import { all, get, nextSeq, run, type Row } from '../../kernel/platform/db/index.ts';
import { seal, unseal } from '../../kernel/platform/seal.ts';
import { hasFeature } from '../../kernel/platform/features.ts';
import { badRequest } from '../../kernel/platform/http.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { translate, translatorFor, type Locale } from '../../kernel/i18n/i18n.ts';
import { serverClock } from '../../kernel/write-path/bootstrap.ts';
import { canSeeProject, displayName, parseIds, writeEntity, type WriteOpts } from '../../kernel/write-path/repo.ts';
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
  /** What the host's token said about them, kept to the widget's fields. Signed visitors only. */
  context?: Record<string, string | number | boolean>;
}

/* ------------------------------------------------------- the widget secret */

const WIDGET_SECRET = 'widget';

/** A host's signing key as the database keeps it. */
export const sealWidgetSecret = (plain: string): string => seal(WIDGET_SECRET, plain);

/**
 * The key a host signs with, opened — or '' when it cannot be.
 *
 * '' is what a restore without the instance's `.secret` file leaves: every
 * token is then refused as unsigned, and *New secret* on the widget's card is
 * the way out. A key stored before sealing existed is read as it is, for the
 * one boot between the upgrade and `sealWidgetSecrets`.
 */
export function widgetSecret(widget: Row): string {
  const stored = String(widget.secret ?? '');
  return stored.startsWith('v1.') ? unseal(WIDGET_SECRET, stored) ?? '' : stored;
}

/**
 * Widgets made before their key was sealed, sealed once.
 *
 * With context claims a widget's key signs in a customer *and* says what plan
 * they are on, so a leaked database copy should not be a leaked key. A
 * minted key is base64url and never starts with `v1.`, which is how a sealed
 * one is told from one that is not.
 */
export function sealWidgetSecrets(): void {
  for (const row of all<Row>(`SELECT id, secret FROM widgets WHERE secret <> '' AND secret NOT LIKE 'v1.%'`)) {
    run(`UPDATE widgets SET secret = ? WHERE id = ?`, sealWidgetSecret(String(row.secret)), row.id);
  }
}

/* ------------------------------------------------------- what the host said */

/**
 * Kept beside the conversation, never on a device: the column is a `secret`
 * one, written here with a plain UPDATE, so no `seq` moves and no pull carries
 * it. Overwritten by every token, because the host is the authority on it.
 */
function keepContext(conversationId: string, visitor: Visitor): void {
  const context = visitor.verified && visitor.context && Object.keys(visitor.context).length
    ? JSON.stringify(visitor.context)
    : null;
  run(`UPDATE conversations SET visitor_context = ? WHERE id = ?`, context, conversationId);
}

/**
 * What the model may be told about the visitor of a conversation, by label.
 *
 * Kept to the widget's fields as they are *now*, so a field an admin removes
 * stops reaching the model at once, not when the visitor's next token comes.
 * Nothing at all for a visitor nobody vouched for.
 */
export function contextOf(widget: Row, conversation: Row): { label: string; value: string | number | boolean }[] {
  if (widget.identity !== 'signed' || !Number(conversation.verified) || !conversation.visitor_context) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(String(conversation.visitor_context));
  } catch {
    return [];
  }
  const fields = contextFieldsOf(widget);
  const picked = pickContext(stored, fields);
  return fields.filter((field) => field.key in picked).map((field) => ({ label: field.label, value: picked[field.key] }));
}

/** A widget's allowed fields, from the JSON the row keeps them in. */
export function contextFieldsOf(widget: Row): WidgetContextField[] {
  try {
    const stored = typeof widget.context_fields === 'string' ? JSON.parse(widget.context_fields) : widget.context_fields;
    return cleanContextFields(Array.isArray(stored) ? stored : []);
  } catch {
    return [];
  }
}

/** A new conversation for this visitor, in this widget. */
function openConversation(widget: Row, visitor: Visitor): Row {
  const id = uid();
  writeEntity('conversation', id, {
    workspace_id: widget.workspace_id,
    project_id: widget.project_id,
    widget_id: widget.id,
    visitor_id: visitor.id,
    visitor_name: visitor.name,
    visitor_email: visitor.email,
    verified: visitor.verified ? 1 : 0,
    status: 'open',
  }, asWidget(widget));
  keepContext(id, visitor);
  return get<Row>(`SELECT * FROM conversations WHERE id = ?`, id)!;
}

/**
 * The visitor's newest conversation with this widget, opened if there is none.
 *
 * Newest, not open: a visitor whose chat the team resolved comes back to it,
 * sees that it was resolved, and writes on (which reopens it) or starts a new
 * one. A deleted conversation is not theirs to come back to.
 *
 * A signed visitor's name and address are refreshed from every token, because
 * the host site is the authority on them and people do change their email.
 */
export function conversationFor(widget: Row, visitor: Visitor): Row {
  const found = get<Row>(
    `SELECT * FROM conversations WHERE widget_id = ? AND visitor_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    widget.id, visitor.id,
  );
  if (!found) return openConversation(widget, visitor);
  const patch: Record<string, unknown> = {};
  if (visitor.verified && visitor.name !== found.visitor_name) patch.visitor_name = visitor.name;
  if (visitor.verified && visitor.email !== found.visitor_email) patch.visitor_email = visitor.email;
  if (Object.keys(patch).length) writeEntity('conversation', String(found.id), patch, asWidget(widget));
  keepContext(String(found.id), visitor);
  return get<Row>(`SELECT * FROM conversations WHERE id = ?`, found.id)!;
}

/**
 * "Start a new chat": a fresh conversation for the same visitor, who they are
 * taken from the one they are in.
 *
 * An open chat of theirs with nothing in it yet is that fresh conversation
 * already — a second click, or "new chat" pressed again from an older one —
 * so it is handed back rather than joined by another empty one.
 */
export function newConversation(widget: Row, from: Row): Row {
  const empty = get<Row>(
    `SELECT * FROM conversations c
      WHERE c.widget_id = ? AND c.visitor_id = ? AND c.id <> ? AND c.status = 'open' AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)
      ORDER BY c.created_at DESC LIMIT 1`,
    widget.id, from.visitor_id, from.id,
  );
  if (empty) return empty;
  return openConversation(widget, {
    id: String(from.visitor_id),
    name: from.visitor_name ?? null,
    email: from.visitor_email ?? null,
    verified: !!Number(from.verified),
    context: storedContext(from),
  });
}

/** The context a conversation was given, carried into the visitor's next one. */
function storedContext(conversation: Row): Record<string, string | number | boolean> | undefined {
  try {
    const parsed = conversation.visitor_context ? JSON.parse(String(conversation.visitor_context)) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long a conversation nobody wrote in is kept: past the longest session a
 * visitor can hold, so nobody is still looking at one when it goes.
 */
const EMPTY_KEPT_MS = 31 * 86_400_000;

/**
 * Conversations nobody ever wrote in, removed once no session can still open
 * them. Returns how many.
 *
 * Every session opens one before a word is said — a signed widget does it on
 * the first click of the launcher — and an anonymous visitor gets a new one on
 * every visit their storage does not survive. They are kept out of the team's
 * sight already (the pull, the inbox, `list_conversations` skip a conversation
 * with no line in it); this is the table not growing for ever underneath.
 *
 * Removed outright, with a `purge` marker in place of each, the way emptying
 * the trash does it: a device that pulled one before they were hidden drops
 * its copy when the marker arrives.
 */
export function pruneEmptyConversations(now = Date.now()): number {
  const doomed = all<Row>(
    `SELECT id, workspace_id FROM conversations c
      WHERE c.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)`,
    now - EMPTY_KEPT_MS,
  );
  for (const row of doomed) {
    run(`DELETE FROM conversations WHERE id = ?`, row.id);
    run(
      `INSERT INTO purges (id, workspace_id, entity, row_id, reason, created_at, updated_at, seq, clocks)
       VALUES (?, ?, 'conversation', ?, 'retention', ?, ?, ?, '{}')`,
      uid(), row.workspace_id, row.id, now, now, nextSeq(),
    );
  }
  return doomed.length;
}

/** The visitor's chats with this widget, newest first: what the window lists as earlier chats. */
export const conversationsOfVisitor = (conversation: Row, limit = 20): Row[] =>
  all<Row>(
    `SELECT * FROM conversations WHERE widget_id = ? AND visitor_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ?`,
    conversation.widget_id, conversation.visitor_id, limit,
  );

/** One of the visitor's own chats with this widget, by id: never somebody else's, never a deleted one. */
export const visitorsOwn = (conversation: Row, id: string): Row | undefined =>
  get<Row>(
    `SELECT * FROM conversations WHERE id = ? AND widget_id = ? AND visitor_id = ? AND deleted_at IS NULL`,
    id, conversation.widget_id, conversation.visitor_id,
  );

/** How many lines the team (or the model) wrote in a conversation since its visitor last looked. */
export const unreadByVisitor = (conversation: Row): number =>
  Number(get<Row>(
    `SELECT COUNT(*) AS n FROM conversation_messages
      WHERE conversation_id = ? AND author <> 'visitor' AND deleted_at IS NULL AND created_at > ?`,
    conversation.id, Number(conversation.visitor_read_at ?? 0),
  )?.n ?? 0);

/** The visitor says it is done. The team is not woken for it: nothing is waiting on them. */
export function resolveByVisitor(widget: Row, conversation: Row): void {
  if (conversation.status === 'resolved') return;
  writeEntity('conversation', String(conversation.id), { status: 'resolved' }, asWidget(widget));
}

/** The thread, oldest first. Deleted messages are left out; the visitor never saw a tombstone. */
export const messagesOf = (conversationId: string, limit = 200): Row[] =>
  all<Row>(
    // The order they were written in when the clock cannot tell: a question
    // and the model's answer to it land in one millisecond on a fast machine,
    // and sorted by time alone the answer came back first.
    `SELECT * FROM (
       SELECT *, rowid AS written FROM conversation_messages
        WHERE conversation_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT ?
     ) ORDER BY created_at ASC, written ASC`,
    conversationId, limit,
  );

/**
 * What a visitor sends: words, files, or both — never neither.
 *
 * Who hears about it is not decided here: the model may answer it first, or
 * the team is told. That is `respondTo` in `assistant.ts`, which every caller
 * hands the line to next — the widget's route and the email poller.
 */
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
 * project, whatever the list says — and when that leaves a step with nobody
 * on it, the next step is asked rather than nobody being told. An assignee who
 * lost access to the project, or an agents list of people who left, used to
 * mean a visitor's line reached no one.
 */
export function teamOf(widget: Row, conversation: Row): string[] {
  const canSee = (userId: string) => canSeeProject(userId, String(conversation.project_id));
  const steps: (() => string[])[] = [
    () => (conversation.assignee_id ? [String(conversation.assignee_id)] : []),
    () => parseIds(widget.agents),
    () => all<Row>(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
      widget.workspace_id,
    ).map((member) => String(member.user_id)),
  ];
  for (const step of steps) {
    const people = [...new Set(step())].filter(canSee);
    if (people.length) return people;
  }
  return [];
}

/**
 * How long a visitor's burst of messages counts as one.
 *
 * People write a support message the way they write a chat message: three
 * lines in a row. A notification for each is a phone buzzing three times about
 * one question, which teaches the team to mute it.
 */
const BURST_MS = 5 * 60_000;

/**
 * Tell the team about a visitor's line — once per burst, unless `now`.
 *
 * A system write tells no listeners (see `afterWrite`), so this is called
 * directly, the way an intake form tells. `now` is the hand-over: the model has
 * been answering, and this line is the one a person has to pick up.
 */
export function tellTeam(widget: Row, conversation: Row, message: Row, now = false): void {
  const previous = get<Row>(
    `SELECT author, created_at FROM conversation_messages
      WHERE conversation_id = ? AND id <> ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    conversation.id, message.id,
  );
  if (!now && previous?.author === 'visitor' && Number(message.created_at) - Number(previous.created_at) < BURST_MS) return;
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
      conversationId: String(conversation.id),
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
 * A conversation as a task description: where it came from, then who said
 * what, oldest first.
 *
 * The first line links back to the conversation, so whoever works the task can
 * answer the person who asked. Pictures go in as pictures, through the same
 * `/files` route the inbox shows them with — which also keeps them out of the
 * trash for as long as the task shows them. The visitor's name is prose, not a
 * user — the same as an intake reporter.
 */
export function transcript(conversation: Row, names: (userId: string) => string, from: string, assistant: string): string {
  const visitor = visitorLabel(conversation as Conversation);
  const lines = messagesOf(String(conversation.id), 100).map((message) => {
    // The model's lines have no author id, and asking for the name of nobody
    // answered "Somebody" — a task that said a person wrote what a model did.
    const who = message.author === 'visitor' ? visitor
      : message.author === 'bot' ? assistant
        : names(String(message.author_id ?? ''));
    const at = new Date(Number(message.created_at)).toISOString().slice(0, 16).replace('T', ' ');
    const files = parseFiles(message.files)
      .map((file) => `![${file.name.replace(/[[\]]/g, '')}](/files/${file.hash}/${encodeURIComponent(file.name)})`)
      .join(' ');
    return `**${who}** · ${at}\n\n${[String(message.body ?? ''), files].filter(Boolean).join('\n\n')}`;
  });
  return [`[${from}](/support/${conversation.id})`, ...lines].join('\n\n---\n\n');
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

/**
 * The conversation as a task in the widget's project: the visitor's first
 * words as its title, a link back and the transcript as its description.
 *
 * Once: a conversation that is already a task says so — unless that task has
 * been deleted since, which leaves nothing to open. The inbox's button and the
 * MCP tool both come here, so the two cannot drift apart.
 */
export function conversationAsTask(conversation: Row, opts: WriteOpts, locale: Locale, title?: string): { task: Row; conversation: Row } {
  if (conversation.task_id && get(`SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL`, conversation.task_id)) {
    throw badRequest('This conversation is already a task');
  }
  const widget = get<Row>(`SELECT name FROM widgets WHERE id = ?`, conversation.widget_id);
  const { row: task } = writeEntity('task', uid(), {
    workspace_id: conversation.workspace_id,
    project_id: conversation.project_id,
    title: String(title ?? '').trim() || taskTitle(conversation),
    description: transcript(conversation, displayName, translate(locale, 'support.taskFrom', {
      name: visitorLabel(conversation as Conversation),
      widget: String(widget?.name ?? ''),
    }), translate(locale, 'support.assistant')),
    created_by: opts.actorId,
  }, opts);
  writeEntity('conversation', String(conversation.id), { task_id: task.id }, { ...opts, system: true });
  return { task, conversation: get<Row>(`SELECT * FROM conversations WHERE id = ?`, conversation.id)! };
}
