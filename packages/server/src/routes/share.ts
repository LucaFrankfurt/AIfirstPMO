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
import { all, get, nextSeq, run, type Row } from '../db/index.ts';
import { translatorFor } from '../lib/i18n.ts';
import { createNotification } from '../lib/notify.ts';
import { uid } from '../lib/ids.ts';
import { notifyDevices } from '../lib/push.ts';
import { byAddress, enforce, LIMITS } from '../lib/ratelimit.ts';
import { readBody, type Ctx, type Router } from '../lib/http.ts';
import { readFilters, tasksMatching } from '../lib/viewquery.ts';

const escape = (text: unknown): string =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The page a share renders into.
 *
 * Styles are inline and small on purpose: this document has to stand on its own
 * without the app's stylesheet, and a stranger's browser should not be asked to
 * download a bundle to read a paragraph.
 */
function document_(title: string, body: string, workspace: string, writable = false): string {
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
  .warn { color: #b3261e; }
  .intake label { display: block; font-size: 13px; font-weight: 600; margin: 18px 0 5px; }
  .intake .req { font-weight: 400; color: var(--muted); }
  .intake input, .intake textarea {
    width: 100%; font: inherit; color: inherit; background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
  }
  .intake textarea { resize: vertical; }
  .intake .two { display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 520px) { .intake .two { grid-template-columns: 1fr; } }
  .intake .trap { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  .intake button {
    margin-top: 22px; font: inherit; font-weight: 600; color: #fff; background: var(--accent);
    border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer;
  }
  .note-box { margin-top: 40px; border-top: 1px solid var(--line); padding-top: 8px; }
  .note-box h2 { font-size: 17px; }
  /* A note box is for writing in, not for printing. */
  @media print { .note-box { display: none; } }
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
<p class="foot">${escape(workspace)} · ${writable ? 'a form from Kolibri' : 'shared read-only from Kolibri'}</p>
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
function pageBody(share: Row, notice?: 'sent' | 'problem'): string {
  const page = get<Row>(`SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL`, share.page_id);
  if (!page) return '';
  // Scoped to the shared page's own workspace as well as its parentage. The
  // write path refuses a cross-workspace `parent_id` now, but this query is
  // what *publishes* a child to strangers, and a published page is the wrong
  // place to be relying on a check made somewhere else.
  const children = all<Row>(
    `SELECT * FROM pages
      WHERE parent_id = ? AND workspace_id = ? AND deleted_at IS NULL AND archived = 0
      ORDER BY sort_order`,
    page.id, page.workspace_id,
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
    noteBox(share, notice),
  ].filter(Boolean).join('\n');
}

/**
 * A box for a stranger to leave a note, when the link says they may.
 *
 * Deliberately a *box* and not a thread: the note goes into the page's comments
 * where the team reads it, and nothing of the existing conversation comes back
 * out. A page's thread is usually internal, and a tickbox called "allow
 * comments" is nobody's idea of consent to publishing what colleagues have
 * already said about the document.
 */
function noteBox(share: Row, notice?: 'sent' | 'problem'): string {
  if (!share.allow_comments) return '';
  if (notice === 'sent') {
    return `<div class="note-box"><h2>Thank you</h2>
<p class="meta">Your note is with the people who wrote this. It is not shown on this page.</p></div>`;
  }
  return `<div class="note-box">
<h2>Leave a note</h2>
<p class="meta">It goes to the people who wrote this. Nothing here is shown on this page — not your
note, and not anything anybody else has said.</p>
${notice === 'problem' ? '<p class="warn">That did not go through. A note needs some words in it, and there is a limit on how often this box can be used.</p>' : ''}
<form method="post" class="intake">
  <label for="note">Your note</label>
  <textarea id="note" name="note" rows="5" maxlength="4000" required></textarea>
  <label for="who">Your name</label>
  <input id="who" name="who" maxlength="120" autocomplete="name" />
  <div class="trap" aria-hidden="true"><label for="company">Company</label><input id="company" name="company" tabindex="-1" autocomplete="off" /></div>
  <button type="submit">Send it</button>
</form></div>`;
}

/** The tasks a shared view resolves to, as a table. */
function tasksBody(share: Row): string {
  const view = share.view_id
    ? get<Row>(`SELECT * FROM views WHERE id = ? AND deleted_at IS NULL`, share.view_id)
    : undefined;

  // The filter translation lives in `lib/viewquery.ts` — the calendar feed
  // resolves the same views, and two copies of this is how a shared link and a
  // subscribed calendar end up disagreeing about what a view contains.
  const tasks = tasksMatching({
    workspaceId: String(share.workspace_id),
    projectId: share.project_id ? String(share.project_id) : null,
    filters: readFilters(view?.filters),
    includeDone: !!share.include_done,
  });

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

/* ------------------------------------------------------------------ intake */

/**
 * The form a stranger fills in.
 *
 * Plain HTML that posts to itself. No JavaScript at all: somebody reporting a
 * problem with your product is exactly the person whose browser might be doing
 * something unusual, and a form that needs a bundle to work is a report you
 * never receive.
 */
function intakeBody(share: Row, notice?: 'sent' | 'problem'): string {
  const project = get<Row>(`SELECT name FROM projects WHERE id = ? AND deleted_at IS NULL`, share.project_id);
  if (!project) return '';

  if (notice === 'sent') {
    return `<h1>Thank you</h1>
<p>Your report reached the ${escape(project.name)} team. Somebody will look at it.</p>
<p class="meta">You will not hear back through this page — leave an email address next time if you
would like a reply.</p>`;
  }

  return `<h1>${escape(share.name || `Report something to ${project.name}`)}</h1>
<p class="meta">This goes to the ${escape(project.name)} team. Nothing here is public.</p>
${notice === 'problem' ? '<p class="warn">That did not go through. A title is the one thing needed — and there is a limit on how often this form can be used.</p>' : ''}
<form method="post" class="intake">
  <label for="title">What happened?<span class="req"> — required</span></label>
  <input id="title" name="title" maxlength="200" required autofocus placeholder="One line" />

  <label for="body">Anything else</label>
  <textarea id="body" name="body" rows="7" maxlength="8000" placeholder="What you did, what you expected, what happened instead."></textarea>

  <div class="two">
    <div>
      <label for="reporter">Your name</label>
      <input id="reporter" name="reporter" maxlength="120" autocomplete="name" />
    </div>
    <div>
      <label for="email">Your email</label>
      <input id="email" name="email" type="email" maxlength="200" autocomplete="email" />
    </div>
  </div>

  <!-- Left empty by people and filled in by the sort of program that fills in
       every field it finds. Hidden from assistive technology too, so nobody is
       asked to leave a box blank they were never meant to see. -->
  <div class="trap" aria-hidden="true"><label for="company">Company</label><input id="company" name="company" tabindex="-1" autocomplete="off" /></div>

  <button type="submit">Send it</button>
</form>`;
}

/**
 * A stranger's note on a shared page.
 *
 * It becomes an ordinary comment — the team should read it where they read
 * everything else — with `guest_name` instead of an author, which is what makes
 * every screen able to say the name is unverified. The people told are the ones
 * a page comment always tells: whoever wrote it and whoever has spoken on it.
 */
function leaveNote(share: Row, body: string, who: string): void {
  const page = get<Row>(`SELECT id, workspace_id, title, created_by FROM pages WHERE id = ? AND deleted_at IS NULL`, share.page_id);
  if (!page) return;

  const now = Date.now();
  run(
    `INSERT INTO comments (id, workspace_id, page_id, body, author_id, guest_name, created_at, updated_at, seq, clocks)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, '{}')`,
    uid(), page.workspace_id, page.id, body, who || null, now, now, nextSeq(),
  );

  const audience = new Set<string>();
  if (page.created_by) audience.add(String(page.created_by));
  for (const row of all<Row>(
    `SELECT DISTINCT author_id FROM comments WHERE page_id = ? AND author_id IS NOT NULL AND deleted_at IS NULL`,
    page.id,
  )) audience.add(String(row.author_id));

  for (const userId of audience) {
    const t = translatorFor(userId);
    createNotification({
      workspaceId: String(page.workspace_id),
      userId,
      kind: 'comment',
      title: t('notify.sharedNote', { title: String(page.title ?? '') }),
      body: body.slice(0, 200),
      pageId: String(page.id),
    });
  }
}

/** `a=b&c=d` from a form post. */
function formFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) out[key] = value;
  return out;
}

const safeList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
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
    const sent = ctx.query.get('sent') === '1' ? 'sent' as const : undefined;
    const body = share.kind === 'tasks' ? tasksBody(share)
      : share.kind === 'intake' ? intakeBody(share, sent)
        : pageBody(share, sent);
    if (!body) return html(ctx, gone('The thing this link pointed at is gone.'), 404);

    // Counted rather than logged: how often a link is opened is useful, by whom
    // is not this instance's business and not something a share should collect.
    run(`UPDATE shares SET views = views + 1, last_seen_at = ? WHERE id = ?`, Date.now(), share.id);

    return html(ctx, document_(String(share.name || workspace?.name || 'Kolibri'), body, String(workspace?.name ?? 'Kolibri'), share.kind === 'intake'));
  });

  /**
   * A report, from somebody with no account.
   *
   * The only unauthenticated write in the app, so it is narrow on purpose: a
   * tight bucket per address, a honeypot field, hard length caps, and — the
   * part that actually matters — what it writes is an `intake` row rather than
   * a task. Spam never reaches the board, because nothing reaches the board
   * until a member says so.
   */
  router.post('/s/:token', async (ctx: Ctx) => {
    // Caught rather than thrown on: whoever hit the limit is a person looking
    // at a form they just filled in, and a JSON error object is not an answer
    // to that. `enforce` still sets `retry-after` on the way past.
    let allowed = true;
    try {
      enforce(ctx, byAddress(ctx, LIMITS.intake, 'intake'));
    } catch {
      allowed = false;
    }

    const share = get<Row>(`SELECT * FROM shares WHERE token = ? AND deleted_at IS NULL`, ctx.params.token);
    const takesWriting = share && (share.kind === 'intake' || (share.kind === 'page' && share.allow_comments));
    if (!share || !takesWriting) return html(ctx, gone('That link does not take anything.'), 404);
    if (share.expires_at && Number(share.expires_at) < Date.now()) {
      return html(ctx, gone('That link has expired.'), 410);
    }
    const workspace = get<Row>(`SELECT name FROM workspaces WHERE id = ?`, share.workspace_id);
    const render = (notice: 'sent' | 'problem') =>
      (share.kind === 'intake' ? intakeBody(share, notice) : pageBody(share, notice));
    const back = (notice: 'sent' | 'problem', status = 200) => html(
      ctx,
      document_(String(share.name || 'Kolibri'), render(notice), String(workspace?.name ?? 'Kolibri'), true),
      status,
    );

    // 16 KiB: a bug report is prose, and anything larger is not one.
    const fields = formFields((await readBody(ctx.req, 16 * 1024)).toString('utf8'));

    // A filled honeypot is answered as though it worked. Telling a robot it was
    // caught only teaches whoever wrote it to stop filling that field in.
    if (fields.company) return back('sent');

    if (share.kind === 'page') {
      const note = String(fields.note ?? '').trim().slice(0, 4000);
      if (!allowed || !note) return back('problem', allowed ? 400 : 429);
      leaveNote(share, note, String(fields.who ?? '').trim().slice(0, 120));
      ctx.res.writeHead(303, { location: `/s/${encodeURIComponent(String(share.token))}?sent=1`, 'cache-control': 'no-store' });
      ctx.res.end();
      return undefined;
    }

    const title = String(fields.title ?? '').trim().slice(0, 200);
    if (!allowed || !title) return back('problem', allowed ? 400 : 429);

    const id = uid();
    const now = Date.now();
    run(
      `INSERT INTO intakes (id, workspace_id, project_id, share_id, reporter, email, title, body,
                            status, created_at, updated_at, seq, clocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, '{}')`,
      id, share.workspace_id, share.project_id, share.id,
      String(fields.reporter ?? '').trim().slice(0, 120) || null,
      String(fields.email ?? '').trim().slice(0, 200) || null,
      title,
      String(fields.body ?? '').trim().slice(0, 8000) || null,
      now, now, nextSeq(),
    );
    tellSomebody(share, title);

    // Redirect rather than render, so a refresh does not send it twice.
    ctx.res.writeHead(303, { location: `/s/${encodeURIComponent(String(share.token))}?sent=1`, 'cache-control': 'no-store' });
    ctx.res.end();
    return undefined;
  });
}

/**
 * Tell the people who would want to know.
 *
 * The project lead, or the workspace's owners and admins if it has none. A
 * queue nobody is told about is a queue nobody reads, and the whole point of
 * intake is that a report from outside does not sit unseen.
 */
function tellSomebody(share: Row, title: string): void {
  const lead = get<Row>(`SELECT lead_id FROM projects WHERE id = ?`, share.project_id)?.lead_id;
  const people = lead
    ? [String(lead)]
    : all<Row>(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
      share.workspace_id,
    ).map((row) => String(row.user_id));

  for (const userId of new Set(people)) {
    const t = translatorFor(userId);
    createNotification({
      workspaceId: String(share.workspace_id),
      userId,
      kind: 'intake',
      title: t('notify.intake'),
      body: title.slice(0, 200),
      projectId: share.project_id ? String(share.project_id) : null,
    });
  }
}
