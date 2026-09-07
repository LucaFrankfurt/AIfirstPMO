/**
 * A page that is HTML: reading it, and writing it two ways.
 *
 * The markdown editor here is a `<textarea>` on purpose — what is stored and
 * what is on screen are the same characters, so nothing can be lost between
 * them. An HTML page cannot be written that way and be pleasant: nobody drafts
 * a handbook by typing `<strong>`. So this is the other shape, and it comes
 * with the cost that shape has — the document and the screen are two things,
 * and something has to keep them honest.
 *
 * `sanitizeHtml` is that something, and it is the same function the reader is
 * rendered through and the same one the server puts a shared page through.
 * Every route in and out of this component goes past it: what a paste brings,
 * what the browser's own editing commands leave behind, what the source box is
 * handed. A page therefore cannot hold markup that the reader would not be
 * shown — the editor and the renderer cannot disagree, because they are asking
 * the same code the same question.
 *
 * The one thing here that is not ours is `document.execCommand`. It is
 * deprecated, and it is also the only rich-text engine every browser already
 * ships; the alternative is a selection-and-range engine of our own, which is
 * thousands of lines to be worse at typing in three languages, or a dependency
 * — and the server has none, so the client having a large one to write bold
 * text would be an odd place to start. What it produces is normalised on the
 * way out anyway, so the parts of it that are ugly (`<font>`, a stray `<div>`)
 * never reach the page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { escapeHtml, formatHtml, sanitizeHtml } from '@kolibri/shared';

import { useInAppLinks, useUploads } from './Markdown';
import { HEADING_PREFIX } from './page-links';
import { cn } from '../../kernel/design-system/cn';
import { buttonVariants } from '../../kernel/design-system/ui/button';
import { Input, Textarea } from '../../kernel/design-system/ui/field';
import { Icon, useLightbox } from '../../kernel/design-system/ui';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';

/* ---------------------------------------------------------------- reading */

/**
 * An HTML page, as a reader sees it.
 *
 * The same `.md` class the markdown renderer's output wears, and that is a
 * decision rather than a saving: a wiki where an imported page is set in a
 * different typeface from the one beside it looks like two products. What the
 * page may bring of its own is an alignment and a code block's language —
 * everything else about how it looks is the app's.
 */
export function HtmlView({ source, className = '', asPage }: {
  source?: string | null;
  className?: string;
  /** Headings get ids to link to, the way `Markdown` gives them on a page. */
  asPage?: boolean;
}) {
  const html = useMemo(
    () => sanitizeHtml(source ?? '', asPage ? { headingPrefix: HEADING_PREFIX, idPrefix: 'u-' } : {}),
    [source, asPage],
  );
  // Memoised for the reason `Markdown` memoises it: a fresh object makes React
  // rewrite `innerHTML` unconditionally, which throws away the reader's
  // selection — and the selection is what the comment bubble is offering on.
  const inner = useMemo(() => ({ __html: html }), [html]);
  const { open, lightbox } = useLightbox();
  const follow = useInAppLinks();

  if (!source?.trim()) return null;
  return (
    <>
      <div
        className={`md ${className}`}
        onClick={(event) => {
          open(event);
          follow(event);
        }}
        dangerouslySetInnerHTML={inner}
      />
      {lightbox}
    </>
  );
}

/* ---------------------------------------------------------------- writing */

/** One button on the visual toolbar: a command, and what it is called. */
interface Tool {
  id: string;
  title: TranslationKey;
  icon: string;
  command: string;
  argument?: string;
}

const TOOLS: Tool[] = [
  { id: 'bold', title: 'editor.bold', icon: 'B', command: 'bold' },
  { id: 'italic', title: 'editor.italic', icon: 'I', command: 'italic' },
  { id: 'strike', title: 'editor.strike', icon: 'S', command: 'strikeThrough' },
  { id: 'h2', title: 'editor.cmdHeading', icon: 'H', command: 'formatBlock', argument: 'h2' },
  { id: 'h3', title: 'editor.cmdSubheading', icon: 'h', command: 'formatBlock', argument: 'h3' },
  { id: 'p', title: 'editor.cmdParagraph', icon: '¶', command: 'formatBlock', argument: 'p' },
  { id: 'ul', title: 'editor.bulletList', icon: '•', command: 'insertUnorderedList' },
  { id: 'ol', title: 'editor.cmdNumbered', icon: '1.', command: 'insertOrderedList' },
  { id: 'quote', title: 'editor.quote', icon: '❝', command: 'formatBlock', argument: 'blockquote' },
  { id: 'code', title: 'editor.cmdCode', icon: '</>', command: 'formatBlock', argument: 'pre' },
  { id: 'hr', title: 'editor.cmdDivider', icon: '—', command: 'insertHorizontalRule' },
  { id: 'clear', title: 'editor.clearFormatting', icon: '⌫', command: 'removeFormat' },
];

const TABLE = '<table><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p>&nbsp;</p>';

export function HtmlEditor({ value, onChange, minHeight = 420, attachTo }: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: number;
  attachTo?: { task_id?: string; page_id?: string };
}) {
  const t = useT();
  const [source, setSource] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const { busy, take } = useUploads(attachTo);
  /** Where a link is being typed, and the selection it will be applied to. */
  const [link, setLink] = useState<{ url: string; range: Range | null } | null>(null);

  /**
   * What the editable element is currently showing.
   *
   * The whole reason a rich-text surface is awkward in React: the DOM under
   * this component is written by the browser, not by a render, so the component
   * must not put `value` back into it on every keystroke — that is the update
   * that moves the caret to the end of the document while somebody is typing in
   * the middle of it. So the element is written only when `value` arrives
   * saying something the element is not already saying, which is what happens
   * when a colleague's edit is merged in over sync, when history is restored,
   * or when the source view hands back something it changed.
   */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || source) return;
    if (shown.current === value) return;
    shown.current = value;
    element.innerHTML = sanitizeHtml(value);
  }, [value, source]);

  useEffect(() => {
    // `<p>` rather than `<div>` for a new paragraph, and tags rather than
    // inline styles for bold. Both are asked for once; both are ignored by
    // browsers that already do the right thing, and neither throws where the
    // command is unknown.
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, 'false');
    } catch {
      /* An old browser keeps its own defaults; the output is normalised anyway. */
    }
  }, []);

  /** Read the element back, through the allowlist, and report it. */
  const capture = (): void => {
    const element = host.current;
    if (!element) return;
    const next = sanitizeHtml(element.innerHTML);
    // Recorded as what the element is showing *before* the change goes out, so
    // the effect above does not answer our own edit by rewriting the DOM.
    shown.current = next;
    onChange(next);
  };

  const run = (command: string, argument?: string): void => {
    host.current?.focus();
    try {
      document.execCommand(command, false, argument);
    } catch {
      /* Nothing to do: an unsupported command leaves the document alone. */
    }
    capture();
  };

  /** Put markup in at the caret — for a table, an image, a pasted document. */
  const put = (html: string): void => {
    host.current?.focus();
    try {
      document.execCommand('insertHTML', false, html);
    } catch {
      /* As above. */
    }
    capture();
  };

  const insertImages = async (files: File[]): Promise<void> => {
    const done = await take(files);
    if (done.length) put(done.map((one) => (one.image ? `<p><img src="${one.url}" alt=""></p>` : `<p><a href="${one.url}">${one.name}</a></p>`)).join(''));
  };

  /**
   * The link bar.
   *
   * A `window.prompt` would be four lines instead of thirty and is the reason
   * this is written out: a native dialog steals the selection on the way up in
   * some browsers, and the selection is the thing the link is being made of.
   * The range is taken before the bar opens and put back before the command
   * runs, so what gets linked is what was highlighted.
   */
  const openLink = (): void => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    setLink({ url: '', range });
  };

  const applyLink = (): void => {
    if (!link) return;
    const url = link.url.trim();
    setLink(null);
    if (!url) return;
    host.current?.focus();
    if (link.range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(link.range);
    }
    // A link with nothing selected has nothing to be called, so it is written
    // out as its own address — which is what a reader would have to see anyway.
    if (link.range?.collapsed) put(`<a href="${url}">${url}</a>`);
    else run('createLink', url);
  };

  const button = (key: string, title: TranslationKey, icon: React.ReactNode, onClick: () => void, active = false) => (
    <button
      key={key} type="button" title={t(title)} aria-label={t(title)}
      className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), active && 'bg-active text-fg')}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <div className="editor">
      <div className="editor-toolbar">
        {!source && (
          <>
            {TOOLS.map((tool) => button(tool.id, tool.title, tool.icon, () => run(tool.command, tool.argument)))}
            {button('link', 'editor.link', <Icon name="link" size={14} />, openLink)}
            {button('table', 'editor.cmdTable', '▦', () => put(TABLE))}
            <label className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'cursor-pointer')} title={t('editor.attachImage')}>
              <Icon name="image" size={14} />
              <input
                type="file" hidden multiple accept="image/*,application/pdf"
                onChange={(event) => {
                  void insertImages([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
            </label>
          </>
        )}
        {source && button('tidy', 'editor.tidy', <Icon name="sparkle" size={14} />, () => onChange(formatHtml(value)))}
        <span className="flex-1 min-w-0" />
        {busy && <span className="text-muted text-[12.5px]">{t('editor.uploading')}</span>}
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), source && 'bg-active text-fg')}
          aria-pressed={source}
          onClick={() => {
            // The element is thrown away and rebuilt on the way back, so what
            // it was showing is no longer true of anything.
            shown.current = null;
            setSource(!source);
          }}
        >
          {source ? t('editor.visual') : t('editor.source')}
        </button>
      </div>

      {link && (
        <div className="editor-linkbar">
          <Input
            autoFocus value={link.url} placeholder="https://…" aria-label={t('editor.link')}
            onChange={(event) => setLink({ ...link, url: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
              }
              if (event.key === 'Escape') setLink(null);
            }}
          />
          <button type="button" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }))} onClick={applyLink}>
            {t('action.apply')}
          </button>
          <button type="button" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))} onClick={() => setLink(null)}>
            {t('action.cancel')}
          </button>
        </div>
      )}

      {source ? (
        <Textarea
          className="mono"
          style={{ minHeight }}
          value={value}
          spellCheck={false}
          placeholder={t('editor.htmlPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div
          ref={host}
          className="md editor-visual"
          style={{ minHeight }}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t('editor.visual')}
          data-placeholder={t('editor.placeholderHtml')}
          onInput={capture}
          onBlur={capture}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              void insertImages(files);
              return;
            }
            /*
             * The one place dirt gets in, so it is cleaned here rather than
             * afterwards. Left alone, the browser drops whatever a word
             * processor put on the clipboard straight into the document —
             * `mso-` styles, class names that reach the app's own stylesheet,
             * a `<script>` in the case that matters — and the next `capture`
             * would strip it while the reader watched their paste rearrange
             * itself. Cleaned on the way in, what lands is what stays.
             */
            const html = event.clipboardData.getData('text/html');
            event.preventDefault();
            if (html) put(sanitizeHtml(html));
            else put(escapeForPaste(event.clipboardData.getData('text/plain')));
          }}
        />
      )}
      <p className="text-[12px] text-muted mt-1.5">{source ? t('editor.htmlHint') : t('editor.visualHint')}</p>
    </div>
  );
}

/**
 * Plain text, as paragraphs.
 *
 * `insertHTML` with unescaped text would read `<b>` in somebody's notes as
 * markup — and pasting text into a rich-text box is the one moment where a
 * reader is certain they are pasting *text*.
 */
const escapeForPaste = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
