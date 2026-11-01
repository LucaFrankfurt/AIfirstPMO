/**
 * Boards leaving the page they are on: copied into another page, or written
 * to a file somebody can keep.
 *
 * A canvas and a board page are their boards — the page's own text is empty —
 * so everything that copies or downloads such a page has to carry the boards,
 * or it carries nothing and says it carried the page.
 */
import { escapeHtml, isBoardFormat, withFit, type Artboard, type Page } from '@kolibri/shared';
import { byOrder, create } from '../../kernel/sync/mutations';
import { list } from '../../kernel/sync/store';
import { inlineFiles } from './board-files';
import { download, fileName } from './page-parts';

/**
 * A page's boards, put onto another page: fresh rows where they stood, and
 * none of the comments, pins or history the originals have — a template's
 * discussion is about the template.
 */
export function copyBoards(from: Page, to: { id: string; title: string; format: Page['format'] }): number {
  if (!isBoardFormat(from.format)) return 0;
  const boards = list('artboard', (board) => board.page_id === from.id).sort(byOrder) as Artboard[];
  for (const board of boards) {
    create('artboard', {
      page_id: to.id, kind: board.kind,
      // A board page's board carries its page's title, and the copy has its own.
      title: to.format === 'board' ? to.title : board.title,
      content: board.content, color: board.color,
      x: board.x, y: board.y, w: board.w, h: board.h, sort_order: board.sort_order,
    });
  }
  return boards.length;
}

const STYLE = `
  body { margin: 0; padding: 28px 20px 48px; background: #f4f5f7; color: #14161c;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 1320px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 22px; }
  figure { margin: 0 0 28px; }
  figcaption { font-size: 13px; color: #555b66; margin: 0 0 6px; }
  iframe { display: block; width: 100%; border: 1px solid #dfe1e6; border-radius: 10px; background: #ffffff; }
  .note { margin: 0 0 28px; padding: 12px 14px; border-radius: 8px; background: #fdf3c4; white-space: pre-wrap; max-width: 520px; }
  @media print { body { background: #ffffff; padding: 0; } iframe { break-inside: avoid; } }
`;

/**
 * The file a download writes.
 *
 * A board page is its board's document as it stands — the same file an
 * artifact downloaded from Claude is, and a file that can be imported back.
 * A canvas is one document that frames each of its boards, in reading order,
 * with its notes as text: one file, opened by double-clicking, nothing beside
 * it. Either way the pictures go in as their bytes, because a file somebody
 * keeps cannot ask this server for them later — and each board carries the
 * script that fits it to a phone (`withFit` in `shared`), because a file is
 * opened on phones as well, with no app around it to do the fitting. The
 * script is marked, and *Import HTML…* takes it out again.
 */
export async function boardsFile(page: Page, boards: Artboard[], untitled: string): Promise<string> {
  const live = boards.filter((board) => !board.deleted_at);
  if (page.format === 'board') {
    const board = live.find((one) => one.kind === 'html');
    return board ? withFit(await inlineFiles(board.content ?? '')) : '';
  }
  const ordered = [...live].sort((a, b) => a.y - b.y || a.x - b.x);
  const parts = await Promise.all(ordered.map(async (board) => {
    if (board.kind === 'note') return `<aside class="note">${escapeHtml(board.content ?? '')}</aside>`;
    const source = withFit(await inlineFiles(board.content ?? ''));
    // `srcdoc` and the sandbox: each board keeps its own document and scripts,
    // and none of them can reach the others or the file around them.
    return `<figure><figcaption>${escapeHtml(board.title || untitled)}</figcaption>`
      + `<iframe sandbox="allow-scripts allow-popups" title="${escapeHtml(board.title || untitled)}"`
      + ` style="max-width: ${board.w}px; height: ${board.h}px" srcdoc="${escapeHtml(source)}"></iframe></figure>`;
  }));
  const title = escapeHtml(page.title || untitled);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>${title}</h1>
${parts.join('\n')}
</main></body>
</html>
`;
}

/** Write a canvas or a board page to an HTML file. */
export async function downloadBoards(page: Page, untitled: string): Promise<void> {
  const boards = list('artboard', (board) => board.page_id === page.id) as Artboard[];
  download(await boardsFile(page, boards, untitled), 'text/html', fileName(page, 'html'));
}
