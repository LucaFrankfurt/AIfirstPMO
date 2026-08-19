/**
 * Public share links.
 *
 * A share is rendered by the *server*, as one small HTML document, rather than
 * handed to the app. Three reasons, in order: somebody outside the workspace
 * has no session and the app is built around having one; a link that opens as a
 * document works in any browser on any connection; and the smaller the surface
 * an anonymous request can reach, the easier it is to be sure of it.
 *
 * The token in the URL is the whole of the authorisation, so this file is
 * deliberately narrow: it reads one row, renders it, and offers nothing else.
 */
import { renderMarkdown } from '@kolibri/shared';
import { all, get, run, type Row } from '../db/index.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';
import type { Ctx, Router } from '../lib/http.ts';

const escape = (text: unknown): string =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The page a share renders into.
 *
 * Styles are inline and small on purpose: this document has to stand on its own
 * without the app's stylesheet, and a stranger's browser should not be asked to
 * download a bundle to read a paragraph.
 */
function document_(title: string, body: string, workspace: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #14161a; --muted: #6b7280; --line: #e5e7eb; --bg: #fff; --accent: #5b5bd6; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e7e9ee; --muted: #9aa1ad; --line: #2a2e37; --bg: #14161a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: 20px; margin: 28px 0 8px; }
  h3 { font-size: 16px; margin: 22px 0 6px; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 14px; }
  a { color: var(--accent); }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, var(--fg) 8%, transparent); padding: 1px 4px; border-radius: 4px; }
  pre { background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
  blockquote { border-inline-start: 3px solid var(--line); padding-inline-start: 12px; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border-bottom: 1px solid var(--line); padding: 7px 10px; text-align: start; vertical-align: top; }
  th { font-size: 12.5px; color: var(--muted); font-weight: 600; }
  .meta { color: var(--muted); font-size: 13px; margin: 0 0 26px; }
  .foot { color: var(--muted); font-size: 12.5px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 14px; }
  .done td:first-child { text-decoration: line-through; color: var(--muted); }
  .pill { display: inline-block; font-size: 11.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; }
  /* A shared link is also the thing somebody prints, so it prints properly. */
  @media print {
    @page { margin: 18mm 16mm; }
    body { padding: 0; color: #000; background: #fff; }
    h1, h2, h3 { break-after: avoid; }
    p, ul, ol, pre, blockquote, table, tr { break-inside: avoid; }
    pre { white-space: pre-wrap; }
    .foot { border-color: #ddd; }
  }
</style>
</head>
<body><main>
${body}
<p class="foot">${escape(workspace)} · shared read-only from Kolibri</p>
</main></body>
</html>`;
}

const gone = (message: string): string =>
  document_('Not available', `<h1>Not available</h1><p class="meta">${escape(message)}</p>`, 'Kolibri');

function html(ctx: Ctx, body: string, status = 200): undefined {
  ctx.res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // A shared link is not a page to keep: a stale copy of a document somebody
    // has since unshared is exactly what nobody wants cached.
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  });
  ctx.res.end(body);
  return undefined;
}

/** The page a share points at, with its children — a shared page brings its tree. */
function pageBody(share: Row): string {
  const page = get<Row>(`SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL`, share.page_id);
  if (!page) return '';
  const children = all<Row>(
    `SELECT * FROM pages WHERE parent_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY sort_order`,
    page.id,
  );
  // A page whose body already opens with its own title does not get a second
  // one bolted on top — which is most pages people actually write.
  const ownTitle = (row: Row): boolean =>
    new RegExp(`^\\s*#\\s+${String(row.title ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
      .test(String(row.content ?? '').split('\n', 3).join('\n'));

  const section = (row: Row, level: number): string =>
    (ownTitle(row) ? '' : `<h${level}>${escape(row.icon ?? '')} ${escape(row.title)}</h${level}>`)
    + renderMarkdown(String(row.content ?? ''));

  return [
    ownTitle(page) ? '' : `<h1>${escape(page.icon ?? '')} ${escape(page.title)}</h1>`,
    `<p class="meta">Updated ${new Date(Number(page.updated_at)).toISOString().slice(0, 10)}</p>`,
    renderMarkdown(String(page.content ?? '')),
    ...children.map((child) => section(child, 2)),
  ].filter(Boolean).join('\n');
}

/** The tasks a shared view resolves to, as a table. */
function tasksBody(share: Row): string {
  const view = share.view_id
    ? get<Row>(`SELECT * FROM views WHERE id = ? AND deleted_at IS NULL`, share.view_id)
    : undefined;

  const filters = readFilters(view?.filters);
  const where = ['t.deleted_at IS NULL', 't.archived = 0'];
  const params: unknown[] = [];

  if (share.project_id) {
    where.push('t.project_id = ?');
    params.push(share.project_id);
  } else {
    where.push('t.workspace_id = ?');
    params.push(share.workspace_id);
  }
  if (!share.include_done) where.push(`s.group_key NOT IN ('completed', 'cancelled')`);
  // The saved view names things the way the interface does — `state`, `type`,
  // `cycle` — and the table names them `state_id` and so on. Mapping the two is
  // the whole of it, and getting it wrong shows a shared link *more* tasks than
  // the view it was made from.
  const COLUMNS: Record<string, string> = {
    state: 'state_id', type: 'type_id', cycle: 'cycle_id', module: 'module_id',
    project: 'project_id', priority: 'priority',
  };
  for (const [key, values] of Object.entries(filters)) {
    const column = COLUMNS[key];
    if (!column || !Array.isArray(values) || !values.length) continue;
    where.push(`t.${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values.map(String));
  }
  // Custom fields, which live in a table of their own. Each field is a separate
  // condition, because two fields are an AND and two answers to one are an OR.
  const fieldFilters = (filters.field && typeof filters.field === 'object' ? filters.field : {}) as Record<string, unknown>;
  for (const [fieldId, wanted] of Object.entries(fieldFilters)) {
    if (!Array.isArray(wanted) || !wanted.length) continue;
    const kind = get<Row>(`SELECT kind FROM custom_fields WHERE id = ? AND deleted_at IS NULL`, fieldId)?.kind;
    if (!kind) continue;
    const clauses: string[] = [];
    const answers = wanted.map(String);
    const exists = (test: string) => `EXISTS (SELECT 1 FROM field_values fv WHERE fv.task_id = t.id
        AND fv.field_id = ? AND fv.deleted_at IS NULL AND fv.value IS NOT NULL AND fv.value != '' AND (${test}))`;

    if (answers.includes('')) {
      clauses.push(`NOT ${exists('1 = 1')}`);
      params.push(fieldId);
    }
    if (answers.includes('*')) {
      clauses.push(exists('1 = 1'));
      params.push(fieldId);
    }
    const values = answers.filter((value) => value !== '' && value !== '*');
    if (values.length) {
      // A multi-select is stored as a JSON array, so membership is a LIKE on
      // the quoted value rather than equality. Ugly, and correct: the quotes
      // are what stop `"do"` matching `"done"`.
      const test = String(kind) === 'multi_select'
        ? values.map(() => `fv.value LIKE ?`).join(' OR ')
        : `fv.value IN (${values.map(() => '?').join(', ')})`;
      clauses.push(exists(test));
      params.push(fieldId, ...(String(kind) === 'multi_select' ? values.map((value) => `%"${value}"%`) : values));
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  const tasks = all<Row>(
    `SELECT t.*, s.name AS state_name, s.group_key
       FROM tasks t LEFT JOIN states s ON s.id = t.state_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.sort_order LIMIT 500`,
    ...params,
  );

  const people = new Map(
    all<Row>(`SELECT id, name FROM users`).map((user) => [String(user.id), String(user.name)]),
  );

  const rows = tasks.map((task) => {
    const done = task.group_key === 'completed' || task.group_key === 'cancelled';
    const assignees = safeList(task.assignees).map((id) => people.get(id) ?? '').filter(Boolean).join(', ');
    return `<tr${done ? ' class="done"' : ''}>
      <td>${escape(task.title)}</td>
      <td><span class="pill">${escape(task.state_name ?? '')}</span></td>
      <td>${escape(assignees)}</td>
      <td>${escape(task.due_date ?? '')}</td>
    </tr>`;
  }).join('\n');

  const name = share.name || view?.name || 'Tasks';
  return `<h1>${escape(name)}</h1>
<p class="meta">${tasks.length} task${tasks.length === 1 ? '' : 's'}</p>
<table>
  <thead><tr><th>Task</th><th>State</th><th>Assignees</th><th>Due</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">Nothing here yet.</td></tr>'}</tbody>
</table>`;
}

const safeList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const readFilters = (raw: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export function registerShareRoutes(router: Router): void {
  router.get('/s/:token', (ctx: Ctx) => {
    // Rate limited by address: the token is guessable only in theory, and a
    // theory is not a reason to let somebody try a million times.
    enforce(ctx, byAddress(ctx, LIMITS.invite, 'share'));

    const share = get<Row>(`SELECT * FROM shares WHERE token = ? AND deleted_at IS NULL`, ctx.params.token);
    // A page rather than a JSON 404: whoever followed this link is a person
    // with a browser, not a program with an error handler.
    if (!share) return html(ctx, gone('That link does not exist, or it was turned off.'), 404);
    if (share.expires_at && Number(share.expires_at) < Date.now()) {
      return html(ctx, gone('That link has expired.'), 410);
    }

    const workspace = get<Row>(`SELECT name FROM workspaces WHERE id = ?`, share.workspace_id);
    const body = share.kind === 'tasks' ? tasksBody(share) : pageBody(share);
    if (!body) return html(ctx, gone('The thing this link pointed at is gone.'), 404);

    // Counted rather than logged: how often a link is opened is useful, by whom
    // is not this instance's business and not something a share should collect.
    run(`UPDATE shares SET views = views + 1, last_seen_at = ? WHERE id = ?`, Date.now(), share.id);

    return html(ctx, document_(String(share.name || workspace?.name || 'Kolibri'), body, String(workspace?.name ?? 'Kolibri')));
  });
}
