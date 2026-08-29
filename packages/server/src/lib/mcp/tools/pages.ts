/**
 * The wiki: reading it, writing it, and starting from a template.
 */
import { all, get, type Row } from '../../../db/index.ts';
import { env } from '../../../env.ts';
import { serialize, writeEntity } from '../../repo.ts';
import { uid } from '../../ids.ts';
import { findPage, findProject, McpError, requireWrite, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

export const pageTools: ToolDef[] = [
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'List wiki pages, optionally scoped to a project. Templates are left out — `list_page_templates` has those.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        include_templates: { type: 'boolean', description: 'Include the pages marked as templates, flagged with `is_template`.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      /* Templates out by default, and flagged when asked for. They were mixed
         in and unmarked: a template is a starting point rather than content, so
         an assistant summarising "the pages in this project" was summarising a
         half-written form as though somebody had meant it. The interface has
         always kept them out of the tree for the same reason. */
      const templates = args.include_templates === true;
      return all<Row>(
        `SELECT id, title, icon, project_id, parent_id, updated_at, created_by, is_template FROM pages
          WHERE workspace_id = ? ${project ? 'AND project_id = ?' : ''} AND deleted_at IS NULL AND archived = 0
            ${templates ? '' : 'AND is_template = 0'}
            AND (access <> 'private' OR created_by = ?)
          ORDER BY updated_at DESC LIMIT 200`,
        ...(project ? [workspaceId, project.id, ctx.auth.userId] : [workspaceId, ctx.auth.userId]),
      );
    },
  },
  {
    name: 'get_page',
    title: 'Get page',
    description: 'Read a wiki page by id or exact title, including its markdown body.',
    readOnly: true,
    schema: { type: 'object', required: ['page'], properties: { page: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const page = findPage(String(args.page), workspaceId, ctx);
      return serialize('page', page);
    },
  },
  {
    name: 'create_page',
    title: 'Create page',
    description: 'Create a wiki page from markdown.',
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' }, content: { type: 'string' }, project: { type: 'string' },
        parent: { type: 'string' }, icon: { type: 'string' }, workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const { row } = writeEntity('page', uid(), {
        workspace_id: workspaceId,
        project_id: project?.id ?? null,
        parent_id: str(args.parent) ?? null,
        title: String(args.title),
        icon: str(args.icon) ?? '📄',
        content: String(args.content ?? ''),
        created_by: ctx.auth.userId,
      }, writeOpts(workspaceId, ctx));
      return serialize('page', row);
    },
  },
  {
    name: 'update_page',
    title: 'Update page',
    description: 'Replace or append to a page body. The previous revision is kept in the page history.',
    schema: {
      type: 'object',
      required: ['page'],
      properties: {
        page: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        append: { type: 'string', description: 'Markdown appended to the end instead of replacing' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const page = get<Row>(
        `SELECT * FROM pages WHERE workspace_id = ? AND (id = ? OR lower(title) = lower(?)) AND deleted_at IS NULL LIMIT 1`,
        workspaceId, args.page, args.page,
      );
      if (!page) throw new McpError(`Page ${args.page} not found`);
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.content !== undefined) patch.content = String(args.content);
      if (args.append) patch.content = `${page.content ?? ''}\n\n${args.append}`;
      const { row } = writeEntity('page', page.id, patch, writeOpts(workspaceId, ctx));
      return serialize('page', row);
    },
  },
  {
    name: 'list_page_templates',
    title: 'List page templates',
    description: 'The pages marked as templates — meeting notes, a decision record, a runbook — that `create_page_from_template` can start a new page from.',
    readOnly: true,
    schema: { type: 'object', properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      return all<Row>(
        `SELECT id, title, icon, project_id, updated_at FROM pages
          WHERE workspace_id = ? AND is_template = 1 AND deleted_at IS NULL AND archived = 0
            AND (access <> 'private' OR created_by = ?)
            ${project ? 'AND (project_id IS NULL OR project_id = ?)' : ''}
          ORDER BY title LIMIT 100`,
        ...(project ? [workspaceId, ctx.auth.userId, project.id] : [workspaceId, ctx.auth.userId]),
      ).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        icon: row.icon ?? null,
        // The key people type, not the id — a template is picked by name.
        project: row.project_id
          ? (get<Row>(`SELECT key FROM projects WHERE id = ?`, row.project_id)?.key ?? null)
          : null,
      }));
    },
  },
  {
    name: 'create_page_from_template',
    title: 'New page from a template',
    description: 'Copy a template into a new page — the same thing the New from template button does. A copy, not a link: editing the new page never edits the template.',
    schema: {
      type: 'object',
      required: ['template'],
      properties: {
        template: { type: 'string', description: 'Template id or exact title, from list_page_templates' },
        title: { type: 'string', description: "The new page's title. Defaults to the template's." },
        project: { type: 'string', description: "Key or name. Defaults to the template's project, which may be none." },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const template = get<Row>(
        `SELECT * FROM pages WHERE workspace_id = ? AND is_template = 1 AND deleted_at IS NULL
           AND (id = ? OR lower(title) = lower(?)) AND (access <> 'private' OR created_by = ?)`,
        workspaceId, String(args.template), String(args.template), ctx.auth.userId,
      );
      if (!template) throw new McpError(`No page template called "${args.template}" — list_page_templates has the ones there are`);

      const project = str(args.project)
        ? findProject(String(args.project), workspaceId, ctx)
        : (template.project_id ? findProject(String(template.project_id), workspaceId, ctx) : null);

      const { row } = writeEntity('page', uid(), {
        workspace_id: workspaceId,
        project_id: project?.id ?? null,
        title: str(args.title) ?? String(template.title),
        // The body is a CRDT elsewhere; a fresh page starts from the text and
        // grows its own history rather than inheriting the template's.
        content: String(template.content ?? ''),
        icon: template.icon ?? null,
        created_by: ctx.auth.userId,
        // Never a template itself. Copying one is how somebody ends up with
        // four almost-identical templates and no idea which is the real one.
        is_template: 0,
      }, writeOpts(workspaceId, ctx));

      return {
        id: String(row.id),
        title: String(row.title),
        from_template: String(template.title),
        project: project?.key ?? null,
        url: `${env.publicUrl}/pages/${row.id}`,
      };
    },
  },
];
