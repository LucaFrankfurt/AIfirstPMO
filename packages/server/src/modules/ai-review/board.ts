/**
 * Drawing a board on a canvas from a sentence, or redrawing one.
 *
 * The same model the task review asks, through the same port, for a much
 * larger answer: a whole HTML document. Two things decide whether that answer
 * is usable, and both are said to the model rather than hoped for.
 *
 * **It has to work in the frame.** A board is drawn in a sandbox that reaches
 * no network (see `docs/canvas.md`), so a page that loads Tailwind or Chart.js
 * from a CDN — the first thing a model reaches for — draws an empty box. The
 * rules below forbid it and name what to use instead.
 *
 * **It has to be editable afterwards.** The editor restyles an element through
 * its `style` attribute, so a page whose whole look is in one stylesheet of
 * class rules is a page nobody can recolour without writing CSS. The model is
 * asked to put the look on the elements.
 *
 * Nothing is written here. The draft goes back to the person who asked, and
 * their client puts it on the canvas — through the ordinary write path, as an
 * edit they made, undoable in the editor when it is a redraw.
 */
import { htmlTitle } from '@kolibri/shared';
import { env } from '../../kernel/platform/env.ts';
import { AiError, modelFor } from './model.ts';

/** Enough for a dense dashboard; a ceiling, and one a board rarely nears. */
const MAX_TOKENS = 16_000;

/**
 * How long a board may take. A review's default is twenty seconds and a whole
 * page is minutes of writing — thousands of tokens, after the thinking — so
 * the review's limit would refuse nearly every board. Nothing between the
 * browser and here cuts a long request (the server's `requestTimeout` is off,
 * the documented proxies wait), so this is the only clock that does. The
 * configured timeout still wins if it is longer.
 */
const BOARD_TIMEOUT_MS = 300_000;

/** How much of another board is sent as a reference for its look. */
const REFERENCE_CHARS = 6000;

export const BOARD_SYSTEM = `You are a product designer who writes front-end code. You make one board on a
canvas in a team's project workspace: a single, complete HTML document, drawn in a frame of a fixed size.

Rules that decide whether the board works at all:
- Answer with the HTML document and nothing else: start with <!doctype html>, end with </html>.
  No commentary before or after it, no code fences.
- It is drawn in a sandbox that reaches no network. Nothing may be fetched: no CDN scripts or
  stylesheets, no web fonts, no remote images, no fetch or XMLHttpRequest. Use system font stacks,
  inline SVG for icons, charts and illustrations, and CSS for shapes and colour.
- Inline <style> and <script> work and run. Put interactivity (tabs, filters, toggles, sorting,
  small calculators) in plain JavaScript in one <script> at the end of the body.
- Give the document a <title> that names the board in a few words.

Rules that decide whether people can keep working on it:
- Put the look of each visible element in its own style attribute: colours, sizes, spacing,
  borders, radius. People restyle elements in a visual editor that edits style attributes. A
  short <style> block for resets and the body font is fine; class-based styling of everything is not.
- Build from real elements — headings, paragraphs, lists, tables, buttons, labelled inputs — not
  divs pretending to be them. Every text must clear 4.5:1 contrast against its background.
- Lay it out for the frame's width. Content taller than the frame scrolls, which is fine.

Content:
- Specific, realistic content that fits the request — names, numbers, labels a real team would use.
  Never lorem ipsum. Do not present invented facts about real companies as true.
- When you are given an existing board to change, change what is asked and keep everything else
  exactly as it was, including its look.
- When you are given other boards from the same canvas, match their look: palette, type, spacing.`;

/** Another board on the canvas, sent for its look. */
export interface Reference {
  title: string;
  html: string;
}

export interface BoardRequest {
  instruction: string;
  /** The canvas page's title, which is usually what the boards are about. */
  canvas: string;
  w: number;
  h: number;
  /** The board's current HTML, when this is a redraw. */
  current?: string | null;
  references?: Reference[];
}

export interface BoardDraft {
  title: string;
  html: string;
  /** Which model drew it, so the person can tell. */
  model: string;
}

/** The user message: everything that differs between two requests. */
export function describeRequest(request: BoardRequest): string {
  const parts = [
    `Canvas: ${request.canvas || 'Untitled'}`,
    `Frame: ${request.w} × ${request.h} CSS pixels`,
  ];
  for (const reference of request.references ?? []) {
    parts.push(`Another board on this canvas, "${reference.title || 'Untitled'}", for its look:\n${reference.html.slice(0, REFERENCE_CHARS)}`);
  }
  if (request.current) parts.push(`The board to change, as it is now:\n${request.current}`);
  parts.push(`${request.current ? 'What to change' : 'What to draw'}:\n${request.instruction}`);
  return parts.join('\n\n');
}

/**
 * The HTML document in a model's reply, or null when there is none.
 *
 * A model asked for a document alone will still, sometimes, wrap it in a code
 * fence or say a sentence first. The document is cut out of whatever surrounds
 * it — from the doctype or `<html>` to the last `</html>` — rather than the
 * reply being refused for its manners. A reply with no `<html>` at all but a
 * body's worth of markup is wrapped in one; a reply with no markup is not a
 * board.
 */
export function htmlFromReply(reply: string): string | null {
  const text = reply.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  const lower = text.toLowerCase();
  const start = [lower.indexOf('<!doctype'), lower.indexOf('<html')].filter((at) => at >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined) {
    const end = lower.lastIndexOf('</html>');
    const html = end > start ? text.slice(start, end + '</html>'.length) : text.slice(start);
    return html.trim();
  }
  if (/<(body|main|div|section|h1|table)\b/i.test(text)) {
    return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${text.trim()}\n</body>\n</html>`;
  }
  return null;
}

/** Ask the configured model for a board. Throws `AiError`. */
export async function draftBoard(request: BoardRequest): Promise<BoardDraft> {
  const model = modelFor(env.aiProvider);
  if (!model) throw new AiError('No model is configured on this server', true);
  const reply = await model.ask({
    system: BOARD_SYSTEM,
    user: describeRequest(request),
    maxTokens: MAX_TOKENS,
    timeoutMs: Math.max(env.ai.timeoutMs, BOARD_TIMEOUT_MS),
    // A page is design work, which is worth more thought than a review's JSON.
    effort: 'medium',
  });
  const html = htmlFromReply(reply);
  if (!html) throw new AiError('The model answered without a page', false);
  const title = htmlTitle(html)?.trim() || request.instruction.trim().split('\n')[0].slice(0, 60);
  return { title, html, model: model.model };
}
