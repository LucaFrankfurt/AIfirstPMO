/**
 * The widget's side of the wall: what a visitor's browser talks to.
 *
 * Everything here is reached from the iframe this server serves at
 * `/w/:widget`, so it is same-origin and needs no CORS — the host site only
 * ever loads `widget.js` and frames the page. Nothing here reads the app's
 * session: a visitor is identified by the token their site signed, or by
 * nothing at all on an anonymous widget, and holds a session of ours after.
 *
 * Every route asks `liveWidget` first. A widget switched off, deleted, or in a
 * workspace that turned support off answers like one that never existed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationFile } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { buildCsp } from '../../../kernel/platform/csp.ts';
import { subscribe } from '../../../kernel/platform/bus.ts';
import {
  HttpError, badRequest, decodeParam, notFound, readBody, readJson, type Ctx, type Router,
} from '../../../kernel/platform/http.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import { byAddress, enforce, LIMITS } from '../../../kernel/identity/ratelimit.ts';
import { contentDisposition, disposition } from '../../../kernel/files/mime.ts';
import * as storage from '../../../kernel/files/storage.ts';
import { storeFile } from '../../../kernel/files/uploads.ts';
import { displayName } from '../../../kernel/write-path/repo.ts';
import {
  conversationFor, liveWidget, markVisitorRead, messagesOf, onTyping, parseFiles, postVisitorMessage,
  setTyping, typingIn, type Visitor,
} from '../../../modules/support/support.ts';
import { readSession, signSession, verifyHostToken } from '../token.ts';
import { withdrawMail } from '../mail.ts';

/** The iframe page, built by Vite beside the app's own `index.html`. */
export const WIDGET_FILE = 'widget.html';

/** A signed visitor comes back with a fresh token on every page; an anonymous one has only this. */
const SIGNED_SESSION_MS = 12 * 3600_000;
const ANONYMOUS_SESSION_MS = 30 * 86_400_000;

/** What a visitor may send: pictures, which is what a support question is missing. */
const VISITOR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const VISITOR_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The app's own policy, with the one thing a widget needs changed: who may
 * frame it. This instance itself, so the settings screen can show a preview,
 * and the sites the widget lists. The origins went through `cleanOrigins`, so
 * none of them can carry a space or a semicolon into the header.
 */
function widgetCsp(origins: string[]): string {
  return buildCsp(env.storage).replace("frame-ancestors 'none'", `frame-ancestors 'self' ${origins.join(' ')}`.trim());
}

const originsOf = (widget: Row): string[] => {
  try {
    const parsed = JSON.parse(String(widget.origins ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** The parts of a widget a stranger may know. Never the secret, never the agents. */
const publicView = (widget: Row) => ({
  id: widget.id,
  name: widget.name,
  greeting: widget.greeting ?? null,
  color: widget.color ?? null,
  identity: widget.identity,
});

const conversationView = (conversation: Row) => ({
  id: conversation.id,
  status: conversation.status,
  agent_read_at: conversation.agent_read_at ?? null,
  visitor_name: conversation.visitor_name ?? null,
});

/** A message as the visitor sees it: who answered is a first name, not a user id. */
const messageView = (message: Row) => ({
  id: message.id,
  author: message.author,
  agent: message.author === 'agent' ? displayName(String(message.author_id ?? '')) : null,
  body: message.body,
  files: parseFiles(message.files),
  created_at: message.created_at,
  seq: message.seq,
});

const sessionEnded = () => new HttpError(401, 'The chat session has ended', 'session_expired');

function widgetOf(ctx: Ctx): Row {
  const widget = liveWidget(ctx.params.widget);
  if (!widget) throw notFound('No such chat');
  return widget;
}

/**
 * The widget and the conversation this request's session opens.
 *
 * The session rides in a header, except on the stream, where `EventSource`
 * cannot set one — the reason the app's own stream reads a query too.
 */
function visitorOf(ctx: Ctx, fromQuery = false): { widget: Row; conversation: Row } {
  const widget = widgetOf(ctx);
  const token = String(ctx.req.headers['x-widget-session'] ?? (fromQuery ? ctx.query.get('session') ?? '' : ''));
  const session = readSession(token, String(widget.id));
  if (!session) throw sessionEnded();
  const conversation = get<Row>(
    `SELECT * FROM conversations WHERE id = ? AND widget_id = ? AND deleted_at IS NULL`,
    session.c, widget.id,
  );
  if (!conversation) throw sessionEnded();
  return { widget, conversation };
}

const cleanText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const cleanEmail = (value: unknown): string | null => {
  const email = cleanText(value, 254);
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

/**
 * Files a visitor names must be stored in this workspace already — which they
 * are when they came up through `/w/:widget/files` a moment before.
 */
function storedFiles(workspaceId: string, value: unknown): ConversationFile[] {
  return parseFiles(value)
    .filter((file) => file && typeof file.hash === 'string' && /^[0-9a-f]{64}$/.test(file.hash))
    .slice(0, 5)
    .map((file) => get<Row>(`SELECT * FROM files WHERE hash = ? AND workspace_id = ?`, file.hash, workspaceId))
    .filter((row): row is Row => !!row)
    .map((row) => ({
      hash: String(row.hash), name: String(row.name), type: String(row.mime), size: Number(row.size),
      width: row.width ?? null, height: row.height ?? null,
    }));
}

export function registerWidgetRoutes(router: Router): void {
  /** The page inside the iframe. Framed only by the sites the widget names, and by this instance. */
  router.get('/w/:widget', (ctx: Ctx) => {
    const widget = get<Row>(`SELECT * FROM widgets WHERE id = ? AND deleted_at IS NULL`, ctx.params.widget);
    if (!widget) throw notFound('No such chat');
    const file = join(env.webDir, WIDGET_FILE);
    if (!existsSync(file)) throw notFound('This build has no chat page; run "npm run build"');
    const page = readFileSync(file);
    ctx.res.setHeader('content-security-policy', widgetCsp(originsOf(widget)));
    ctx.res.removeHeader('x-frame-options');
    ctx.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(page.length),
      'cache-control': 'no-cache',
      'x-robots-tag': 'noindex, nofollow',
    });
    ctx.res.end(page);
    return undefined;
  });

  /** What the window looks like, before anybody is known. */
  router.get('/w/:widget/config', (ctx: Ctx) => ({ widget: publicView(widgetOf(ctx)) }));

  /**
   * Who is writing, settled once.
   *
   * A signed widget wants the host's token and believes nothing else. An
   * anonymous one takes a name and an address as typed — both optional, both
   * shown to the team as unverified — and refuses a form that filled in the
   * field no person can see.
   */
  router.post('/w/:widget/session', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.widgetSession, 'widget-session'));
    const widget = widgetOf(ctx);
    const body = await readJson<{ token?: string; name?: string; email?: string; website?: string }>(ctx, 16 * 1024);
    let visitor: Visitor;
    if (widget.identity === 'anonymous') {
      if (cleanText(body.website, 200)) throw badRequest('That did not look like a person');
      visitor = { id: `anon-${uid()}`, name: cleanText(body.name, 120), email: cleanEmail(body.email), verified: false };
    } else {
      const claims = verifyHostToken(String(widget.secret ?? ''), String(body.token ?? ''));
      visitor = { id: claims.sub, name: claims.name, email: claims.email, verified: true };
    }
    const conversation = conversationFor(widget, visitor);
    const expiresAt = Date.now() + (widget.identity === 'anonymous' ? ANONYMOUS_SESSION_MS : SIGNED_SESSION_MS);
    return {
      session: signSession({ w: String(widget.id), c: String(conversation.id), exp: expiresAt }),
      expiresAt,
      conversation: conversationView(conversation),
    };
  });

  router.get('/w/:widget/messages', (ctx: Ctx) => {
    const { conversation } = visitorOf(ctx);
    return {
      conversation: conversationView(conversation),
      messages: messagesOf(String(conversation.id)).map(messageView),
    };
  });

  router.post('/w/:widget/messages', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.widgetMessage, 'widget-message'));
    const { conversation } = visitorOf(ctx);
    const body = await readJson<{ body?: string; files?: unknown }>(ctx, 64 * 1024);
    const message = postVisitorMessage(conversation, String(body.body ?? ''), storedFiles(String(conversation.workspace_id), body.files));
    return { message: messageView(message) };
  });

  /** The visitor has seen the thread: say so, and withdraw the email an answer was waiting behind. */
  router.post('/w/:widget/read', (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.widgetSignal, 'widget-signal'));
    const { conversation } = visitorOf(ctx);
    markVisitorRead(conversation);
    withdrawMail(String(conversation.id));
    return { ok: true };
  });

  router.post('/w/:widget/typing', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.widgetSignal, 'widget-signal'));
    const { conversation } = visitorOf(ctx);
    const body = await readJson<{ typing?: boolean }>(ctx, 1024).catch(() => ({ typing: false }));
    setTyping(String(conversation.id), 'visitor', !!body?.typing);
    return { ok: true };
  });

  /**
   * New messages in this one conversation, as they are written.
   *
   * It listens to the workspace's change feed and asks one indexed question
   * per change, rather than trusting the event's `kind`: the bus coalesces a
   * burst into one event and keeps the first kind, so a task written in the
   * same forty milliseconds as an answer would hide the answer.
   */
  router.get('/w/:widget/stream', (ctx: Ctx) => {
    const { conversation } = visitorOf(ctx, true);
    const id = String(conversation.id);
    let after = Number(ctx.query.get('after') ?? 0) || 0;
    let read = Number(conversation.agent_read_at ?? 0);

    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    ctx.res.write('retry: 3000\n\n');
    const send = (event: string, data: unknown) => ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let stopped = false;
    const catchUp = () => {
      if (stopped) return;
      for (const message of all<Row>(
        `SELECT * FROM conversation_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq`, id, after,
      )) {
        after = Math.max(after, Number(message.seq));
        if (message.deleted_at) send('gone', { id: message.id });
        else send('message', messageView(message));
      }
      const now = get<Row>(`SELECT agent_read_at, deleted_at FROM conversations WHERE id = ?`, id);
      if (!now || now.deleted_at) {
        send('end', {});
        stop();
        return;
      }
      if (Number(now.agent_read_at ?? 0) !== read) {
        read = Number(now.agent_read_at ?? 0);
        send('read', { agent_read_at: read });
      }
    };

    const unsubscribe = subscribe(String(conversation.workspace_id), catchUp);
    const unwatch = onTyping((changed) => {
      if (changed === id) send('typing', { agent: typingIn(id).agent });
    });
    const keepAlive = setInterval(() => ctx.res.write(': ping\n\n'), 25_000);
    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(keepAlive);
      unsubscribe();
      unwatch();
      ctx.res.end();
    }
    ctx.req.on('close', stop);
    ctx.req.on('error', stop);
    catchUp();
    return undefined;
  });

  /** A picture from the visitor. Raw body, like the app's own uploads; images only. */
  router.post('/w/:widget/files', async (ctx: Ctx) => {
    enforce(ctx, byAddress(ctx, LIMITS.widgetUpload, 'widget-upload'));
    const { widget, conversation } = visitorOf(ctx);
    const mime = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!VISITOR_TYPES.has(mime)) throw badRequest('Only pictures can be sent here');
    const name = decodeParam(String(ctx.req.headers['x-filename'] ?? 'screenshot'), 'x-filename');
    const body = await readBody(ctx.req, VISITOR_UPLOAD_BYTES);
    if (!body.length) throw badRequest('Empty upload');
    const stored = await storeFile({
      workspaceId: String(conversation.workspace_id),
      userId: String(widget.created_by ?? ''),
      name, mime, body,
    });
    return {
      file: {
        hash: stored.hash, name: stored.name, type: mime, size: body.length,
        width: stored.width ?? null, height: stored.height ?? null,
      },
    };
  });

  /**
   * A file in this conversation, and only one in it.
   *
   * The hash alone is not enough: it has to appear in a message of the
   * conversation the session opens, so a visitor cannot use this window to
   * read anything else the workspace has stored.
   */
  router.get('/w/:widget/files/:hash', async (ctx: Ctx) => {
    const { conversation } = visitorOf(ctx);
    const hash = ctx.params.hash;
    if (!/^[0-9a-f]{64}$/.test(hash)) throw notFound('No such file');
    const used = get(
      `SELECT 1 FROM conversation_messages WHERE conversation_id = ? AND deleted_at IS NULL AND files LIKE ?`,
      conversation.id, `%"${hash}"%`,
    );
    const file = used && get<Row>(`SELECT * FROM files WHERE hash = ? AND workspace_id = ?`, hash, conversation.workspace_id);
    if (!file) throw notFound('No such file');
    const result = await storage.read(storage.keyFor(String(file.hash), String(file.mime)), (file.storage ?? 'disk') as storage.StorageKind);
    if (!result) throw notFound('File contents are missing from storage');
    const { inline, type } = disposition(String(file.mime));
    ctx.res.writeHead(200, {
      'content-type': type,
      ...(result.size ? { 'content-length': String(result.size) } : {}),
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', String(file.name)),
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    result.stream.pipe(ctx.res);
    result.stream.on('error', () => ctx.res.destroy());
    return undefined;
  });
}
