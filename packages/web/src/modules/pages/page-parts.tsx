/**
 * The pieces that turn a page from a document into a wiki: labels, watching,
 * who can see it, what changed, and getting it back out.
 *
 * Each was already half-built in the schema — `labels`, `watchers`, `access`,
 * `page_versions` — and had no screen. This is the screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Page } from '@kolibri/shared';
import { collapse, diffLines, diffSummary, renderMarkdown, type DiffLine } from '@kolibri/shared';
import { api } from '../../kernel/sync/api';
import { relativeTime, shortDate } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { byOrder, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { moveTargets, plotMove, type DropZone } from './pagetree';
import { pull } from '../../kernel/sync/sync';
import { useMe, useMemberMap, useSession } from '../../kernel/identity/session';
import { chipDot, chipVariants } from '../../kernel/design-system/ui/chip';
import { Button } from '../../kernel/design-system/ui/button';
import { Avatar, Icon, Sheet, useConfirm, useToast, type MenuItem } from '../../kernel/design-system/ui';
import { downscale } from './Markdown';

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
    <span className="flex items-center flex-wrap gap-[5px]">
      {ids.map((id) => {
        const label = byId('label', id);
        if (!label) return null;
        return (
          <span className={chipVariants()} key={id}>
            <span className={chipDot} style={{ background: label.color }} /> {label.name}
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
    icon: <span className={chipDot} style={{ background: label.color }} />,
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
      {failed && <p className="text-[12px] text-danger">{t('page.historyFailed')}</p>}
      {old === null && !failed && <p className="text-muted">{t('common.loading')}</p>}
      {old !== null && (
        <>
          <p className="text-[12px] text-muted mb-2.5">
            {t('page.diffSummary', { added: summary.added, removed: summary.removed })}
          </p>
          {summary.added === 0 && summary.removed === 0 ? (
            <p className="text-muted">{t('page.diffIdentical')}</p>
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

/* -------------------------------------------------------------- moving */

/**
 * Every page a move is worked out against.
 *
 * Templates and archived pages are out because the tree does not draw them:
 * offering a position relative to a row nobody can see is a move that appears
 * to do nothing.
 */
const movable = (workspaceId: string): Page[] =>
  list('page', (page) => page.workspace_id === workspaceId && !page.archived && !page.is_template) as Page[];

/**
 * Move a page in the tree, and say whether it went.
 *
 * The arithmetic is `plotMove` in `lib/pagetree.ts`; this is the half that
 * needs the store. `false` means the move was refused — dropping a page into
 * its own subtree is the only one somebody reaches by accident.
 */
export function movePage(pageId: string, targetId: string, zone: DropZone, workspaceId: string): boolean {
  const patch = plotMove(pageId, targetId, zone, movable(workspaceId));
  if (!patch) return false;
  update('page', pageId, patch);
  return true;
}

/**
 * The four moves as menu items: up, down, in, out.
 *
 * Which of them are possible is `moveTargets`; what they are called and what
 * they do when picked is here.
 */
export function moveItems(page: Page, workspaceId: string, section: string): MenuItem[] {
  const targets = moveTargets(page.id, movable(workspaceId));
  const move = (target: string, zone: DropZone) => () => { movePage(page.id, target, zone, workspaceId); };
  const items: MenuItem[] = [];

  if (targets.up) {
    items.push({
      id: 'move-up', section, label: <MoveLabel k="page.moveUp" />, icon: <Icon name="chevronUp" size={14} />,
      onSelect: move(targets.up, 'before'),
    });
  }
  if (targets.in) {
    items.push({
      id: 'move-in', section, label: <MoveLabel k="page.moveIn" />, icon: <Icon name="chevronRight" size={14} />,
      onSelect: move(targets.in, 'inside'),
    });
  }
  if (targets.down) {
    items.push({
      id: 'move-down', section, label: <MoveLabel k="page.moveDown" />, icon: <Icon name="chevronDown" size={14} />,
      onSelect: move(targets.down, 'after'),
    });
  }
  if (targets.out) {
    items.push({
      id: 'move-out', section, label: <MoveLabel k="page.moveOut" />, icon: <Icon name="chevronLeft" size={14} />,
      onSelect: move(targets.out, 'after'),
    });
  }
  return items;
}

/** A menu label is rendered, so it can call the hook a plain string cannot. */
const MoveLabel = ({ k }: { k: TranslationKey }) => <>{useT()(k)}</>;

/* --------------------------------------------------------------- cover */

/**
 * The picture across the top of a page.
 *
 * `pages.cover_url` has been in the schema, in the `Page` type, in the synced
 * field list and in the import rewriter since pages were added, and no screen
 * ever set it or drew it. This is that screen: the same upload path the editor
 * uses for a dropped image, downscaled the same way, so a cover costs what an
 * inline picture costs.
 */
export function useCover(page: Page): { input: React.ReactNode; items: (section: string) => MenuItem[] } {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file || !workspaceId) return;
    setBusy(true);
    try {
      const result = await api.upload(workspaceId, await downscale(file, 2400), file.name, { page_id: page.id });
      update('page', page.id, { cover_url: result.url });
    } catch (err) {
      toast(err instanceof Error ? t('editor.uploadFailedReason', { reason: err.message }) : t('editor.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  return {
    input: (
      <input
        ref={field} type="file" accept="image/*" hidden
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          // Cleared, so choosing the same file twice in a row still fires.
          event.target.value = '';
        }}
      />
    ),
    items: (section) => [
      {
        id: 'cover-set', section, icon: <Icon name="image" size={14} />,
        label: <MoveLabel k={busy ? 'editor.uploading' : page.cover_url ? 'page.coverReplace' : 'page.coverAdd'} />,
        onSelect: () => field.current?.click(),
      },
      ...(page.cover_url
        ? [{
          id: 'cover-clear', section, icon: <Icon name="close" size={14} />,
          label: <MoveLabel k="page.coverRemove" />,
          onSelect: () => update('page', page.id, { cover_url: null }),
        }]
        : []),
    ],
  };
}

/** The cover itself. Decorative: the page's title is right underneath it. */
export function PageCover({ page }: { page: Page }) {
  if (!page.cover_url) return null;
  return <img className="page-cover" src={page.cover_url} alt="" />;
}

/* ------------------------------------------------------------- history */

/** One thing that happened to the page, whichever half of the record it is in. */
type Entry =
  | { kind: 'version'; id: string; at: number; who: string | null; title: string; size: number }
  | { kind: 'change'; id: string; at: number; who: string | null; verb: string; field: string | null; to: string | null };

/** How a field change reads, per field. Anything unlisted is not shown at all. */
const CHANGE_KEY: Record<string, TranslationKey> = {
  title: 'page.changeTitle',
  parent_id: 'page.changeParent',
  labels: 'page.changeLabels',
  access: 'page.changeAccess',
  project_id: 'page.changeProject',
};

/**
 * Everything that has happened to a page, in one list.
 *
 * The record was in two halves and only one of them had a screen. Body edits
 * write a `page_versions` row — that is the half this sheet already showed, and
 * the half you can compare and restore. Renames, moves, archiving, labels and
 * visibility write an `activities` row, which has been recorded since pages
 * existed and had no route to read it.
 *
 * Interleaved rather than two tabs, because the question people bring here is
 * "what happened to this page", and an edit and the rename that came with it
 * are one event to everybody except the database.
 */
export function PageHistory({ page, onClose, onCompare }: {
  page: Page;
  onClose: () => void;
  onCompare: (versionId: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    // Both halves at once, and one failure is the whole sheet's failure: a
    // history missing its renames looks complete and is not.
    Promise.all([api.pageVersions(page.id), api.pageActivity(page.id)])
      .then(([versions, activity]) => {
        if (!live) return;
        const rows: Entry[] = [
          ...versions.map((version: any): Entry => ({
            kind: 'version', id: String(version.id), at: Number(version.created_at),
            who: version.author_id ? String(version.author_id) : null,
            title: String(version.title ?? ''), size: Number(version.size ?? 0),
          })),
          ...activity.map((row: any): Entry => ({
            kind: 'change', id: String(row.id), at: Number(row.created_at),
            who: row.actor_id ? String(row.actor_id) : null,
            verb: String(row.verb ?? ''), field: row.field ? String(row.field) : null,
            to: row.new_value == null ? null : String(row.new_value),
          })),
        ];
        setEntries(rows.sort((a, b) => b.at - a.at));
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [page.id]);

  /** What one activity row says, or nothing if it is a field nobody reads about. */
  const said = (entry: Extract<Entry, { kind: 'change' }>): string | null => {
    if (entry.verb === 'created') return t('page.changeCreated');
    if (entry.verb === 'deleted') return t('page.changeDeleted');
    if (entry.field === 'archived') return entry.to === '1' ? t('page.changeArchived') : t('page.changeRestored');
    if (entry.field === 'is_template') return entry.to === '1' ? t('page.changeTemplated') : t('page.changeUntemplated');
    const key = entry.field ? CHANGE_KEY[entry.field] : undefined;
    return key ? t(key) : null;
  };

  const shown = (entries ?? []).filter((entry) => entry.kind === 'version' || said(entry) !== null);

  return (
    <Sheet title={t('page.history')} onClose={onClose}>
      {failed && <p className="text-[12px] text-danger">{t('page.historyFailed')}</p>}
      {entries === null && !failed && <p className="text-muted">{t('common.loading')}</p>}
      {entries !== null && shown.length === 0 && <p className="text-muted">{t('page.noVersions')}</p>}

      {shown.map((entry) => (
        <div className="flex items-center gap-2" key={entry.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
          <Avatar user={entry.who ? members.get(entry.who) : undefined} size={20} />
          {entry.kind === 'change' ? (
            <div className="flex-1 min-w-0">
              <span className="text-[13.5px]">
                <strong>{(entry.who && members.get(entry.who)?.name) || t('common.someone')}</strong>{' '}
                {said(entry)}
              </span>
              <div className="text-muted text-[12.5px]">{relativeTime(entry.at)}</div>
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <strong className="text-[13.5px]">{entry.title || t('common.untitled')}</strong>
                <div className="text-muted text-[12.5px]">
                  {shortDate(entry.at)} · {(entry.who && members.get(entry.who)?.name) || t('common.someone')}
                  {' '}· {t('page.versionSize', { count: entry.size })}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => onCompare(entry.id)}>{t('page.compare')}</Button>
              <Button
                size="sm"
                onClick={async () => {
                  if (!(await confirm(t('page.restoreConfirm'), t('action.restore')))) return;
                  await api.restoreVersion(page.id, entry.id);
                  await pull();
                  onClose();
                  toast(t('page.restored'));
                }}
              >
                {t('action.restore')}
              </Button>
            </>
          )}
        </div>
      ))}
      {dialog}
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
