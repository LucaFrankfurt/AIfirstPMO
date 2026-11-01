/**
 * One artboard, drawn in its sandbox.
 *
 * The component's job is the handshake with `public/artboard.html`: the frame
 * says it is ready, it is handed the prepared document, it says when that is
 * drawn. Each render is numbered, and whatever a frame says about any other
 * number is dropped — a click reported against yesterday's element numbers
 * would select the wrong thing, and an edit against them would change it.
 *
 * **Every render is a fresh frame.** The first version wrote each new render
 * into the same frame with `document.write`, and that keeps the frame's
 * JavaScript realm: a board whose script says `const values = …` at the top —
 * which is how Claude writes them — threw "Identifier 'values' has already
 * been declared" on every redraw after the first, and its script never ran
 * again. Found on the seeded canvas, whose tiles stopped adding up after one
 * edit. So a new render loads the frame file afresh in a second iframe behind
 * the first, and the two swap when the new one says it is drawn: a new realm
 * every time, and no empty board in between. The file is cached `immutable`,
 * so the reload costs nothing and works offline.
 *
 * There is deliberately no `onLoad`: the frame's own `ready` and `rendered`
 * are the only signals believed.
 *
 * `sandbox="allow-scripts"` and nothing else, on purpose: no
 * `allow-same-origin` (the board would share the app's storage), no
 * `allow-popups` (links come back to the app instead — see `outboundLink`), no
 * `allow-forms`, no `allow-top-navigation`.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../kernel/i18n/i18n';
import { cn } from '../../kernel/design-system/cn';
import { FRAME_URL, outboundLink, prepare, readMessage, type FrameMessage, type FrameMode } from './frame';
import { hasFiles, inlineFiles } from './board-files';

/** One iframe and what is known about it. */
interface Layer {
  key: number;
  /** The render this frame was given, or null while it has none yet. */
  rev: number | null;
  ready: boolean;
}

export type BoardMessage = Exclude<
  FrameMessage,
  { type: 'kolibri:ready' } | { type: 'kolibri:open' } | { type: 'kolibri:rendered' } | { type: 'kolibri:scroll' } | { type: 'kolibri:size' }
  | { type: 'kolibri:located' } | { type: 'kolibri:at' }
>;

/** A pin by what it is on: the element's path in the board, and where on it, as fractions. */
export interface PinPlace { id: string; el: string; fx: number; fy: number }

/** Which element is under a point of the board, and where on it — or null for none, or no answer. */
export type Locate = (x: number, y: number) => Promise<{ el: string; fx: number; fy: number } | null>;

/** How long a question to the frame waits for its answer before it is taken as none. */
const ANSWER_MS = 600;

export function ArtboardFrame({
  source, mode, title, selected = null, keepScroll = false, onMessage, onRendered, onSize, pins, onPins, locator, className, style,
}: {
  source: string;
  mode: FrameMode;
  title: string;
  /** In `edit`, the element drawn as selected. Changing it does not redraw the board. */
  selected?: number | null;
  /** Keep the board's scroll position across a redraw, which is what an edit is. */
  keepScroll?: boolean;
  onMessage?: (message: BoardMessage) => void;
  /** The board is drawn and on screen — what printing waits for. */
  onRendered?: () => void;
  /**
   * How tall the board's content is, as drawn and whenever it changes. Asking
   * for it is what makes the frame measure: a board on a canvas is a window of
   * a fixed size and never needs to.
   */
  onSize?: (height: number, width?: number) => void;
  /**
   * Pins to find by what they are on. The frame answers where each one is now
   * through `onPins` — on every render, and whenever the board reflows.
   */
  pins?: PinPlace[];
  onPins?: (points: Map<string, { x: number; y: number }>) => void;
  /** Filled with a way to ask which element is under a point, for a pin about to be put there. */
  locator?: React.MutableRefObject<Locate | null>;
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const [layers, setLayers] = useState<Layer[]>([{ key: 0, rev: null, ready: false }]);
  /** Which layer is on screen. Messages are believed only from it. */
  const [front, setFront] = useState(0);
  const elements = useRef(new Map<number, HTMLIFrameElement>());
  const rev = useRef(0);
  const scroll = useRef<{ x: number; y: number } | null>(null);
  // The latest of everything, read by the listener without re-subscribing on
  // every keystroke.
  const latest = useRef({ source, mode, selected, keepScroll, onMessage, onRendered, onSize, pins, onPins, drag: t('canvas.drag'), layers, front });
  latest.current = { source, mode, selected, keepScroll, onMessage, onRendered, onSize, pins, onPins, drag: t('canvas.drag'), layers, front };
  /** Questions asked of the frame, by the id the answer will carry. */
  const asked = useRef(new Map<string, (answer: { el: string; fx: number; fy: number } | null) => void>());

  /** Tell a layer which pins to find. Only ever the one on screen is asked. */
  const sendPins = (key: number): void => {
    const now = latest.current.pins;
    if (!now?.length) return;
    elements.current.get(key)?.contentWindow?.postMessage({ type: 'kolibri:where', pins: now }, '*');
  };

  /** Hand a layer the document for render `number`, once its pictures are in. */
  const render = (key: number, number: number): void => {
    const now = latest.current;
    const post = (html: string): void => {
      // A newer render was asked for while this one waited for its pictures.
      if (number !== rev.current) return;
      elements.current.get(key)?.contentWindow?.postMessage({ type: 'kolibri:render', html }, '*');
    };
    const write = (source: string): void => post(prepare(source, {
      mode: now.mode, rev: number, selected: now.selected,
      scroll: now.keepScroll ? scroll.current : null, labels: { drag: now.drag }, fit: !!now.onSize,
    }));
    // Pictures from this server go in as their bytes — see `board-files.ts`.
    if (hasFiles(now.source)) void inlineFiles(now.source).then(write);
    else write(now.source);
  };

  // A new source or mode is a new render, in a new frame unless the only frame
  // there is has not been given one yet.
  useEffect(() => {
    rev.current += 1;
    const number = rev.current;
    const { layers: current, front: shown } = latest.current;
    const blank = current.length === 1 && current[0].rev === null;
    if (blank) {
      setLayers([{ ...current[0], rev: number }]);
      if (current[0].ready) render(current[0].key, number);
      return;
    }
    const key = Math.max(...current.map((layer) => layer.key)) + 1;
    // Only the front and the newest render are ever kept: anything in between
    // is a render nobody will see.
    setLayers([...current.filter((layer) => layer.key === shown), { key, rev: number, ready: false }]);
  }, [source, mode]);

  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      const { layers: current, front: shown } = latest.current;
      const layer = current.find((one) => elements.current.get(one.key)?.contentWindow === event.source);
      if (!layer) return;
      const message = readMessage(event.data);
      if (!message) return;
      if (message.type === 'kolibri:ready') {
        setLayers((all) => all.map((one) => (one.key === layer.key ? { ...one, ready: true } : one)));
        if (layer.rev !== null) render(layer.key, layer.rev);
        return;
      }
      if (message.type === 'kolibri:rendered') {
        if (message.rev !== layer.rev || layer.rev !== rev.current) return;
        setFront(layer.key);
        setLayers((all) => all.filter((one) => one.key === layer.key));
        if (message.height) latest.current.onSize?.(message.height, message.width);
        sendPins(layer.key);
        latest.current.onRendered?.();
        return;
      }
      // Everything else is about what is on screen, and only believed from it.
      if (layer.key !== shown || ('rev' in message && message.rev !== layer.rev)) return;
      if (message.type === 'kolibri:scroll') {
        scroll.current = { x: message.x, y: message.y };
        return;
      }
      if (message.type === 'kolibri:size') {
        latest.current.onSize?.(message.height, message.width);
        return;
      }
      if (message.type === 'kolibri:at') {
        latest.current.onPins?.(new Map(message.points.map((point) => [point.id, { x: point.x, y: point.y }])));
        return;
      }
      if (message.type === 'kolibri:located') {
        const answer = asked.current.get(message.id);
        asked.current.delete(message.id);
        answer?.(message.el ? { el: message.el, fx: message.fx, fy: message.fy } : null);
        return;
      }
      if (message.type === 'kolibri:open') {
        const href = outboundLink(message.href);
        if (href && latest.current.mode !== 'edit') window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      latest.current.onMessage?.(message);
    };
    addEventListener('message', listen);
    return () => removeEventListener('message', listen);
    // `render` and the rest read refs only.
  }, []);

  useEffect(() => {
    if (mode !== 'edit') return;
    elements.current.get(front)?.contentWindow?.postMessage({ type: 'kolibri:select', k: selected }, '*');
  }, [selected, mode, front]);

  // A new list of pins goes to the frame on screen; a new frame is sent it when it is drawn.
  const pinKey = pins?.length ? JSON.stringify(pins) : '';
  useEffect(() => { if (pinKey) sendPins(front); }, [pinKey, front]);

  useEffect(() => {
    if (!locator) return;
    let count = 0;
    locator.current = (x, y) => new Promise((resolve) => {
      const id = `q${++count}`;
      asked.current.set(id, resolve);
      elements.current.get(latest.current.front)?.contentWindow?.postMessage({ type: 'kolibri:locate', id, x, y }, '*');
      // A frame that never answers — still loading, or a board whose script
      // took the message channel — leaves the pin to its point alone.
      setTimeout(() => { if (asked.current.delete(id)) resolve(null); }, ANSWER_MS);
    });
    return () => { locator.current = null; };
  }, [locator]);

  return (
    <div className={cn('artboard-host', className)} style={style}>
      {layers.map((layer) => (
        <iframe
          key={layer.key}
          ref={(element) => {
            if (element) elements.current.set(layer.key, element);
            else elements.current.delete(layer.key);
          }}
          src={FRAME_URL}
          sandbox="allow-scripts"
          title={title}
          referrerPolicy="no-referrer"
          loading={mode === 'view' ? 'lazy' : undefined}
          className="artboard-layer"
          // The one being drawn sits underneath until it says it is done.
          style={{ visibility: layer.key === front ? 'visible' : 'hidden', zIndex: layer.key === front ? 1 : 0 }}
          aria-hidden={layer.key === front ? undefined : true}
          tabIndex={layer.key === front ? undefined : -1}
        />
      ))}
    </div>
  );
}
