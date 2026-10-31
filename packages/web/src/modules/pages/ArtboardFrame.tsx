/**
 * One artboard, drawn in its sandbox.
 *
 * The component's whole job is the handshake with `public/artboard.html`:
 * wait for the frame to say it is ready, hand it the prepared document, and
 * hand it a new one whenever the source or the mode changes. Each render is
 * numbered, and whatever the frame says about an older number is dropped — a
 * click reported against yesterday's element numbers would select the wrong
 * thing, and an edit against them would change it.
 *
 * There is deliberately no `onLoad`: writing a render into the frame fires
 * one, and treating it as "the frame started over" stopped every render after
 * the first. A frame that really does start over says `ready` again, which is
 * the only signal believed.
 *
 * `sandbox="allow-scripts"` and nothing else, on purpose: no
 * `allow-same-origin` (the board would share the app's storage), no
 * `allow-popups` (links come back to the app instead — see `outboundLink`), no
 * `allow-forms`, no `allow-top-navigation`.
 */
import { useEffect, useRef } from 'react';
import { useT } from '../../kernel/i18n/i18n';
import { FRAME_URL, outboundLink, prepare, readMessage, type FrameMessage, type FrameMode } from './frame';

export function ArtboardFrame({ source, mode, title, selected = null, keepScroll = false, onMessage, className, style }: {
  source: string;
  mode: FrameMode;
  title: string;
  /** In `edit`, the element drawn as selected. Changing it does not redraw the board. */
  selected?: number | null;
  /** Keep the board's scroll position across a redraw, which is what an edit is. */
  keepScroll?: boolean;
  onMessage?: (message: Exclude<FrameMessage, { type: 'kolibri:ready' } | { type: 'kolibri:open' }>) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const rev = useRef(0);
  // The latest of everything, read by the listener and `send` without
  // re-subscribing on every keystroke.
  const latest = useRef({ source, mode, selected, keepScroll, onMessage, drag: t('canvas.drag') });
  latest.current = { source, mode, selected, keepScroll, onMessage, drag: t('canvas.drag') };

  const send = (): void => {
    const target = frame.current?.contentWindow;
    if (!target || !ready.current) return;
    rev.current += 1;
    const now = latest.current;
    const html = prepare(now.source, {
      mode: now.mode, rev: rev.current, selected: now.selected, keepScroll: now.keepScroll, labels: { drag: now.drag },
    });
    target.postMessage({ type: 'kolibri:render', html }, '*');
  };

  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = readMessage(event.data);
      if (!message) return;
      if (message.type === 'kolibri:ready') {
        ready.current = true;
        send();
        return;
      }
      if (message.type === 'kolibri:open') {
        const href = outboundLink(message.href);
        if (href && latest.current.mode !== 'edit') window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      if (message.rev !== rev.current) return;
      latest.current.onMessage?.(message);
    };
    addEventListener('message', listen);
    return () => removeEventListener('message', listen);
    // `send` reads refs only.
  }, []);

  useEffect(() => {
    send();
  }, [source, mode]);

  useEffect(() => {
    if (mode !== 'edit' || !ready.current) return;
    frame.current?.contentWindow?.postMessage({ type: 'kolibri:select', k: selected }, '*');
  }, [selected, mode]);

  return (
    <iframe
      ref={frame}
      src={FRAME_URL}
      sandbox="allow-scripts"
      title={title}
      referrerPolicy="no-referrer"
      loading={mode === 'view' ? 'lazy' : undefined}
      className={className}
      style={style}
    />
  );
}
