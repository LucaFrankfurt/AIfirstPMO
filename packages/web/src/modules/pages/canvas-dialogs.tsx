/**
 * The two ways onto a canvas that are not a template: describe a board and
 * have Claude draw it, or bring one that already exists.
 *
 * Both end the same way — a board's HTML and a title, handed back to the
 * canvas, which puts it down as an edit like any other. Neither writes
 * anything itself, so neither needs to know where a board goes or how big the
 * canvas is.
 *
 * Claude is reached through `CanvasAi`, which the page route hands in: the
 * model belongs to the `ai-review` capability, which already leans on pages,
 * and a canvas reaching back for it would tie the two into a loop. When the
 * server has no model or the workspace has it switched off, there is no
 * `CanvasAi`, and nothing here mentions it — the convention the task review
 * set: an instance without the feature looks like an app without the feature.
 */
import { useState } from 'react';
import { htmlTitle, looksLikeHtml } from '@kolibri/shared';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Select, Textarea } from '../../kernel/design-system/ui/field';
import { Icon, Sheet } from '../../kernel/design-system/ui';

/** What a canvas may ask of a model. Filled by `ai-review/board-ai.ts`, through the page route. */
export interface CanvasAi {
  /**
   * What to call the model on a button — "Claude", "Gemini" — or null when
   * the server reaches it through a gateway that could be serving anybody's.
   * A button saying Claude on a server that asks Gemini would be a small lie
   * told on every click.
   */
  name: string | null;
  draft: (pageId: string, request: { instruction: string; board?: string; w?: number; h?: number; match?: boolean })
    => Promise<{ title: string; html: string; model: string }>;
}

/** The two things a canvas offers, named after the model that will answer. */
export function useAiLabels(ai: CanvasAi | null | undefined): { describe: string; ask: string } {
  const t = useT();
  const name = ai?.name;
  return {
    describe: name ? t('canvas.describe', { name }) : t('canvas.describeModel'),
    ask: name ? t('canvas.ask', { name }) : t('canvas.askModel'),
  };
}

/** A board's frame, offered by what it is for rather than by its pixels. */
export const FORMATS: { id: string; label: TranslationKey; w: number; h: number }[] = [
  { id: 'page', label: 'canvas.format.page', w: 1280, h: 800 },
  { id: 'wide', label: 'canvas.format.wide', w: 1440, h: 900 },
  { id: 'slide', label: 'canvas.format.slide', w: 1280, h: 720 },
  { id: 'phone', label: 'canvas.format.phone', w: 390, h: 844 },
];

export interface Drafted {
  title: string;
  html: string;
  w: number;
  h: number;
}

function FormatPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <label className="canvas-dialog-field">
      <span>{t('canvas.format')}</span>
      <Select inputSize="sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {FORMATS.map((format) => (
          <option key={format.id} value={format.id}>{t(format.label)} · {format.w} × {format.h}</option>
        ))}
      </Select>
    </label>
  );
}

/**
 * Describe a board, or what to change about one, and wait for Claude.
 *
 * With `board`, it is a redraw: the board's size stays, there is nothing to
 * match, and the answer replaces the board's source in the editor — as one
 * edit, which the editor's undo takes back.
 */
export function DraftDialog({ ai, pageId, board, hasOthers, onDrafted, onClose }: {
  ai: CanvasAi;
  pageId: string;
  /** The board to redraw, when this is not a new one. */
  board?: { id: string; w: number; h: number };
  hasOthers: boolean;
  onDrafted: (draft: Drafted) => void;
  onClose: () => void;
}) {
  const t = useT();
  const labels = useAiLabels(ai);
  const [instruction, setInstruction] = useState('');
  const [format, setFormat] = useState('page');
  const [match, setMatch] = useState(true);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const draw = async () => {
    const size = board ?? FORMATS.find((one) => one.id === format) ?? FORMATS[0];
    setWorking(true);
    setProblem(null);
    try {
      const draft = await ai.draft(pageId, {
        instruction: instruction.trim(), board: board?.id, w: size.w, h: size.h, match: !board && hasOthers && match,
      });
      onDrafted({ title: draft.title, html: draft.html, w: size.w, h: size.h });
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : t('canvas.draftFailed'));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Sheet
      title={board ? labels.ask : labels.describe}
      onClose={() => { if (!working) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={working} onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={working || !instruction.trim()} onClick={() => { void draw(); }}>
            <Icon name="sparkle" size={14} /> {working ? t('canvas.drawing') : board ? t('canvas.change') : t('canvas.draw')}
          </Button>
        </>
      )}
    >
      <label className="canvas-dialog-field">
        <span>{board ? t('canvas.whatToChange') : t('canvas.whatToDraw')}</span>
        <Textarea
          autoFocus rows={5} value={instruction} disabled={working}
          placeholder={board ? t('canvas.changePlaceholder') : t('canvas.drawPlaceholder')}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && instruction.trim()) void draw(); }}
        />
      </label>
      {!board && <FormatPicker value={format} onChange={setFormat} />}
      {!board && hasOthers && (
        <label className="canvas-dialog-check">
          <input type="checkbox" checked={match} onChange={(event) => setMatch(event.target.checked)} disabled={working} />
          <span>{t('canvas.matchLook')}</span>
        </label>
      )}
      <p className="text-muted text-[12.5px] mt-2">{working ? t('canvas.drawingHint') : t('canvas.draftPrivacy')}</p>
      {problem && <p className="text-danger text-[12.5px] mt-1.5" role="alert">{problem}</p>}
    </Sheet>
  );
}

/**
 * Bring a board that already exists: an HTML file — an artifact downloaded
 * from Claude, a page saved from a browser — or HTML pasted in.
 *
 * Kept exactly as it came. A board is drawn in a sandbox and the source is the
 * document, so there is nothing to clean and nothing to convert; what does not
 * work in a board (a CDN script, a web font) is said on the canvas page itself,
 * not stripped here behind the person's back.
 */
export function ImportDialog({ onImported, onClose }: { onImported: (draft: Drafted) => void; onClose: () => void }) {
  const t = useT();
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState('page');
  const [problem, setProblem] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setSource(await file.text());
    setName(file.name.replace(/\.html?$/i, ''));
    setProblem(null);
  };

  const done = () => {
    const html = source.trim();
    if (!looksLikeHtml(html)) {
      setProblem(t('canvas.importNotHtml'));
      return;
    }
    const size = FORMATS.find((one) => one.id === format) ?? FORMATS[0];
    onImported({ title: htmlTitle(html)?.trim() || name || t('canvas.imported'), html, w: size.w, h: size.h });
  };

  return (
    <Sheet
      title={t('canvas.importTitle')}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!source.trim()} onClick={done}>{t('canvas.importAction')}</Button>
        </>
      )}
    >
      <label className="canvas-dialog-field">
        <span>{t('canvas.importFile')}</span>
        <input type="file" accept=".html,.htm,text/html" onChange={(event) => { void read(event.target.files?.[0]); }} />
      </label>
      <label className="canvas-dialog-field">
        <span>{t('canvas.importPaste')}</span>
        <Textarea
          rows={6} value={source} spellCheck={false} className="canvas-dialog-code"
          placeholder="<!doctype html>…" onChange={(event) => { setSource(event.target.value); setProblem(null); }}
        />
      </label>
      <FormatPicker value={format} onChange={setFormat} />
      <p className="text-muted text-[12.5px] mt-2">{t('canvas.importHint')}</p>
      {problem && <p className="text-danger text-[12.5px] mt-1.5" role="alert">{problem}</p>}
    </Sheet>
  );
}
