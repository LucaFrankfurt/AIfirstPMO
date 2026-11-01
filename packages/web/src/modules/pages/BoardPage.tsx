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
 * **Working, not a picture.** On a canvas a board is something to move, and a
 * press on it picks it up. Here nothing moves, so the board is live: its
 * buttons, tabs and links work as they do in *Try it*. Pinning a comment is a
 * mode, a layer over the board that takes the one click.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isPin, orderKey, type Artboard, type Page, type Pin } from '@kolibri/shared';
import { byOrder, create } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useI18n, useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon } from '../../kernel/design-system/ui';
import { cn } from '../../kernel/design-system/cn';
import { ArtboardFrame } from './ArtboardFrame';
import { ArtboardEditor, useWords } from './ArtboardEditor';
import { CanvasPrint, type ThreadProps } from './Canvas';
import { TEMPLATE_KINDS, TEMPLATE_LABEL, template, type TemplateKind } from './blocks';
import { DraftDialog, ImportDialog, useAiLabels, type CanvasAi, type Drafted } from './canvas-dialogs';

/** The tallest a board page grows to — the server's ceiling for a board's frame. */
const MAX_HEIGHT = 8000;

/**
 * The page's frame height, grown to what the board says it needs.
 *
 * Kept in a ref as well as in state because the guard compares against the
 * height last *set*, not the one last rendered: two measurements can arrive
 * between renders.
 */
function useFittedHeight(board: Artboard | null): [number, (reported: number) => void] {
  const floor = board?.h ?? 0;
  const [height, setHeight] = useState(floor);
  const current = useRef(floor);
  const growth = useRef<number | null>(null);

  // A new source is a new measurement, and the guard starts over with it.
  useEffect(() => { growth.current = null; }, [board?.content]);
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
    const watch = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    watch.observe(element);
    observer.current = watch;
  }, []);
  return [ref, width];
}

export function BoardPageView({ page, canWrite, ai = null, editing, onEditing, onRename, thread }: {
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
  const [height, fit] = useFittedHeight(board);
  const scale = board && width ? Math.min(1, width / board.w) : 1;

  const [panel, setPanel] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pending, setPending] = useState<Pin | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [opening, setOpening] = useState<'describe' | 'import' | null>(null);
  const [asking, setAsking] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  // Escape leaves the pin tool, as it does on the canvas.
  useEffect(() => {
    if (!pinning) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPinning(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [pinning]);

  const pins = useMemo(() => {
    const out: { id: string; n: number; x: number; y: number }[] = [];
    let n = 0;
    for (const comment of comments) {
      if (!isPin(comment.anchor) || comment.resolution) continue;
      n += 1;
      if (board && comment.anchor.board === board.id) out.push({ id: comment.id, n, x: comment.anchor.x, y: comment.anchor.y });
    }
    return out;
  }, [comments, board]);

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

  const pinAt = (event: React.MouseEvent): void => {
    if (!board || !sheet.current) return;
    const rect = sheet.current.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) / scale);
    const y = Math.round((event.clientY - rect.top) / scale);
    setPending({ board: board.id, x: Math.max(0, Math.min(board.w, x)), y: Math.max(0, Math.min(height, y)) });
    setPinning(false);
    setPanel(true);
  };

  const pick = (id: string): void => {
    setActive(id);
    document.querySelector(`[data-pin="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    <div className={cn('board-page', panel && 'with-panel')}>
      <div className="canvas-toolbar" role="toolbar" aria-label={t('canvas.tools')}>
        <Button
          size="sm" variant={pinning ? 'primary' : 'ghost'} aria-pressed={pinning} disabled={!board}
          onClick={() => setPinning(!pinning)} title={t('canvas.commentTool')} aria-label={t('canvas.commentTool')}
        >
          <Icon name="pin" size={14} /> <span className="hide-sm">{t('canvas.comment')}</span>
        </Button>
        {ai && canWrite && board && (
          <Button size="sm" variant="ghost" onClick={() => { setAsking(true); onEditing(true); }}>
            <Icon name="sparkle" size={14} /> <span className="hide-sm">{aiLabels.ask}</span>
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm" variant="ghost" disabled={!board || printing} onClick={() => setPrinting(true)}
          title={t('canvas.exportPdf')} aria-label={t('canvas.exportPdf')}
        >
          <Icon name="page" size={14} /> <span className="hide-sm">{t('canvas.pdf')}</span>
        </Button>
        <Button size="sm" variant={panel ? 'primary' : 'secondary'} aria-pressed={panel} onClick={() => setPanel(!panel)}>
          <Icon name="chat" size={14} /> <span className="hide-sm">{t('canvas.comments')}</span>
          {pins.length > 0 && <span className="canvas-count">{pins.length}</span>}
        </Button>
      </div>

      <div ref={stageRef} className="board-stage">
        {board ? (
          <div className="board-sheet" style={{ width: board.w * scale, height: height * scale }}>
            <div
              ref={sheet}
              className="board-sheet-inner"
              style={{ width: board.w, height, transform: `scale(${scale})`, '--inverse': 1 / scale } as React.CSSProperties}
            >
              <ArtboardFrame
                source={board.content ?? ''} mode="play" title={page.title || t('common.untitled')}
                className="board-frame" onSize={fit}
              />
              {pinning && (
                <button type="button" className="board-pin-layer" aria-label={t('canvas.pinHint')} onClick={pinAt} />
              )}
              {pins.map((pin) => (
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
              {pending && (
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

      {/* The PDF is the board at the height the page shows it, so nothing below its frame is cut. */}
      {printing && board && (
        <CanvasPrint boards={[{ ...board, h: height }]} title={page.title || t('common.untitled')} onDone={() => setPrinting(false)} />
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
