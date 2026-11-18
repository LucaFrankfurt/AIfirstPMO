/**
 * What kind of document a page is, whether it is the one that counts, what
 * replaced it, what it says since it was signed off, and what comes next in its
 * series.
 *
 * Each of these is something the first real wiki on an instance did by hand,
 * in the one place it could — the title. `Preismodell V5`, `Sales Prozess
 * final`, `Weekly 04.11.2026 – Meetingprotokoll`, `(Arbeitsversion 2)`: nine
 * titles carried a version or a state, twenty-one a date in seven formats, and
 * a page called "Aufräumliste" kept a table of which page was current on each
 * subject. This file is those words moved out of the titles and into fields
 * the wiki can sort, group and draw by.
 */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  comparePages, isSuperseded, localDay, ladder, orderKey, pageKey, seriesEntryTitle, statusOf, supersededStatus,
  type Page, type PageStatus, type PageType,
} from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { create, createPage, remove, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useCanWrite, useMe, useSession } from '../../kernel/identity/session';
import { Icon, MenuButton, useConfirm, type MenuGroup, type MenuItem } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Input } from '../../kernel/design-system/ui/field';
import { Chip, chipDot } from '../../kernel/design-system/ui/chip';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { EmojiPicker } from '../../kernel/design-system/ui/emoji-picker';
import { shortDate } from '../../kernel/design-system/format';
import { usePageStatuses } from './status';

/* ---------------------------------------------------------------- types */

/** This workspace's page types, in its own order. */
export function usePageTypes(): PageType[] {
  const { workspaceId } = useSession();
  return useQuery(
    () => (list('pageType', (row) => row.workspace_id === workspaceId) as PageType[]).sort(comparePages),
    [workspaceId],
  );
}

/**
 * The type a page has, if any.
 *
 * Read defensively: `type_id` is newer than the rows a device may already hold,
 * and a type somebody deleted leaves its id behind on every page that had it —
 * both mean "no type", which is what this answers.
 */
export const typeOf = (page: Pick<Page, 'type_id'>, types: PageType[]): PageType | undefined =>
  page.type_id ? types.find((type) => type.id === page.type_id) : undefined;

/** The type, as an icon and a word — or a dot, in a tree row. */
export function PageTypeChip({ page, dot }: { page: Pick<Page, 'type_id'>; dot?: boolean }) {
  const types = usePageTypes();
  const type = typeOf(page, types);
  if (!type) return null;
  if (dot) {
    return <span aria-label={type.name} title={type.name} style={{ fontSize: 12 }}>{type.icon ?? '•'}</span>;
  }
  return (
    <Chip title={type.name}>
      <span aria-hidden="true">{type.icon ?? <span className={chipDot} style={{ background: type.color }} />}</span>
      {type.name}
    </Chip>
  );
}

/** The types as a drawer that sets one — or none. A choice, like the rung beside it. */
export function typeItems(page: Page, types: PageType[], section: string, none: string): MenuGroup {
  const current = typeOf(page, types);
  return {
    id: 'type',
    label: section,
    icon: <Icon name="tag" size={14} />,
    hint: current?.name,
    items: [
      ...types.map((type) => ({
        id: `type-${type.id}`,
        label: type.name,
        icon: <span aria-hidden="true">{type.icon ?? '•'}</span>,
        hint: current?.id === type.id ? '✓' : undefined,
        onSelect: () => { if (page.type_id !== type.id) update('page', page.id, { type_id: type.id }); },
      })),
      { id: 'type-none', label: none, hint: current ? undefined : '✓', onSelect: () => update('page', page.id, { type_id: null }) },
    ],
  };
}

/**
 * Where a workspace says what kinds of document it keeps.
 *
 * The status ladder's editor, nearly row for row, because the two lists answer
 * the same shape of question and should not be two controls to learn. An icon
 * where the ladder has a kind: a type means nothing to the product beyond
 * itself, so there is nothing underneath it to choose.
 *
 * Deleting a type touches no page. Every page that had it reads as having none
 * (`typeOf`), which is what the confirmation says.
 */
export function PageTypeSettings() {
  const t = useT();
  const { workspaceId } = useSession();
  const types = usePageTypes();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  if (!canWrite) return null;

  return (
    <>
      <div className="flex items-center gap-2" style={{ margin: '18px 0 8px' }}>
        <SectionHeading tight>{t('page.types')}</SectionHeading>
      </div>
      <p className="mt-0 mb-2.5 text-[12.5px] text-muted">{t('page.typesHint')}</p>
      {types.map((type, at) => (
        <div className="stack-card" key={type.id}>
          <div className="flex items-center gap-2">
            <EmojiPicker value={type.icon} fallback="📄" onChange={(next) => update('pageType', type.id, { icon: next })} />
            <input
              type="color" value={type.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
              aria-label={t('page.typeColour')}
              onChange={(event) => update('pageType', type.id, { color: event.target.value })}
            />
            <Input
              className="flex-1 min-w-0" value={type.name} aria-label={t('page.typeName')}
              onChange={(event) => update('pageType', type.id, { name: event.target.value })}
            />
            <Button
              variant="ghost" size="icon" aria-label={t('state.moveUp')} disabled={at === 0}
              onClick={() => update('pageType', type.id, {
                sort_order: orderKey(types[at - 2]?.sort_order ?? null, types[at - 1]?.sort_order ?? null),
              })}
            >
              <Icon name="chevronUp" size={14} />
            </Button>
            <Button
              variant="ghost" size="icon" aria-label={t('state.moveDown')} disabled={at === types.length - 1}
              onClick={() => update('pageType', type.id, {
                sort_order: orderKey(types[at + 1]?.sort_order ?? null, types[at + 2]?.sort_order ?? null),
              })}
            >
              <Icon name="chevronDown" size={14} />
            </Button>
            <Button
              variant="ghost" size="icon" aria-label={t('page.typeDelete')}
              onClick={async () => {
                if (await confirm(t('page.typeDeleteConfirm', { name: type.name }))) remove('pageType', type.id);
              }}
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button
        variant="secondary" size="sm" className="mt-2"
        onClick={() => create('pageType', {
          workspace_id: workspaceId,
          name: t('page.typeNew'),
          icon: '📄',
          color: '#64748b',
          sort_order: orderKey(types[types.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('page.typeAdd')}
      </Button>
      {dialog}
    </>
  );
}

/* -------------------------------------------------------------- pinning */

/**
 * Whether a page is the reference on its subject.
 *
 * `pinned` is newer than the rows a device holds; missing is "no".
 */
export const isPinned = (page: Pick<Page, 'pinned'>): boolean => Number(page.pinned ?? 0) === 1;

export function pinItem(page: Page, t: ReturnType<typeof useT>): MenuItem {
  const pinned = isPinned(page);
  return {
    id: 'pin',
    label: pinned ? t('page.unpin') : t('page.pin'),
    icon: <Icon name="star" size={14} />,
    hint: pinned ? '✓' : undefined,
    onSelect: () => update('page', page.id, { pinned: pinned ? 0 : 1 }),
  };
}

/* ------------------------------------------------------------ replaced */

/** Whether this page has been replaced, read the way every screen reads it. */
export function useIsSuperseded(page: Pick<Page, 'status_id' | 'superseded_by'>): boolean {
  const statuses = usePageStatuses();
  return isSuperseded(page, statuses);
}

/**
 * "Replaced by…", as a drawer of the pages that could have replaced this one.
 *
 * Choosing one moves the page to the workspace's `superseded` rung as well.
 * The server does the same for a write that names only the successor, so a
 * device and the server agree on the rung even before the round trip — and a
 * workspace without such a rung keeps the pointer alone, which `isSuperseded`
 * reads.
 *
 * Templates, archived pages and the page itself are not offered: a page cannot
 * be replaced by a form, by something nobody can find, or by itself.
 */
export function successorItems(
  page: Page,
  candidates: Page[],
  statuses: PageStatus[],
  t: ReturnType<typeof useT>,
): MenuGroup {
  const rung = supersededStatus(statuses);
  const current = page.superseded_by ? byId('page', page.superseded_by) : undefined;
  const offered = candidates
    .filter((other) => other.id !== page.id && !other.is_template && !other.archived && !isSuperseded(other, statuses))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return {
    id: 'replaced',
    label: t('page.replacedBy'),
    icon: <Icon name="refresh" size={14} />,
    hint: current?.title,
    search: offered.length > 8,
    items: [
      ...offered.map((other) => ({
        id: `replaced-${other.id}`,
        label: `${other.icon ?? '📄'} ${other.title || t('common.untitled')}`,
        hint: page.superseded_by === other.id ? '✓' : undefined,
        onSelect: () => update('page', page.id, { superseded_by: other.id, ...(rung ? { status_id: rung.id } : {}) }),
      })),
      ...(page.superseded_by ? [{
        id: 'replaced-none', label: t('page.replacedByNone'),
        onSelect: () => update('page', page.id, { superseded_by: null }),
      }] : []),
    ],
  };
}

/**
 * The line a replaced page opens with: what replaced it, as a link.
 *
 * Above the trail and the title, where the archived notice sits, because it
 * answers the same question — "is this the page I should be reading" — and it
 * is the question somebody arriving from an old link has first. The successor
 * may have been deleted since; then the line says the page was replaced and
 * stops, rather than linking to a page that is not there.
 */
export function SupersededNotice({ page }: { page: Page }) {
  const t = useT();
  const statuses = usePageStatuses();
  const canWrite = useCanWrite();
  const successor = useQuery(
    () => (page.superseded_by ? byId('page', page.superseded_by) : undefined),
    [page.superseded_by],
  );
  if (!isSuperseded(page, statuses)) return null;
  const draft = ladder(statuses).find((status) => status.kind === 'draft');
  return (
    <div className="page-archived" role="note">
      <Icon name="refresh" size={15} />
      <span className="flex-1 min-w-0">
        {successor && !successor.deleted_at
          ? <>{t('page.replacedNoticeBy')} <Link to={`/pages/${successor.id}`}>{successor.icon ?? '📄'} {successor.title || t('common.untitled')}</Link>.</>
          : t('page.replacedNotice')}
      </span>
      {canWrite && (
        <Button
          size="sm"
          onClick={() => update('page', page.id, {
            superseded_by: null,
            // Off the superseded rung too, or the page would go on saying it
            // was replaced with nothing left to say by what.
            ...(statusOf(page, statuses)?.kind === 'superseded' && draft ? { status_id: draft.id } : {}),
          })}
        >
          {t('page.replacedClear')}
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------- changed since final */

/**
 * "Changed since Final on 16.11." — and the difference, one click away.
 *
 * The rung stays where it is; this is what tells a reader that the text under
 * it has moved. The server keeps both halves (`settled_version_id`,
 * `settled_drift`), because the version it compares against lives where no
 * device has it. Drawn only while the page still stands on a `final` rung:
 * once it leaves, there is no claim left to have drifted from.
 */
export function DriftNotice({ page, onCompare }: { page: Page; onCompare: (versionId: string) => void }) {
  const t = useT();
  const statuses = usePageStatuses();
  const status = statusOf(page, statuses);
  if (!page.settled_version_id || !Number(page.settled_drift ?? 0) || status?.kind !== 'final') return null;
  return (
    <div className="page-archived" role="note">
      <Icon name="pencil" size={15} />
      <span className="flex-1 min-w-0">
        {t('page.changedSince', { status: status.name, date: shortDate(page.updated_at) })}
      </span>
      <Button size="sm" onClick={() => onCompare(page.settled_version_id!)}>{t('page.changedSinceCompare')}</Button>
    </div>
  );
}

/* --------------------------------------------------------------- series */

/** Whether a page's sub-pages are dated entries. Missing on an old row is "no". */
export const isSeries = (page: Pick<Page, 'series'>): boolean => Number(page.series ?? 0) === 1;

export function seriesItem(page: Page, t: ReturnType<typeof useT>): MenuItem {
  const on = isSeries(page);
  return {
    id: 'series',
    label: t('page.series'),
    icon: <Icon name="calendar" size={14} />,
    hint: on ? '✓' : undefined,
    onSelect: () => update('page', page.id, { series: on ? 0 : 1 }),
  };
}

/**
 * Make the next entry of a series, and say where it went.
 *
 * The same rules the server's `addSeriesEntry` applies, with the same shared
 * functions: titled `<series> · YYYY-MM-DD` in this device's own day, never a
 * title already in use, and inheriting the series' project, type, labels and
 * access. The text is a template's or nothing — never the previous entry's,
 * which is how a scorecard for one week became an untouched copy of the last.
 */
export function useSeriesEntry(): (series: Page, template?: Page) => string {
  const me = useMe();
  const { workspaceId } = useSession();
  return (series, template) => {
    const taken = new Set(list('page', (page) => page.workspace_id === workspaceId).map((page) => pageKey(page.title || '')));
    return createPage({
      parent_id: series.id,
      project_id: series.project_id ?? null,
      access: series.access,
      title: seriesEntryTitle(series.title || '', localDay(Date.now()), taken),
      icon: series.icon ?? undefined,
      content: template?.content ?? '',
      format: template?.format ?? 'markdown',
      // The series says what kind of document its entries are; a template only
      // when the series has not.
      type_id: series.type_id ?? template?.type_id ?? null,
      labels: series.labels ?? [],
    }, me);
  };
}

/**
 * A series' entries, newest first, where its sub-pages would be.
 *
 * Newest first because the question a series is opened with is "the latest
 * one" — this week's minutes, this month's report — and in tree order that is
 * at the bottom of a list that only gets longer. The tree keeps its own order;
 * this is the series' view of the same rows.
 */
export function SeriesEntries({ page, entries }: { page: Page; entries: Page[] }) {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const { workspaceId } = useSession();
  const next = useSeriesEntry();
  const templates = useQuery(
    () => list('page', (one) => one.workspace_id === workspaceId && !!one.is_template && !one.archived) as Page[],
    [workspaceId],
  );
  const newest = useMemo(
    () => [...entries].sort((a, b) => b.created_at - a.created_at || comparePages(b, a)),
    [entries],
  );
  const start = (template?: Page) => navigate(`/pages/${next(page, template)}`);

  return (
    <section className="mt-7">
      <div className="flex items-center gap-2 mb-1">
        <SectionHeading tight>{t('page.seriesEntries')}</SectionHeading>
        <span className="flex-1 min-w-0" />
        {canWrite && (templates.length ? (
          <MenuButton
            variant="secondary" size="sm"
            items={[
              { id: 'entry-empty', label: t('page.seriesEmpty'), onSelect: () => start() },
              ...templates.map((template) => ({
                id: `entry-${template.id}`, section: t('page.seriesTemplates'),
                label: `${template.icon ?? '📄'} ${template.title}`,
                onSelect: () => start(template),
              })),
            ]}
          >
            <Icon name="plus" size={14} /> {t('page.seriesNew')}
          </MenuButton>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => start()}>
            <Icon name="plus" size={14} /> {t('page.seriesNew')}
          </Button>
        ))}
      </div>
      <p className="mt-0 mb-2 text-[12.5px] text-muted">{t('page.seriesHint')}</p>
      {!newest.length && <p className="text-muted text-[12.5px]">{t('page.seriesNone')}</p>}
      {newest.map((entry) => (
        <Link key={entry.id} to={`/pages/${entry.id}`} className="task-row text-left" style={{ width: '100%' }}>
          <span aria-hidden="true">{entry.icon ?? '📄'}</span>
          <span className="flex-1 min-w-0 truncate">{entry.title || t('common.untitled')}</span>
          <span className="text-[11.5px] text-muted">{shortDate(entry.created_at)}</span>
        </Link>
      ))}
    </section>
  );
}
