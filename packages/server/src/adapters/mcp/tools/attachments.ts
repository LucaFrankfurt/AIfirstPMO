/**
 * Bytes hung off a task, a page or a comment.
 */
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { deleteEntity } from '../../../kernel/write-path/repo.ts';
import { storeFile } from '../../../kernel/files/uploads.ts';
import { findPage, findTask, McpError, mimeFromName, requireWrite, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

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
      const row = get<Row>(
        `SELECT * FROM attachments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        String(args.attachment_id), workspaceId,
      );
      if (!row) throw new McpError(`Attachment ${args.attachment_id} not found`);
      // An attachment inherits the privacy of whatever it hangs on — and it can
      // hang on a task, a page, or a comment (which itself hangs on one of the
      // other two). Checking only the task branch left files on private pages
      // deletable by people who could not read the page.
      if (row.task_id) findTask(String(row.task_id), workspaceId, ctx);
      if (row.page_id) findPage(String(row.page_id), workspaceId, ctx);
      if (row.comment_id) {
        const comment = get<Row>(`SELECT task_id, page_id FROM comments WHERE id = ?`, row.comment_id);
        if (comment?.task_id) findTask(String(comment.task_id), workspaceId, ctx);
        if (comment?.page_id) findPage(String(comment.page_id), workspaceId, ctx);
      }

      deleteEntity('attachment', String(row.id), writeOpts(workspaceId, ctx));
      return { deleted: String(row.name), id: String(row.id) };
    },
  },
];
