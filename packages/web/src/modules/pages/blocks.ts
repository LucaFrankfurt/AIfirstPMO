/**
 * What a canvas offers to start from: whole boards, and blocks to put into one.
 *
 * Plain HTML with inline styles, and that is the point rather than a shortcut.
 * Whatever is inserted becomes part of the board's source, which a person can
 * read and Claude can rewrite, and inline style is what the inspector edits —
 * a block styled by a class would be a block whose look the inspector could
 * not touch. Each block is one element, so it can be selected, moved and
 * deleted as one thing the moment it lands.
 *
 * The words come from the caller, in the reader's language: a German team's
 * new board should not start out speaking English.
 */

export type BlockKind = 'heading' | 'text' | 'box' | 'columns' | 'table' | 'list' | 'button' | 'divider' | 'callout';

export const BLOCK_KINDS: BlockKind[] = ['heading', 'text', 'box', 'columns', 'table', 'list', 'button', 'divider', 'callout'];

/** The placeholder words a block or a board is written with. */
export interface Words {
  title: string;
  heading: string;
  text: string;
  item: string;
  button: string;
  column: string;
  metric: string;
}

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One block, as a single element. */
export function block(kind: BlockKind, words: Words): string {
  switch (kind) {
    case 'heading':
      return `<h2 style="margin: 0; font-size: 24px; line-height: 1.25">${esc(words.heading)}</h2>`;
    case 'text':
      return `<p style="margin: 0; color: #4a4f5a">${esc(words.text)}</p>`;
    case 'box':
      return `<div style="padding: 20px; border: 1px solid #e5e6eb; border-radius: 12px; background: #f7f7f9"><p style="margin: 0">${esc(words.text)}</p></div>`;
    case 'columns':
      return `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px">`
        + `<div style="padding: 16px; border: 1px solid #e5e6eb; border-radius: 10px"><h3 style="margin: 0 0 6px; font-size: 16px">${esc(words.column)} 1</h3><p style="margin: 0; color: #4a4f5a">${esc(words.text)}</p></div>`
        + `<div style="padding: 16px; border: 1px solid #e5e6eb; border-radius: 10px"><h3 style="margin: 0 0 6px; font-size: 16px">${esc(words.column)} 2</h3><p style="margin: 0; color: #4a4f5a">${esc(words.text)}</p></div>`
        + `</div>`;
    case 'table': {
      const cell = 'padding: 8px 12px; border-bottom: 1px solid #e5e6eb; text-align: left';
      const head = [1, 2, 3].map((n) => `<th style="${cell}; font-size: 12px; color: #646872">${esc(words.column)} ${n}</th>`).join('');
      const row = (r: number) => `<tr>${[1, 2, 3].map((n) => `<td style="${cell}">${esc(words.item)} ${r}.${n}</td>`).join('')}</tr>`;
      return `<table style="width: 100%; border-collapse: collapse"><tr>${head}</tr>${row(1)}${row(2)}</table>`;
    }
    case 'list':
      return `<ul style="margin: 0; padding-left: 20px">${[1, 2, 3].map((n) => `<li>${esc(words.item)} ${n}</li>`).join('')}</ul>`;
    case 'button':
      return `<a href="#" style="display: inline-block; padding: 10px 18px; border-radius: 8px; background: #5b5bd6; color: #ffffff; text-decoration: none; font-weight: 600; align-self: flex-start">${esc(words.button)}</a>`;
    case 'divider':
      return `<hr style="border: 0; border-top: 1px solid #e5e6eb; margin: 8px 0">`;
    case 'callout':
      return `<div style="padding: 14px 16px; border-radius: 10px; background: #eeeefc; color: #2e2e8f"><strong>${esc(words.heading)}</strong> ${esc(words.text)}</div>`;
  }
}

export type TemplateKind = 'blank' | 'document' | 'dashboard' | 'phone';

export const TEMPLATE_KINDS: TemplateKind[] = ['blank', 'document', 'dashboard', 'phone'];

/** What a board page shows in the tree before anybody picks an icon. */
export const BOARD_ICON = '🖼️';

/** What each template is called in a menu, by translation key. */
export const TEMPLATE_LABEL = {
  blank: 'canvas.template.blank', document: 'canvas.template.document',
  dashboard: 'canvas.template.dashboard', phone: 'canvas.template.phone',
} as const satisfies Record<TemplateKind, string>;

/** A new board: its frame and its first source. */
export interface Template {
  w: number;
  h: number;
  content: string;
}

/** A whole document around a `<main>`, laid out one element per line so edits keep it readable. */
function page(lang: string, main: string[], mainStyle: string): string {
  return [
    '<!doctype html>',
    `<html lang="${esc(lang)}">`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <style>',
    "    body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #14161c; background: #ffffff; line-height: 1.5; }",
    '  </style>',
    '</head>',
    '<body>',
    `  <main style="${mainStyle}">`,
    ...main.map((line) => `    ${line}`),
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function template(kind: TemplateKind, words: Words, lang: string): Template {
  const column = 'max-width: 960px; margin: 0 auto; padding: 48px 40px; display: flex; flex-direction: column; gap: 16px';
  switch (kind) {
    case 'blank':
      return { w: 1280, h: 800, content: page(lang, [
        `<h1 style="margin: 0; font-size: 36px; line-height: 1.2">${esc(words.title)}</h1>`,
      ], column) };
    case 'document':
      return { w: 1280, h: 900, content: page(lang, [
        `<h1 style="margin: 0; font-size: 36px; line-height: 1.2">${esc(words.title)}</h1>`,
        block('text', words),
        block('heading', words),
        block('text', words),
        block('callout', words),
      ], column) };
    case 'dashboard': {
      const metric = (n: number) => `<div style="padding: 20px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">${esc(words.metric)} ${n}</p><p style="margin: 4px 0 0; font-size: 28px; font-weight: 700">0</p></div>`;
      return { w: 1440, h: 900, content: page(lang, [
        `<h1 style="margin: 0; font-size: 28px">${esc(words.title)}</h1>`,
        `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px">${metric(1)}${metric(2)}${metric(3)}</div>`,
        block('table', words),
      ], 'max-width: 1280px; margin: 0 auto; padding: 32px; display: flex; flex-direction: column; gap: 20px') };
    }
    case 'phone':
      return { w: 390, h: 844, content: page(lang, [
        `<h1 style="margin: 0; font-size: 24px">${esc(words.title)}</h1>`,
        block('text', words),
        block('list', words),
        `<a href="#" style="display: block; padding: 14px; border-radius: 12px; background: #5b5bd6; color: #ffffff; text-align: center; text-decoration: none; font-weight: 600">${esc(words.button)}</a>`,
      ], 'padding: 56px 20px 24px; display: flex; flex-direction: column; gap: 16px') };
  }
}

/**
 * A board that is one picture, filling its frame.
 *
 * `object-fit: contain` rather than `cover`: a board resized to a different
 * shape should show all of the picture with a margin, not quietly crop it.
 */
export function imageBoard(url: string, name: string, lang: string): string {
  return [
    '<!doctype html>',
    `<html lang="${esc(lang)}">`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <style>html, body { margin: 0; height: 100%; background: #ffffff; }</style>',
    '</head>',
    '<body>',
    `  <img src="${esc(url)}" alt="${esc(name).replace(/"/g, '&quot;')}" style="display: block; width: 100%; height: 100%; object-fit: contain">`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
