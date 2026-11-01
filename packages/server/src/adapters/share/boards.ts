/**
 * Boards, for a stranger holding a share link.
 *
 * A shared page is one small server-rendered document with no script in it,
 * and a board is somebody's whole page with scripts in it — the two cannot be
 * the same document. So the share document frames each board, and each board
 * is served on its own, at `/s/:token/boards/:id`, under the policy the app's
 * board frame has: `sandbox`, so its origin is opaque and it reaches neither
 * the app's cookies nor its storage, and no network at all. The token is the
 * whole of the authorisation, as for the page around it: a board is served
 * only if it is on the shared page, or on one of the pages the share brings.
 *
 * Two things the app's frame does with the app's help are done here instead:
 *
 * - **Pictures.** In the app they are fetched with the reader's session and
 *   handed in as bytes. A stranger has no session, so the server inlines them —
 *   and only pictures hung on the very page the board is on, which is what the
 *   share publishes. A board naming a file from anywhere else draws a broken
 *   picture rather than becoming a way to publish it.
 * - **Links.** In the app the frame asks the app to open them. Here the board
 *   opens them itself, in a new tab, which is what the share's frame policy
 *   allows and nothing more.
 */
import { escapeHtml, fitBoard } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import * as storage from '../../kernel/files/storage.ts';

const escape = (text: unknown): string => escapeHtml(String(text ?? ''));

/** A stored file's address, where it starts a value — the rule `board-files.ts` follows in the app. */
const FILE_PATH = /(?<=^|["'(=\s])\/files\/[0-9a-f]{64}\/[^"'()\s<>]+/gi;

/** Past this a picture stays a broken link rather than a megabyte of base64 in every view. */
const LARGEST = 8 * 1024 * 1024;

/** What a board's frame may do in a share: run, and open a link in a new tab. */
export const SHARE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/**
 * The boards of a canvas or a board page, as the share document shows them.
 *
 * In reading order, as the PDF prints them. A board page's one board is a
 * window the height of the screen, the way an artifact is shown; a canvas's
 * boards are each at their own height, scrolling inside past it, with their
 * names, and its notes are text.
 */
export function sharedBoards(token: string, page: Row): string {
  const rows = all<Row>(
    `SELECT id, title, kind, content, w, h, color FROM artboards WHERE page_id = ? AND deleted_at IS NULL ORDER BY y, x`,
    String(page.id),
  );
  const single = page.format === 'board';
  const parts = rows.map((board) => {
    if (board.kind === 'note') return `<aside class="board-note">${escape(board.content)}</aside>`;
    const frame = `<iframe src="/s/${encodeURIComponent(token)}/boards/${encodeURIComponent(String(board.id))}"`
      + ` sandbox="${SHARE_SANDBOX}" title="${escape(board.title || page.title)}" loading="lazy"`
      + (single ? '' : ` style="height: ${Math.max(120, Number(board.h) || 640)}px"`)
      + '></iframe>';
    return single
      ? `<figure class="board single">${frame}</figure>`
      : `<figure class="board"><figcaption>${escape(board.title)}</figcaption>${frame}</figure>`;
  });
  return parts.join('\n') || '<p class="meta">Nothing has been put here yet.</p>';
}

/** A board on the shared page, or on a page the share brings with it; otherwise undefined. */
export function sharedBoard(share: Row, boardId: string): Row | undefined {
  return get<Row>(
    `SELECT a.* FROM artboards a JOIN pages p ON p.id = a.page_id
      WHERE a.id = ? AND a.deleted_at IS NULL AND a.kind = 'html'
        AND p.deleted_at IS NULL AND p.workspace_id = ?
        AND (p.id = ? OR (p.parent_id = ? AND p.archived = 0))`,
    boardId, share.workspace_id, share.page_id, share.page_id,
  );
}

/** The board's pictures as bytes — those hung on its own page, and no others. */
async function inlinePictures(source: string, pageId: string, workspaceId: string): Promise<string> {
  const paths = [...new Set(source.match(FILE_PATH) ?? [])];
  if (!paths.length) return source;
  const urls = new Map<string, string>();
  for (const path of paths) {
    const hash = path.split('/')[2].toLowerCase();
    const hung = get<Row>(
      `SELECT 1 AS here FROM attachments WHERE checksum = ? AND page_id = ? AND deleted_at IS NULL`,
      hash, pageId,
    );
    if (!hung) continue;
    const file = get<Row>(`SELECT hash, mime, storage FROM files WHERE hash = ? AND workspace_id = ?`, hash, workspaceId);
    if (!file || !String(file.mime).startsWith('image/')) continue;
    // Too large, or gone from the store: a broken picture, not a board that will not open.
    const bytes = await storage.readAll(
      storage.keyFor(String(file.hash), String(file.mime)), LARGEST, (file.storage ?? 'disk') as storage.StorageKind,
    ).catch(() => null);
    if (bytes) urls.set(path, `data:${file.mime};base64,${bytes.toString('base64')}`);
  }
  return source.replace(FILE_PATH, (path) => urls.get(path) ?? path);
}

/**
 * Ours, in the board: a link opens in a new tab instead of navigating the
 * frame, which would leave the board for a site that may refuse to be framed.
 * An in-page `#anchor` is the board's own business.
 */
const LINKS = `<script>(function(){document.addEventListener('click',function(e){var t=e.target;if(t&&t.nodeType!==1)t=t.parentElement;var a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;if((a.getAttribute('href')||'').charAt(0)==='#')return;var u;try{u=new URL(a.href)}catch(x){return}if(!/^(https?|mailto):$/.test(u.protocol))return;e.preventDefault();window.open(u.href,'_blank','noopener,noreferrer')},true)})();</script>`;

/**
 * Ours, in the board, too: a board not written for the width it is framed at
 * — a phone, most of all — is made to fit it, as the app does for a board
 * page (`fitBoard` in `shared`, which says what it changes). Once drawn, once
 * more when a script has had a moment to add to it, and on every resize; a
 * board that fits is left exactly as it is.
 */
const FIT = `<script>(function(fit){var run=function(){try{fit()}catch(e){}};addEventListener('load',function(){run();setTimeout(run,600)});addEventListener('resize',run)})(${fitBoard.toString().replace(/<\/script/gi, '<\\/script')});</script>`;

/** The board's document, ready to be served on its own. */
export async function boardDocument(board: Row): Promise<string> {
  const body = await inlinePictures(String(board.content ?? ''), String(board.page_id), String(board.workspace_id));
  const ours = LINKS + FIT;
  const head = /<head(\s[^>]*)?>/i.exec(body);
  if (head) return `${body.slice(0, head.index + head[0].length)}${ours}${body.slice(head.index + head[0].length)}`;
  const html = /<html(\s[^>]*)?>/i.exec(body);
  if (html) return `${body.slice(0, html.index + html[0].length)}<head>${ours}</head>${body.slice(html.index + html[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body);
  if (doctype) return `${doctype[0]}${ours}${body.slice(doctype[0].length)}`;
  return `<!doctype html><meta charset="utf-8">${ours}${body}`;
}
