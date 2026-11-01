/**
 * Drawing an artboard: the frame, what is sent into it, and what may come back.
 *
 * A board is somebody's whole HTML document, scripts included, so it is never
 * drawn into the app. It is drawn in `public/artboard.html`, inside an iframe
 * with `sandbox="allow-scripts"` and a policy that reaches no network — see
 * `docs/canvas.md` for what that was measured to refuse. This file is the
 * app's half of the conversation with that frame:
 *
 * - `prepare` turns a board's source into the document the frame becomes:
 *   the source, plus one small script of ours (`runtime`) at the top of its
 *   head, plus — while editing — a number on every element a person may pick.
 * - `readMessage` is the only way anything the frame says is believed. A
 *   board's own scripts can post messages too, and they are somebody's code:
 *   every message is checked for its shape and its numbers, and a message
 *   about an older render than the one on screen is dropped.
 *
 * The runtime is written as a function and sent as its own source text. That
 * keeps it type-checked and readable here, at the price of one rule: it may
 * use nothing from outside its own body, because it does not run here.
 */
import { artboard } from '@kolibri/shared';

/**
 * The frame file's hash, which is the address the browser caches it under.
 *
 * The server sends the frame with a year-long `immutable` cache — offline, the
 * HTTP cache is the only copy there is, because a service worker is never asked
 * for a sandboxed frame. So the address has to change whenever the file does,
 * and `test/frame.test.ts` fails if this is not the file's current hash.
 */
export const FRAME_VERSION = 'd5c5ac1c1712';
export const FRAME_URL = `/artboard.html?v=${FRAME_VERSION}`;

/**
 * How a board is shown.
 *
 * `view` is the canvas: drawn, not touched. `play` is the board working as its
 * author meant, links and buttons and all. `edit` is the editor: clicks select
 * instead of acting, and text can be changed where it stands.
 */
export type FrameMode = 'view' | 'play' | 'edit';

export type Where = 'before' | 'after';

/** Everything the frame may tell the app. */
export type FrameMessage =
  | { type: 'kolibri:ready' }
  | { type: 'kolibri:rendered'; rev: number; height?: number; width?: number }
  | { type: 'kolibri:size'; rev: number; height: number; width?: number }
  | { type: 'kolibri:located'; rev: number; id: string; el: string | null; fx: number; fy: number }
  | { type: 'kolibri:at'; rev: number; points: { id: string; x: number; y: number }[] }
  | { type: 'kolibri:scroll'; rev: number; x: number; y: number }
  | { type: 'kolibri:open'; href: string }
  | { type: 'kolibri:select'; rev: number; k: number | null; x?: number; y?: number }
  | { type: 'kolibri:inner'; rev: number; k: number; html: string }
  | { type: 'kolibri:move'; rev: number; k: number; target: number; where: Where }
  | { type: 'kolibri:key'; rev: number; key: FrameKey };

export type FrameKey = 'delete' | 'escape' | 'undo' | 'redo' | 'duplicate';

const KEYS = new Set<FrameKey>(['delete', 'escape', 'undo', 'redo', 'duplicate']);

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1e7;
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e6;
const isHeight = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e6;
const isFraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 100;
/** An element's place in a board: `tag:index` steps down from the body, as `elementPath` writes them. */
export const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length < 2000 && /^[a-z][a-z0-9-]*:\d+(\/[a-z][a-z0-9-]*:\d+)*$/.test(value);

/** A message from a frame, if it is one of ours and well-formed; otherwise null. */
export function readMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  const rev = message.rev;
  switch (message.type) {
    case 'kolibri:ready':
      return { type: 'kolibri:ready' };
    case 'kolibri:rendered':
      if (!isIndex(rev)) return null;
      // How large the board is, when it was asked: a nicety, dropped when insane.
      return {
        type: 'kolibri:rendered', rev,
        ...(isHeight(message.height) ? { height: message.height } : {}),
        ...(isHeight(message.width) ? { width: message.width } : {}),
      };
    case 'kolibri:size':
      return isIndex(rev) && isHeight(message.height)
        ? { type: 'kolibri:size', rev, height: message.height, ...(isHeight(message.width) ? { width: message.width } : {}) }
        : null;
    case 'kolibri:located':
      return isIndex(rev) && isId(message.id) && isFraction(message.fx) && isFraction(message.fy)
        && (message.el === null || isPath(message.el))
        ? { type: 'kolibri:located', rev, id: message.id, el: message.el, fx: message.fx, fy: message.fy } : null;
    case 'kolibri:at': {
      if (!isIndex(rev) || !Array.isArray(message.points) || message.points.length > 1000) return null;
      const points = (message.points as unknown[]).filter((point): point is { id: string; x: number; y: number } => {
        const one = point as Record<string, unknown> | null;
        return !!one && isId(one.id) && isCoordinate(one.x) && isCoordinate(one.y);
      }).map((point) => ({ id: point.id, x: point.x, y: point.y }));
      return { type: 'kolibri:at', rev, points };
    }
    case 'kolibri:scroll':
      return isIndex(rev) && isCoordinate(message.x) && isCoordinate(message.y)
        ? { type: 'kolibri:scroll', rev, x: message.x, y: message.y } : null;
    case 'kolibri:open':
      return typeof message.href === 'string' && message.href.length < 4096 ? { type: 'kolibri:open', href: message.href } : null;
    case 'kolibri:select':
      if (!isIndex(rev)) return null;
      if (message.k === null) return { type: 'kolibri:select', rev, k: null };
      if (!isIndex(message.k)) return null;
      // Where the element starts in the board, for a pin left on it. Dropped
      // rather than refused when it is not a sane number: it is a nicety.
      return {
        type: 'kolibri:select', rev, k: message.k,
        ...(isCoordinate(message.x) && isCoordinate(message.y) ? { x: message.x, y: message.y } : {}),
      };
    case 'kolibri:inner':
      return isIndex(rev) && isIndex(message.k) && typeof message.html === 'string' && message.html.length < 1_000_000
        ? { type: 'kolibri:inner', rev, k: message.k, html: message.html } : null;
    case 'kolibri:move':
      return isIndex(rev) && isIndex(message.k) && isIndex(message.target) && (message.where === 'before' || message.where === 'after')
        ? { type: 'kolibri:move', rev, k: message.k, target: message.target, where: message.where } : null;
    case 'kolibri:key':
      return isIndex(rev) && KEYS.has(message.key as FrameKey) ? { type: 'kolibri:key', rev, key: message.key as FrameKey } : null;
    default:
      return null;
  }
}

/**
 * Only a web or mail link leaves the board, and only into a new tab.
 *
 * Inside the frame a link would navigate the frame itself — away from the
 * board, to a site that may refuse to be framed — so the runtime stops every
 * click on one and asks the app instead.
 */
export function outboundLink(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

/** What the runtime is told about the render it is part of. */
export interface RuntimeConfig {
  mode: FrameMode;
  rev: number;
  selected: number | null;
  /** Where to scroll to once drawn: where the previous render was, across an edit. */
  scroll: { x: number; y: number } | null;
  /** Report the board's height as it is drawn and whenever it changes — for a board shown as a page. */
  fit?: boolean;
  /** Words the editing overlay shows, in the reader's language. */
  labels: { drag: string };
}

/**
 * The script of ours inside every board.
 *
 * Self-contained by necessity: it is sent as text and runs in the frame. Three
 * jobs in every mode — say when the board is drawn, keep its scroll position
 * across the next one, and hand links to the app — and in `edit` the whole
 * editing surface: a hover
 * outline, a selection with a grip to drag by, text edited in place, and the
 * keys an editor answers to. The outline lives in a shadow root hung off
 * `<html>`, outside the body, so nothing it draws can end up in what is saved.
 */
export function runtime(config: RuntimeConfig): void {
  const post = (message: Record<string, unknown>): void => parent.postMessage({ rev: config.rev, ...message }, '*');

  /*
   * Where a pin is, in terms of what it was put on rather than where.
   *
   * A pin is a point in the board's own pixels, which is right as long as the
   * board is drawn at its own width — and wrong the moment it reflows to a
   * phone, where the paragraph it was on is somewhere else entirely. So a pin
   * also names the element under it, as the steps down from the body that
   * reach it (`main:0/div:10`), and where on that element it sat, as fractions
   * of its box. A step whose tag no longer matches finds nothing rather than
   * the wrong thing: an edit that moved the paragraph leaves the pin to its
   * point, not on the heading that took the paragraph's place.
   */
  const elementPath = (element: Element | null): string | null => {
    const steps: string[] = [];
    let node = element;
    while (node && node !== document.body && node.parentElement) {
      steps.unshift(`${node.tagName.toLowerCase()}:${Array.prototype.indexOf.call(node.parentElement.children, node)}`);
      node = node.parentElement;
    }
    return node === document.body && steps.length ? steps.join('/') : null;
  };
  const elementAt = (path: string): Element | null => {
    let node: Element | null = document.body;
    for (const step of path.split('/')) {
      const [tag, index] = step.split(':');
      const next: Element | undefined = node ? node.children[Number(index)] : undefined;
      if (!next || next.tagName.toLowerCase() !== tag) return null;
      node = next;
    }
    return node;
  };
  const fraction = (value: number): number => Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
  let pinned: { id: string; el: string; fx: number; fy: number }[] = [];
  const placePins = (): void => {
    if (!pinned.length) return;
    const points: { id: string; x: number; y: number }[] = [];
    for (const pin of pinned) {
      const element = elementAt(pin.el);
      const box = element ? element.getBoundingClientRect() : null;
      // Hidden at this width — `display: none` on a phone — is nowhere, not the corner.
      if (!box || (!box.width && !box.height)) continue;
      points.push({ id: pin.id, x: Math.round(box.left + pin.fx * box.width + scrollX), y: Math.round(box.top + pin.fy * box.height + scrollY) });
    }
    post({ type: 'kolibri:at', points });
  };

  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data) return;
    const data = event.data as { type?: string; k?: number | null; id?: string; x?: number; y?: number; pins?: unknown };
    if (data.type === 'kolibri:select' && config.mode === 'edit') select(typeof data.k === 'number' ? data.k : null, false);
    if (data.type === 'kolibri:locate' && typeof data.id === 'string' && typeof data.x === 'number' && typeof data.y === 'number') {
      const element = document.elementFromPoint(data.x - scrollX, data.y - scrollY);
      const path = elementPath(element);
      const box = element && path ? element.getBoundingClientRect() : null;
      post({
        type: 'kolibri:located', id: data.id, el: box ? path : null,
        fx: box && box.width ? fraction((data.x - scrollX - box.left) / box.width) : 0,
        fy: box && box.height ? fraction((data.y - scrollY - box.top) / box.height) : 0,
      });
    }
    if (data.type === 'kolibri:where' && Array.isArray(data.pins)) {
      pinned = (data.pins as { id: string; el: string; fx: number; fy: number }[]).slice(0, 1000);
      placePins();
    }
  });

  /*
   * How tall the board is, for a page that shows all of it rather than a
   * window onto it. The document's own scroll height when it overflows the
   * frame; otherwise the body's, margins included — the root's scroll height
   * is never less than the frame, so asking only that could grow a board and
   * never let it shrink again.
   */
  const measure = (): number => {
    const root = document.documentElement;
    if (root.scrollHeight > root.clientHeight + 1 || !document.body) return root.scrollHeight;
    const style = getComputedStyle(document.body);
    return Math.ceil(document.body.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
  };
  /*
   * How wide the board's content is — more than the frame when its layout
   * does not fit: a row of cards that does not wrap, a table with no box to
   * scroll in. A box that scrolls on purpose does not count; that is a board
   * doing what it meant to.
   */
  const measureWidth = (): number => document.documentElement.scrollWidth;

  // Drawn: back where the last render was scrolled to, then say so — the app
  // shows this frame in place of the previous one only now, so an edit never
  // flashes an empty board. The height rides on the same message: a separate
  // one could arrive before this frame is the one on screen, and be dropped.
  addEventListener('load', () => {
    if (config.scroll) scrollTo(config.scroll.x, config.scroll.y);
    // A timer rather than an animation frame: a frame the browser counts as off
    // screen — every board being laid out for a PDF — may never be given one.
    setTimeout(() => {
      post({ type: 'kolibri:rendered', ...(config.fit ? { height: measure(), width: measureWidth() } : {}) });
      if (!config.fit || typeof ResizeObserver === 'undefined' || !document.body) return;
      // A board's script may draw after load — a chart, a list filled in — and
      // the page around it should grow with it.
      let last = measure();
      let lastWidth = measureWidth();
      let pending = 0;
      new ResizeObserver(() => {
        // A frame with no size is hidden, not empty: what it would measure now
        // is nothing, and nothing is not what the board is.
        if (pending || !document.documentElement.clientWidth) return;
        pending = setTimeout(() => {
          pending = 0;
          if (!document.documentElement.clientWidth) return;
          const now = measure();
          const wide = measureWidth();
          // A reflow moves what pins are on, whether or not the size changed.
          placePins();
          if (Math.abs(now - last) < 2 && Math.abs(wide - lastWidth) < 2) return;
          last = now;
          lastWidth = wide;
          post({ type: 'kolibri:size', height: now, width: wide });
        }, 100) as unknown as number;
      }).observe(document.body);
    }, 0);
  });
  let reported = 0;
  addEventListener('scroll', () => {
    if (reported) return;
    reported = setTimeout(() => { reported = 0; post({ type: 'kolibri:scroll', x: scrollX, y: scrollY }); }, 120) as unknown as number;
  }, { passive: true });

  const elementOf = (node: EventTarget | null): Element | null =>
    node && (node as Node).nodeType === 1 ? node as Element : (node as Node | null)?.parentElement ?? null;

  document.addEventListener('click', (event) => {
    if (config.mode === 'edit') return;
    const link = elementOf(event.target)?.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    post({ type: 'kolibri:open', href: (link as HTMLAnchorElement).href });
  }, true);

  if (config.mode !== 'edit') {
    // Focus inside a board is focus the app cannot see, so an Escape pressed
    // there would never close the dialog the board is shown in. Passed up only
    // when the board did not want it itself — its own menu may close on it.
    addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) post({ type: 'kolibri:key', key: 'escape' });
    });
    return;
  }

  /* ------------------------------------------------------------ editing */

  const host = document.createElement('kolibri-overlay');
  host.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .box{position:fixed;pointer-events:none;box-sizing:border-box;display:none}
    .hover{outline:1px dashed #5b5bd6;outline-offset:-1px}
    .sel{outline:2px solid #5b5bd6;outline-offset:-1px}
    .tag{position:absolute;left:-2px;top:-20px;font:600 11px/18px system-ui,sans-serif;color:#fff;background:#5b5bd6;padding:0 6px;border-radius:4px 4px 0 0;white-space:nowrap}
    .grip{position:absolute;right:-2px;top:-20px;width:20px;height:18px;border:0;border-radius:4px 4px 0 0;background:#5b5bd6;color:#fff;font:14px/18px system-ui;cursor:grab;pointer-events:auto;padding:0;touch-action:none}
    @media (pointer:coarse){.grip{width:36px;height:30px;top:-32px;font-size:18px;line-height:30px}.tag{top:-32px;line-height:30px}}
    .drop{position:fixed;display:none;background:#5b5bd6;pointer-events:none;border-radius:2px}
  </style><div class="box hover"></div><div class="box sel"><span class="tag"></span><button class="grip" type="button">⠿</button></div><div class="drop"></div>`;
  document.documentElement.appendChild(host);
  const hoverBox = shadow.querySelector('.hover') as HTMLElement;
  const selBox = shadow.querySelector('.sel') as HTMLElement;
  const tag = shadow.querySelector('.tag') as HTMLElement;
  const grip = shadow.querySelector('.grip') as HTMLButtonElement;
  const drop = shadow.querySelector('.drop') as HTMLElement;
  grip.title = config.labels.drag;
  grip.setAttribute('aria-label', config.labels.drag);

  const keyOf = (element: Element | null): number | null => {
    const value = element?.getAttribute('data-k');
    return value === null || value === undefined ? null : Number(value);
  };
  const pick = (node: EventTarget | null): Element | null => elementOf(node)?.closest('[data-k]') ?? null;
  const byKey = (k: number | null): Element | null => (k === null ? null : document.querySelector(`[data-k="${k}"]`));

  const place = (box: HTMLElement, element: Element | null): void => {
    if (!element) {
      box.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  };

  let selected: number | null = null;
  let editing: { element: HTMLElement; before: string } | null = null;

  const redraw = (): void => {
    const element = byKey(selected);
    place(selBox, element);
    if (element) tag.textContent = element.tagName.toLowerCase();
  };

  function select(k: number | null, tell: boolean): void {
    selected = k !== null && byKey(k) ? k : null;
    redraw();
    if (!tell) return;
    const element = byKey(selected);
    const rect = element?.getBoundingClientRect();
    post({ type: 'kolibri:select', k: selected, ...(rect ? { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY) } : {}) });
  }

  const ready = (): void => select(config.selected, false);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready);
  else ready();
  addEventListener('load', redraw);
  addEventListener('resize', redraw);
  addEventListener('scroll', redraw, true);

  document.addEventListener('mousemove', (event) => {
    if (editing) return place(hoverBox, null);
    const element = pick(event.target);
    place(hoverBox, keyOf(element) === selected ? null : element);
  });
  document.addEventListener('mouseleave', () => place(hoverBox, null));

  /** Blocks a paragraph-level edit must not swallow: text can be edited in place only where there are none. */
  const BLOCKS = 'div,p,section,article,header,footer,main,nav,aside,table,ul,ol,li,h1,h2,h3,h4,h5,h6,form,figure,svg,canvas,video,iframe,img,button,input,select,textarea,blockquote,pre,hr';

  function finish(commit: boolean): void {
    if (!editing) return;
    const { element, before } = editing;
    editing = null;
    element.removeAttribute('contenteditable');
    const k = keyOf(element);
    if (!commit) element.innerHTML = before;
    else if (k !== null && element.innerHTML !== before) post({ type: 'kolibri:inner', k, html: element.innerHTML });
    redraw();
  }

  // Capturing, so a board's own handlers never see a click meant to select.
  document.addEventListener('click', (event) => {
    if (editing && editing.element.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    if (editing) finish(true);
    select(keyOf(pick(event.target)), true);
  }, true);

  document.addEventListener('dblclick', (event) => {
    const element = pick(event.target) as HTMLElement | null;
    if (!element || editing || element.querySelector(BLOCKS) || element.matches('img,svg,input,select,textarea,hr,br,canvas,video,iframe')) return;
    event.preventDefault();
    select(keyOf(element), true);
    editing = { element, before: element.innerHTML };
    element.setAttribute('contenteditable', 'true');
    element.focus();
    place(hoverBox, null);
  }, true);

  document.addEventListener('focusout', (event) => {
    if (editing && event.target === editing.element) finish(true);
  });

  document.addEventListener('keydown', (event) => {
    if (editing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      }
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    let says: string | null = null;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) says = 'delete';
    else if (event.key === 'Escape') says = 'escape';
    else if (mod && key === 'z') says = event.shiftKey ? 'redo' : 'undo';
    else if (mod && key === 'y') says = 'redo';
    else if (mod && key === 'd' && selected !== null) says = 'duplicate';
    if (!says) return;
    event.preventDefault();
    if (says === 'escape') select(null, true);
    post({ type: 'kolibri:key', key: says });
  }, true);

  /* ---------------------------------------------------------- dragging */

  let dragging: { k: number; element: Element; target: number | null; where: string } | null = null;

  /** Whether siblings in this element's parent run across rather than down. */
  const across = (element: Element): boolean => {
    const parentElement = element.parentElement;
    if (!parentElement) return false;
    const style = getComputedStyle(parentElement);
    if (style.display.includes('flex')) return !style.flexDirection.startsWith('column');
    if (style.display.includes('grid')) {
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean);
      return columns.length > 1;
    }
    return false;
  };

  grip.addEventListener('pointerdown', (event) => {
    const element = byKey(selected);
    if (selected === null || !element) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    dragging = { k: selected, element, target: null, where: 'after' };
    grip.style.cursor = 'grabbing';
  });

  grip.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const under = document.elementsFromPoint(event.clientX, event.clientY)
      .find((element) => element !== host && !dragging!.element.contains(element) && element.closest('[data-k]'));
    const target = under ? under.closest('[data-k]') : null;
    if (!target || dragging.element.contains(target)) {
      dragging.target = null;
      drop.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    const sideways = across(target);
    const after = sideways ? event.clientX > rect.left + rect.width / 2 : event.clientY > rect.top + rect.height / 2;
    dragging.target = keyOf(target);
    dragging.where = after ? 'after' : 'before';
    drop.style.display = 'block';
    if (sideways) {
      drop.style.left = `${(after ? rect.right : rect.left) - 2}px`;
      drop.style.top = `${rect.top}px`;
      drop.style.width = '4px';
      drop.style.height = `${rect.height}px`;
    } else {
      drop.style.left = `${rect.left}px`;
      drop.style.top = `${(after ? rect.bottom : rect.top) - 2}px`;
      drop.style.width = `${rect.width}px`;
      drop.style.height = '4px';
    }
  });

  const endDrag = (commit: boolean): void => {
    if (!dragging) return;
    const { k, target, where } = dragging;
    dragging = null;
    drop.style.display = 'none';
    grip.style.cursor = 'grab';
    if (commit && target !== null && target !== k) post({ type: 'kolibri:move', k, target, where });
  };
  grip.addEventListener('pointerup', () => endDrag(true));
  grip.addEventListener('pointercancel', () => endDrag(false));
}

/**
 * The document the frame becomes.
 *
 * The runtime goes first in the head, so it is listening before any of the
 * board's own scripts run — and after the doctype, never before it, because a
 * script ahead of `<!doctype html>` puts the whole board into quirks mode.
 */
export function prepare(source: string, config: RuntimeConfig): string {
  const body = config.mode === 'edit' ? artboard.annotate(source) : source;
  // `<\/script>` cannot appear in a function's source unless it is in a
  // string, and then it is escaped; the replace is for the one that is not.
  const script = `<script>(${runtime.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')});</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(body);
  if (head) return `${body.slice(0, head.index + head[0].length)}${script}${body.slice(head.index + head[0].length)}`;
  const html = /<html(\s[^>]*)?>/i.exec(body);
  if (html) return `${body.slice(0, html.index + html[0].length)}<head>${script}</head>${body.slice(html.index + html[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body);
  if (doctype) return `${doctype[0]}${script}${body.slice(doctype[0].length)}`;
  return `<!doctype html><meta charset="utf-8">${script}${body}`;
}

/**
 * Ask for the frame once, early, so the browser has it for the day there is
 * no network.
 *
 * Measured: a frame the app fetched like this, but never showed, draws offline
 * afterwards — the cache entry is the one the iframe uses.
 */
export function warmFrame(): void {
  if (typeof fetch === 'undefined') return;
  fetch(FRAME_URL).catch(() => undefined);
}
