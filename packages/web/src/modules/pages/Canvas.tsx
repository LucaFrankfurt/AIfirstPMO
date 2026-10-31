/**
 * A canvas page: boards of HTML and sticky notes, laid out on a plane.
 *
 * The plane is the page — pan by dragging the background or scrolling, zoom
 * with a pinch or the buttons — and each board is a whole document drawn in its
 * own sandbox at its own size (`ArtboardFrame`). On the plane a board is a
 * picture: it is moved, sized, opened, played and commented on here, and its
 * contents are edited in `ArtboardEditor`.
 *
 * A drag is held locally and written once, when it ends. Writing every
 * pointer move would queue a mutation per frame for a change nobody else needs
 * to see half of; written at the end it is one last-writer-wins change to `x`
 * and `y`, which is the whole reason a board is a row of its own.
 *
 * Comments here are pins: a point on a board, in the board's own pixels, so a
 * pin stays on the thing it was put on however the canvas is panned or the
 * board is moved. They are ordinary page comments otherwise, in the page's one
 * thread, which is why the panel beside the canvas is the same component a
 * text page has under it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isPin, orderKey, type Anchor, type Artboard, type Page, type Pin } from '@kolibri/shared';
import { byOrder, create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useI18n, useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../kernel/design-system/ui/dialog';
import { Icon, MenuButton, useConfirm } from '../../kernel/design-system/ui';
import { cn } from '../../kernel/design-system/cn';
import { ArtboardFrame } from './ArtboardFrame';
import { ArtboardEditor, useWords } from './ArtboardEditor';
import { TEMPLATE_KINDS, template, type TemplateKind } from './blocks';
import { clampScale, grip, pinch, STEP, wheelFactor, zoomAt, type Grip, type View } from './zoom';

/** Space between boards placed side by side, in canvas pixels. */
const GAP = 80;
/** How far a press has to travel before it is a drag rather than a click. */
const SLOP = 3;
/** The colours a note may be, by name: the stylesheet owns what each looks like. */
const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'] as const;
const NOTE_LABEL = {
  yellow: 'canvas.color.yellow', blue: 'canvas.color.blue', green: 'canvas.color.green', pink: 'canvas.color.pink',
} as const;

const TEMPLATE_LABEL = {
  blank: 'canvas.template.blank', document: 'canvas.template.document',
  dashboard: 'canvas.template.dashboard', phone: 'canvas.template.phone',
} as const;

interface Box { x: number; y: number; w: number; h: number }

/** Everything on the canvas, as one rectangle. */
function bounds(boards: Box[]): Box | null {
  if (!boards.length) return null;
  const left = Math.min(...boards.map((b) => b.x));
  const top = Math.min(...boards.map((b) => b.y));
  const right = Math.max(...boards.map((b) => b.x + b.w));
  const bottom = Math.max(...boards.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The view that shows `box` whole inside a viewport of `width` × `height`, never zoomed past 1. */
function fitTo(box: Box, width: number, height: number, margin = 56): View {
  const scale = clampScale(Math.min(1, (width - margin * 2) / box.w, (height - margin * 2) / box.h));
  return { scale, x: (width - box.w * scale) / 2 - box.x * scale, y: (height - box.h * scale) / 2 - box.y * scale };
}

/**
 * What the canvas asks of a comment thread.
 *
 * The thread itself is `work/comments` — the one every task and page has — and
 * it is handed in by the page route rather than imported here: `work` already
 * leans on `pages`, and a canvas reaching back for it would tie the two into a
 * loop. A route composes; that is what it is for.
 */
export interface ThreadProps {
  target: { page_id: string };
  empty: string;
  anchor: Anchor | Pin | null;
  onAnchorDone: () => void;
  active: string | null;
  onPick: (id: string) => void;
  pinLabel: (pin: Pin) => string;
}

type Drag =
  | { kind: 'pan'; start: { x: number; y: number }; view: View }
  | { kind: 'move'; id: string; start: { x: number; y: number }; origin: Box; moved: boolean }
  | { kind: 'resize'; id: string; start: { x: number; y: number }; origin: Box };

export function CanvasView({ page, canWrite, thread }: {
  page: Page;
  canWrite: boolean;
  thread: (props: ThreadProps) => ReactNode;
}) {
  const t = useT();
  const { locale } = useI18n();
  const words = useWords();
  const { confirm, dialog } = useConfirm();
  const boards = useQuery(() => list('artboard', (b) => b.page_id === page.id).sort(byOrder), [page.id]);
  const comments = useQuery(
    () => list('comment', (c) => c.page_id === page.id).sort((a, b) => a.created_at - b.created_at),
    [page.id],
  );

  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: 0.5, x: 48, y: 48 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [panel, setPanel] = useState(false);
  const [pending, setPending] = useState<Pin | null>(null);
  const [active, setActive] = useState<string | null>(null);
  /** Where a board is while it is being dragged, before the drag is written. */
  const [live, setLive] = useState<{ id: string; box: Box } | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchFrom = useRef<{ grip: Grip; view: View } | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Open on the whole canvas, once per page — not on every board that moves.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === page.id || !size.width || !boards.length) return;
    fitted.current = page.id;
    setView(fitTo(bounds(boards)!, size.width, size.height));
  }, [page.id, size.width, size.height, boards]);

  /** A point on the screen, in canvas pixels. */
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
  };

  // Wheel: a pinch on a trackpad arrives as a wheel with ctrl held, and zooms;
  // anything else pans. Native, because a passive React listener cannot stop
  // the page itself from scrolling underneath.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        setView((now) => zoomAt(now, { x: event.clientX - rect.left, y: event.clientY - rect.top }, wheelFactor(event.deltaY * 2)));
      } else {
        setView((now) => ({ ...now, x: now.x - event.deltaX, y: now.y - event.deltaY }));
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const boxOf = (board: Artboard): Box => (live?.id === board.id ? live.box : { x: board.x, y: board.y, w: board.w, h: board.h });

  /* ------------------------------------------------------------ pointers */

  const begin = (event: React.PointerEvent, next: Drag) => {
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = next;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2 && pinchFrom.current) {
        const [a, b] = [...pointers.current.values()];
        setView(pinch(pinchFrom.current.view, pinchFrom.current.grip, grip(a, b)));
        return;
      }
    }
    const now = drag.current;
    if (!now) return;
    const dx = event.clientX - now.start.x;
    const dy = event.clientY - now.start.y;
    if (now.kind === 'pan') {
      setView({ ...now.view, x: now.view.x + dx, y: now.view.y + dy });
    } else if (now.kind === 'move') {
      if (!now.moved && Math.hypot(dx, dy) < SLOP) return;
      now.moved = true;
      setLive({ id: now.id, box: { ...now.origin, x: Math.round(now.origin.x + dx / view.scale), y: Math.round(now.origin.y + dy / view.scale) } });
    } else {
      setLive({
        id: now.id,
        box: { ...now.origin, w: Math.max(40, Math.round(now.origin.w + dx / view.scale)), h: Math.max(40, Math.round(now.origin.h + dy / view.scale)) },
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    const now = drag.current;
    drag.current = null;
    if (!now || now.kind === 'pan' || !live || live.id !== now.id) {
      setLive(null);
      return;
    }
    if (now.kind === 'move') update('artboard', now.id, { x: live.box.x, y: live.box.y });
    else update('artboard', now.id, { w: live.box.w, h: live.box.h });
    setLive(null);
  };

  const onBackgroundDown = (event: React.PointerEvent) => {
    if (event.target !== event.currentTarget && !(event.target as Element).classList.contains('canvas-world')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchFrom.current = { grip: grip(a, b), view };
      drag.current = null;
      return;
    }
    setSelected(null);
    setNoteEditing(null);
    begin(event, { kind: 'pan', start: { x: event.clientX, y: event.clientY }, view });
  };

  const onBoardDown = (event: React.PointerEvent, board: Artboard) => {
    if (event.button !== 0) return;
    if (pinning) {
      event.stopPropagation();
      const point = toCanvas(event.clientX, event.clientY);
      setPending({ board: board.id, x: Math.round(point.x - board.x), y: Math.round(point.y - board.y) });
      setPanel(true);
      setPinning(false);
      return;
    }
    setSelected(board.id);
    if (!canWrite) return;
    begin(event, { kind: 'move', id: board.id, start: { x: event.clientX, y: event.clientY }, origin: boxOf(board), moved: false });
  };

  /* -------------------------------------------------------------- actions */

  /** Where a new board goes: to the right of everything, or in the middle of what is on screen. */
  const spot = (w: number, h: number): { x: number; y: number } => {
    const all = bounds(boards);
    if (all) return { x: all.x + all.w + GAP, y: all.y };
    const centre = size.width ? { x: (size.width / 2 - view.x) / view.scale, y: (size.height / 2 - view.y) / view.scale } : { x: 0, y: 0 };
    return { x: Math.round(centre.x - w / 2), y: Math.round(centre.y - h / 2) };
  };

  const front = () => orderKey(boards[boards.length - 1]?.sort_order ?? null, null);

  /** Bring a board into view after it is placed, if it landed off screen. */
  const show = (box: Box) => {
    if (!size.width) return;
    setView(fitTo(box, size.width, size.height));
  };

  const addBoard = (kind: TemplateKind) => {
    const made = template(kind, words, locale);
    const at = spot(made.w, made.h);
    const id = create('artboard', {
      page_id: page.id, kind: 'html', title: t(TEMPLATE_LABEL[kind]), x: at.x, y: at.y, w: made.w, h: made.h,
      content: made.content, sort_order: front(),
    });
    setSelected(id);
    show({ ...at, w: made.w, h: made.h });
  };

  const addNote = () => {
    const centre = size.width ? { x: (size.width / 2 - view.x) / view.scale, y: (size.height / 2 - view.y) / view.scale } : { x: 0, y: 0 };
    const id = create('artboard', {
      page_id: page.id, kind: 'note', title: '', color: 'yellow', x: Math.round(centre.x - 120), y: Math.round(centre.y - 90),
      w: 240, h: 180, content: '', sort_order: front(),
    });
    setSelected(id);
    setNoteEditing(id);
  };

  const duplicateBoard = (board: Artboard) => {
    const id = create('artboard', {
      page_id: page.id, kind: board.kind, title: board.title, color: board.color, x: board.x + board.w + GAP, y: board.y,
      w: board.w, h: board.h, content: board.content, sort_order: front(),
    });
    setSelected(id);
  };

  const deleteBoard = async (board: Artboard) => {
    if (board.kind === 'html' && !(await confirm(t('canvas.deleteBoard', { title: board.title || t('common.untitled') })))) return;
    remove('artboard', board.id);
    setSelected(null);
  };

  const nudge = (board: Artboard, dx: number, dy: number) => update('artboard', board.id, { x: board.x + dx, y: board.y + dy });

  const onBoardKey = (event: React.KeyboardEvent, board: Artboard) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (board.kind === 'note') setNoteEditing(board.id);
      else setEditing(board.id);
      return;
    }
    if (!canWrite) return;
    const step = event.shiftKey ? 40 : 8;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      nudge(board, ...moves[event.key]);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      void deleteBoard(board);
    }
  };

  const zoomBy = (factor: number) => setView((now) => zoomAt(now, { x: size.width / 2, y: size.height / 2 }, factor));
  const fitAll = () => {
    const all = bounds(boards);
    if (all && size.width) setView(fitTo(all, size.width, size.height));
  };

  /* ---------------------------------------------------------------- pins */

  const pinsOn = useMemo(() => {
    const out = new Map<string, { id: string; n: number; x: number; y: number }[]>();
    let n = 0;
    for (const comment of comments) {
      if (!isPin(comment.anchor)) continue;
      n += 1;
      const pin = comment.anchor;
      out.set(pin.board, [...(out.get(pin.board) ?? []), { id: comment.id, n, x: pin.x, y: pin.y }]);
    }
    return out;
  }, [comments]);

  const boardTitle = (id: string) => {
    const board = boards.find((b) => b.id === id);
    if (!board) return t('canvas.boardGone');
    return board.kind === 'note' ? t('canvas.note') : board.title || t('common.untitled');
  };

  const pickComment = (id: string) => {
    setActive(id);
    const comment = comments.find((c) => c.id === id);
    if (!comment || !isPin(comment.anchor)) return;
    const board = boards.find((b) => b.id === (comment.anchor as Pin).board);
    if (board && size.width) {
      const point = { x: board.x + comment.anchor.x, y: board.y + comment.anchor.y };
      setView((now) => ({ ...now, x: size.width / 2 - point.x * now.scale, y: size.height / 2 - point.y * now.scale }));
    }
  };

  const chosen = boards.find((b) => b.id === selected) ?? null;
  const editingBoard = boards.find((b) => b.id === editing) ?? null;
  const playingBoard = boards.find((b) => b.id === playing) ?? null;
  const pinCount = [...pinsOn.values()].reduce((sum, pins) => sum + pins.length, 0);

  /* --------------------------------------------------------------- render */

  return (
    <div className={cn('canvas', panel && 'with-panel')}>
      <div className="canvas-toolbar" role="toolbar" aria-label={t('canvas.tools')}>
        {canWrite && (
          <MenuButton
            variant="secondary" size="sm" label={t('canvas.addBoard')}
            items={TEMPLATE_KINDS.map((kind) => ({ id: kind, label: t(TEMPLATE_LABEL[kind]), onSelect: () => addBoard(kind) }))}
          >
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('canvas.addBoard')}</span>
          </MenuButton>
        )}
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={addNote} title={t('canvas.addNote')} aria-label={t('canvas.addNote')}>
            <Icon name="note" size={14} /> <span className="hide-sm">{t('canvas.addNote')}</span>
          </Button>
        )}
        <Button
          size="sm" variant={pinning ? 'primary' : 'ghost'} aria-pressed={pinning}
          onClick={() => setPinning(!pinning)} title={t('canvas.commentTool')} aria-label={t('canvas.commentTool')}
          disabled={!boards.length}
        >
          <Icon name="pin" size={14} /> <span className="hide-sm">{t('canvas.comment')}</span>
        </Button>
        <span className="canvas-divider" aria-hidden="true" />
        <Button size="iconSm" variant="ghost" onClick={() => zoomBy(1 / STEP)} aria-label={t('page.diagramOut')} title={t('page.diagramOut')}><Icon name="minus" size={14} /></Button>
        <span className="canvas-scale" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <Button size="iconSm" variant="ghost" onClick={() => zoomBy(STEP)} aria-label={t('page.diagramIn')} title={t('page.diagramIn')}><Icon name="plus" size={14} /></Button>
        <Button size="iconSm" variant="ghost" onClick={fitAll} disabled={!boards.length} aria-label={t('canvas.fit')} title={t('canvas.fit')}><Icon name="fit" size={14} /></Button>
        {chosen && (
          <>
            <span className="canvas-divider" aria-hidden="true" />
            {chosen.kind === 'html' && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(chosen.id)}>
                  <Icon name="pencil" size={13} /> {canWrite ? t('action.edit') : t('canvas.open')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPlaying(chosen.id)}>
                  <Icon name="play" size={13} /> <span className="hide-sm">{t('canvas.play')}</span>
                </Button>
              </>
            )}
            {canWrite && chosen.kind === 'note' && (
              <MenuButton
                variant="ghost" size="sm" label={t('canvas.noteColor')}
                items={NOTE_COLORS.map((color) => ({
                  id: color, label: t(NOTE_LABEL[color]), hint: (chosen.color ?? 'yellow') === color ? '✓' : undefined,
                  onSelect: () => update('artboard', chosen.id, { color }),
                }))}
              >
                <span className={cn('canvas-note-chip', `is-${chosen.color ?? 'yellow'}`)} aria-hidden="true" />
              </MenuButton>
            )}
            {canWrite && (
              <MenuButton
                variant="ghost" size="iconSm" label={t('common.moreActions')}
                items={[
                  { id: 'duplicate', label: t('canvas.duplicate'), icon: <Icon name="copy" size={14} />, onSelect: () => duplicateBoard(chosen) },
                  { id: 'front', label: t('canvas.toFront'), onSelect: () => update('artboard', chosen.id, { sort_order: front() }) },
                  { id: 'delete', label: t('canvas.delete'), danger: true, icon: <Icon name="trash" size={14} />, onSelect: () => { void deleteBoard(chosen); } },
                ]}
              >
                <Icon name="dots" size={15} />
              </MenuButton>
            )}
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant={panel ? 'primary' : 'secondary'} aria-pressed={panel} onClick={() => setPanel(!panel)}>
          <Icon name="chat" size={14} /> <span className="hide-sm">{t('canvas.comments')}</span>
          {pinCount > 0 && <span className="canvas-count">{pinCount}</span>}
        </Button>
      </div>

      <div
        ref={viewport}
        className={cn('canvas-viewport', pinning && 'is-pinning')}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, '--inverse': 1 / view.scale } as React.CSSProperties}
        >
          {boards.map((board) => {
            const box = boxOf(board);
            const isSelected = selected === board.id;
            const name = board.kind === 'note' ? t('canvas.note') : board.title || t('common.untitled');
            return (
              <div
                key={board.id}
                className={cn('canvas-item', board.kind === 'note' ? `canvas-note is-${board.color ?? 'yellow'}` : 'canvas-board', isSelected && 'is-selected')}
                style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              >
                {board.kind === 'html' && (
                  <div className="canvas-board-name" aria-hidden="true">
                    <span className="truncate">{name}</span>
                    <span className="canvas-board-size">{box.w} × {box.h}</span>
                  </div>
                )}
                {board.kind === 'html' ? (
                  <ArtboardFrame source={board.content ?? ''} mode="view" title={name} className="canvas-frame" />
                ) : noteEditing === board.id && canWrite ? (
                  <textarea
                    className="canvas-note-text"
                    autoFocus
                    aria-label={t('canvas.note')}
                    defaultValue={board.content ?? ''}
                    onPointerDown={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                      if (event.target.value !== (board.content ?? '')) update('artboard', board.id, { content: event.target.value });
                      setNoteEditing(null);
                    }}
                    onKeyDown={(event) => { if (event.key === 'Escape') (event.target as HTMLTextAreaElement).blur(); }}
                  />
                ) : (
                  <p className="canvas-note-body">{board.content || <span className="text-muted">{t('canvas.notePlaceholder')}</span>}</p>
                )}
                {noteEditing !== board.id && (
                  <button
                    type="button"
                    className="canvas-hit"
                    aria-label={board.kind === 'note' ? t('canvas.noteLabel', { text: (board.content ?? '').slice(0, 60) }) : t('canvas.boardLabel', { title: name })}
                    aria-pressed={isSelected}
                    onPointerDown={(event) => onBoardDown(event, board)}
                    onClick={() => setSelected(board.id)}
                    onDoubleClick={() => {
                      if (pinning) return;
                      if (board.kind === 'note') { if (canWrite) setNoteEditing(board.id); } else setEditing(board.id);
                    }}
                    onKeyDown={(event) => onBoardKey(event, board)}
                  />
                )}
                {(pinsOn.get(board.id) ?? []).map((pin) => (
                  <button
                    key={pin.id}
                    type="button"
                    className={cn('canvas-pin', active === pin.id && 'is-active')}
                    style={{ left: pin.x, top: pin.y }}
                    aria-label={t('canvas.pinLabel', { n: pin.n })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => { setPanel(true); setActive(pin.id); }}
                  >
                    {pin.n}
                  </button>
                ))}
                {pending?.board === board.id && (
                  <span className="canvas-pin is-pending" style={{ left: pending.x, top: pending.y }} aria-hidden="true">+</span>
                )}
                {isSelected && canWrite && (
                  <span
                    className="canvas-resize"
                    role="presentation"
                    onPointerDown={(event) => begin(event, { kind: 'resize', id: board.id, start: { x: event.clientX, y: event.clientY }, origin: box })}
                  />
                )}
              </div>
            );
          })}
        </div>
        {!boards.length && (
          <div className="canvas-empty">
            <p>{canWrite ? t('canvas.emptyHint') : t('canvas.emptyReadOnly')}</p>
          </div>
        )}
        {pinning && <p className="canvas-hint" role="status">{t('canvas.pinHint')}</p>}
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
            onPick: pickComment,
            pinLabel: (pin) => t('canvas.pinOn', { title: boardTitle(pin.board) }),
          })}
        </aside>
      )}

      {editingBoard && <ArtboardEditor board={editingBoard} canWrite={canWrite} onClose={() => setEditing(null)} />}

      {playingBoard && (
        <Dialog open onOpenChange={(open) => { if (!open) setPlaying(null); }}>
          <DialogContent full closeLabel={t('action.close')} className="canvas-play" aria-describedby={undefined}>
            <header className="artboard-bar">
              <DialogTitle className="flex-1 text-sm">{playingBoard.title || t('common.untitled')}</DialogTitle>
            </header>
            <div className="canvas-play-stage">
              <ArtboardFrame
                source={playingBoard.content ?? ''} mode="play" title={playingBoard.title || t('common.untitled')}
                className="canvas-play-frame" style={{ width: Math.min(playingBoard.w, 4000) }}
                onMessage={(message) => { if (message.type === 'kolibri:key' && message.key === 'escape') setPlaying(null); }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
      {dialog}
    </div>
  );
}
