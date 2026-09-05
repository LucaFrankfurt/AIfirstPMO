/**
 * The wiki: reading it, writing it, and starting from a template.
 */
import {
  linkGraph, linkableTitle, orderKey, pageKey, pageResolver, renameLinks, wikiLinks, type LinkablePage,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import {
  findPage, findProject, McpError, requireWrite, str, type McpCtx, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

/**
 * Every page this person may read, as the link arithmetic wants them.
 *
 * `[[Onboarding]]` resolves by title across the whole workspace, so the answer
 * to "what links here" is only right if the whole workspace was looked at —
 * minus the pages this caller may not see, which is the same clause
 * `list_pages` applies and has to stay one sentence long for that reason.
 * Archived pages are in: a link to one still resolves, and pretending it does
 * not would report the target as unwritten.
 */
const linkablePages = (workspaceId: string, userId: string): LinkablePage[] =>
  all<Row>(
    `SELECT id, title, content, created_at FROM pages
      WHERE workspace_id = ? AND deleted_at IS NULL AND (access <> 'private' OR created_by = ?)`,
    workspaceId, userId,
  ).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    created_at: Number(row.created_at ?? 0),
  }));

/**
 * Rename a page and take the links to it along, the way the interface does.
 *
 * Here rather than in the write path, and that is a decision worth stating.
 * The client rewrites the links itself because it is offline-first: a rename
 * made on a train has to leave a wiki whose links work before anything reaches
 * a server. Doing it in the entity rule as well would mean the same rewrite
 * arriving from both ends of the sync. So each surface that offers a *rename*
 * carries it, and a raw `PATCH /api/pages/:id` — which is documented as a field
 * write and nothing more — does not.
 */
function followRename(page: Row, next: string, workspaceId: string, ctx: McpCtx): number {
  const was = String(page.title ?? '').trim();
  if (!was || !next.trim() || pageKey(was) === pageKey(next) || !linkableTitle(next.trim())) return 0;
  let moved = 0;
  for (const other of all<Row>(
    `SELECT id, content FROM pages WHERE workspace_id = ? AND deleted_at IS NULL AND id <> ?`,
    workspaceId, page.id,
  )) {
    const rewritten = renameLinks(String(other.content ?? ''), was, next.trim());
    if (rewritten === null || rewritten === String(other.content ?? '')) continue;
    writeEntity('page', String(other.id), { content: rewritten }, writeOpts(workspaceId, ctx));
    moved += 1;
  }
  return moved;
}

/**
 * Where a page lands when it is moved under another one.
 *
 * Both halves at once — the parent and a `sort_order` at the end of its new
 * siblings — for the reason `plotMove` does it on the client: they are one
 * gesture, and two writes would sync as two states, the middle of which is a
 * page briefly in the wrong place on everybody's screen. A page moved without
 * a new order keeps whatever key it had, which puts it at an arbitrary point
 * among its new siblings.
 *
 * The refusal is the one that matters: a page cannot be moved inside its own
 * subtree. Nothing stops it at the database, the walk up is over an indexed
 * column, and the branch it would detach is reachable only by URL afterwards —
 * which is a wiki quietly losing a chapter.
 */
function reparent(page: Row, ref: string, workspaceId: string, ctx: McpCtx): Record<string, unknown> {
  if (ref === 'root' || ref === '') return { parent_id: null, sort_order: lastOrder(workspaceId, null) };
  const parent = findPage(ref, workspaceId, ctx);
  if (parent.id === page.id) throw new McpError('A page cannot be its own parent');
  // A set rather than a depth limit: a cycle already in the table would spin
  // here forever, and a number picked as "deep enough" is a wrong answer
  // waiting for somebody's genuinely deep handbook.
  const seen = new Set<string>([String(parent.id)]);
  let at = String(parent.parent_id ?? '') || null;
  while (at && !seen.has(at)) {
    if (at === page.id) throw new McpError(`"${page.title}" cannot be moved inside itself`);
    seen.add(at);
    at = (get<Row>(`SELECT parent_id FROM pages WHERE id = ?`, at)?.parent_id as string | null) ?? null;
  }
  return { parent_id: parent.id, sort_order: lastOrder(workspaceId, String(parent.id)) };
}

/** A key after every sibling there, so a moved page lands at the bottom. */
function lastOrder(workspaceId: string, parentId: string | null): string {
  const last = get<Row>(
    `SELECT sort_order FROM pages
      WHERE workspace_id = ? AND deleted_at IS NULL
        AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}
      ORDER BY sort_order DESC LIMIT 1`,
    ...(parentId ? [workspaceId, parentId] : [workspaceId]),
  );
  return orderKey((last?.sort_order as string | null) ?? null, null);
}

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
        parent: {
          type: 'string',
          description: "One page's id or exact title, for its children only. `root` for the pages with no parent.",
        },
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
      /* The tree, one level at a time. Without this the only way to see the
         shape of a wiki over MCP was to fetch two hundred pages ordered by
         when they were touched and rebuild it from `parent_id` — which is a
         lot of tokens for a question the database answers with an index. */
      const parent = str(args.parent);
      const under = parent && parent !== 'root' ? findPage(parent, workspaceId, ctx).id : null;
      const level = parent ? (under ? 'AND parent_id = ?' : 'AND parent_id IS NULL') : '';
      return all<Row>(
        `SELECT id, title, icon, project_id, parent_id, sort_order, updated_at, created_by, is_template FROM pages
          WHERE workspace_id = ? ${project ? 'AND project_id = ?' : ''} ${level} AND deleted_at IS NULL AND archived = 0
            ${templates ? '' : 'AND is_template = 0'}
            AND (access <> 'private' OR created_by = ?)
          ORDER BY ${parent ? 'sort_order' : 'updated_at DESC'} LIMIT 200`,
        workspaceId,
        ...(project ? [project.id] : []),
        ...(under ? [under] : []),
        ctx.auth.userId,
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
      /* The web the page sits in, alongside its text. An assistant reading a
         wiki one page at a time has the same problem a person does — it cannot
         see what a page is part of — and answering "who links here" is what
         turns a pile of documents back into a wiki. Titles rather than ids,
         because a title is what `[[…]]` and `get_page` both take. */
      const pages = linkablePages(workspaceId, ctx.auth.userId);
      const graph = linkGraph(pages);
      const resolve = pageResolver(pages);
      const byId = new Map(pages.map((one) => [one.id, one]));
      const titles = (ids: string[] | undefined) =>
        (ids ?? []).map((id) => byId.get(id)?.title).filter((title): title is string => !!title);
      return {
        ...serialize('page', page),
        links_to: titles(graph.out.get(String(page.id))),
        linked_from: titles(graph.in.get(String(page.id))),
        // What this page asks for and nobody has written. Spelled as the author
        // typed it rather than as the index folded it, because it is a title
        // somebody is about to create a page under.
        links_unwritten: [...new Set(
          wikiLinks(String(page.content ?? ''))
            .filter((link) => !resolve(link.target))
            .map((link) => link.target),
        )],
      };
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
    description: 'Replace or append to a page body, rename it, or move it in the tree. The previous revision is kept in the page history, and a rename rewrites the `[[links]]` that pointed at the old title.',
    schema: {
      type: 'object',
      required: ['page'],
      properties: {
        page: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        append: { type: 'string', description: 'Markdown appended to the end instead of replacing' },
        icon: { type: 'string' },
        parent: {
          type: 'string',
          description: "Move it under this page — id or exact title. `root` takes it back to the top level.",
        },
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
      const renamed = args.title !== undefined ? followRename(page, String(args.title), workspaceId, ctx) : 0;
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.content !== undefined) patch.content = String(args.content);
      if (args.append) patch.content = `${page.content ?? ''}\n\n${args.append}`;
      if (args.icon !== undefined) patch.icon = str(args.icon) ?? null;
      if (args.parent !== undefined) Object.assign(patch, reparent(page, String(args.parent), workspaceId, ctx));
      const { row } = writeEntity('page', page.id, patch, writeOpts(workspaceId, ctx));
      // Said in the answer, because rewriting other people's pages is a real
      // thing to have done and the caller is the only one who can mention it.
      return { ...serialize('page', row), ...(renamed ? { links_followed: renamed } : {}) };
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
