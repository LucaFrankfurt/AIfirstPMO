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
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { isPin, orderKey, type Anchor, type Artboard, type Page, type Pin } from '@kolibri/shared';
import { byOrder, create, createPage, remove, update } from '../../kernel/sync/mutations';
import { useMe } from '../../kernel/identity/session';
import { list, useQuery } from '../../kernel/sync/store';
import { useI18n, useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../kernel/design-system/ui/dialog';
import { Icon, MenuButton, useConfirm } from '../../kernel/design-system/ui';
import { cn } from '../../kernel/design-system/cn';
import { ArtboardFrame } from './ArtboardFrame';
import { ArtboardEditor, useWords } from './ArtboardEditor';
import { BOARD_ICON, TEMPLATE_KINDS, TEMPLATE_LABEL, imageBoard, template, type TemplateKind } from './blocks';
import { DraftDialog, ImportDialog, useAiLabels, type CanvasAi, type Drafted } from './canvas-dialogs';
import { useUploads } from '../../kernel/files/uploads';
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

interface Box { x: number; y: number; w: number; h: number }

/** A picture's own size, read before it is uploaded — the upload is downscaled, the proportions are not. */
function naturalSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { resolve({ width: image.naturalWidth || 800, height: image.naturalHeight || 600 }); URL.revokeObjectURL(url); };
    image.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    image.src = url;
  });
}

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

/**
 * A note being written, saved however it is left.
 *
 * It used to be saved on blur and on nothing else — and a press on the canvas
 * ends the editing by taking the text box off the screen, which a browser does
 * without a blur. So the most natural way out of a note, clicking beside it,
 * threw away everything typed into it. Reported, and measured before the fix:
 * leaving by Escape or by the toolbar kept the text, leaving by the canvas lost
 * it. Now the text is also written when the box goes away, and writing twice is
 * harmless because only a change is ever sent.
 */
function NoteEditor({ board, label, onDone }: { board: Artboard; label: string; onDone: () => void }) {
  const value = useRef(board.content ?? '');
  const written = useRef(board.content ?? '');
  const save = (): void => {
    if (value.current === written.current) return;
    written.current = value.current;
    update('artboard', board.id, { content: value.current });
  };
  const keep = useRef(save);
  keep.current = save;
  useEffect(() => () => keep.current(), []);
  return (
    <textarea
      className="canvas-note-text"
      autoFocus
      aria-label={label}
      defaultValue={board.content ?? ''}
      onChange={(event) => { value.current = event.target.value; }}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => { save(); onDone(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') (event.target as HTMLTextAreaElement).blur(); }}
    />
  );
}

/** How long a PDF waits for boards that never say they are drawn, before printing anyway. */
const PRINT_PATIENCE_MS = 8000;
/** The tallest page a board prints as — the server's ceiling for a board's frame. */
const PRINT_TALLEST = 8000;

/**
 * The canvas as a PDF: one page per board, each page exactly the board's size.
 *
 * Through the browser's own print, because the server renders nothing — it
 * has no browser and no dependency to be one — and because the browser is
 * the one thing that can draw a board at all: its scripts have to run. Each
 * board is drawn again here at its own size, given a named page whose
 * `@page` size is the board's, and the dialogue's "Save as PDF" is the export.
 * In reading order — top to bottom, then left to right — with the notes as
 * small pages of their own, because a note is part of what the canvas says.
 *
 * The layer is in the document while it waits, at the top of the screen and
 * invisible: a frame the browser counts as off screen may be held back, and a
 * board drawn into a print that has already been taken is a blank page.
 */
export function CanvasPrint({ boards, title, fit = false, onDone }: {
  boards: Artboard[];
  title: string;
  /**
   * Print each board as tall as it is rather than as tall as its frame — a
   * board page's PDF, where the board is a document. Measured here, at the
   * board's own width, so it does not matter how the screen showed it.
   */
  fit?: boolean;
  onDone: () => void;
}) {
  const ordered = useMemo(() => [...boards].sort((a, b) => a.y - b.y || a.x - b.x), [boards]);
  const waiting = useRef(new Set(ordered.filter((board) => board.kind === 'html').map((board) => board.id)));
  const printed = useRef(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [ready, setReady] = useState(!waiting.current.size);

  useEffect(() => {
    const done = () => onDone();
    addEventListener('afterprint', done);
    const fallback = setTimeout(() => go(), PRINT_PATIENCE_MS);
    return () => { removeEventListener('afterprint', done); clearTimeout(fallback); };
    // Once, for the boards there were when the export was asked for.
  }, []);

  // After the render that carries the measured heights, so each page is sized
  // to its board before the dialogue takes its picture.
  useEffect(() => { if (ready) go(); }, [ready]);

  function go(): void {
    if (printed.current) return;
    printed.current = true;
    const before = document.title;
    // The title is the file name the dialogue offers.
    document.title = title;
    window.print();
    document.title = before;
  }

  const drawn = (id: string) => {
    waiting.current.delete(id);
    if (!waiting.current.size) setReady(true);
  };
  const measured = (id: string, floor: number, height: number) => {
    if (printed.current) return;
    setHeights((now) => ({ ...now, [id]: Math.min(PRINT_TALLEST, Math.max(floor, Math.ceil(height))) }));
  };
  const heightOf = (board: Artboard): number => heights[board.id] ?? board.h;

  return createPortal(
    <div className="canvas-print" aria-hidden="true">
      <style>{ordered.map((board, at) => `@page board-${at} { size: ${board.w}px ${heightOf(board)}px; margin: 0; }`).join('\n')}</style>
      {ordered.map((board, at) => (
        <section key={board.id} className="canvas-print-page" style={{ page: `board-${at}`, width: board.w, height: heightOf(board) }}>
          {board.kind === 'html' ? (
            <ArtboardFrame
              source={board.content ?? ''} mode="play" title={board.title || title}
              className="canvas-print-frame" onRendered={() => drawn(board.id)}
              onSize={fit ? (height) => measured(board.id, board.h, height) : undefined}
            />
          ) : (
            <div className={cn('canvas-note', `is-${board.color ?? 'yellow'}`)} style={{ width: board.w, height: board.h }}>
              <p className="canvas-note-body">{board.content}</p>
            </div>
          )}
        </section>
      ))}
    </div>,
    document.body,
  );
}

type Drag =
  | { kind: 'pan'; start: { x: number; y: number }; view: View }
  | { kind: 'move'; id: string; start: { x: number; y: number }; origin: Box; moved: boolean }
  | { kind: 'resize'; id: string; start: { x: number; y: number }; origin: Box };

export function CanvasView({ page, canWrite, thread, ai = null, printRequest = 0 }: {
  page: Page;
  canWrite: boolean;
  thread: (props: ThreadProps) => ReactNode;
  /** Bumped by the page menu's *Download → PDF*: the print layer lives here, with the boards. */
  printRequest?: number;
  /** The model, when this server has one and the workspace has it switched on. */
  ai?: CanvasAi | null;
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
  const [printing, setPrinting] = useState(false);
  useEffect(() => { if (printRequest) setPrinting(true); }, [printRequest]);
  const [opening, setOpening] = useState<'describe' | 'import' | null>(null);
  const aiLabels = useAiLabels(ai);
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

  /**
   * Every finger, wherever it lands — on the plane or on a board.
   *
   * Counted in the capture phase so that a second finger is seen before a
   * board under it can start a drag of its own: two fingers are a pinch, and
   * whatever the first one had started is let go of. Only the plane counted
   * fingers before, so a pinch that began on a board — most of a full canvas,
   * on a phone — moved the board instead of zooming.
   */
  const onPointerDownCapture = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size !== 2) return;
    const [a, b] = [...pointers.current.values()];
    pinchFrom.current = { grip: grip(a, b), view };
    drag.current = null;
    setLive(null);
    event.stopPropagation();
  };

  /**
   * A double tap, by hand: a touch screen does not reliably send `dblclick`,
   * and a board that opens on a double click and on nothing else cannot be
   * opened on a phone except through the toolbar.
   */
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const tapped = (board: Artboard) => {
    const now = Date.now();
    if (lastTap.current?.id === board.id && now - lastTap.current.at < 350) {
      lastTap.current = null;
      if (board.kind === 'note') { if (canWrite) setNoteEditing(board.id); } else setEditing(board.id);
      return;
    }
    lastTap.current = { id: board.id, at: now };
  };

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    const now = drag.current;
    drag.current = null;
    if (now?.kind === 'move' && !now.moved && event.pointerType !== 'mouse' && !pinning) {
      const board = boards.find((one) => one.id === now.id);
      if (board) tapped(board);
    }
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
    setSelected(null);
    setNoteEditing(null);
    begin(event, { kind: 'pan', start: { x: event.clientX, y: event.clientY }, view });
  };

  const onBoardDown = (event: React.PointerEvent, board: Artboard) => {
    if (event.button !== 0) return;
    // A board a viewer cannot move still has to be openable by a double tap.
    if (!canWrite && event.pointerType !== 'mouse' && !pinning) {
      setSelected(board.id);
      tapped(board);
      return;
    }
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

  /** A board that arrived whole — drawn by Claude or brought from a file — put where a new board goes. */
  const place = (draft: Drafted) => {
    const at = spot(draft.w, draft.h);
    const id = create('artboard', {
      page_id: page.id, kind: 'html', title: draft.title, x: at.x, y: at.y, w: draft.w, h: draft.h,
      content: draft.html, sort_order: front(),
    });
    setSelected(id);
    show({ ...at, w: draft.w, h: draft.h });
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

  /*
   * Pictures dropped on the plane become boards of their own, where they were
   * dropped, at their own proportions. Uploaded like any file and hung on the
   * canvas, so they follow its visibility; drawn through `board-files.ts`.
   */
  const uploads = useUploads({ kind: 'page', id: page.id });
  const [dropping, setDropping] = useState(false);
  const dropImages = async (files: File[], clientX: number, clientY: number) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length || !canWrite) return;
    const sizes = await Promise.all(images.map(naturalSize));
    const done = await uploads.take(images);
    let at = toCanvas(clientX, clientY);
    let last: string | null = null;
    done.forEach((image, index) => {
      const natural = sizes[index] ?? { width: 800, height: 600 };
      const scale = Math.min(1, 1200 / natural.width);
      const w = Math.max(40, Math.round(natural.width * scale));
      const h = Math.max(40, Math.round(natural.height * scale));
      last = create('artboard', {
        page_id: page.id, kind: 'html', title: image.name, x: Math.round(at.x), y: Math.round(at.y), w, h,
        content: imageBoard(image.url, image.name, locale), sort_order: front(),
      });
      at = { x: at.x + w + GAP, y: at.y };
    });
    if (last) setSelected(last);
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

  /*
   * A board taken out to stand on its own: a board page beside nothing, under
   * this canvas in the tree. A copy, not a move — the board's pins and their
   * discussion belong to this canvas's thread, and a move would either strand
   * them or carry somebody's comments to a page they did not write on. Who may
   * see it is who may see this canvas: a copy of something private is private.
   */
  const navigate = useNavigate();
  const me = useMe();
  const copyToPage = (board: Artboard) => {
    const id = createPage({
      title: board.title || t('common.untitled'), format: 'board', icon: BOARD_ICON,
      parent_id: page.id, project_id: page.project_id, access: page.access,
    }, me);
    create('artboard', {
      page_id: id, kind: 'html', title: board.title || t('common.untitled'), x: 0, y: 0, w: board.w, h: board.h,
      content: board.content, sort_order: orderKey(null, null),
    });
    navigate(`/pages/${id}`);
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
      // A settled comment leaves the board; the thread still has it.
      if (!isPin(comment.anchor) || comment.resolution) continue;
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
            items={[
              // First when it is there: describing the board is the way to
              // something like a real product screen, and a template is a
              // blank with a heading.
              ...(ai ? [{ id: 'describe', label: aiLabels.describe, icon: <Icon name="sparkle" size={14} />, onSelect: () => setOpening('describe') }] : []),
              ...TEMPLATE_KINDS.map((kind) => ({ id: kind, label: t(TEMPLATE_LABEL[kind]), onSelect: () => addBoard(kind) })),
              { id: 'import', label: t('canvas.importTitle'), icon: <Icon name="attach" size={14} />, onSelect: () => setOpening('import') },
            ]}
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
                  ...(chosen.kind === 'html'
                    ? [{ id: 'own-page', label: t('board.copyToPage'), icon: <Icon name="page" size={14} />, onSelect: () => copyToPage(chosen) }]
                    : []),
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
        <Button
          size="sm" variant="ghost" disabled={!boards.length || printing} onClick={() => setPrinting(true)}
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
          {pinCount > 0 && <span className="canvas-count">{pinCount}</span>}
        </Button>
      </div>

      <div
        ref={viewport}
        className={cn('canvas-viewport', pinning && 'is-pinning', dropping && 'is-dropping')}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragOver={(event) => {
          if (!canWrite || ![...event.dataTransfer.items].some((item) => item.kind === 'file')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!canWrite) return;
          event.preventDefault();
          setDropping(false);
          void dropImages([...event.dataTransfer.files], event.clientX, event.clientY);
        }}
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
                data-board={board.id}
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
                  <NoteEditor board={board} label={t('canvas.note')} onDone={() => setNoteEditing(null)} />
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
        {printing && <p className="canvas-hint" role="status">{t('canvas.preparingPdf')}</p>}
        {(dropping || uploads.busy) && <p className="canvas-hint" role="status">{uploads.busy ? t('canvas.uploading') : t('canvas.dropImages')}</p>}
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

      {printing && <CanvasPrint boards={boards} title={page.title || t('common.untitled')} onDone={() => setPrinting(false)} />}

      {opening === 'describe' && ai && (
        <DraftDialog
          ai={ai} pageId={page.id} hasOthers={boards.some((board) => board.kind === 'html')}
          onDrafted={(draft) => { place(draft); setOpening(null); }} onClose={() => setOpening(null)}
        />
      )}
      {opening === 'import' && <ImportDialog onImported={(draft) => { place(draft); setOpening(null); }} onClose={() => setOpening(null)} />}

      {editingBoard && <ArtboardEditor board={editingBoard} canWrite={canWrite} ai={ai} onClose={() => setEditing(null)} />}

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
