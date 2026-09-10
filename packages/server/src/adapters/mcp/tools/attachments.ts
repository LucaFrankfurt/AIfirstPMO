/**
 * Bytes hung off a task, a page or a comment.
 */
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { canSeeFile, deleteEntity } from '../../../kernel/write-path/repo.ts';
import { storeFile } from '../../../kernel/files/uploads.ts';
import * as storage from '../../../kernel/files/storage.ts';
import { findPage, findTask, type McpCtx, McpError, mimeFromName, requireWrite, str, ToolAnswer, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

/**
 * How many bytes one answer will carry, and why this is not the upload limit.
 *
 * `KOLIBRI_MAX_UPLOAD_MB` says what an operator is willing to *store*, and 25 MB
 * of screenshot is a perfectly reasonable thing to keep. It is not a reasonable
 * thing to put in a tool answer: the answer goes into a model's context, base64
 * costs a third again on the way, and the ceiling that actually applies belongs
 * to the client rather than to this deployment — the major model APIs stop
 * accepting an inline image somewhere around five megabytes whatever the server
 * is willing to send.
 *
 * So it is a constant here and not a setting. An operator raising a number in
 * their environment cannot make their assistant read a 20 MB photograph, and a
 * setting that looks like it might is worse than no setting at all. Anything
 * over it is refused with the URL, which is a real answer: the file is still
 * there and a person can still open it.
 */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/**
 * Image types a model can actually look at.
 *
 * Narrower than what Kolibri stores and narrower than what a browser renders.
 * AVIF and SVG are images to the interface and are not images to a model — it
 * refuses them — so handing one over as an `image` block would produce an error
 * in the client rather than a picture, and the caller would have no idea why.
 * SVG is the one worth naming twice: it is a document that can carry script,
 * which is why `mime.ts` will not render it in place either.
 */
const MODEL_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Types whose bytes *are* text, beyond the `text/…` that says so. */
const TEXT_TYPES = new Set(['application/json', 'application/xml']);
const isText = (mime: string): boolean => mime.startsWith('text/') || TEXT_TYPES.has(mime);

/** The hash in `/files/<hash>/<name>`, which is where a stored file is addressed. */
const FILE_URL = /\/files\/([0-9a-f]{64})(?:[/?#]|$)/i;
const BARE_HASH = /^[0-9a-f]{64}$/i;

/**
 * An attachment, and whether this token may have it.
 *
 * An attachment inherits the privacy of whatever it hangs on — and it can hang
 * on a task, a page, or a comment, which itself hangs on one of the other two.
 * `findTask` and `findPage` refuse a private one, so calling them *is* the
 * check.
 *
 * This was written inline in `delete_attachment`, where the task branch alone
 * was the whole of it for a while — which left files on private pages deletable
 * by people who could not read the page. Reading them back is the same question
 * asked by a second tool, and a second copy of an answer that has already been
 * wrong once is how the halves drift apart.
 */
function findAttachment(id: string, workspaceId: string, ctx: McpCtx): Row {
  const row = get<Row>(
    `SELECT * FROM attachments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    id, workspaceId,
  );
  if (!row) throw new McpError(`Attachment ${id} not found`);
  if (row.task_id) findTask(String(row.task_id), workspaceId, ctx);
  if (row.page_id) findPage(String(row.page_id), workspaceId, ctx);
  if (row.comment_id) {
    const comment = get<Row>(`SELECT task_id, page_id FROM comments WHERE id = ?`, row.comment_id);
    if (comment?.task_id) findTask(String(comment.task_id), workspaceId, ctx);
    if (comment?.page_id) findPage(String(comment.page_id), workspaceId, ctx);
  }
  return row;
}

/**
 * Which bytes a caller means, when it names a file rather than a row.
 *
 * A `/files/<hash>/<name>` URL is what an image in a description or a page
 * renders from, and it is what `list_attachments` hands back, so it is the form
 * a caller already has. The bare hash is accepted because it is the same thing
 * with the packaging removed and refusing it would be pedantry.
 *
 * Nothing about this grants anything: it parses. Whether these bytes may be
 * read is asked afterwards and separately, which is the order that matters —
 * the answer to "is this a hash" has never been the answer to "is it yours".
 */
function hashFrom(ref: string): string {
  if (BARE_HASH.test(ref)) return ref.toLowerCase();
  const match = FILE_URL.exec(ref);
  if (!match) throw new McpError(`\`file\` should be a /files/<hash>/<name> URL or the hash itself, not "${ref}"`);
  return match[1].toLowerCase();
}

/**
 * Which bytes an attachment is about.
 *
 * `checksum` is the column the write path fills in and a client cannot reach,
 * and it is what `canSeeFile` joins on. A row written before it started being
 * filled in has it empty and still carries the hash in its URL, so that is the
 * fallback rather than a failure — the file is right there.
 */
function hashOf(row: Row): string {
  const recorded = str(row.checksum);
  if (recorded && BARE_HASH.test(recorded)) return recorded.toLowerCase();
  const fromUrl = FILE_URL.exec(String(row.url ?? ''));
  if (!fromUrl) throw new McpError(`Attachment ${row.id} does not point at any stored bytes`);
  return fromUrl[1].toLowerCase();
}

/**
 * May this token have these bytes, when all it named was the file?
 *
 * `canSeeFile` is the rule `GET /files/:hash/*` applies, and it is a floor
 * rather than the answer. It walks the attachment rows carrying these bytes and
 * asks whether *any* of them is one you may see — which is right, since a file
 * on a task you can read is yours to read however else it is also filed — but
 * it answers `true` for a page-bound row without looking at the page. That gap
 * is deliberate and recorded in TODO.md: a page carries its own `access`
 * column, and teaching `canSeeFile` what `guardPage` knows is a second rule
 * about a second column.
 *
 * It cannot be inherited here, because this tool has two doors into one file.
 * Naming the attachment runs the walk in `findAttachment`, which refuses a
 * private page; naming the URL would not have, and a URL is a hash with a name
 * on the end. One tool answering "no" and "here you are" to the same bytes
 * depending on which argument you used is worse than either rule on its own —
 * it is the shape of every access bug this file has already had.
 *
 * So the rows are walked with the same function the other door uses. A hash
 * with no rows at all falls back to `canSeeFile`, which is the case that must
 * not get stricter: an avatar, a workspace logo, an image pasted into a chat
 * message are stored with no attachment row, and requiring one would make every
 * avatar a refusal.
 */
function mayRead(hash: string, workspaceId: string, ctx: McpCtx): boolean {
  const rows = all<Row>(
    `SELECT id FROM attachments WHERE checksum = ? AND workspace_id = ? AND deleted_at IS NULL`,
    hash, workspaceId,
  );
  if (!rows.length) return canSeeFile(ctx.auth.userId, hash);
  // A throw is a refusal, which is the direction a surprise should fall in:
  // `findAttachment` refuses by raising, and a row it will not return is a row
  // that does not count towards "any of them is yours".
  return rows.some((row) => {
    try {
      findAttachment(String(row.id), workspaceId, ctx);
      return true;
    } catch {
      return false;
    }
  });
}

export const attachmentTools: ToolDef[] = [
  {
    /**
     * Put a file on a task.
     *
     * The gap this closes is not a convenience. An assistant could already
     * write a task, comment on it and move it, but anything it *produced* — a
     * CSV, a screenshot, a generated report — had nowhere to go except pasted
     * into a comment as text. Everything else in Kolibri that carries a file
     * hangs off the attachment row this writes, so a file put here appears in
     * the task's own Files section rather than in a place only an assistant
     * knows about.
     *
     * Base64 because MCP carries JSON. That is a real cost — the encoding adds
     * a third again, and the whole thing is a string in memory on both sides —
     * so the limit below is enforced against the *decoded* size, and checked
     * before decoding rather than after.
     */
    name: 'upload_attachment',
    title: 'Attach a file to a task',
    description: "Upload a file and attach it to a task, where it appears in the task's Files section. Content is base64. Use this for anything you have produced — a report, an export, an image — rather than pasting it into a comment.",
    schema: {
      type: 'object',
      required: ['task', 'name', 'content_base64'],
      properties: {
        task: { type: 'string', description: 'Task id or identifier, e.g. WEB-12' },
        name: { type: 'string', description: 'File name as it should appear, e.g. "burndown.csv"' },
        content_base64: { type: 'string', description: 'The file, base64 encoded' },
        mime: {
          type: 'string',
          description: 'Content type, e.g. text/csv. Guessed from the file name when omitted.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: async (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const task = findTask(String(args.task), workspaceId, ctx);

      const name = str(args.name);
      if (!name) throw new McpError('A file needs a name');
      const encoded = typeof args.content_base64 === 'string' ? args.content_base64.trim() : '';
      if (!encoded) throw new McpError('`content_base64` is empty');

      /*
       * Refuse an oversized upload before decoding it, not after.
       *
       * Base64 is four characters for every three bytes, so the decoded length
       * is knowable from the string. Decoding first to measure would mean
       * allocating the very buffer the limit exists to prevent — a 200 MB
       * string against a 25 MB limit would be rejected, having already been
       * held in memory twice.
       */
      const approx = Math.floor((encoded.length * 3) / 4);
      if (approx > env.maxUploadBytes) {
        throw new McpError(
          `That file is about ${Math.round(approx / 1024 / 1024)} MB and the limit is ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB`,
        );
      }

      /*
       * And check that it really is base64.
       *
       * `Buffer.from(x, 'base64')` never fails: it skips anything outside the
       * alphabet and stops at the first byte it cannot use. Hand it a JSON
       * document by mistake and it returns a short buffer of nonsense, which
       * would be stored, attached, and downloaded later as a corrupt file with
       * nothing anywhere saying so.
       */
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
        throw new McpError('`content_base64` is not base64 — send the file encoded, not as raw text');
      }
      const body = Buffer.from(encoded, 'base64');
      if (!body.length) throw new McpError('That decodes to no bytes at all');
      if (body.length > env.maxUploadBytes) {
        throw new McpError(`That file is larger than the ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB limit`);
      }

      const stored = await storeFile({
        workspaceId,
        userId: ctx.auth.userId,
        name,
        mime: str(args.mime) ?? mimeFromName(name),
        body,
        taskId: String(task.id),
      });

      return {
        task: task.identifier,
        name: stored.name,
        mime: stored.mime,
        size: stored.size,
        url: stored.url,
        attachment: stored.attachment,
      };
    },
  },
  {
    /**
     * What is already attached, and where to fetch it.
     *
     * `page` as well as `task`, because the model hangs attachments off either
     * and a tool that could only see half of them would send an assistant
     * looking for a file that is plainly there.
     *
     * The URL is the same one the interface uses and needs the same
     * credentials — it is not a public link, and an object-store deployment
     * turns it into a short-lived signed one at the moment it is followed.
     */
    name: 'list_attachments',
    title: 'List attachments',
    description: "Files attached to a task or a page, with the URL to fetch each. The URL needs the same authorisation as this call — it is not a public link.",
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task id or identifier' },
        page: { type: 'string', description: 'Page id — give this or `task`, not both' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const taskRef = str(args.task);
      const pageRef = str(args.page);
      if (!taskRef && !pageRef) throw new McpError('Which one? Pass `task` or `page`');
      if (taskRef && pageRef) throw new McpError('Pass `task` or `page`, not both');

      // Both branches carry the owner's access rule: a private task's project
      // and a private page refuse here exactly as get_task and get_page do —
      // an attachment listing is the page's content with a download URL on it.
      const where: [string, string] = taskRef
        ? ['task_id', String(findTask(taskRef, workspaceId, ctx).id)]
        : ['page_id', String(findPage(String(pageRef), workspaceId, ctx).id)];

      return all<Row>(
        `SELECT * FROM attachments WHERE workspace_id = ? AND ${where[0]} = ? AND deleted_at IS NULL ORDER BY created_at`,
        workspaceId, where[1],
      ).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        mime: row.mime ?? null,
        size: Number(row.size ?? 0),
        url: row.url ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        uploaded_by: row.uploaded_by ?? null,
        created_at: Number(row.created_at ?? 0),
      }));
    },
  },
  {
    /**
     * The bytes back — and for an image, that means the picture.
     *
     * This is the half of attachments that was missing. An assistant could put
     * a file on a task and could list what was there, and everything it got
     * back for a screenshot was a name and a URL it has no way to follow: the
     * URL needs the same credentials as this call, and the stdio bridge in
     * `packages/mcp` forwards JSON-RPC rather than proxying HTTP. So an image
     * somebody attached to a task, or pasted into its description, was visible
     * to every person in the workspace and to nothing on this surface — "look
     * at the mockup on WEB-12" was a request Kolibri could not answer.
     *
     * An image comes back as MCP's own `image` block rather than as base64 in
     * the JSON, which is the whole point: the second is a string a model reads,
     * the first is a picture a model sees. Text comes back as text, because a
     * CSV this same tool group uploaded should be readable by the assistant
     * that wrote it. Everything else is refused *with its URL*, which is a real
     * answer rather than a shrug — a zip in a tool answer helps nobody, and the
     * file is still there for a person to open.
     *
     * Two ways to name one: `attachment`, which is what `list_attachments` and
     * `get_task` hand out, and `file`, which is the `/files/…` URL an image in
     * a description points at. The second is not a convenience. An image pasted
     * into a task's description appears in the markdown as a link and is the
     * thing being asked about, and making the caller map it back through a
     * listing to find the id of a row it already has the URL of is a request
     * whose only purpose is to work around this argument.
     */
    name: 'get_attachment',
    title: 'Read an attachment',
    description: "The contents of a file attached to a task or a page — an image comes back as an image, so this is how you look at a screenshot or a mockup somebody attached. Text files come back as text. Name it with `attachment` (the id from list_attachments or get_task) or with `file` (the /files/… URL an image in a description points at).",
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        attachment: { type: 'string', description: 'Attachment id, from list_attachments or get_task' },
        file: {
          type: 'string',
          description: 'A /files/<hash>/<name> URL — what an image in a task description or a page points at. Give this or `attachment`, not both.',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: async (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const attachmentRef = str(args.attachment);
      const fileRef = str(args.file);
      if (!attachmentRef && !fileRef) throw new McpError('Which one? Pass `attachment` or `file`');
      if (attachmentRef && fileRef) throw new McpError('Pass `attachment` or `file`, not both');

      const attachment = attachmentRef ? findAttachment(attachmentRef, workspaceId, ctx) : null;
      const hash = attachment ? hashOf(attachment) : hashFrom(fileRef!);

      /*
       * The `files` row, and not the attachment's own columns.
       *
       * An attachment records a name, a type and a size, and every one of them
       * was written by whoever uploaded it. The `files` row is what the store
       * is actually holding — including which backend holds it, which the
       * attachment does not know at all, and which decides where to look.
       *
       * Scoped to this workspace, because a hash is not a capability. The same
       * bytes in two workspaces are one blob with a row in each, and asking the
       * store for a key without asking whose file it is would turn "I know a
       * hash" into "I may have that file" — the same mistake `findTask` has a
       * paragraph about.
       */
      const file = get<Row>(`SELECT * FROM files WHERE hash = ? AND workspace_id = ?`, hash, workspaceId);
      if (!file) throw new McpError('No such file in this workspace');

      /*
       * And whose file it is, for the branch that has not asked yet.
       *
       * `findAttachment` above already refused a private task's or page's file,
       * which is the stricter question — it is about this row rather than about
       * any row carrying these bytes. The `file` branch has asked nothing, and a
       * URL is a hash with a name on the end: without this, pasting the URL out
       * of a private project's description would fetch what the listing refuses
       * to mention.
       */
      if (!attachment && !mayRead(hash, workspaceId, ctx)) {
        throw new McpError('That file is attached to something you cannot see');
      }

      const mime = String(file.mime ?? 'application/octet-stream');
      const name = str(attachment?.name) ?? String(file.name ?? 'file');
      const url = str(attachment?.url) ?? `/files/${hash}/${encodeURIComponent(name)}`;
      const recorded = Number(file.size ?? 0);

      // Refuse before reading, and say where the file still is. Both of these
      // are cheap answers to expensive questions, and a caller that gets the
      // URL back can hand it to a person rather than to a model.
      if (!MODEL_IMAGES.has(mime) && !isText(mime)) {
        throw new McpError(
          mime.startsWith('image/')
            ? `${name} is ${mime}, which a model cannot look at. Open ${url} instead — it needs the same authorisation as this call.`
            : `${name} is ${mime}, which does not belong in an answer. Open ${url} instead — it needs the same authorisation as this call.`,
        );
      }
      if (recorded > MAX_INLINE_BYTES) {
        throw new McpError(
          `${name} is ${(recorded / 1024 / 1024).toFixed(1)} MB and an answer carries at most ${MAX_INLINE_BYTES / 1024 / 1024} MB.`
          + ` Open ${url} instead — it needs the same authorisation as this call.`,
        );
      }

      const body = await storage.readAll(
        storage.keyFor(hash, mime), MAX_INLINE_BYTES, (file.storage ?? 'disk') as storage.StorageKind,
      );
      if (!body) throw new McpError(`The bytes behind ${name} are missing from storage`);

      const meta = {
        ...(attachment ? { attachment: String(attachment.id) } : {}),
        name, mime, url,
        size: body.length,
        width: file.width ?? null,
        height: file.height ?? null,
      };

      /*
       * The metadata first, then the file.
       *
       * Two blocks rather than one, so this tool still answers what every other
       * tool answers — the JSON a caller can read `name` and `size` out of —
       * and carries the picture as well. `structuredContent` is that same
       * metadata and never the bytes: a client that reads only the structured
       * half gets a usable answer, and nobody pays for the base64 twice.
       */
      return new ToolAnswer(
        [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          MODEL_IMAGES.has(mime)
            ? { type: 'image', data: body.toString('base64'), mimeType: mime }
            : { type: 'text', text: body.toString('utf8') },
        ],
        meta,
      );
    },
  },
  {
    /**
     * Detach a file.
     *
     * This removes the attachment — the row that puts the file on the task —
     * and not the bytes. Storage is content-addressed and shared: the same
     * bytes uploaded to two workspaces are one blob with two rows, so deleting
     * the blob here would take the file out from under somebody else. Sweeping
     * blobs that no row points at any more is a separate job, and deliberately
     * not this one.
     *
     * Soft, like every other delete here: it goes to the trash and can be
     * restored.
     */
    name: 'delete_attachment',
    title: 'Delete attachment',
    description: 'Remove a file from the task or page it is attached to. Soft — it goes to the trash and can be restored. The stored bytes are shared and are not deleted.',
    schema: {
      type: 'object',
      required: ['attachment_id'],
      properties: {
        attachment_id: { type: 'string', description: 'From list_attachments' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const row = findAttachment(String(args.attachment_id), workspaceId, ctx);
      deleteEntity('attachment', String(row.id), writeOpts(workspaceId, ctx));
      return { deleted: String(row.name), id: String(row.id) };
    },
  },
];
