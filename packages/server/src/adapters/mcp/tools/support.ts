/**
 * Support: the conversations visitors open through a chat widget, as the
 * inbox shows them.
 *
 * Who sees one is whoever can see the widget's project — the inbox's rule and
 * the pull's, asked again here because a token reaches every row a query can.
 * An answer written here is a member's line like any other, because it goes
 * through the same write: the visitor hears it live, it follows them by email
 * when they have left, it reopens a resolved conversation, and it takes over
 * from the model.
 */
import { SUPPORT_MESSAGE_MAX, awaitsReply, excerpt, unreadByTeam, visitorLabel, type Conversation } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { isLocale, localeOf } from '../../../kernel/i18n/i18n.ts';
import { canSeeProject, displayName, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { conversationAsTask, messagesOf, parseFiles } from '../../../modules/support/support.ts';
import {
  findMember, McpError, requireFeature, requireWrite, str, taskView, type McpCtx, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

const STATUS = ['open', 'resolved'] as const;

/** The gate every tool here starts with: the switch, then — for a write — who is asking. */
function enter(args: Record<string, any>, ctx: McpCtx, writing = false): string {
  const workspaceId = workspaceOf(args, ctx);
  requireFeature(workspaceId, 'support');
  if (writing) requireWrite(ctx, workspaceId);
  return workspaceId;
}

/** A conversation this caller may see, or the same "no such" a conversation that does not exist gets. */
function findConversation(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(
    `SELECT * FROM conversations WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, ref, workspaceId,
  );
  if (!row || !canSeeProject(ctx.auth.userId, String(row.project_id))) {
    throw new McpError(`No conversation "${ref}" in this workspace`);
  }
  return row;
}

const asConversation = (row: Row): Conversation => serialize('conversation', row) as unknown as Conversation;

const widgetNames = (workspaceId: string): Map<string, string> =>
  new Map(all<Row>(`SELECT id, name FROM widgets WHERE workspace_id = ?`, workspaceId)
    .map((widget) => [String(widget.id), String(widget.name)]));

/** The task a conversation became, while it still exists. */
const taskOf = (row: Row): string | null =>
  row.task_id
    ? String(get<Row>(`SELECT identifier FROM tasks WHERE id = ? AND deleted_at IS NULL`, row.task_id)?.identifier ?? '') || null
    : null;

/** A conversation as the inbox's list shows it: who, where, and what was said last. */
function summary(row: Row, widgets: Map<string, string>) {
  const conversation = asConversation(row);
  const last = get<Row>(
    `SELECT body, files, author FROM conversation_messages WHERE conversation_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    row.id,
  );
  const said = last ? String(last.body ?? '') || parseFiles(last.files).map((file) => file.name).join(', ') : '';
  return {
    id: row.id,
    visitor: visitorLabel(conversation),
    email: row.visitor_email ?? null,
    verified: !!Number(row.verified),
    widget: widgets.get(String(row.widget_id)) ?? null,
    status: row.status,
    assignee: row.assignee_id ? displayName(String(row.assignee_id)) : null,
    unread: unreadByTeam(conversation),
    awaiting_reply: awaitsReply(conversation),
    last_message_at: row.last_message_at ? new Date(Number(row.last_message_at)).toISOString() : null,
    last_from: last?.author ?? null,
    last: said ? excerpt(said, 140) : '',
    task: taskOf(row),
  };
}

/** Who said a line, as a person reading the thread would name them. */
const speaker = (message: Row, visitor: string): { from: string; name: string } => {
  if (message.author === 'visitor') return { from: 'visitor', name: visitor };
  if (message.author === 'bot') return { from: 'assistant', name: 'Assistant' };
  return { from: 'member', name: displayName(String(message.author_id ?? '')) };
};

export const supportTools: ToolDef[] = [
  {
    name: 'list_conversations',
    title: 'List support conversations',
    description:
      'The support inbox: conversations visitors opened through a chat widget, newest first. '
      + '`unread` means the team has not seen the newest line; `awaiting_reply` that the visitor '
      + 'wrote last and nobody has answered. Only conversations in projects you can see.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...STATUS], description: 'Default open' },
        widget: { type: 'string', description: 'A widget\'s id or name' },
        unread: { type: 'boolean', description: 'Only conversations the team has not read' },
        limit: { type: 'number', description: 'Default 50, at most 200' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const widgets = widgetNames(workspaceId);
      const wantedWidget = str(args.widget)?.toLowerCase();
      const widgetId = wantedWidget
        ? [...widgets].find(([id, name]) => id === args.widget || name.toLowerCase() === wantedWidget)?.[0]
        : undefined;
      if (wantedWidget && !widgetId) throw new McpError(`No widget "${args.widget}" in this workspace`);
      const status = STATUS.includes(args.status) ? args.status : 'open';
      const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 50)));
      const rows = all<Row>(
        `SELECT * FROM conversations WHERE workspace_id = ? AND deleted_at IS NULL AND status = ?
          ${widgetId ? 'AND widget_id = ?' : ''}
          ORDER BY COALESCE(last_message_at, created_at) DESC`,
        ...[workspaceId, status, ...(widgetId ? [widgetId] : [])],
      ).filter((row) => canSeeProject(ctx.auth.userId, String(row.project_id)));
      const listed = rows.map((row) => summary(row, widgets)).filter((row) => !args.unread || row.unread);
      return { conversations: listed.slice(0, limit), total: listed.length };
    },
  },
  {
    name: 'get_conversation',
    title: 'One support conversation',
    description:
      'A conversation with its thread, oldest first: who said each line (`visitor`, `member` or '
      + '`assistant`), when, and the names of any pictures. `assistant_answering` is true while the '
      + 'widget\'s model is still answering it; a member answering takes over.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        conversation: { type: 'string', description: 'Its id' },
        limit: { type: 'number', description: 'The newest lines to return; default 100, at most 200' },
        workspace_id: { type: 'string' },
      },
      required: ['conversation'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const row = findConversation(String(args.conversation), workspaceId, ctx);
      const visitor = visitorLabel(asConversation(row));
      const widget = get<Row>(`SELECT assistant FROM widgets WHERE id = ?`, row.widget_id);
      const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 100)));
      return {
        ...summary(row, widgetNames(workspaceId)),
        assistant_answering: widget?.assistant === 'answer' && !row.handover_at,
        messages: messagesOf(String(row.id), limit).map((message) => ({
          ...speaker(message, visitor),
          body: message.body ?? '',
          pictures: parseFiles(message.files).map((file) => file.name),
          at: new Date(Number(message.created_at)).toISOString(),
        })),
      };
    },
  },
  {
    name: 'reply_to_conversation',
    title: 'Answer a support conversation',
    description:
      'Write a line to the visitor, as you. They see it live in the widget, and by email after a '
      + 'few minutes if they have left. It reopens a resolved conversation and takes over from the '
      + 'model. Plain text; there is no markdown in the widget.',
    schema: {
      type: 'object',
      properties: {
        conversation: { type: 'string', description: 'Its id' },
        body: { type: 'string' },
        workspace_id: { type: 'string' },
      },
      required: ['conversation', 'body'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const row = findConversation(String(args.conversation), workspaceId, ctx);
      const body = str(args.body);
      if (!body) throw new McpError('Write something first');
      if (body.length > SUPPORT_MESSAGE_MAX) throw new McpError(`At most ${SUPPORT_MESSAGE_MAX} characters`);
      const { row: message } = writeEntity('conversationMessage', uid(), {
        conversation_id: row.id,
        body,
        files: [],
      }, writeOpts(workspaceId, ctx));
      const now = get<Row>(`SELECT status FROM conversations WHERE id = ?`, row.id);
      return { message: message.id, status: now?.status ?? row.status };
    },
  },
  {
    name: 'update_conversation',
    title: 'Assign or resolve a support conversation',
    description:
      'Resolve or reopen a conversation, or give it to somebody. The visitor\'s window says so at '
      + 'once when it is resolved. `assignee` is an id, an email or a name of a member; an empty '
      + 'string unassigns.',
    schema: {
      type: 'object',
      properties: {
        conversation: { type: 'string', description: 'Its id' },
        status: { type: 'string', enum: [...STATUS] },
        assignee: { type: 'string', description: 'A member, or "" to unassign' },
        workspace_id: { type: 'string' },
      },
      required: ['conversation'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const row = findConversation(String(args.conversation), workspaceId, ctx);
      const patch: Record<string, unknown> = {};
      if (args.status !== undefined) {
        if (!STATUS.includes(args.status)) throw new McpError('status is open or resolved');
        patch.status = args.status;
      }
      if (args.assignee !== undefined) {
        const who = String(args.assignee).trim();
        if (who) {
          const member = findMember(who, workspaceId);
          if (!canSeeProject(String(member.id), String(row.project_id))) {
            throw new McpError(`${member.name} cannot see this conversation's project`);
          }
          patch.assignee_id = member.id;
        } else {
          patch.assignee_id = null;
        }
      }
      if (!Object.keys(patch).length) throw new McpError('Nothing to change: give a status or an assignee');
      const { row: updated } = writeEntity('conversation', String(row.id), patch, writeOpts(workspaceId, ctx));
      return summary(updated, widgetNames(workspaceId));
    },
  },
  {
    name: 'create_task_from_conversation',
    title: 'Make a task of a support conversation',
    description:
      'A task in the widget\'s project, as the inbox\'s button makes it: the visitor\'s first words '
      + 'as its title unless one is given, a link back to the conversation and the transcript as its '
      + 'description. Once — unless the task it became has been deleted since.',
    schema: {
      type: 'object',
      properties: {
        conversation: { type: 'string', description: 'Its id' },
        title: { type: 'string' },
        locale: { type: 'string', enum: ['en', 'de', 'fr'], description: 'The language of the link back; default yours' },
        workspace_id: { type: 'string' },
      },
      required: ['conversation'],
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      const row = findConversation(String(args.conversation), workspaceId, ctx);
      const locale = isLocale(args.locale) ? args.locale : localeOf(ctx.auth.userId);
      const { task } = conversationAsTask(row, writeOpts(workspaceId, ctx), locale, str(args.title));
      return { task: taskView(task), conversation: row.id };
    },
  },
];
