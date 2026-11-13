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
 *
 * The widgets too, because the assistant's answers are only as good as the
 * pages it reads, and whoever writes those pages needs to see which ones it
 * reads, how much of each, and what it says with them — without opening a
 * stranger's conversation on the website to find out.
 */
import {
  SUPPORT_MESSAGE_MAX, WIDGET_ASSISTANTS, awaitsReply, excerpt, unreadByTeam, visitorLabel, type Conversation,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { hasFeature } from '../../../kernel/platform/features.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { isLocale, localeOf } from '../../../kernel/i18n/i18n.ts';
import { canSeeProject, displayName, parseIds, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { answersToday, knowledgeOf, tryAssistant, type KnowledgePage } from '../../../modules/support/assistant.ts';
import { conversationAsTask, messagesOf, parseFiles } from '../../../modules/support/support.ts';
import {
  findMember, findPage, McpError, requireFeature, requireWrite, str, taskView, type McpCtx, type ToolDef, workspaceOf, writeOpts,
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

/** A widget this caller may see, by id or by name. */
function findWidget(ref: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(
    `SELECT * FROM widgets WHERE workspace_id = ? AND deleted_at IS NULL AND (id = ? OR lower(name) = lower(?)) LIMIT 1`,
    workspaceId, ref, ref,
  );
  if (!row || !canSeeProject(ctx.auth.userId, String(row.project_id))) {
    throw new McpError(`No widget "${ref}" in this workspace`);
  }
  return row;
}

/** A widget is an admin's: it decides who outside the workspace may write in, and what the model reads. */
function requireWidgetAdmin(ctx: McpCtx, workspaceId: string): void {
  const role = ctx.auth.memberships.get(workspaceId);
  if (role !== 'owner' && role !== 'admin') {
    throw new McpError('Widgets are set up by an owner or an admin of the workspace', -32000);
  }
}

/** One knowledge page as the caller needs to judge it: read or not, and how much. */
const knowledgeView = (page: KnowledgePage) => ({
  id: page.id,
  title: page.title,
  read: !page.skipped,
  chars: page.chars,
  chars_read: page.text.length,
  ...(page.skipped ? { skipped: page.skipped } : {}),
});

/** A widget as its settings show it, minus the signing secret, plus what the model reads. */
function widgetView(row: Row) {
  const widget = serialize('widget', row) as Record<string, any>;
  const project = get<Row>(`SELECT name FROM projects WHERE id = ?`, row.project_id);
  return {
    id: row.id,
    name: row.name,
    project: project?.name ?? null,
    who_may_write: row.identity,
    sites: widget.origins ?? [],
    greeting: row.greeting ?? null,
    live: !!Number(row.enabled),
    assistant: row.assistant ?? 'off',
    model_ready: env.aiEnabled && hasFeature(String(row.workspace_id), 'ai'),
    answers_today: answersToday(String(row.id)),
    answers_a_day: Number(row.assistant_budget ?? 0),
    knowledge: knowledgeOf(row).map(knowledgeView),
  };
}

const KNOWLEDGE_RULES = 'The model reads a page only while it is marked as public knowledge and not private, '
  + 'in the order listed, the first 8,000 characters of each and 24,000 in all; `chars_read` below `chars` '
  + 'means the end of the page is never read. `skipped` says why a page is not read: `deleted`, `private`, '
  + '`not_public_knowledge` or `over_budget`.';

/** Who said a line, as a person reading the thread would name them. */
const speaker = (message: Row, visitor: string): { from: string; name: string } => {
  if (message.author === 'visitor') return { from: 'visitor', name: visitor };
  if (message.author === 'bot') return { from: 'assistant', name: 'Assistant' };
  return { from: 'member', name: displayName(String(message.author_id ?? '')) };
};

/** The page titles an answer rests on, stored as JSON. */
function parseSources(value: unknown): string[] {
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

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
      + '`assistant`), when, and the names of any pictures. An assistant\'s line names the knowledge '
      + 'pages it rests on in `sources`, as the visitor saw them. `assistant_answering` is true while the '
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
          ...(message.author === 'bot' ? { sources: parseSources(message.sources) } : {}),
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
  {
    name: 'list_widgets',
    title: 'List support widgets',
    description:
      'The chat widgets on your websites: who may write in, on which sites, whether the model answers '
      + `(\`assistant\`: off, suggest or answer), and the knowledge pages it reads. ${KNOWLEDGE_RULES} `
      + '`model_ready` is false while no model is configured on the server or AI assistance is off for the workspace.',
    readOnly: true,
    schema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx);
      const rows = all<Row>(
        `SELECT * FROM widgets WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at`, workspaceId,
      ).filter((row) => canSeeProject(ctx.auth.userId, String(row.project_id)));
      return { widgets: rows.map(widgetView) };
    },
  },
  {
    name: 'update_widget',
    title: 'Set up a widget\'s assistant',
    description:
      'Rename a widget, change its greeting, switch its model (`off`, `suggest` drafts replies for the team, '
      + '`answer` answers visitors first and hands over when unsure), set how many answers a day it may give, '
      + 'or replace the pages it reads. `knowledge` is the whole list, in the order to read them — page ids or '
      + 'exact titles, at most 20 — and every page must be marked as public knowledge first (`update_page` '
      + 'with `public_knowledge: true`). The name is what the model calls the business, and the window\'s '
      + 'title. Owners and admins only.',
    schema: {
      type: 'object',
      required: ['widget'],
      properties: {
        widget: { type: 'string', description: 'Its id or name' },
        name: { type: 'string' },
        greeting: { type: 'string', description: 'The first line a visitor reads; "" for none' },
        assistant: { type: 'string', enum: [...WIDGET_ASSISTANTS] },
        knowledge: { type: 'array', items: { type: 'string' }, description: 'Page ids or exact titles, in order' },
        answers_a_day: { type: 'number', description: 'Past it, every conversation goes to a person' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = enter(args, ctx, true);
      requireWidgetAdmin(ctx, workspaceId);
      const row = findWidget(String(args.widget), workspaceId, ctx);
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) {
        if (!str(args.name)) throw new McpError('A widget needs a name');
        patch.name = str(args.name);
      }
      if (args.greeting !== undefined) patch.greeting = str(args.greeting) ?? null;
      if (args.assistant !== undefined) {
        if (!(WIDGET_ASSISTANTS as readonly unknown[]).includes(args.assistant)) {
          throw new McpError('assistant is off, suggest or answer');
        }
        patch.assistant = args.assistant;
      }
      if (args.answers_a_day !== undefined) patch.assistant_budget = Number(args.answers_a_day);
      if (args.knowledge !== undefined) {
        if (!Array.isArray(args.knowledge)) throw new McpError('knowledge is a list of pages');
        if (args.knowledge.length > 20) throw new McpError('At most 20 pages');
        const pages = args.knowledge.map((ref: unknown) => findPage(String(ref), workspaceId, ctx));
        // Refused rather than stored and skipped: the caller asked for the model
        // to read this page, and the answer to that is no, said now.
        const unfit = pages.filter((page: Row) => Number(page.public_knowledge) !== 1 || page.access === 'private');
        if (unfit.length) {
          throw new McpError(`Not marked as public knowledge${unfit.some((page: Row) => page.access === 'private') ? ', or private' : ''}: `
            + `${unfit.map((page: Row) => `"${page.title}"`).join(', ')}. Mark a page with update_page and public_knowledge: true once it is fit to be told to a visitor.`);
        }
        patch.knowledge = parseIds(pages.map((page: Row) => String(page.id)));
      }
      if (!Object.keys(patch).length) throw new McpError('Nothing to change');
      const { row: updated } = writeEntity('widget', String(row.id), patch, writeOpts(workspaceId, ctx));
      return widgetView(updated);
    },
  },
  {
    name: 'try_assistant',
    title: 'Ask a widget\'s assistant a test question',
    description:
      'What the widget\'s model would answer a visitor who wrote this, from the pages it reads now — and '
      + 'nothing is written: no conversation, no line in the inbox, nothing counted against the day\'s answers. '
      + 'Works whatever the widget\'s own setting, so pages can be tried before visitors meet the model. '
      + '`handover: true` means it would hand the visitor to a person, and `answer` is then the line it would '
      + 'say. One model call on the instance\'s key. Owners and admins only.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['widget', 'question'],
      properties: {
        widget: { type: 'string', description: 'Its id or name' },
        question: { type: 'string', description: 'As a visitor would write it' },
        workspace_id: { type: 'string' },
      },
    },
    run: async (args, ctx) => {
      const workspaceId = enter(args, ctx);
      requireWidgetAdmin(ctx, workspaceId);
      const row = findWidget(String(args.widget), workspaceId, ctx);
      const question = str(args.question);
      if (!question) throw new McpError('Ask something');
      const read = knowledgeOf(row).filter((page) => !page.skipped);
      try {
        const answer = await tryAssistant(row, question);
        return { ...answer, pages_read: read.map((page) => page.title) };
      } catch (error) {
        throw new McpError(error instanceof Error ? error.message : 'The model did not answer');
      }
    },
  },
];
