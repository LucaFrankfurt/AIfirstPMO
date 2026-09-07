/**
 * Bringing documents in.
 *
 * The wiki could always be got *out* — a markdown bundle, one click — and there
 * was no way in except to paste, one page at a time. That asymmetry is the
 * thing people notice when they are deciding whether to move: a tool you can
 * only leave slowly is a tool nobody moves into quickly.
 *
 * So: drop files, see exactly what will be created, and say yes. Three
 * decisions and no wizard, because the questions an import raises here are only
 * three deep — what language the result should be in, whether one long document
 * should become one page or many, and where it all lands.
 *
 * Everything is worked out in the browser from the file's own text: the same
 * `htmlToMarkdown` a paste uses, the same `splitByHeadings` that knows not to
 * cut a runbook in half at a shell comment. Nothing is uploaded to be parsed —
 * which means the preview and the result are computed by the same code, and
 * cannot disagree.
 */
import { useMemo, useState } from 'react';
import { htmlTitle, htmlToMarkdown, looksLikeHtml, outlineOf, splitByHeadings, type PageFormat } from '@kolibri/shared';

import { createPage } from '../../kernel/sync/mutations';
import { useMe } from '../../kernel/identity/session';
import { useT } from '../../kernel/i18n/i18n';
import { cn } from '../../kernel/design-system/cn';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon, Sheet, useToast } from '../../kernel/design-system/ui';
import { buttonVariants } from '../../kernel/design-system/ui/button';

/** What the extension says, before anything looks inside the file. */
const HTML_NAME = /\.(html?|xhtml)$/i;
const TEXT_NAME = /\.(md|markdown|mdown|txt|text|html?|xhtml)$/i;

/** A file that has been read, before any decision has been applied to it. */
interface Loaded {
  key: string;
  name: string;
  text: string;
  html: boolean;
}

/** A page that would be created. What the list shows is exactly this. */
interface Draft {
  title: string;
  content: string;
  format: PageFormat;
}

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';

/** The first `# heading`, which is what a markdown export calls its document. */
const markdownTitle = (source: string): string | null =>
  outlineOf(source).find((heading) => heading.level === 1)?.text ?? null;

export function ImportPages({ parentId, projectId, onClose }: {
  /** Where the new pages land in the tree. Null for the top level. */
  parentId?: string | null;
  projectId?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const me = useMe();
  const toast = useToast();
  const [files, setFiles] = useState<Loaded[]>([]);
  const [dropping, setDropping] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  /**
   * Whether an HTML file stays HTML.
   *
   * One answer for the batch rather than one per file, because it is a question
   * about what the reader wants their wiki to be made of and not about any
   * particular document. Keeping it is the default: an import that silently
   * converted a carefully laid-out page into approximate markdown would be
   * taking a decision the person can no longer see the input to.
   */
  const [keepHtml, setKeepHtml] = useState(true);
  const [split, setSplit] = useState(false);

  const load = async (chosen: File[]): Promise<void> => {
    const usable = chosen.filter((file) => TEXT_NAME.test(file.name) || file.type.startsWith('text/'));
    setRefused(chosen.filter((file) => !usable.includes(file)).map((file) => file.name));
    const read = await Promise.all(usable.map(async (file, at) => {
      const text = await file.text();
      return {
        key: `${file.name}-${at}-${file.size}`,
        name: file.name,
        text,
        // The extension first, then the content. A `.txt` full of markup is
        // still a document somebody saved out of a browser, and an `.html` that
        // is really a note is read the same way either way.
        html: HTML_NAME.test(file.name) || looksLikeHtml(text),
      } satisfies Loaded;
    }));
    setFiles((before) => [...before, ...read]);
  };

  /**
   * What the button will create, worked out fresh from the two switches.
   *
   * Derived rather than stored, so flipping "convert to markdown" re-reads
   * every file rather than editing a list of drafts — there is no state here to
   * get out of step with what the reader is looking at.
   */
  const drafts = useMemo<Draft[]>(() => files.flatMap((file): Draft[] => {
    const fallback = (file.html ? htmlTitle(file.text) : markdownTitle(file.text)) ?? baseName(file.name);
    if (file.html && keepHtml) return [{ title: fallback, content: file.text.trim(), format: 'html' as const }];
    const markdown = (file.html ? htmlToMarkdown(file.text) : file.text).trim();
    if (!split) return [{ title: fallback, content: markdown, format: 'markdown' as const }];
    return splitByHeadings(markdown).map((section, at) => ({
      // The lead-in before the first heading keeps the document's own name; a
      // section that somehow has no heading is numbered rather than left blank,
      // because two pages called "Untitled" are two pages nobody can tell apart.
      title: section.title ?? (at === 0 ? fallback : `${fallback} (${at + 1})`),
      content: section.content,
      format: 'markdown' as const,
    }));
  }), [files, keepHtml, split]);

  const anyHtml = files.some((file) => file.html);
  const splittable = files.some((file) => !file.html || !keepHtml);

  const run = (): void => {
    for (const draft of drafts) {
      createPage({
        title: draft.title, content: draft.content, format: draft.format,
        parent_id: parentId ?? null, project_id: projectId ?? null,
      }, me);
    }
    toast(t('page.imported', { count: drafts.length }));
    onClose();
  };

  return (
    <Sheet
      title={t('page.import')}
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={!drafts.length} onClick={run}>
            {t('page.importAction', { count: drafts.length })}
          </Button>
        </>
      }
    >
      <div
        className={cn('import-drop', dropping && 'dropping')}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          void load([...event.dataTransfer.files]);
        }}
      >
        <Icon name="page" size={20} />
        <p className="m-0">{t('page.importDrop')}</p>
        <label className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'cursor-pointer')}>
          {t('page.importChoose')}
          <input
            type="file" hidden multiple
            accept=".md,.markdown,.mdown,.txt,.text,.html,.htm,.xhtml,text/markdown,text/html,text/plain"
            onChange={(event) => {
              void load([...(event.target.files ?? [])]);
              // Cleared, so choosing the same file twice in a row still fires.
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {refused.length > 0 && (
        <p className="text-[12.5px] text-danger mt-2.5">{t('page.importRefused', { names: refused.join(', ') })}</p>
      )}

      {files.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 mt-3.5">
            {anyHtml && (
              <label className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={keepHtml} onChange={(event) => setKeepHtml(event.target.checked)} />
                {t('page.importKeepHtml')}
              </label>
            )}
            <label className={cn('flex items-center gap-1.5 text-[13px]', !splittable && 'text-muted')}>
              <input
                type="checkbox" checked={split && splittable} disabled={!splittable}
                onChange={(event) => setSplit(event.target.checked)}
              />
              {t('page.importSplit')}
            </label>
            <span className="flex-1 min-w-0" />
            <Button variant="ghost" size="sm" onClick={() => { setFiles([]); setRefused([]); }}>
              {t('action.clear')}
            </Button>
          </div>
          <p className="text-[12.5px] text-muted mt-1.5 mb-2.5">
            {parentId ? t('page.importUnderPage') : t('page.importAtTop')}
          </p>

          {/* The preview *is* the drafts — the same array the button walks, so
              a row that is shown is a page that will exist. */}
          {drafts.map((draft, at) => (
            <div className="flex items-center gap-2 py-1.5 border-t border-line" key={`${draft.title}-${at}`}>
              <span aria-hidden="true">📄</span>
              <span className="flex-1 min-w-0 truncate">{draft.title}</span>
              <span className="text-[11.5px] text-muted mono">
                {draft.format === 'html' ? 'HTML' : 'MD'} · {t('page.versionSize', { count: draft.content.length })}
              </span>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}
