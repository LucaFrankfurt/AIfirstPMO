/**
 * One board, open for editing.
 *
 * Two ways to change it, over one text. **Design** is the board as it looks:
 * click to select, double-click to type where the words are, drag the grip to
 * move a thing, and an inspector beside it for the look of whatever is
 * selected. **Source** is the same board as HTML, typed. Both write the board's
 * source and nothing else — every design edit is a rewrite of the source
 * (`artboard.ts` in shared) handed to the same collaborative text a keystroke
 * goes through — so two people, one in each tab, are editing one document.
 *
 * Undo is this editor's, kept for as long as it is open: a step back to the
 * text before the last design edit, sent as an edit like any other. A board
 * has no saved history yet the way a page does; see `TODO.md`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { artboard, makeAnchor, type Artboard, type ElementInfo } from '@kolibri/shared';
import { comment, update } from '../../kernel/sync/mutations';
import { useMe, useMemberMap } from '../../kernel/identity/session';
import { api } from '../../kernel/sync/api';
import { pull } from '../../kernel/sync/sync';
import { shortDate } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Dialog, DialogContent, DialogTitle } from '../../kernel/design-system/ui/dialog';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select, Textarea } from '../../kernel/design-system/ui/field';
import { Avatar, Icon, useConfirm, useToast } from '../../kernel/design-system/ui';
import { cn } from '../../kernel/design-system/cn';
import { useCollaborativeText, type CollabTarget } from './collab';
import { ArtboardFrame, type BoardMessage } from './ArtboardFrame';
import { restoreFiles } from './board-files';
import { DraftDialog, useAiLabels, type CanvasAi } from './canvas-dialogs';
import { useUploads } from '../../kernel/files/uploads';
import { BLOCK_KINDS, block, type BlockKind, type Words } from './blocks';

export const BOARD_BODY: CollabTarget = { entity: 'artboard', state: 'body', text: 'content' };

/** How long the source rests before the preview is redrawn from it. */
const PREVIEW_MS = 300;

/** The properties the inspector offers, in the order a person reaches for them. */
const STYLE_FIELDS: { property: string; label: TranslationKey; kind: 'color' | 'text' | 'select'; options?: string[] }[] = [
  { property: 'color', label: 'canvas.style.color', kind: 'color' },
  { property: 'background', label: 'canvas.style.background', kind: 'color' },
  { property: 'font-size', label: 'canvas.style.fontSize', kind: 'text' },
  { property: 'font-weight', label: 'canvas.style.fontWeight', kind: 'select', options: ['', '400', '500', '600', '700', '800'] },
  { property: 'text-align', label: 'canvas.style.align', kind: 'select', options: ['', 'left', 'center', 'right'] },
  { property: 'padding', label: 'canvas.style.padding', kind: 'text' },
  { property: 'margin', label: 'canvas.style.margin', kind: 'text' },
  { property: 'gap', label: 'canvas.style.gap', kind: 'text' },
  { property: 'border', label: 'canvas.style.border', kind: 'text' },
  { property: 'border-radius', label: 'canvas.style.radius', kind: 'text' },
  { property: 'width', label: 'canvas.style.width', kind: 'text' },
];

const BLOCK_LABEL: Record<BlockKind, TranslationKey> = {
  heading: 'canvas.block.heading', text: 'canvas.block.text', box: 'canvas.block.box', columns: 'canvas.block.columns',
  table: 'canvas.block.table', list: 'canvas.block.list', button: 'canvas.block.button', divider: 'canvas.block.divider',
  callout: 'canvas.block.callout',
};

export function useWords(): Words {
  const t = useT();
  return useMemo(() => ({
    title: t('canvas.word.title'), heading: t('canvas.word.heading'), text: t('canvas.word.text'),
    item: t('canvas.word.item'), button: t('canvas.word.button'), column: t('canvas.word.column'),
    metric: t('canvas.word.metric'),
  }), [t]);
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** A colour as `<input type="color">` can show it, or black when it is not a plain hex. */
const asHex = (value: string | undefined): string => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? '').trim());
  if (!hex) return '#000000';
  const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
  return `#${digits.toLowerCase()}`;
};

/** A text field that commits on Enter and on leaving it, not on every key. */
function Committed({ value, onCommit, label, multiline }: {
  value: string; onCommit: (next: string) => void; label: string; multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return multiline ? (
    <Textarea
      aria-label={label} value={draft} rows={3}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit(); }}
    />
  ) : (
    <Input
      aria-label={label} value={draft} inputSize="sm"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
    />
  );
}

/**
 * Propose new words for an element instead of writing them.
 *
 * The suggestion is a comment pinned where the element is, carrying the
 * element's source as its passage — so whoever accepts it gets exactly this
 * span replaced, found again by its quote even if the board has moved on
 * around it, and refused if the span itself has changed.
 */
function SuggestChange({ text, onSuggest }: { text: string; onSuggest: (replacement: string, note: string) => void }) {
  const t = useT();
  const [replacement, setReplacement] = useState(text);
  const [note, setNote] = useState('');
  useEffect(() => setReplacement(text), [text]);
  return (
    <section className="artboard-section">
      <h3>{t('suggest.title')}</h3>
      <Textarea aria-label={t('suggest.replaceWith')} rows={3} value={replacement} onChange={(event) => setReplacement(event.target.value)} />
      <Input
        aria-label={t('suggest.why')} placeholder={t('suggest.why')} inputSize="sm" className="mt-1.5"
        value={note} onChange={(event) => setNote(event.target.value)}
      />
      <Button
        size="sm" variant="secondary" className="mt-1.5" disabled={replacement === text}
        onClick={() => { onSuggest(replacement, note.trim()); setNote(''); }}
      >
        <Icon name="pencil" size={13} /> {t('suggest.send')}
      </Button>
    </section>
  );
}

function Inspector({ info, onStyle, onText, onAttribute, onSelect, act, cell, onSuggest, onReplaceImage }: {
  info: ElementInfo;
  onSuggest: (replacement: string, note: string) => void;
  onReplaceImage: () => void;
  onStyle: (property: string, value: string) => void;
  onText: (text: string) => void;
  onAttribute: (name: string, value: string | null) => void;
  onSelect: (k: number) => void;
  act: (action: 'up' | 'down' | 'duplicate' | 'delete') => void;
  cell: (action: 'rowAbove' | 'rowBelow' | 'columnLeft' | 'columnRight' | 'removeRow' | 'removeColumn') => void;
}) {
  const t = useT();
  return (
    <>
      <nav className="artboard-path" aria-label={t('canvas.path')}>
        {info.path.map((step, at) => (
          <button
            key={step.k} type="button"
            className={cn('artboard-crumb', step.k === info.k && 'is-current')}
            onClick={() => onSelect(step.k)}
          >
            {at > 0 && <span aria-hidden="true">›</span>} {step.tag}
          </button>
        ))}
      </nav>
      <div className="artboard-actions">
        <Button size="sm" variant="ghost" onClick={() => act('up')} aria-label={t('canvas.moveUp')} title={t('canvas.moveUp')}><Icon name="chevronUp" size={14} /></Button>
        <Button size="sm" variant="ghost" onClick={() => act('down')} aria-label={t('canvas.moveDown')} title={t('canvas.moveDown')}><Icon name="chevronDown" size={14} /></Button>
        <Button size="sm" variant="ghost" onClick={() => act('duplicate')} aria-label={t('canvas.duplicate')} title={t('canvas.duplicate')}><Icon name="copy" size={14} /></Button>
        <Button size="sm" variant="ghost" onClick={() => act('delete')} aria-label={t('canvas.deleteElement')} title={t('canvas.deleteElement')}><Icon name="trash" size={14} /></Button>
      </div>
      {info.cell && (
        <section className="artboard-section">
          <h3>{t('canvas.table')}</h3>
          <div className="artboard-grid2">
            <Button size="sm" onClick={() => cell('rowAbove')}>{t('canvas.rowAbove')}</Button>
            <Button size="sm" onClick={() => cell('rowBelow')}>{t('canvas.rowBelow')}</Button>
            <Button size="sm" onClick={() => cell('columnLeft')}>{t('canvas.columnLeft')}</Button>
            <Button size="sm" onClick={() => cell('columnRight')}>{t('canvas.columnRight')}</Button>
            <Button size="sm" variant="ghost" onClick={() => cell('removeRow')}>{t('canvas.removeRow')}</Button>
            <Button size="sm" variant="ghost" onClick={() => cell('removeColumn')}>{t('canvas.removeColumn')}</Button>
          </div>
        </section>
      )}
      {info.text !== null && (
        <section className="artboard-section">
          <h3>{t('canvas.text')}</h3>
          <Committed value={info.text} onCommit={onText} label={t('canvas.text')} multiline />
        </section>
      )}
      {info.text !== null && <SuggestChange text={info.text} onSuggest={onSuggest} />}
      {info.tag === 'img' && (
        <section className="artboard-section">
          <h3>{t('canvas.image')}</h3>
          <Button size="sm" variant="secondary" onClick={onReplaceImage}>
            <Icon name="image" size={13} /> {t('canvas.imageReplace')}
          </Button>
          <label className="artboard-field mt-1.5">
            <span>{t('canvas.imageAlt')}</span>
            <Committed value={info.attrs.alt ?? ''} onCommit={(alt) => onAttribute('alt', alt)} label={t('canvas.imageAlt')} />
          </label>
        </section>
      )}
      {info.tag === 'a' && (
        <section className="artboard-section">
          <h3>{t('canvas.link')}</h3>
          <Committed value={info.attrs.href ?? ''} onCommit={(href) => onAttribute('href', href || null)} label={t('canvas.link')} />
        </section>
      )}
      <section className="artboard-section">
        <h3>{t('canvas.style')}</h3>
        {STYLE_FIELDS.map((field) => (
          <label key={field.property} className="artboard-field">
            <span>{t(field.label)}</span>
            {field.kind === 'select' ? (
              <Select
                inputSize="sm" value={info.style[field.property] ?? ''}
                onChange={(event) => onStyle(field.property, event.target.value)}
              >
                {field.options!.map((option) => <option key={option} value={option}>{option || '—'}</option>)}
              </Select>
            ) : field.kind === 'color' ? (
              <span className="flex items-center gap-1.5">
                <input
                  type="color" className="artboard-swatch" aria-label={t(field.label)}
                  value={asHex(info.style[field.property])}
                  onChange={(event) => onStyle(field.property, event.target.value)}
                />
                <Committed value={info.style[field.property] ?? ''} onCommit={(value) => onStyle(field.property, value)} label={t(field.label)} />
              </span>
            ) : (
              <Committed value={info.style[field.property] ?? ''} onCommit={(value) => onStyle(field.property, value)} label={t(field.label)} />
            )}
          </label>
        ))}
      </section>
    </>
  );
}

/** One saved state of a board, as the history lists it. */
interface BoardVersion { id: string; title: string; author_id: string | null; created_at: number; size: number }

/**
 * What the board said before each sitting, and the way back to it.
 *
 * Listed from the server — a board's history is never mirrored — and shown by
 * drawing the old source in the stage itself, so a version is judged by how it
 * looks rather than by its HTML. Restoring is a write like any other, so the
 * board as it was a moment ago becomes a version too and the restore can be
 * undone the same way.
 */
function BoardHistory({ board, previewing, onPreview, onRestored }: {
  board: Artboard;
  previewing: string | null;
  onPreview: (version: { id: string; content: string } | null) => void;
  onRestored: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [versions, setVersions] = useState<BoardVersion[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.boardVersions(board.id)
      .then((rows) => { if (live) setVersions(rows as BoardVersion[]); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [board.id, board.updated_at]);

  const preview = async (id: string) => {
    if (previewing === id) return onPreview(null);
    try {
      const version = await api.boardVersion(board.id, id);
      onPreview({ id, content: String(version.content ?? '') });
    } catch {
      toast(t('page.historyFailed'));
    }
  };

  const restore = async (id: string) => {
    if (!(await confirm(t('canvas.restoreConfirm'), t('action.restore')))) return;
    await api.restoreBoardVersion(board.id, id);
    await pull();
    onPreview(null);
    onRestored();
    toast(t('page.restored'));
  };

  return (
    <section className="artboard-section">
      <h3>{t('canvas.history')}</h3>
      {failed && <p className="text-[12px] text-danger">{t('page.historyFailed')}</p>}
      {versions === null && !failed && <p className="text-muted text-[12.5px]">{t('common.loading')}</p>}
      {versions !== null && versions.length === 0 && <p className="text-muted text-[12.5px]">{t('canvas.noVersions')}</p>}
      {(versions ?? []).map((version) => (
        <div key={version.id} className={cn('artboard-version', previewing === version.id && 'is-current')}>
          <Avatar user={version.author_id ? members.get(version.author_id) : undefined} size={18} />
          <button type="button" className="artboard-version-name" aria-pressed={previewing === version.id} onClick={() => { void preview(version.id); }}>
            <span>{shortDate(version.created_at)}</span>
            <span className="text-muted">{(version.author_id && members.get(version.author_id)?.name) || t('common.someone')}</span>
          </button>
          <Button size="sm" variant="ghost" onClick={() => { void restore(version.id); }}>{t('action.restore')}</Button>
        </div>
      ))}
      {dialog}
    </section>
  );
}

export function ArtboardEditor({ board, canWrite, ai = null, onClose }: {
  board: Artboard;
  canWrite: boolean;
  /** Claude, when this server has a model and the workspace has it on. */
  ai?: CanvasAi | null;
  onClose: () => void;
}) {
  const t = useT();
  const aiLabels = useAiLabels(ai);
  const toast = useToast();
  const words = useWords();
  const { text, setText, rewrite, flush, fieldRef, merged } = useCollaborativeText(
    board.id, board.body, board.content ?? '', canWrite, BOARD_BODY,
  );
  const [tab, setTab] = useState<'design' | 'source'>('design');
  const [playing, setPlaying] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [asking, setAsking] = useState(false);
  /** An old version drawn in the stage instead of the board, while the history is open. */
  const [previewing, setPreviewing] = useState<{ id: string; content: string } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /** Where the selected element starts on the board, for a pin left on it. */
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const me = useMe();
  const [title, setTitle] = useState(board.title);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const [, bump] = useState(0);

  // The preview follows the source, but not on every key — each redraw
  // reruns the board's scripts.
  const [preview, setPreview] = useState(text);
  useEffect(() => {
    if (tab === 'design') return setPreview(text);
    const timer = setTimeout(() => setPreview(text), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [text, tab]);

  useEffect(() => () => flush(), [flush]);
  useEffect(() => setTitle(board.title), [board.title]);

  /** One design edit: remember where it came from, then write it. */
  const apply = useCallback((next: string) => {
    if (!canWrite || next === text) return;
    undo.current.push(text);
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    rewrite(next);
    bump((n) => n + 1);
  }, [canWrite, rewrite, text]);

  /** Run a source rewrite, and say so rather than throw if its element is gone. */
  const attempt = useCallback((edit: () => void) => {
    try {
      edit();
    } catch {
      setSelected(null);
      toast(t('canvas.elementGone'));
    }
  }, [t, toast]);

  const step = useCallback((from: string[], to: string[]) => {
    const previous = from.pop();
    if (previous === undefined) return;
    to.push(text);
    rewrite(previous);
    setSelected(null);
    bump((n) => n + 1);
  }, [rewrite, text]);

  const info = useMemo(() => (selected === null ? null : artboard.describe(text, selected)), [selected, text]);

  const act = (action: 'up' | 'down' | 'duplicate' | 'delete') => attempt(() => {
    if (selected === null) return;
    if (action === 'delete') {
      apply(artboard.remove(text, selected));
      setSelected(null);
    } else if (action === 'duplicate') {
      const done = artboard.duplicate(text, selected);
      apply(done.source);
      setSelected(done.k);
    } else {
      const neighbour = artboard.sibling(text, selected, action === 'up' ? -1 : 1);
      if (neighbour === null) return;
      const done = artboard.move(text, selected, neighbour, action === 'up' ? 'before' : 'after');
      apply(done.source);
      setSelected(done.k);
    }
  });

  const cell = (action: 'rowAbove' | 'rowBelow' | 'columnLeft' | 'columnRight' | 'removeRow' | 'removeColumn') => attempt(() => {
    if (selected === null) return;
    const next = {
      rowAbove: () => artboard.addRow(text, selected, 'above'),
      rowBelow: () => artboard.addRow(text, selected, 'below'),
      columnLeft: () => artboard.addColumn(text, selected, 'left'),
      columnRight: () => artboard.addColumn(text, selected, 'right'),
      removeRow: () => artboard.removeRow(text, selected),
      removeColumn: () => artboard.removeColumn(text, selected),
    }[action]();
    apply(next);
    // Rows and columns shift the numbering; the cell that was selected is
    // somewhere else now, and selecting whatever took its number would be wrong.
    setSelected(null);
  });

  /*
   * Pictures. Uploaded like any other file, hung on the canvas page so they
   * follow its visibility, and written into the board by their `/files/…`
   * path — `board-files.ts` hands the frame the bytes.
   */
  const uploads = useUploads({ kind: 'page', id: board.page_id });
  const picker = useRef<HTMLInputElement>(null);
  const picking = useRef<'insert' | 'replace'>('insert');
  const pick = (mode: 'insert' | 'replace') => {
    picking.current = mode;
    picker.current?.click();
  };
  const picked = async (files: File[]) => {
    const done = (await uploads.take(files)).filter((one) => one.image);
    if (!done.length) return;
    attempt(() => {
      if (picking.current === 'replace' && selected !== null) {
        apply(artboard.setAttribute(text, selected, 'src', done[0].url));
        return;
      }
      let next = text;
      let at = selected;
      for (const image of done) {
        const html = `<img src="${image.url}" alt="${escapeAttribute(image.name)}" style="display: block; max-width: 100%; height: auto; border-radius: 8px">`;
        const placed = at !== null ? artboard.insert(next, at, 'after', html) : artboard.append(next, html);
        next = placed.source;
        at = placed.k;
      }
      apply(next);
      setSelected(at);
    });
  };

  const add = (kind: BlockKind) => attempt(() => {
    const html = block(kind, words);
    const done = selected !== null ? artboard.insert(text, selected, 'after', html) : artboard.append(text, html);
    apply(done.source);
    setSelected(done.k);
  });

  const heard = (message: BoardMessage) => {
    if (message.type === 'kolibri:select') {
      setSelected(message.k);
      setSpot(message.x !== undefined && message.y !== undefined ? { x: message.x, y: message.y } : null);
    }
    if (message.type === 'kolibri:key' && message.key === 'escape' && (!canWrite || playing)) {
      onClose();
      return;
    }
    if (!canWrite) return;
    if (message.type === 'kolibri:inner') attempt(() => apply(artboard.setInner(text, message.k, restoreFiles(message.html))));
    if (message.type === 'kolibri:move') {
      attempt(() => {
        const done = artboard.move(text, message.k, message.target, message.where);
        apply(done.source);
        setSelected(done.k);
      });
    }
    if (message.type === 'kolibri:key') {
      if (message.key === 'delete') act('delete');
      if (message.key === 'duplicate') act('duplicate');
      // Escape steps out of a selection first, and out of the editor after.
      if (message.key === 'escape') {
        if (selected === null) { flush(); commitTitle(); onClose(); } else setSelected(null);
      }
      if (message.key === 'undo') step(undo.current, redo.current);
      if (message.key === 'redo') step(redo.current, undo.current);
    }
  };

  const commitTitle = () => {
    const next = title.trim();
    if (next !== board.title) update('artboard', board.id, { title: next });
  };

  // The board's frame, drawn at its own width and scaled down to fit the stage.
  // Watched through a callback ref, not a ref read in an effect: the dialog
  // mounts its content a render after this component, so an effect that ran
  // once on mount found nothing to watch and the board was drawn at full size.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const scale = room.width ? Math.min(1, room.width / board.w) : 1;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) { flush(); commitTitle(); onClose(); } }}>
      <DialogContent full closeLabel={t('action.close')} className="artboard-editor" aria-describedby={undefined}>
        <header className="artboard-bar">
          <DialogTitle className="sr-only">{t('canvas.editing', { title: board.title || t('common.untitled') })}</DialogTitle>
          <Input
            className="artboard-title" inputSize="sm" value={title} disabled={!canWrite}
            aria-label={t('canvas.boardTitle')} placeholder={t('common.untitled')}
            onChange={(event) => setTitle(event.target.value)} onBlur={commitTitle}
          />
          <div className="artboard-tabs" role="tablist" aria-label={t('canvas.view')}>
            <button type="button" role="tab" aria-selected={tab === 'design'} className={cn('artboard-tab', tab === 'design' && 'is-current')} onClick={() => setTab('design')}>{t('canvas.design')}</button>
            <button type="button" role="tab" aria-selected={tab === 'source'} className={cn('artboard-tab', tab === 'source' && 'is-current')} onClick={() => { flush(); setTab('source'); }}>{t('canvas.source')}</button>
          </div>
          <span className="flex-1" />
          {merged && <span className="text-[12px] text-muted">{t('page.mergedIn')}</span>}
          <Button size="iconSm" variant="ghost" disabled={!undo.current.length} onClick={() => step(undo.current, redo.current)} aria-label={t('canvas.undo')} title={t('canvas.undo')}><Icon name="undo" size={15} /></Button>
          <Button size="iconSm" variant="ghost" disabled={!redo.current.length} onClick={() => step(redo.current, undo.current)} aria-label={t('canvas.redo')} title={t('canvas.redo')}><Icon name="redo" size={15} /></Button>
          {ai && canWrite && (
            <Button size="sm" variant="secondary" onClick={() => { flush(); setAsking(true); }}>
              {/* No `hide-sm`: the editor is a portal outside the `screen` container that rule asks, so it would
                  hide the label at every width and leave a button with no name. The bar scrolls on a phone instead. */}
              <Icon name="sparkle" size={13} /> {aiLabels.ask}
            </Button>
          )}
          <Button
            size="iconSm" variant={showHistory ? 'primary' : 'ghost'} aria-pressed={showHistory}
            onClick={() => { setShowHistory(!showHistory); setPreviewing(null); }}
            aria-label={t('canvas.history')} title={t('canvas.history')}
          >
            <Icon name="refresh" size={15} />
          </Button>
          <Button size="sm" variant={playing ? 'primary' : 'secondary'} onClick={() => setPlaying(!playing)} aria-pressed={playing}>
            <Icon name="play" size={13} /> {t('canvas.play')}
          </Button>
        </header>
        <div className="artboard-body">
          <div className="artboard-stage" ref={setStage}>
            <div className="artboard-sheet" style={{ width: board.w * scale, height: Math.max(room.height - 32, 200) }}>
              <ArtboardFrame
                source={previewing ? previewing.content : tab === 'design' ? text : preview}
                mode={previewing ? 'view' : playing || !canWrite ? 'play' : 'edit'}
                selected={selected}
                keepScroll
                title={board.title || t('common.untitled')}
                onMessage={heard}
                className="artboard-frame"
                style={{ width: board.w, height: Math.max(room.height - 32, 200) / scale, transform: `scale(${scale})` }}
              />
            </div>
          </div>
          {showHistory ? (
            <aside className="artboard-inspector" aria-label={t('canvas.history')}>
              <BoardHistory
                board={board}
                previewing={previewing?.id ?? null}
                onPreview={setPreviewing}
                onRestored={() => { setShowHistory(false); setSelected(null); }}
              />
            </aside>
          ) : tab === 'source' ? (
            <aside className="artboard-source">
              <textarea
                ref={fieldRef}
                className="artboard-code"
                value={text}
                readOnly={!canWrite}
                spellCheck={false}
                aria-label={t('canvas.source')}
                onChange={(event) => setText(event.target.value)}
              />
            </aside>
          ) : (
            <aside className="artboard-inspector" aria-label={t('canvas.inspector')}>
              {canWrite && (
                <section className="artboard-section">
                  <h3>{selected === null ? t('canvas.insert') : t('canvas.insertAfter')}</h3>
                  <div className="artboard-grid2">
                    {BLOCK_KINDS.map((kind) => (
                      <Button key={kind} size="sm" variant="ghost" className="justify-start" onClick={() => add(kind)}>
                        <Icon name="plus" size={13} /> {t(BLOCK_LABEL[kind])}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" className="justify-start" disabled={uploads.busy} onClick={() => pick('insert')}>
                      <Icon name="image" size={13} /> {uploads.busy ? t('canvas.uploading') : t('canvas.block.image')}
                    </Button>
                    <input
                      ref={picker} type="file" accept="image/*" multiple hidden
                      onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void picked(files); }}
                    />
                  </div>
                </section>
              )}
              {info && canWrite ? (
                <Inspector
                  info={info}
                  onSelect={setSelected}
                  onStyle={(property, value) => attempt(() => apply(artboard.setStyle(text, info.k, property, value)))}
                  onText={(next) => attempt(() => apply(artboard.setText(text, info.k, next)))}
                  onAttribute={(name, value) => attempt(() => apply(artboard.setAttribute(text, info.k, name, value)))}
                  act={act}
                  cell={cell}
                  onReplaceImage={() => pick('replace')}
                  onSuggest={(replacement, note) => {
                    const passage = makeAnchor(text, info.inner.start, info.inner.end);
                    if (!passage) return;
                    comment(
                      { page_id: board.page_id }, note, me,
                      { board: board.id, x: spot?.x ?? 24, y: spot?.y ?? 24, ...passage },
                      replacement,
                    );
                    toast(t('suggest.sent'));
                  }}
                />
              ) : (
                <p className="text-muted text-[12.5px] artboard-section">{canWrite ? t('canvas.selectHint') : t('canvas.readOnly')}</p>
              )}
              <section className="artboard-section">
                <h3>{t('canvas.board')}</h3>
                <div className="artboard-grid2">
                  <label className="artboard-field"><span>{t('canvas.width')}</span>
                    <Committed value={String(board.w)} label={t('canvas.width')} onCommit={(value) => canWrite && update('artboard', board.id, { w: Number(value) || board.w })} />
                  </label>
                  <label className="artboard-field"><span>{t('canvas.height')}</span>
                    <Committed value={String(board.h)} label={t('canvas.height')} onCommit={(value) => canWrite && update('artboard', board.id, { h: Number(value) || board.h })} />
                  </label>
                </div>
              </section>
            </aside>
          )}
        </div>
        {asking && ai && (
          <DraftDialog
            ai={ai} pageId={board.page_id} board={{ id: board.id, w: board.w, h: board.h }} hasOthers={false}
            // One edit, through the same CRDT as typing: it merges with anybody
            // else's, keeps a version in the history, and undo takes it back.
            onDrafted={(draft) => { apply(draft.html); setSelected(null); setAsking(false); }}
            onClose={() => setAsking(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
