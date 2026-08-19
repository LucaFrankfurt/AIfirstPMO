/**
 * The pieces that turn a page from a document into a wiki: labels, watching,
 * who can see it, what changed, and getting it back out.
 *
 * Each was already half-built in the schema — `labels`, `watchers`, `access`,
 * `page_versions` — and had no screen. This is the screen.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Page } from '@kolibri/shared';
import { collapse, diffLines, diffSummary, renderMarkdown, type DiffLine } from '@kolibri/shared';
import { api } from '../lib/api';
import { shortDate } from '../lib/format';
import { useT, type TranslationKey } from '../lib/i18n';
import { byOrder, update } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useMe, useMemberMap } from '../session';
import { Icon, Sheet, useToast, type MenuItem } from './ui';

/* -------------------------------------------------------------- labels */

/**
 * Every label in the workspace.
 *
 * Not "this page's project's labels": a page is the one thing that can live
 * outside a project entirely, and scoping its labels to one would leave every
 * workspace-level page unlabellable — which is what the first version did, and
 * it showed up the moment the menu opened with no labels in it.
 */
export const usePageLabels = (_page: Page) => useQuery(() => list('label'), []);

export function PageLabelChips({ page }: { page: Page }) {
  const ids = page.labels ?? [];
  if (!ids.length) return null;
  return (
    <span className="row wrap" style={{ gap: 5 }}>
      {ids.map((id) => {
        const label = byId('label', id);
        if (!label) return null;
        return (
          <span className="chip" key={id}>
            <span className="dot" style={{ background: label.color }} /> {label.name}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Menu items for the page's labels — a tick per label, toggled in place.
 *
 * Labels belong to projects, so a workspace with three projects has three
 * called "documentation". Listing them by name alone is a menu of identical
 * rows; each therefore says which project it came from, and the ones that
 * belong to no project — which any page can use without qualification — sort
 * to the top.
 */
export function labelItems(
  page: Page,
  labels: { id: string; name: string; color: string; project_id?: string | null }[],
  section: string,
): MenuItem[] {
  const ordered = [...labels].sort((a, b) => {
    if (!a.project_id !== !b.project_id) return a.project_id ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return ordered.map((label) => ({
    id: `label-${label.id}`,
    section,
    label: label.name,
    icon: <span className="dot" style={{ background: label.color }} />,
    hint: (page.labels ?? []).includes(label.id)
      ? '✓'
      : label.project_id ? byId('project', label.project_id)?.name : undefined,
    onSelect: () => {
      const current = page.labels ?? [];
      update('page', page.id, {
        labels: current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id],
      });
    },
  }));
}

/* ------------------------------------------------------------ watching */

/** Whether the current person hears about edits to this page. */
export function useWatching(page: Page): { watching: boolean; toggle: () => void } {
  const me = useMe();
  const watchers = page.watchers ?? [];
  return {
    watching: watchers.includes(me),
    toggle: () => update('page', page.id, {
      watchers: watchers.includes(me) ? watchers.filter((id) => id !== me) : [...watchers, me],
    }),
  };
}

/* -------------------------------------------------------------- access */

export const ACCESS_KEY: Record<string, TranslationKey> = {
  workspace: 'page.accessWorkspace',
  project: 'page.accessProject',
  private: 'page.accessPrivate',
};

/* ---------------------------------------------------------------- diff */

/**
 * What changed between a version and what the page says now.
 *
 * Against the *current* text rather than against the next version along,
 * because the question somebody opens this to answer is "what would restoring
 * this give me back", not "what did that one edit do".
 */
export function VersionDiff({ page, versionId, onClose }: { page: Page; versionId: string; onClose: () => void }) {
  const t = useT();
  const [old, setOld] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.pageVersion(page.id, versionId)
      .then((version) => { if (live) setOld(String(version.content ?? '')); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [page.id, versionId]);

  const parts = useMemo(
    () => (old === null ? [] : collapse(diffLines(old, page.content ?? ''), 3)),
    [old, page.content],
  );
  const summary = useMemo(
    () => (old === null ? { added: 0, removed: 0 } : diffSummary(diffLines(old, page.content ?? ''))),
    [old, page.content],
  );

  return (
    <Sheet title={t('page.whatChanged')} wide onClose={onClose}>
      {failed && <p className="hint warn">{t('page.historyFailed')}</p>}
      {old === null && !failed && <p className="muted">{t('common.loading')}</p>}
      {old !== null && (
        <>
          <p className="hint" style={{ marginBottom: 10 }}>
            {t('page.diffSummary', { added: summary.added, removed: summary.removed })}
          </p>
          {summary.added === 0 && summary.removed === 0 ? (
            <p className="muted">{t('page.diffIdentical')}</p>
          ) : (
            <div className="diff">
              {parts.map((part, index) =>
                part.op === 'skipped' ? (
                  <div className="diff-skip" key={index}>{t('page.diffSkipped', { count: part.count })}</div>
                ) : (
                  <div className={`diff-line ${part.op}`} key={index}>
                    <span className="diff-no">{(part as DiffLine).before ?? ''}</span>
                    <span className="diff-no">{(part as DiffLine).after ?? ''}</span>
                    <span className="diff-mark" aria-hidden>
                      {part.op === 'added' ? '+' : part.op === 'removed' ? '−' : ' '}
                    </span>
                    {/* The marker is decorative; the row says which side it is on. */}
                    <span className="diff-text">
                      <span className="sr-only">
                        {part.op === 'added' ? t('page.diffAdded') : part.op === 'removed' ? t('page.diffRemoved') : ''}
                      </span>
                      {(part as DiffLine).text || ' '}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

/* -------------------------------------------------------------- export */

/**
 * The page and everything under it as one markdown file.
 *
 * Plain text on purpose: a markdown bundle opens in anything, survives this
 * product, and needs no library. PDF would need a renderer and would be worse
 * at the one job an export has, which is not locking your writing in here.
 */
export function useExport(): (page: Page) => void {
  const t = useT();
  const toast = useToast();
  const members = useMemberMap();

  return (page: Page) => {
    const seen = new Set<string>();
    const write = (current: Page, depth: number): string => {
      if (seen.has(current.id)) return '';
      seen.add(current.id);
      const author = members.get(current.created_by)?.name;
      const heading = '#'.repeat(Math.min(depth + 1, 6));
      const children = list('page', (child) => child.parent_id === current.id && !child.archived);
      return [
        `${heading} ${current.icon ?? ''} ${current.title}`.trim(),
        '',
        author ? `*${t('page.byAuthor', { name: author })} · ${shortDate(current.updated_at)}*` : '',
        '',
        current.content ?? '',
        '',
        ...children.map((child) => write(child as Page, depth + 1)),
      ].join('\n');
    };

    const blob = new Blob([write(page, 0)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(page.title || 'page').replace(/[^\w\d -]+/g, '').trim() || 'page'}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next tick: revoking immediately can beat the download in
    // some browsers and produce an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(t('page.exported'));
  };
}

/**
 * Print a page and everything under it — which is how you get a PDF.
 *
 * Deliberately the browser's own print path rather than a renderer on the
 * server. A PDF engine is a large dependency, a font problem and a security
 * surface, and every browser already has one that honours the reader's paper
 * size and their own idea of margins. What this does is give it a document
 * worth printing: the page tree, rendered, with the app's furniture gone.
 */
export function usePrint(): (page: Page) => void {
  const t = useT();
  const toast = useToast();
  const members = useMemberMap();

  return (page: Page) => {
    const seen = new Set<string>();
    const section = (current: Page, depth: number): string => {
      if (seen.has(current.id)) return '';
      seen.add(current.id);
      const level = Math.min(depth + 1, 6);
      const author = members.get(current.created_by)?.name;
      const children = list('page', (child) => child.parent_id === current.id && !child.archived)
        .sort(byOrder) as Page[];
      return [
        `<h${level}>${escapeHtml(`${current.icon ?? ''} ${current.title}`.trim())}</h${level}>`,
        author ? `<p class="meta">${escapeHtml(t('page.byAuthor', { name: author }))} · ${escapeHtml(shortDate(current.updated_at))}</p>` : '',
        renderMarkdown(current.content ?? ''),
        ...children.map((child) => section(child, depth + 1)),
      ].join('\n');
    };

    const win = window.open('', '_blank');
    if (!win) {
      toast(t('page.printBlocked'));
      return;
    }
    win.document.write(printable(escapeHtml(page.title || t('common.untitled')), section(page, 0)));
    win.document.close();
    // The images have to have arrived, or the print dialogue captures gaps.
    win.addEventListener('load', () => {
      win.focus();
      win.print();
    });
  };
}

const escapeHtml = (text: string): string =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A document with nothing on it but the writing — and margins a printer likes. */
const printable = (title: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8" /><title>${title}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { margin: 0 auto; max-width: 720px; padding: 24px 20px;
    font: 13.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #14161a; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 24px 0 6px; }
  h3 { font-size: 15px; margin: 18px 0 4px; }
  h1, h2, h3 { break-after: avoid; }
  p, ul, ol, pre, blockquote, table { margin: 0 0 12px; break-inside: avoid; }
  .meta { color: #6b7280; font-size: 12px; margin: 0 0 14px; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f7f8fa; padding: 10px 12px; border-radius: 6px; overflow: hidden; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  blockquote { border-left: 3px solid #e5e7eb; padding-left: 10px; color: #4b5563; margin-left: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 5px 8px; text-align: left; }
  a { color: inherit; text-decoration: underline; }
</style></head>
<body>${body}</body></html>`;

export { Icon };
