/**
 * The wiki: reading it, writing it, and starting from a template.
 */
import {
  artboard, findAnchor, isBoardFormat, isPin, linkGraph, makeAnchor, orderKey, pageResolver, passageOf, textAnchor, wikiLinks,
  type LinkablePage, type PageFormat,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { canSeeSubject, deleteEntity, serialize, wouldLoop, writeEntity } from '../../../kernel/write-path/repo.ts';
import { renameFollowers } from '../../../modules/pages/rules/pages.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import {
  findPage, findProject, McpError, requireWrite, str, type McpCtx, type ToolDef, visiblePagesSql, workspaceOf, writeOpts,
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
      WHERE workspace_id = ? AND deleted_at IS NULL ${visiblePagesSql()}`,
    workspaceId, userId, userId,
  ).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    created_at: Number(row.created_at ?? 0),
  }));

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
  // The write path's own walk, which the task and component trees already use
  // — the question "would this make a loop" has one answer here, not one per
  // kind of tree.
  if (wouldLoop('pages', String(page.id), String(parent.id))) {
    throw new McpError(`"${page.title}" cannot be moved inside itself`);
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

/**
 * The rung a name asks for, in this workspace's own ladder.
 *
 * By name because that is what an assistant has been told — "mark it final" —
 * and by id because that is what `list_page_statuses` hands back. Unresolvable
 * is an error rather than a silent draft: a page quietly left on the wrong rung
 * is the one failure this feature exists to prevent.
 */
function findStatus(wanted: string, workspaceId: string): Row {
  const rungs = all<Row>(
    `SELECT id, name, kind FROM page_statuses WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId,
  );
  const want = wanted.trim().toLowerCase();
  const found = rungs.find((rung) => String(rung.id) === wanted)
    ?? rungs.find((rung) => String(rung.name).toLowerCase() === want)
    // The kind as a last resort, so `final` works in a workspace that calls it
    // something else — which is the word an assistant is most likely to be given.
    ?? rungs.find((rung) => String(rung.kind) === want);
  if (!found) {
    throw new Error(`No page status here is called "${wanted}". ${rungs.map((rung) => rung.name).join(', ') || 'This workspace has none.'}`);
  }
  return found;
}


/** The four things a page may be; anything else is markdown. */
const asFormat = (raw: unknown): PageFormat => {
  const format = str(raw);
  return format === 'html' || format === 'canvas' || format === 'board' ? format : 'markdown';
};

/** What a new page shows in the tree before anybody picks an icon. */
const ICONS: Record<PageFormat, string> = { markdown: '📄', html: '📄', canvas: '🎨', board: '🖼️' };

/**
 * What a board may be, said once for every tool that writes one.
 *
 * The frame a board is drawn in reaches no network at all — that is what lets
 * it run scripts — so everything a board needs has to be inside it. Said in the
 * tool description because the assistant writing the board is the one who has
 * to know, and a board that loads Chart.js from a CDN draws a blank box.
 */
const BOARD_RULES = 'A board is one complete, self-contained HTML document (`<!doctype html>` … `</html>`): inline `<style>` and `<script>` are fine and run, but nothing is fetched — no CDN scripts, no web fonts, no remote images, no `fetch`. Use system fonts and inline SVG. For a picture, upload it with `upload_attachment` on the canvas page and use the `/files/…` url it answers as the `src`: the app hands the board the picture itself. Put the look in inline `style` attributes where you can: that is what people restyle in the editor. Make it responsive: a board page is read on phones at about 390px, where nothing may run off the side — grids of cards as `repeat(auto-fit, minmax(…, 1fr))`, rows that wrap, wide tables in a box that scrolls sideways, no fixed width wider than a phone.';

/** A board on a page this caller may see, by id. */
function findBoard(ref: string, workspaceId: string, ctx: McpCtx): { board: Row; page: Row } {
  const board = get<Row>(`SELECT * FROM artboards WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, ref, workspaceId);
  if (!board) throw new McpError(`Board ${ref} not found`);
  // The page's own lookup, so a board is exactly as findable as its canvas.
  const page = findPage(String(board.page_id), workspaceId, ctx);
  return { board, page };
}

/** A board as a listing shows it: everything but the HTML, and how much of that there is. */
const boardSummary = (row: Row) => ({
  id: row.id, title: row.title, kind: row.kind, x: row.x, y: row.y, w: row.w, h: row.h, color: row.color,
  characters: String(row.content ?? '').length,
  text: artboard.text(String(row.content ?? '')).slice(0, 160),
});

/** Where a new board goes when the caller did not say: to the right of everything already there. */
function nextSpot(pageId: string): { x: number; y: number } {
  const edge = get<Row>(
    `SELECT MAX(x + w) AS right, MIN(y) AS top FROM artboards WHERE page_id = ? AND deleted_at IS NULL`, pageId,
  );
  return edge?.right === null || edge?.right === undefined ? { x: 0, y: 0 } : { x: Number(edge.right) + 80, y: Number(edge.top ?? 0) };
}

const finite = (value: unknown): number | undefined => (value === undefined || value === null || !Number.isFinite(Number(value)) ? undefined : Number(value));

export const pageTools: ToolDef[] = [
  {
    name: 'list_page_statuses',
    title: 'List page statuses',
    description: 'The rungs this workspace uses for how finished a page is, in its own order. `kind` is what the product reads — draft, review or final — whatever the rung is called.',
    readOnly: true,
    schema: { type: 'object', properties: { workspace_id: { type: 'string' } } },
    run: (args, ctx) => all<Row>(
      `SELECT id, name, kind, color, sort_order FROM page_statuses
        WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
      workspaceOf(args, ctx),
    ),
  },
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
        `SELECT id, title, icon, project_id, parent_id, sort_order, updated_at, created_by, is_template, format,
            (SELECT name FROM page_statuses WHERE id = pages.status_id) AS status FROM pages
          WHERE workspace_id = ? ${project ? 'AND project_id = ?' : ''} ${level} AND deleted_at IS NULL AND archived = 0
            ${templates ? '' : 'AND is_template = 0'}
            ${visiblePagesSql()}
          ORDER BY ${parent ? 'sort_order' : 'updated_at DESC'} LIMIT 200`,
        workspaceId,
        ...(project ? [project.id] : []),
        ...(under ? [under] : []),
        ctx.auth.userId, ctx.auth.userId,
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
        // A canvas is its boards, and a board page is its one: listed here
        // without their HTML, which `get_artboard` reads one at a time.
        ...(isBoardFormat(page.format as PageFormat) ? {
          artboards: all<Row>(
            `SELECT * FROM artboards WHERE page_id = ? AND deleted_at IS NULL ORDER BY sort_order`, String(page.id),
          ).map(boardSummary),
        } : {}),
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
    description: `Create a wiki page from markdown, from HTML with \`format: "html"\`, an empty canvas with \`format: "canvas"\` — a page of positioned HTML boards and notes that people edit visually and comment on; add boards to it with \`add_artboard\` — or a board page with \`format: "board"\`: one board shown on its own like a page, whose HTML is \`content\`. ${BOARD_RULES}`,
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' }, content: { type: 'string' }, project: { type: 'string' },
        parent: { type: 'string' }, icon: { type: 'string' }, workspace_id: { type: 'string' },
        format: {
          type: 'string', enum: ['markdown', 'html', 'canvas', 'board'],
          description: 'What `content` is written in. Markdown unless said otherwise; HTML is rendered through an allowlist, so a script or a style block in it is dropped rather than stored and refused. `canvas` makes a canvas instead: its content is its boards, so leave `content` out and call `add_artboard`. `board` makes a board page: `content` is the board\'s whole HTML document, kept and run as written.',
        },
        w: { type: 'number', description: 'A board page\'s width in pixels — 1280 unless said otherwise, 390 for a phone screen.' },
        h: { type: 'number', description: 'A board page\'s height in pixels — 800 unless said otherwise. Content taller than this makes the page longer.' },
        status: {
          type: 'string',
          description: "How finished it is — a rung's name, its id, or one of `draft`, `review`, `final`. Left out, it starts on the workspace's draft.",
        },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const format = asFormat(args.format);
      // A board page's content is its board, not its text.
      const board = format === 'board';
      const { row } = writeEntity('page', uid(), {
        workspace_id: workspaceId,
        project_id: project?.id ?? null,
        parent_id: str(args.parent) ?? null,
        title: String(args.title),
        icon: str(args.icon) ?? ICONS[format],
        content: board ? '' : String(args.content ?? ''),
        format,
        created_by: ctx.auth.userId,
        // Only when asked for. Left undefined, the write path's own default
        // puts it on the workspace's draft — one answer, not two.
        ...(args.status === undefined ? {} : { status_id: findStatus(String(args.status), workspaceId).id }),
      }, writeOpts(workspaceId, ctx));
      if (!board) return serialize('page', row);
      const made = writeEntity('artboard', uid(), {
        workspace_id: workspaceId, page_id: row.id, title: String(args.title), kind: 'html',
        content: String(args.content ?? ''), x: 0, y: 0, w: finite(args.w) ?? 1280, h: finite(args.h) ?? 800,
        sort_order: orderKey(null, null),
      }, writeOpts(workspaceId, ctx));
      return { ...serialize('page', row), artboard: boardSummary(made.row), url: `${env.publicUrl}/pages/${row.id}` };
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
        format: {
          type: 'string', enum: ['markdown', 'html', 'canvas', 'board'],
          description: 'Change what the body is read as. The text is not converted — send `content` in the new language in the same call, or the page will render its old body through the new renderer. A canvas and a board page keep their boards in rows of their own, so switching to or from them neither creates nor removes any; a canvas becomes a board page only while it has one board and no notes. To change a board page\'s HTML, use `update_artboard` on its board (listed by `get_page`).',
        },
        parent: {
          type: 'string',
          description: "Move it under this page — id or exact title. `root` takes it back to the top level.",
        },
        status: {
          type: 'string',
          description: "Move it to this rung — a name, an id, or one of `draft`, `review`, `final`.",
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      // `findPage` rather than a query of its own, which is what this was: a
      // second copy of the lookup that asked about neither the project nor
      // `access`, so a colleague's private page could be rewritten by anybody
      // holding a token. Being allowed to write in a workspace is not the same
      // as being allowed to write *this*.
      const page = findPage(String(args.page), workspaceId, ctx);
      const patch: Record<string, unknown> = {};
      /* Counted before the write, because the write is what changes the answer.
         The rewriting itself belongs to the write path — see `renameFollowers`
         — so this is only the sentence the caller needs to hear about it. */
      const following = args.title !== undefined
        ? renameFollowers(String(page.id), workspaceId, String(page.title ?? ''), String(args.title)).length
        : 0;
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.status !== undefined) patch.status_id = findStatus(String(args.status), workspaceId).id;
      if (args.content !== undefined) patch.content = String(args.content);
      if (args.append) patch.content = `${page.content ?? ''}\n\n${args.append}`;
      if (args.icon !== undefined) patch.icon = str(args.icon) ?? null;
      if (args.format !== undefined) patch.format = asFormat(args.format);
      if (args.parent !== undefined) Object.assign(patch, reparent(page, String(args.parent), workspaceId, ctx));
      const { row } = writeEntity('page', page.id, patch, writeOpts(workspaceId, ctx));
      // Said in the answer, because rewriting other people's pages is a real
      // thing to have done and the caller is the only one who can mention it.
      return { ...serialize('page', row), ...(following ? { links_followed: following } : {}) };
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
            ${visiblePagesSql()}
            ${project ? 'AND (project_id IS NULL OR project_id = ?)' : ''}
          ORDER BY title LIMIT 100`,
        ...(project
          ? [workspaceId, ctx.auth.userId, ctx.auth.userId, project.id]
          : [workspaceId, ctx.auth.userId, ctx.auth.userId]),
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
    description: 'Copy a template into a new page — the same thing the New from template button does. A copy, not a link: editing the new page never edits the template. A canvas or board page template gives the new page copies of its boards.',
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
           AND (id = ? OR lower(title) = lower(?)) ${visiblePagesSql()}`,
        workspaceId, String(args.template), String(args.template), ctx.auth.userId, ctx.auth.userId,
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
        // ...and in the language the template is written in, which is the one
        // thing about a copy that must not be decided by a default.
        format: asFormat(template.format),
        icon: template.icon ?? null,
        created_by: ctx.auth.userId,
        // Never a template itself. Copying one is how somebody ends up with
        // four almost-identical templates and no idea which is the real one.
        is_template: 0,
      }, writeOpts(workspaceId, ctx));

      // A canvas or a board page is its boards, so the copy is of them: fresh
      // rows where they stood, with none of the template's comments or history.
      const boards = isBoardFormat(row.format as PageFormat)
        ? all<Row>(`SELECT * FROM artboards WHERE page_id = ? AND deleted_at IS NULL ORDER BY sort_order`, String(template.id))
        : [];
      for (const board of boards) {
        writeEntity('artboard', uid(), {
          workspace_id: workspaceId, page_id: row.id,
          // A board page's board carries the page's title, which may be a new one.
          title: row.format === 'board' ? String(row.title) : String(board.title ?? ''),
          kind: board.kind, content: String(board.content ?? ''), color: board.color ?? null,
          x: board.x, y: board.y, w: board.w, h: board.h, sort_order: board.sort_order,
        }, writeOpts(workspaceId, ctx));
      }

      return {
        id: String(row.id),
        title: String(row.title),
        from_template: String(template.title),
        ...(boards.length ? { artboards: boards.length } : {}),
        project: project?.key ?? null,
        url: `${env.publicUrl}/pages/${row.id}`,
      };
    },
  },
  {
    name: 'get_artboard',
    title: 'Get artboard',
    description: 'Read one board on a canvas page, including its whole HTML. `get_page` lists a canvas\'s boards without it.',
    readOnly: true,
    schema: { type: 'object', required: ['artboard'], properties: { artboard: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const { board, page } = findBoard(String(args.artboard), workspaceId, ctx);
      const { body: _body, ...rest } = serialize('artboard', board) ?? {};
      return { ...rest, page: page.title };
    },
  },
  {
    name: 'add_artboard',
    title: 'Add artboard',
    description: `Put a board on a canvas page: a styled, optionally interactive HTML document people can then edit visually, rearrange and comment on — or, with \`kind: "note"\`, a sticky note of plain text. ${BOARD_RULES} Left without a position it goes to the right of the boards already there.`,
    schema: {
      type: 'object',
      required: ['page'],
      properties: {
        page: { type: 'string', description: 'The canvas page, by id or exact title.' },
        title: { type: 'string' },
        html: { type: 'string', description: 'The board\'s whole HTML document — or a note\'s text.' },
        kind: { type: 'string', enum: ['html', 'note'] },
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number', description: 'Width in pixels: 1280–1440 for a page or dashboard, 390 for a phone screen.' },
        h: { type: 'number' },
        color: { type: 'string', enum: ['yellow', 'blue', 'green', 'pink'], description: 'A note\'s colour.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const page = findPage(String(args.page), workspaceId, ctx);
      if (page.format === 'board') {
        throw new McpError(`"${page.title}" is a board page and holds one board already — change it with update_artboard (get_page lists it), or make the page a canvas with update_page and format: "canvas" to put more beside it.`);
      }
      if (page.format !== 'canvas') throw new McpError(`"${page.title}" is not a canvas. Create one with create_page and format: "canvas".`);
      const note = str(args.kind) === 'note';
      const spot = nextSpot(String(page.id));
      const last = get<Row>(`SELECT sort_order FROM artboards WHERE page_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC LIMIT 1`, String(page.id));
      const { row } = writeEntity('artboard', uid(), {
        workspace_id: workspaceId,
        page_id: page.id,
        title: str(args.title) ?? '',
        kind: note ? 'note' : 'html',
        content: String(args.html ?? ''),
        x: finite(args.x) ?? spot.x,
        y: finite(args.y) ?? spot.y,
        w: finite(args.w) ?? (note ? 240 : 1280),
        h: finite(args.h) ?? (note ? 180 : 800),
        color: note ? (str(args.color) ?? 'yellow') : null,
        sort_order: orderKey((last?.sort_order as string | null) ?? null, null),
      }, writeOpts(workspaceId, ctx));
      return { ...boardSummary(row), page: page.title, url: `${env.publicUrl}/pages/${page.id}` };
    },
  },
  {
    name: 'update_artboard',
    title: 'Update artboard',
    description: `Change a board on a canvas: replace its HTML, rename it, move or resize it. ${BOARD_RULES} Sending \`html\` replaces the whole document, so read it with \`get_artboard\` first and send back the edited whole — somebody may have restyled it by hand since you wrote it.`,
    schema: {
      type: 'object',
      required: ['artboard'],
      properties: {
        artboard: { type: 'string' },
        title: { type: 'string' }, html: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
        color: { type: 'string', enum: ['yellow', 'blue', 'green', 'pink'] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const { board } = findBoard(String(args.artboard), workspaceId, ctx);
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = String(args.title);
      if (args.html !== undefined) patch.content = String(args.html);
      if (args.color !== undefined) patch.color = str(args.color) ?? null;
      for (const field of ['x', 'y', 'w', 'h'] as const) {
        const value = finite(args[field]);
        if (value !== undefined) patch[field] = value;
      }
      const { row } = writeEntity('artboard', String(board.id), patch, writeOpts(workspaceId, ctx));
      return boardSummary(row);
    },
  },
  {
    name: 'delete_artboard',
    title: 'Delete artboard',
    description: 'Take a board off its canvas. It goes to the trash, where it can be restored from.',
    destructive: true,
    schema: { type: 'object', required: ['artboard'], properties: { artboard: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const { board } = findBoard(String(args.artboard), workspaceId, ctx);
      deleteEntity('artboard', String(board.id), writeOpts(workspaceId, ctx));
      return { deleted: board.id, title: board.title };
    },
  },
  {
    name: 'comment_page',
    title: 'Comment on a page',
    description: 'Add a markdown comment to a page\'s discussion. On a canvas, name an `artboard` to pin it there — at `x`, `y` in the board\'s own pixels, its top-left corner if left out.',
    schema: {
      type: 'object',
      required: ['page', 'body'],
      properties: {
        page: { type: 'string' }, body: { type: 'string' },
        artboard: { type: 'string', description: 'Pin the comment to this board of the canvas.' },
        x: { type: 'number' }, y: { type: 'number' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      // `findPage` asks whether this caller may see the page at all, which the
      // comment's own write path does not ask on a create.
      const page = findPage(String(args.page), workspaceId, ctx);
      let anchor: Record<string, unknown> | null = null;
      if (args.artboard !== undefined) {
        const { board } = findBoard(String(args.artboard), workspaceId, ctx);
        if (String(board.page_id) !== String(page.id)) throw new McpError('That board is on another page');
        anchor = { board: board.id, x: Math.round(finite(args.x) ?? 24), y: Math.round(finite(args.y) ?? 24) };
      }
      const { row } = writeEntity('comment', uid(), {
        workspace_id: workspaceId, page_id: page.id, body: String(args.body), author_id: ctx.auth.userId, anchor,
      }, writeOpts(workspaceId, ctx));
      return { id: row.id, page: page.title, created_at: row.created_at, ...(anchor ? { pinned_to: args.artboard } : {}) };
    },
  },
  {
    name: 'list_page_comments',
    title: 'List page comments',
    description: 'The discussion on a page, oldest first: who said what, what it is about — the passage quoted on a text page, the board it is pinned to on a canvas — whether it is still open, and for a suggestion what it proposes instead (`suggests`).',
    readOnly: true,
    schema: { type: 'object', required: ['page'], properties: { page: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const page = findPage(String(args.page), workspaceId, ctx);
      const boards = new Map(all<Row>(`SELECT id, title FROM artboards WHERE page_id = ?`, String(page.id)).map((row) => [String(row.id), String(row.title ?? '')]));
      return all<Row>(
        `SELECT c.id, c.body, c.anchor, c.created_at, c.edited_at, c.guest_name, c.suggestion, c.resolution,
                u.name AS author, r.name AS resolved_by
           FROM comments c LEFT JOIN users u ON u.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by
          WHERE c.page_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`,
        String(page.id),
      ).map((row) => {
        let anchor: unknown = null;
        try { anchor = row.anchor ? JSON.parse(String(row.anchor)) : null; } catch { anchor = null; }
        const quoted = textAnchor(anchor as never) ?? passageOf(anchor as never);
        return {
          id: row.id,
          author: row.author ?? row.guest_name ?? null,
          body: row.body,
          created_at: row.created_at,
          status: row.resolution ?? 'open',
          ...(row.resolution ? { settled_by: row.resolved_by ?? null } : {}),
          ...(quoted ? { about: quoted.quote } : {}),
          ...(row.suggestion !== null && row.suggestion !== undefined ? { suggests: row.suggestion } : {}),
          ...(isPin(anchor) ? { pinned_to: { artboard: anchor.board, title: boards.get(anchor.board) ?? null, x: anchor.x, y: anchor.y } } : {}),
        };
      });
    },
  },
  {
    name: 'suggest_page_edit',
    title: 'Suggest a page edit',
    description: 'Propose replacing a passage of a page — or of one board on a canvas — instead of changing it. It appears in the page\'s discussion with the old words struck through and the new ones beside them, and a person accepts or rejects it; accepting writes it in. Quote the passage exactly as the page has it (`get_page`, `get_artboard`); a passage that appears more than once needs a longer quote.',
    schema: {
      type: 'object',
      required: ['page', 'quote', 'replacement'],
      properties: {
        page: { type: 'string' },
        quote: { type: 'string', description: 'The exact words to replace, as they stand in the page\'s content or the board\'s HTML.' },
        replacement: { type: 'string', description: 'What they should say instead. Plain text; empty to suggest removing them.' },
        body: { type: 'string', description: 'Why — shown with the suggestion.' },
        artboard: { type: 'string', description: 'On a canvas: the board whose HTML the quote is in.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const page = findPage(String(args.page), workspaceId, ctx);
      const quote = String(args.quote ?? '');
      if (!quote.trim()) throw new McpError('Quote the words to replace');
      let text = String(page.content ?? '');
      let board: Row | null = null;
      if (args.artboard !== undefined) {
        board = findBoard(String(args.artboard), workspaceId, ctx).board;
        if (String(board.page_id) !== String(page.id)) throw new McpError('That board is on another page');
        text = String(board.content ?? '');
      }
      // Exactly once, or the person accepting it could not know which copy is
      // meant — and neither could the server, the day it writes it in.
      const first = text.indexOf(quote);
      if (first < 0) {
        const loose = findAnchor(text, { quote, prefix: '', suffix: '' });
        if (!loose) throw new McpError('Those words are not in it. Quote them exactly as they stand.');
      }
      if (first >= 0 && text.indexOf(quote, first + 1) >= 0) {
        throw new McpError('Those words appear more than once. Quote a longer passage, so it says which one.');
      }
      const found = first >= 0 ? { start: first, end: first + quote.length } : findAnchor(text, { quote, prefix: '', suffix: '' })!;
      const passage = makeAnchor(text, found.start, found.end)!;
      const anchor = board ? { board: board.id, x: 24, y: 24, ...passage } : passage;
      const { row } = writeEntity('comment', uid(), {
        workspace_id: workspaceId, page_id: page.id, body: String(args.body ?? ''), author_id: ctx.auth.userId,
        anchor, suggestion: String(args.replacement ?? ''),
      }, writeOpts(workspaceId, ctx));
      return { id: row.id, page: page.title, status: 'open', about: passage.quote, suggests: row.suggestion };
    },
  },
  {
    name: 'resolve_comment',
    title: 'Settle a comment',
    description: 'Settle a comment on a page: `resolved` closes a thread, `accepted` writes a suggestion\'s replacement into the page or board, `rejected` turns it down, `open` reopens it. Accepting is refused when the passage has changed since the suggestion was made.',
    schema: {
      type: 'object',
      required: ['comment', 'status'],
      properties: {
        comment: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'accepted', 'rejected', 'open'] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      const found = get<Row>(`SELECT id, page_id FROM comments WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, String(args.comment), workspaceId);
      // Not found and not yours to see are the same answer, as for a page.
      if (!found || !canSeeSubject(ctx.auth.userId, 'comment', String(found.id))) throw new McpError(`Comment ${args.comment} not found`);
      const status = str(args.status);
      const { row } = writeEntity('comment', String(found.id), { resolution: status === 'open' ? null : status }, writeOpts(workspaceId, ctx));
      return { id: row.id, status: row.resolution ?? 'open' };
    },
  },
];
