/**
 * The screen that says what is wrong with the wiki.
 *
 * A handbook does not get untidy all at once, and none of the ways it does
 * were visible anywhere. The tree draws a confident answer whether a page's
 * parent still exists or not; two pages called `Notes` look like two pages
 * rather than like one `[[link]]` target with a silent winner; a draft nobody
 * filled in looks exactly like a page. So "tidy up the wiki" was a job with no
 * list, which is a job nobody starts.
 *
 * The findings are `tidy.ts`, which is arithmetic and tested without a
 * browser. This is the part that reads the pages out of the store and draws
 * them, and it is deliberately shaped as **a list with an offer beside it**
 * rather than a Fix button: every one of these pages is something somebody
 * meant to write, and a wiki that tidies itself is a wiki that loses a draft.
 *
 * The archive and the trash are on the same screen because they are the same
 * question — "what is not in the tree, and what of it do I still want?" — and
 * the answer used to live two screens away under a different heading. The
 * tombstones are already on the device; `listAll` is the one reader that does
 * not filter them out, which is why this needs no new endpoint.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { matchesTerms, parseTerms, type Page } from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { relativeTime } from '../../../kernel/design-system/format';
import { restore, update } from '../../../kernel/sync/mutations';
import { list, listAll, useQuery } from '../../../kernel/sync/store';
import { useCanWrite, useSession } from '../../../kernel/identity/session';
import { SelectBox, useSelection } from '../../../kernel/design-system/selection';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { navItem } from '../../../kernel/design-system/ui/nav';
import { Empty, Icon, useToast } from '../../../kernel/design-system/ui';
import { useMinute } from '../../../kernel/design-system/minute';
import { STALE_DAYS, tidyPages, type Problem } from '../tidy';
import { trailsOf } from '../pagetree';
import { PageBulkBar } from '../page-bulk';

/** What each finding is called, and the consequence that makes it one. */
const SAYS: Record<Problem, { title: TranslationKey; why: TranslationKey }> = {
  detached: { title: 'problem.detached', why: 'problem.detachedWhy' },
  duplicate: { title: 'problem.duplicate', why: 'problem.duplicateWhy' },
  empty: { title: 'problem.empty', why: 'problem.emptyWhy' },
  isolated: { title: 'problem.isolated', why: 'problem.isolatedWhy' },
  stale: { title: 'problem.stale', why: 'problem.staleWhy' },
};

/** One number with a word under it. Four of them say more than a paragraph. */
const Count = ({ label, value }: { label: string; value: number }) => (
  <div className="tidy-count">
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

/**
 * A page in a finding, with the path to it.
 *
 * The path is the point: a flat list of titles answers "which pages" and not
 * "where", and where is what somebody about to move one needs. Drawn as plain
 * text rather than as links, because the row itself is already the way in and
 * a breadcrumb of six links is six things to miss the real one with.
 */
function TidyRow({ page, trails, order, selection }: {
  page: Page;
  /** Page id → the pages it sits under, built once by the screen. See `trailsOf`. */
  trails: Map<string, Page[]>;
  order: string[];
  selection: ReturnType<typeof useSelection>;
}) {
  const t = useT();
  const trail = (trails.get(page.id) ?? []).map((parent) => parent.title || t('common.untitled'));
  return (
    <div className={`page-row${selection.has(page.id) ? ' selected' : ''}`}>
      <SelectBox id={page.id} order={order} selection={selection} label={page.title || t('common.untitled')} />
      <Link to={`/pages/${page.id}`} className={navItem()}>
        <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
        <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
        {trail.length > 0 && <span className="tidy-where hide-sm">{trail.join(' › ')}</span>}
        <span className="text-[11.5px] text-muted hide-sm">
          {t('page.updated', { time: relativeTime(page.updated_at) })}
        </span>
      </Link>
    </div>
  );
}

export function PagesTidy() {
  useMinute(); // re-reads the ages below once a minute — `design-system/minute.ts`
  const t = useT();
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const toast = useToast();
  const selection = useSelection();
  const [query, setQuery] = useState('');

  /** The tree: what the findings are about. Templates and the archive are not in it. */
  const pages = useQuery(
    () => list('page', (page) => page.workspace_id === workspaceId && !page.archived && !page.is_template) as Page[],
    [workspaceId],
  );
  /**
   * Every page row this device holds, **tombstones included** — the wider list
   * the tree is checked against, and the three lists below all come off it.
   *
   * `listAll` rather than `list`, and that is the fix for a finding this screen
   * was getting wrong about itself: `list` is the one reader that drops
   * deleted rows, so a page whose parent had been *deleted* was not reported
   * as `detached` at all — `tidyPages` asks whether the missing parent is a row
   * it knows, and a tombstone filtered out before it gets there is not. The
   * copy on this very screen promises "archived, deleted or turned into a
   * template", and two of the three were true.
   *
   * It is also why the trash list needs no endpoint: a deleted row keeps
   * syncing, which is what lets two devices agree that something is gone.
   */
  const known = useQuery(
    () => (listAll('page') as Page[]).filter((page) => page.workspace_id === workspaceId),
    [workspaceId],
  );
  const templates = useMemo(
    () => known.filter((page) => page.is_template && !page.archived && !page.deleted_at),
    [known],
  );
  const archived = useMemo(
    () => known.filter((page) => !!page.archived && !page.deleted_at).sort((a, b) => b.updated_at - a.updated_at),
    [known],
  );
  const deleted = useMemo(
    () => known.filter((page) => page.deleted_at).sort((a, b) => Number(b.deleted_at) - Number(a.deleted_at)),
    [known],
  );

  const report = useMemo(() => tidyPages(pages, { all: known }), [pages, known]);
  /**
   * Where each reported page sits, worked out once for the whole screen.
   *
   * A page can be in three findings, so it is three rows, and `ancestorsOf`
   * rebuilds a map of the wiki on every call — which per row is one map of
   * every page per row, re-made each time `useMinute` above ticks.
   */
  const trails = useMemo(() => trailsOf(pages), [pages]);

  // The same reading the search boxes elsewhere do, rather than a lower-cased
  // substring: what is in here is mostly named in German, and a page is looked
  // for by half-remembering what it was called.
  const terms = useMemo(() => parseTerms(query), [query]);
  const keeps = (page: Page) => !terms.length || matchesTerms(page.title || '', terms);

  const findings = useMemo(
    () => report.findings
      .map((one) => ({ ...one, pages: one.pages.filter(keeps) }))
      .filter((one) => one.pages.length > 0),
    [report, query],
  );
  /**
   * Every row on the screen in drawing order, so shift-click spans sections.
   *
   * De-duplicated: a page can be in two findings at once — empty *and* nobody
   * pointing at it is the normal pair — and a range between two ids that each
   * appear twice is a range nobody meant.
   */
  const order = useMemo(
    () => [...new Set(findings.flatMap((one) => one.pages.map((page) => page.id)))],
    [findings],
  );

  return (
    <>
      <Header title={t('page.tidyTitle')}>
        <Button variant="secondary" size="sm" onClick={() => navigate('/pages')}>
          <Icon name="page" size={14} /> <span className="hide-sm">{t('page.listTitle')}</span>
        </Button>
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <Trail parts={[{ to: '/pages', label: t('page.listTitle'), icon: <Icon name="page" size={13} /> }]} />
        <p className="text-muted text-[13.5px]" style={{ marginTop: 0 }}>{t('page.tidyIntro')}</p>

        <div className="tidy-counts">
          <Count label={t('page.tidyCountPages')} value={pages.length} />
          <Count label={t('page.tidyCountTemplates')} value={templates.length} />
          <Count label={t('page.tidyCountArchived')} value={archived.length} />
          <Count label={t('page.tidyCountDeleted')} value={deleted.length} />
        </div>

        {report.pages > 0 && (
          <div className="flex items-center flex-wrap gap-2" style={{ margin: '14px 0 4px' }}>
            <SectionHeading tight>{t('page.tidyFound', { count: report.pages })}</SectionHeading>
            <span className="flex-1 min-w-0" />
            <Input
              style={{ maxWidth: 240 }}
              placeholder={t('page.filterTree')}
              aria-label={t('page.filterTree')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        {report.pages === 0 ? (
          <Empty emoji="🧹" title={t('page.tidyClean')} hint={t('page.tidyCleanHint')} />
        ) : findings.length === 0 ? (
          <p className="text-muted text-[12.5px]">{t('page.filterNone')}</p>
        ) : (
          findings.map(({ problem, pages: found }) => (
            <section key={problem} className="mt-6">
              <h3 className="mb-1 text-sm font-semibold">
                {t(SAYS[problem].title)} <span className="text-muted">· {found.length}</span>
              </h3>
              <p className="mb-2.5 text-[12.5px] text-muted">
                {t(SAYS[problem].why)}
                {problem === 'stale' && <> {t('page.tidyStaleDays')} {t('page.tidyDays', { count: STALE_DAYS })}.</>}
              </p>
              {found.map((page) => (
                <TidyRow key={`${problem}-${page.id}`} page={page} trails={trails} order={order} selection={selection} />
              ))}
            </section>
          ))
        )}

        {/* Not a finding: a page in the archive is where somebody put it. It is
            here because this is the screen that answers "what is not in the
            tree", and the control that brings one back used to live on a page
            you could no longer find. */}
        <section className="mt-8">
          <SectionHeading tight>{t('page.archivedTitle')}</SectionHeading>
          <p className="mb-2.5 text-[12.5px] text-muted">{t('page.archivedHint')}</p>
          {archived.length === 0
            ? <p className="text-muted text-[12.5px]">{t('page.tidyArchiveEmpty')}</p>
            : archived.map((page) => (
              <div className="page-row" key={page.id}>
                <Link to={`/pages/${page.id}`} className={navItem()}>
                  <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
                  <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
                  <span className="text-[11.5px] text-muted hide-sm">
                    {t('page.updated', { time: relativeTime(page.updated_at) })}
                  </span>
                </Link>
                {canWrite && (
                  <Button size="sm" variant="ghost" onClick={() => update('page', page.id, { archived: 0 })}>
                    {t('action.unarchive')}
                  </Button>
                )}
              </div>
            ))}
        </section>

        <section className="mt-8">
          <SectionHeading tight>{t('page.tidyTrash')}</SectionHeading>
          <p className="mb-2.5 text-[12.5px] text-muted">{t('page.tidyTrashHint')}</p>
          {deleted.length === 0
            ? <p className="text-muted text-[12.5px]">{t('page.tidyTrashEmpty')}</p>
            : deleted.slice(0, 100).map((page) => (
              <div className="page-row" key={page.id}>
                {/* Not a link: following one would open a page that is not
                    there and land on the wiki's own "deleted page" screen,
                    which is a dead end two clicks from the way back. */}
                <span className={navItem()}>
                  <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
                  <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
                  <span className="text-[11.5px] text-muted hide-sm">
                    {relativeTime(Number(page.deleted_at))}
                  </span>
                </span>
                {canWrite && (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => {
                      restore('page', page.id);
                      toast(t('page.broughtBack', { title: page.title || t('common.untitled') }));
                    }}
                  >
                    {t('action.restore')}
                  </Button>
                )}
              </div>
            ))}
        </section>
      </div>
      {canWrite && <PageBulkBar selection={selection} pages={pages} />}
    </>
  );
}
