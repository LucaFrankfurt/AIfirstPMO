/**
 * A board on its own: a page of format `board`, which holds exactly one board
 * and shows it the way a markdown page shows its text.
 *
 * Everything a board is lives where it already lived — the row in
 * `artboards`, its CRDT, its history, its pictures, its pins in the page's
 * thread — so a board page is a canvas's board without the plane around it,
 * and every door that knows a board (search, MCP, the editor, export, the
 * trash) knows this one. What is new is only how it is shown:
 *
 * **At its own width, scaled down to fit.** A board is designed at a width,
 * and its pins are points in its own pixels; drawn at whatever width the
 * screen has, its layout would reflow under its comments. So it is the same
 * picture the canvas and the editor draw, as large as the column allows and
 * never larger than itself.
 *
 * **As tall as it is.** A page scrolls; a window inside a page that scrolls
 * too is the thing everybody dislikes about embedded documents. So the frame
 * measures the board and grows to it — down to the board's own height, never
 * below — and the page scrolls instead. A board whose height is the frame's
 * (`100vh`) stays the frame's. One that is the frame's *and a margin* would
 * chase its own tail, growing by the margin each time it is measured; growing
 * by exactly what it just grew by is that signature, and stops it.
 *
 * **Fitted to a phone, when it would otherwise be a stamp.** Scaled to fit, a
 * 1280px board on a 390px screen is drawn at a third of its size. Where the
 * scale would fall below `FIT_BELOW`, the page draws the board at the screen's
 * width instead — a board written to be responsive, as Claude writes them,
 * reflows the way the same artifact does on claude.ai — and offers *As
 * designed* to go back. A pin is a point in the board's own pixels, which
 * means nothing on a reflowed board — so a pin also remembers the element it
 * was put on, and on a reflowed board the frame is asked where that element
 * is now (see `elementPath` in `frame.ts`). A pin from before that, or one
 * whose element an edit has since moved, is shown only as designed. Putting
 * one down needs the designed board, so the comment tool goes back to it.
 *
 * **Working, not a picture.** On a canvas a board is something to move, and a
 * press on it picks it up. Here nothing moves, so the board is live: its
 * buttons, tabs and links work as they do in *Try it*. Pinning a comment is a
 * mode, a layer over the board that takes the one click.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isPin, orderKey, type Page, type Pin } from '@kolibri/shared';
import { byOrder, create } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useI18n, useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon } from '../../kernel/design-system/ui';
import { cn } from '../../kernel/design-system/cn';
import { ArtboardFrame, type Locate, type PinPlace } from './ArtboardFrame';
import { isPath } from './frame';
import { ArtboardEditor, useWords } from './ArtboardEditor';
import { CanvasPrint, type ThreadProps } from './Canvas';
import { TEMPLATE_KINDS, TEMPLATE_LABEL, template, type TemplateKind } from './blocks';
import { DraftDialog, ImportDialog, useAiLabels, type CanvasAi, type Drafted } from './canvas-dialogs';

/** The tallest a board page grows to — the server's ceiling for a board's frame. */
const MAX_HEIGHT = 8000;

/** Below this scale the page offers — and on first sight uses — the board at the screen's width. */
const FIT_BELOW = 0.6;

/** The shortest a reflowed board is drawn before it has measured itself. */
const FIT_FLOOR = 160;

/** Where the comment thread covers the board rather than standing beside it — the same width `app.css` says. */
const PANEL_COVERS = '(max-width: 720px)';

/**
 * The page's frame height, grown to what the board says it needs.
 *
 * Kept in a ref as well as in state because the guard compares against the
 * height last *set*, not the one last rendered: two measurements can arrive
 * between renders.
 */
function useFittedHeight(floor: number, source: string | undefined): [number, (reported: number) => void] {
  const [height, setHeight] = useState(floor);
  const current = useRef(floor);
  const growth = useRef<number | null>(null);

  // A new source or a new layout is a new measurement, and the guard starts over with it.
  useEffect(() => { growth.current = null; }, [source, floor]);
  useEffect(() => {
    if (current.current >= floor) return;
    current.current = floor;
    setHeight(floor);
  }, [floor]);

  const fit = useCallback((reported: number) => {
    const next = Math.min(MAX_HEIGHT, Math.max(floor, Math.ceil(reported)));
    const now = current.current;
    if (next === now) return;
    if (next > now) {
      const delta = next - now;
      if (growth.current !== null && Math.abs(delta - growth.current) <= 2) return;
      growth.current = delta;
    } else {
      growth.current = null;
    }
    current.current = next;
    setHeight(next);
  }, [floor]);

  return [height, fit];
}

/** The width a box has for its content, watched. */
function useWidth(): [(element: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    // A width of nothing is the stage hidden — on a phone the comment thread
    // covers it — not a screen with no room: the last real width stands, or
    // the board would stop being reflowed behind the thread and the thread
    // would be asked about a layout nobody is looking at.
    const watch = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    watch.observe(element);
    observer.current = watch;
  }, []);
  return [ref, width];
}

export function BoardPageView({ page, canWrite, ai = null, editing, onEditing, onRename, thread, printRequest = 0 }: {
  page: Page;
  canWrite: boolean;
  /** The model, when this server has one and the workspace has it switched on. */
  ai?: CanvasAi | null;
  /** Whether the editor is open — the page header's *Edit* asks for it. */
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** Renaming the board renames the page: one title, the page's. */
  onRename: (title: string) => void;
  thread: (props: ThreadProps) => ReactNode;
  /** Bumped by the page menu's *Download → PDF*. */
  printRequest?: number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const words = useWords();
  const aiLabels = useAiLabels(ai);
  // The first by order, if a sync ever left two: the server refuses a second,
  // but a page restored from the trash beside a newer board could hold both.
  const board = useQuery(
    () => list('artboard', (b) => b.page_id === page.id && b.kind === 'html').sort(byOrder)[0] ?? null,
    [page.id],
  );
  const comments = useQuery(
    () => list('comment', (c) => c.page_id === page.id).sort((a, b) => a.created_at - b.created_at),
    [page.id],
  );

  const [stageRef, width] = useWidth();
  const designedScale = board && width ? Math.min(1, width / board.w) : 1;
  // Asked once the screen is known, and left to the reader after that.
  const [layout, setLayout] = useState<'designed' | 'fit' | null>(null);
  const shrunk = !!board && !!width && designedScale < 1;
  const fitted = (layout ?? (designedScale < FIT_BELOW ? 'fit' : 'designed')) === 'fit' && shrunk;
  const scale = fitted ? 1 : designedScale;
  const drawnWidth = board ? (fitted ? Math.floor(width) : board.w) : 0;
  const [height, fit] = useFittedHeight(fitted ? FIT_FLOOR : board?.h ?? 0, board?.content);

  const [panel, setPanel] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pending, setPending] = useState<Pin | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [opening, setOpening] = useState<'describe' | 'import' | null>(null);
  const [asking, setAsking] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => { if (printRequest) setPrinting(true); }, [printRequest]);

  // Escape leaves the pin tool, as it does on the canvas.
  useEffect(() => {
    if (!pinning) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPinning(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [pinning]);

  const pins = useMemo(() => {
    const out: { id: string; n: number; x: number; y: number; on: PinPlace | null }[] = [];
    let n = 0;
    for (const comment of comments) {
      if (!isPin(comment.anchor) || comment.resolution) continue;
      n += 1;
      const pin = comment.anchor;
      if (!board || pin.board !== board.id) continue;
      // Read defensively: a pin is JSON somebody else's client wrote.
      const on = isPath(pin.el) && Number.isFinite(pin.fx) && Number.isFinite(pin.fy)
        ? { id: comment.id, el: pin.el, fx: Number(pin.fx), fy: Number(pin.fy) } : null;
      out.push({ id: comment.id, n, x: pin.x, y: pin.y, on });
    }
    return out;
  }, [comments, board]);
  /** The pins the reflowed board can find, and where it found them. */
  const anchored = useMemo(() => pins.flatMap((pin) => (pin.on ? [pin.on] : [])), [pins]);
  const [found, setFound] = useState<Map<string, { x: number; y: number }>>(new Map());
  const locate = useRef<Locate | null>(null);
  const shown = fitted
    ? pins.flatMap((pin) => { const at = found.get(pin.id); return at ? [{ ...pin, x: at.x, y: at.y }] : []; })
    : pins;

  /** The board, put down — from a template, a file or the model. Named after the page it is. */
  const start = (made: { content: string; w: number; h: number }): void => {
    create('artboard', {
      page_id: page.id, kind: 'html', title: page.title, x: 0, y: 0, w: made.w, h: made.h,
      content: made.content, sort_order: orderKey(null, null),
    });
  };
  const fromTemplate = (kind: TemplateKind): void => {
    start(template(kind, words, locale));
    onEditing(true);
  };
  const arrived = (draft: Drafted): void => {
    start({ content: draft.html, w: draft.w, h: draft.h });
    // An untitled page takes the name the board came with.
    if (draft.title && (!page.title || page.title === t('common.untitled'))) onRename(draft.title);
    setOpening(null);
  };

  const pinAt = async (event: React.MouseEvent): Promise<void> => {
    if (!board || !sheet.current) return;
    const rect = sheet.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(board.w, Math.round((event.clientX - rect.left) / scale)));
    const y = Math.max(0, Math.min(height, Math.round((event.clientY - rect.top) / scale)));
    setPinning(false);
    // The point, and what is under it, so the pin can be found on a phone too.
    const on = await locate.current?.(x, y) ?? null;
    setPending({ board: board.id, x, y, ...(on ?? {}) });
    setPanel(true);
  };

  const pick = (id: string): void => {
    setActive(id);
    // Shown where it is, if the reflowed board found it; otherwise as designed.
    if (fitted && !found.has(id)) setLayout('designed');
    // On a phone the thread covers the board (`app.css`), so picking a pin
    // there would point at something nobody can see: the thread steps aside.
    if (matchMedia(PANEL_COVERS).matches) setPanel(false);
    requestAnimationFrame(() => {
      document.querySelector(`[data-pin="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  return (
    <div className={cn('board-page', panel && 'with-panel')}>
      <div className="canvas-toolbar" role="toolbar" aria-label={t('canvas.tools')}>
        <Button
          size="sm" variant={pinning ? 'primary' : 'ghost'} aria-pressed={pinning} disabled={!board}
          onClick={() => { if (fitted) setLayout('designed'); setPinning(!pinning); }}
          title={t('canvas.commentTool')} aria-label={t('canvas.commentTool')}
        >
          <Icon name="pin" size={14} /> <span className="hide-sm">{t('canvas.comment')}</span>
        </Button>
        {ai && canWrite && board && (
          <Button size="sm" variant="ghost" onClick={() => { setAsking(true); onEditing(true); }}>
            <Icon name="sparkle" size={14} /> <span className="hide-sm">{aiLabels.ask}</span>
          </Button>
        )}
        <span className="flex-1" />
        {shrunk && (
          <Button
            size="sm" variant="ghost" aria-pressed={fitted} onClick={() => setLayout(fitted ? 'designed' : 'fit')}
            title={fitted ? t('board.asDesigned') : t('board.fitScreen')} aria-label={fitted ? t('board.asDesigned') : t('board.fitScreen')}
          >
            <Icon name="fit" size={14} /> <span className="hide-sm">{fitted ? t('board.asDesigned') : t('board.fitScreen')}</span>
          </Button>
        )}
        <Button
          size="sm" variant="ghost" disabled={!board || printing} onClick={() => setPrinting(true)}
          title={t('canvas.exportPdf')} aria-label={t('canvas.exportPdf')}
        >
          <Icon name="page" size={14} /> <span className="hide-sm">{t('canvas.pdf')}</span>
        </Button>
        <Button
          size="sm" variant={panel ? 'primary' : 'secondary'} aria-pressed={panel} onClick={() => setPanel(!panel)}
          // Named on its own: on a phone the word is hidden and the count alone would be its name.
          aria-label={t('canvas.comments')} title={t('canvas.comments')}
        >
          <Icon name="chat" size={14} /> <span className="hide-sm">{t('canvas.comments')}</span>
          {pins.length > 0 && <span className="canvas-count">{pins.length}</span>}
        </Button>
      </div>

      <div ref={stageRef} className="board-stage">
        {board ? (
          <div className={cn('board-sheet', fitted && 'is-fitted')} style={{ width: drawnWidth * scale, height: height * scale }}>
            <div
              ref={sheet}
              className="board-sheet-inner"
              style={{ width: drawnWidth, height, transform: `scale(${scale})`, '--inverse': 1 / scale } as React.CSSProperties}
            >
              <ArtboardFrame
                source={board.content ?? ''} mode="play" title={page.title || t('common.untitled')}
                className="board-frame" onSize={fit} locator={locate}
                pins={fitted ? anchored : undefined} onPins={setFound}
              />
              {pinning && (
                <button type="button" className="board-pin-layer" aria-label={t('canvas.pinHint')} onClick={(event) => { void pinAt(event); }} />
              )}
              {shown.map((pin) => (
                <button
                  key={pin.id}
                  type="button"
                  data-pin={pin.id}
                  className={cn('canvas-pin', active === pin.id && 'is-active')}
                  style={{ left: pin.x, top: pin.y }}
                  aria-label={t('canvas.pinLabel', { n: pin.n })}
                  onClick={() => { setPanel(true); setActive(pin.id); }}
                >
                  {pin.n}
                </button>
              ))}
              {pending && !fitted && (
                <span className="canvas-pin is-pending" style={{ left: pending.x, top: pending.y }} aria-hidden="true">+</span>
              )}
            </div>
          </div>
        ) : (
          <div className="board-empty">
            <h2 className="text-base font-semibold m-0">{t('board.emptyTitle')}</h2>
            <p className="text-muted text-[13px] m-0">{canWrite ? t('board.emptyHint') : t('board.emptyReader')}</p>
            {canWrite && (
              <div className="board-empty-choices">
                {ai && (
                  <Button variant="primary" size="sm" onClick={() => setOpening('describe')}>
                    <Icon name="sparkle" size={14} /> {aiLabels.describe}
                  </Button>
                )}
                {TEMPLATE_KINDS.map((kind) => (
                  <Button key={kind} variant="secondary" size="sm" onClick={() => fromTemplate(kind)}>{t(TEMPLATE_LABEL[kind])}</Button>
                ))}
                <Button variant="secondary" size="sm" onClick={() => setOpening('import')}>
                  <Icon name="attach" size={14} /> {t('canvas.importTitle')}
                </Button>
              </div>
            )}
          </div>
        )}
        {pinning && <p className="canvas-hint" role="status">{t('canvas.pinHint')}</p>}
        {printing && <p className="canvas-hint" role="status">{t('canvas.preparingPdf')}</p>}
      </div>

      {panel && (
        <aside className="canvas-panel" aria-label={t('canvas.comments')}>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="flex-1 text-sm font-semibold m-0">{t('canvas.comments')}</h2>
            <Button size="iconSm" variant="ghost" onClick={() => setPanel(false)} aria-label={t('action.close')}><Icon name="close" size={14} /></Button>
          </div>
          {thread({
            target: { page_id: page.id },
            empty: t('canvas.noComments'),
            anchor: pending,
            onAnchorDone: () => setPending(null),
            active,
            onPick: pick,
            pinLabel: () => t('canvas.pinOn', { title: page.title || t('common.untitled') }),
          })}
        </aside>
      )}

      {/* The PDF is the board as designed and as tall as it is, however the screen is showing it. */}
      {printing && board && (
        <CanvasPrint boards={[board]} fit title={page.title || t('common.untitled')} onDone={() => setPrinting(false)} />
      )}

      {opening === 'describe' && ai && (
        <DraftDialog ai={ai} pageId={page.id} hasOthers={false} onDrafted={arrived} onClose={() => setOpening(null)} />
      )}
      {opening === 'import' && <ImportDialog onImported={arrived} onClose={() => setOpening(null)} />}

      {editing && board && (
        <ArtboardEditor
          board={board} canWrite={canWrite} ai={ai} onRename={onRename} startAsking={asking}
          onClose={() => { setAsking(false); onEditing(false); }}
        />
      )}
    </div>
  );
}
