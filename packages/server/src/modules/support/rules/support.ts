/**
 * The rules a widget, a conversation and a support message live by.
 *
 * A widget is an admin's, because it decides who outside the workspace may
 * write into it. A conversation is opened only by a visitor, through the
 * widget's routes; members can assign it, resolve it and mark it read, and
 * that is all. A message from a member is written through sync like any other
 * row, and who wrote it is the server's to say.
 */
import {
  SUPPORT_MESSAGE_MAX, cleanOrigins, isWidgetColor, isWidgetIdentity, type ConversationFile,
} from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { hasFeature } from '../../../kernel/platform/features.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { token } from '../../../kernel/platform/ids.ts';
import {
  canSeeProject, isWorkspaceAdmin, parseIds, writeEntity, type EntityRule, type WriteOpts,
} from '../../../kernel/write-path/repo.ts';
import { parseFiles } from '../support.ts';

function requireSupport(workspaceId: string): void {
  if (!hasFeature(workspaceId, 'support')) throw badRequest('Support is switched off for this workspace');
}

function guardWidget(values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (!isWorkspaceAdmin(opts.workspaceId, opts.actorId)) {
    throw forbidden('Widgets are set up by an administrator of the workspace');
  }
  requireSupport(opts.workspaceId);
  if (!existing && !values.project_id) throw badRequest('A widget belongs to a project');
}

function guardConversation(existing: Row | undefined, opts: WriteOpts): void {
  if (!existing) throw forbidden('A conversation is opened by a visitor, not by a member');
  requireSupport(opts.workspaceId);
}

function guardMessage(values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  requireSupport(opts.workspaceId);
  if (existing) {
    // Editing and deleting are the writer's, as in chat. A visitor's words are
    // nobody's to rewrite.
    if (existing.author !== 'agent' || existing.author_id !== opts.actorId) {
      throw forbidden('Only the person who wrote a message may change it');
    }
    return;
  }
  const conversation = get<Row>(
    `SELECT project_id FROM conversations WHERE id = ? AND deleted_at IS NULL`,
    values.conversation_id,
  );
  if (!conversation) throw badRequest('No such conversation');
  if (!canSeeProject(opts.actorId, String(conversation.project_id))) throw forbidden('That project is private');
}

function applyWidgetInvariants(values: Record<string, unknown>, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  if (values.origins !== undefined) {
    const encoded = JSON.stringify(cleanOrigins(parseList(values.origins)));
    if (encoded !== values.origins) settle('origins', encoded);
  }
  if (values.agents !== undefined) {
    const encoded = JSON.stringify(parseIds(values.agents));
    if (encoded !== values.agents) settle('agents', encoded);
  }
  if (values.identity !== undefined && !isWidgetIdentity(values.identity)) settle('identity', 'signed');
  if (values.color !== undefined && values.color !== null && !isWidgetColor(values.color)) settle('color', null);
  if (typeof values.name === 'string' && values.name.trim() !== values.name) settle('name', values.name.trim());
  if (typeof values.greeting === 'string' && values.greeting.length > 500) settle('greeting', values.greeting.slice(0, 500));
}

/** A stored JSON list, or a list, or a string of them: the three ways a list of sites arrives. */
function parseList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Files a member attaches must already be stored in this workspace.
 *
 * The bytes go up through the ordinary upload route first; what arrives here
 * is a reference. One to a hash this workspace has never stored would let a
 * member hand a visitor any file on the instance by guessing its hash.
 */
function ownFiles(workspaceId: string, value: unknown): ConversationFile[] {
  return parseFiles(value)
    .filter((file) => file && typeof file.hash === 'string')
    .filter((file) => !!get(`SELECT 1 FROM files WHERE hash = ? AND workspace_id = ?`, file.hash, workspaceId))
    .slice(0, 10)
    .map((file) => ({
      hash: file.hash,
      name: String(file.name ?? 'file').slice(0, 180),
      type: String(file.type ?? 'application/octet-stream'),
      size: Number(file.size) || 0,
      width: file.width ?? null,
      height: file.height ?? null,
    }));
}

export const supportRules = {
  entities: ['widget', 'conversation', 'conversationMessage'] as const,

  defaults(entity, id, values, opts, setForced) {
    if (entity === 'widget') {
      // Minted here, never taken from a client: a secret somebody chose is a
      // secret somebody else can guess.
      setForced('secret', token(32));
      if (!values.created_by) setForced('created_by', opts.actorId);
      if (!values.identity) setForced('identity', 'signed');
    }
    if (entity === 'conversationMessage' && !opts.system) {
      setForced('author', 'agent');
      setForced('author_id', opts.actorId);
    }
  },

  guards(entity, id, values, existing, opts) {
    if (entity === 'widget') guardWidget(values, existing, opts);
    if (entity === 'conversation') guardConversation(existing, opts);
    if (entity === 'conversationMessage') guardMessage(values, existing, opts);
  },

  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'widget') applyWidgetInvariants(values, forced);
    if (entity === 'conversation') {
      if (values.status !== undefined && values.status !== 'open' && values.status !== 'resolved') {
        values.status = 'open';
        forced.status = 'open';
      }
    }
    if (entity === 'conversationMessage') {
      if (typeof values.body === 'string' && values.body.length > SUPPORT_MESSAGE_MAX) {
        values.body = values.body.slice(0, SUPPORT_MESSAGE_MAX);
        forced.body = values.body;
      }
      if (values.files !== undefined && !opts.system) {
        const files = JSON.stringify(ownFiles(opts.workspaceId, values.files));
        values.files = files;
        forced.files = files;
      }
    }
  },

  effects(entity, row, before, changed, opts) {
    if (entity !== 'conversationMessage' || before || row.deleted_at) return;
    // The conversation carries its latest message so the inbox can sort and
    // badge without reading every thread. A visitor writing into a resolved
    // conversation reopens it; a member answering has, by answering, read it.
    const conversation = get<Row>(`SELECT * FROM conversations WHERE id = ?`, row.conversation_id);
    if (!conversation) return;
    const at = Number(row.created_at);
    const patch: Record<string, unknown> = { last_message_at: at, last_author: row.author };
    if (row.author === 'visitor' && conversation.status === 'resolved') patch.status = 'open';
    if (row.author === 'agent') patch.agent_read_at = at;
    writeEntity('conversation', String(conversation.id), patch, { ...opts, system: true });
  },
} satisfies EntityRule;
