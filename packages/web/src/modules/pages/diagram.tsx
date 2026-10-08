/**
 * A diagram, large enough to read.
 *
 * Reported from a page of system boxes: "komplexe mermaid Diagramme kaum
 * lesbar und bieten keine zoom funktion". Measured before anything was
 * touched, that diagram is 2968×1185 in its own units and was drawn into the
 * reading column at 818×327 — a **scale of 0.28**, which takes mermaid's 16px
 * labels down to 4.4 effective pixels. Nor could it be scrolled: `max-width:
 * 100%` shrinks a wide drawing to fit rather than letting it overflow, so
 * there was nothing for the existing `overflow-x` to reveal. Widening the
 * window changed nothing either, because the column is 820px at every width.
 *
 * The page keeps that small drawing — it is the map, and a map at a glance is
 * what a page wants. This is the other half: open it, and it is a picture you
 * can get close to.
 *
 * It clones the SVG already on the page rather than drawing a second time.
 * That is deliberate: a second render is a second thing that can fail, a
 * second theme to keep in step, and a wait where there is no reason for one.
 * An SVG is vector, so the clone zooms to any size without re-rendering.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../kernel/i18n/i18n';
import { Icon } from '../../kernel/design-system/ui';
import { Dialog, DialogContent, DialogTitle } from '../../kernel/design-system/ui/dialog';
import { centre, fit, hold, STEP, wheelFactor, zoomAt, type Size, type View } from './zoom';

/**
 * Give a cloned drawing its own name, everywhere the drawing uses it.
 *
 * Mermaid scopes the stylesheet it embeds to the SVG's own id — in the diagram
 * that prompted this, **73 times** — and points its arrowheads at marker ids
 * built from the same prefix. The first version of this clone simply dropped
 * the id to avoid a duplicate in the document, which detached every one of
 * those rules: the viewer opened on a diagram of black boxes on a black
 * background, with no strokes and no arrowheads, and nothing anywhere said
 * why.
 *
 * So the name is replaced rather than removed, in the attributes, in the
 * `url(#…)` references and in the stylesheet, which leaves the copy standing
 * on its own rather than borrowing the original's definitions.
 */
function rename(copy: SVGElement, from: string, to: string): void {
  for (const node of copy.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.value.includes(from)) attribute.value = attribute.value.split(from).join(to);
    }
  }
  for (const style of copy.querySelectorAll('style')) {
    style.textContent = (style.textContent ?? '').split(from).join(to);
  }
  copy.setAttribute('id', to);
}

/** What mermaid says the drawing is, in its own units. */
function naturalSize(svg: SVGElement): Size {
  const view = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  if (view?.length === 4 && view[2] > 0 && view[3] > 0) return { width: view[2], height: view[3] };
  const box = svg.getBoundingClientRect();
  return { width: Math.max(1, box.width), height: Math.max(1, box.height) };
}

export function DiagramViewer({ svg, onClose }: { svg: SVGElement | null; onClose: () => void }) {
  const t = useT();
  /*
   * The two boxes are held as state behind callback refs, not as `useRef`.
   *
   * Radix portals the dialog's content, and on the pass where `svg` first
   * arrives the effects below ran before that content was in the document:
   * `stage.current` was null, the effect took its early return, and nothing
   * ever changed to run it again. The dialog opened onto an empty frame. A
   * callback ref fires when the node attaches, which is the event these
   * actually wait for.
   */
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [picture, setPicture] = useState<Size>({ width: 1, height: 1 });

  /** The frame's own box, read when it is needed rather than kept in state. */
  const frameSize = useCallback((): Size => {
    const box = frame?.getBoundingClientRect();
    return { width: box?.width ?? 1, height: box?.height ?? 1 };
  }, [frame]);

  const reset = useCallback(() => {
    if (!svg) return;
    setView(fit(naturalSize(svg), frameSize()));
  }, [svg, frameSize]);

  /*
   * The clone is put in by hand because its content is an element, not markup:
   * handing React the SVG's `outerHTML` would mean parsing a string it already
   * has as a node, through the one API in React whose name is a warning.
   */
  useEffect(() => {
    const host = stage;
    if (!svg || !host) return;
    const copy = svg.cloneNode(true) as SVGElement;
    const size = naturalSize(svg);
    // Its own size, in its own units: everything after this is the transform.
    copy.setAttribute('width', String(size.width));
    copy.setAttribute('height', String(size.height));
    copy.style.maxWidth = 'none';
    copy.style.width = `${size.width}px`;
    copy.style.height = `${size.height}px`;
    const name = svg.getAttribute('id');
    if (name) rename(copy, name, `${name}-open`);
    host.replaceChildren(copy);
    setPicture(size);
    setView(fit(size, frameSize()));
    return () => host.replaceChildren();
  }, [svg, stage, frameSize]);

  /* A window resized under an open diagram leaves it fitted, not stranded. */
  useEffect(() => {
    if (!svg) return;
    const on = () => setView((was) => hold(was, picture, frameSize()));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [svg, picture, frameSize]);

  const nudge = (factor: number, at?: { x: number; y: number }) => {
    const box = frameSize();
    const middle = at ?? { x: box.width / 2, y: box.height / 2 };
    setView((was) => hold(zoomAt(was, middle, factor), picture, box));
  };

  /*
   * `onWheel` as a listener rather than a prop: React attaches wheel passively,
   * and a passive listener may not call `preventDefault` — so every notch
   * zoomed the diagram *and* scrolled the page behind it.
   */
  useEffect(() => {
    const box = frame;
    if (!box || !svg) return;
    const on = (event: WheelEvent) => {
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setView((was) => hold(zoomAt(was, at, wheelFactor(event.deltaY)), picture, { width: rect.width, height: rect.height }));
    };
    box.addEventListener('wheel', on, { passive: false });
    return () => box.removeEventListener('wheel', on);
  }, [svg, frame, picture]);

  /** Dragging, on pointer events so a finger and a mouse are the same code. */
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.id !== event.pointerId) return;
    setView((was) => hold({ scale: was.scale, x: event.clientX - from.x, y: event.clientY - from.y }, picture, frameSize()));
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  /**
   * The keys somebody would try. Held on the frame, which takes focus when the
   * dialog opens, so none of this needs a document-wide listener — and Escape
   * stays the dialog's, which already returns focus to the diagram on the page.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const pan = event.shiftKey ? 200 : 60;
    const move = (dx: number, dy: number) => setView((was) => hold({ ...was, x: was.x + dx, y: was.y + dy }, picture, frameSize()));
    switch (event.key) {
      case '+': case '=': nudge(STEP); break;
      case '-': case '_': nudge(1 / STEP); break;
      case '0': reset(); break;
      case 'ArrowLeft': move(pan, 0); break;
      case 'ArrowRight': move(-pan, 0); break;
      case 'ArrowUp': move(0, pan); break;
      case 'ArrowDown': move(0, -pan); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <Dialog open={!!svg} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent full closeLabel={t('action.close')} className="diagram-view">
        <header className="diagram-bar">
          <DialogTitle className="flex-1">{t('page.diagramTitle')}</DialogTitle>
          <span className="diagram-scale" aria-hidden="true">{Math.round(view.scale * 100)}%</span>
          <button type="button" className="diagram-key" onClick={() => nudge(1 / STEP)} aria-label={t('page.diagramOut')}>
            <Icon name="minus" size={16} />
          </button>
          <button type="button" className="diagram-key" onClick={() => nudge(STEP)} aria-label={t('page.diagramIn')}>
            <Icon name="plus" size={16} />
          </button>
          <button type="button" className="diagram-key diagram-fit" onClick={reset}>{t('page.diagramFit')}</button>
        </header>
        <div
          ref={setFrame}
          className="diagram-frame"
          /* Focusable so the keys below reach it, and named so that is not a
             tab stop a screen reader reads out as nothing. */
          tabIndex={0}
          role="application"
          aria-label={t('page.diagramCanvas')}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            // Away from fit, towards it from anywhere else: one gesture both ways.
            if (view.scale < 1) nudge(1 / view.scale, at);
            else setView(centre(fit(picture, frameSize()), picture, frameSize()));
          }}
        >
          <div
            ref={setStage}
            className="diagram-stage"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        </div>
        <p className="diagram-hint">{t('page.diagramHint')}</p>
      </DialogContent>
    </Dialog>
  );
}
