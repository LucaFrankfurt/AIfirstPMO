/**
 * Saved views.
 *
 * A view is a filter set with a name. The `view` entity has synced since the
 * first release and nothing could create one, which made it the widest gap
 * between what the data model does and what you can click.
 *
 * Two scopes, decided by where the control is rendered: a view saved on a
 * project belongs to that project, one saved on **My work** belongs to the
 * workspace and follows you across projects.
 *
 * Shared is the default. A view is a way of looking, and a team that looks at
 * the same things agrees faster; the private option is there for the half-built
 * one you are still fiddling with.
 */
import { useMemo, useState } from 'react';
import type { Filters, Layout, View } from '@kolibri/shared';
import { orderKey } from '@kolibri/shared';
import { useT } from '../lib/i18n';
import { byOrder, create, remove, update } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useCanWrite, useMe, useSession } from '../session';
import { Icon, MenuButton, Sheet, useConfirm, useToast, type IconName, type MenuItem } from './ui';
import type { GroupBy } from './task-parts';
import { ShareSheet, type ShareTarget } from './share';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { DEFAULT_VIEW, type ViewConfig } from './views';

/** The stored row, read back as the shape the screens work in. */
export function configOf(row: View): ViewConfig {
  return {
    layout: (row.layout ?? DEFAULT_VIEW.layout) as Layout,
    groupBy: (row.group_by ?? DEFAULT_VIEW.groupBy) as GroupBy,
    orderBy: (row.order_by ?? DEFAULT_VIEW.orderBy) as ViewConfig['orderBy'],
    filters: (row.filters ?? {}) as Filters,
    showDone: row.show_done !== 0,
  };
}

const rowOf = (config: ViewConfig) => ({
  layout: config.layout,
  group_by: config.groupBy,
  order_by: config.orderBy,
  filters: config.filters,
  show_done: config.showDone ? 1 : 0,
});

/** Same view, ignoring key order — used to tell "saved" from "saved, then changed". */
const sameConfig = (a: ViewConfig, b: ViewConfig): boolean =>
  a.layout === b.layout && a.groupBy === b.groupBy && a.orderBy === b.orderBy && a.showDone === b.showDone
  && JSON.stringify(sortedFilters(a.filters)) === JSON.stringify(sortedFilters(b.filters));

function sortedFilters(filters: Filters): [string, unknown][] {
  return Object.entries(filters)
    .filter(([, value]) => (Array.isArray(value) ? value.length : value !== undefined))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as [string, unknown])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Remembering which view is open is a per-device preference, not shared state. */
const ACTIVE_KEY = (scope: string) => `kolibri.view.active.${scope}`;

/**
 * Icons a view can wear.
 *
 * A short list rather than an open field: the point of an icon here is to make
 * one row in a menu findable at a glance, which a hundred choices actively work
 * against. Chosen for the shapes of work people actually save a view for.
 */
export const VIEW_ICONS: readonly IconName[] = [
  'bookmark', 'bolt', 'target', 'bell', 'shield', 'sparkle',
  'board', 'calendar', 'users', 'inbox', 'cycle', 'archive',
];

/**
 * The view a project opens on, if somebody pinned one.
 *
 * Stored on the *project* rather than as a flag on the view, so two people
 * pinning two different views merge into one answer instead of leaving two rows
 * each claiming to be the default. A pin pointing at a view that has since been
 * deleted or made private simply finds nothing, which is the right amount of
 * fuss to make about it.
 */
export function useProjectDefaultView(projectId: string | undefined, me: string): View | undefined {
  return useQuery(() => {
    if (!projectId) return undefined;
    const pinned = byId('project', projectId)?.default_view_id;
    if (!pinned) return undefined;
    const view = byId('view', pinned);
    return view && (view.shared !== 0 || view.owner_id === me) ? view : undefined;
  }, [projectId, me]);
}

export function SavedViews({
  view, onChange, projectId,
}: { view: ViewConfig; onChange: (next: ViewConfig) => void; projectId?: string }) {
  const t = useT();
  const me = useMe();
  const { workspaceId } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const scope = projectId ?? 'workspace';

  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(ACTIVE_KEY(scope)) ?? '');
  const [editing, setEditing] = useState<{ id?: string; name: string; shared: boolean; icon: string | null } | null>(null);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const canWrite = useCanWrite();
  const pinned = useProjectDefaultView(projectId, me);

  const views = useQuery(
    () => list('view', (row) => row.workspace_id === workspaceId
      && (row.project_id ?? null) === (projectId ?? null)
      // A private view is nobody else's business, including in the list.
      && (row.shared !== 0 || row.owner_id === me)).sort(byOrder),
    [workspaceId, projectId, me],
  );

  // What is open: this device's own choice, or — if it has never made one —
  // the view the project is pinned to. A fallback rather than a write, so
  // clearing the pin puts everybody back on the plain list without leaving a
  // stale name in the button.
  const active = views.find((row) => row.id === (activeId || pinned?.id));
  // Applying a view then nudging a filter should not silently rewrite it.
  const modified = useMemo(() => !!active && !sameConfig(view, configOf(active)), [active, view]);

  const select = (id: string) => {
    setActiveId(id);
    if (id) localStorage.setItem(ACTIVE_KEY(scope), id);
    else localStorage.removeItem(ACTIVE_KEY(scope));
  };

  const apply = (row: View) => {
    select(row.id);
    onChange(configOf(row));
  };

  const save = (name: string, shared: boolean, icon: string | null, id?: string) => {
    if (id) {
      update('view', id, { name, icon, shared: shared ? 1 : 0, ...rowOf(view) });
      toast(t('view.saveUpdated', { name }));
      return;
    }
    const created = create('view', {
      workspace_id: workspaceId,
      project_id: projectId ?? null,
      team_id: null,
      name,
      icon,
      owner_id: me,
      shared: shared ? 1 : 0,
      sort_order: orderKey(views[views.length - 1]?.sort_order ?? null, null),
      ...rowOf(view),
    });
    select(created);
    toast(t('view.saveCreated', { name }));
  };

  /**
   * Pin this view as what the project opens on.
   *
   * Only for a shared view: a default nobody else can see is a project that
   * opens on an empty list for everybody but its author.
   */
  const pin = (row: View | undefined) => {
    if (!projectId) return;
    update('project', projectId, { default_view_id: row?.id ?? null });
    toast(row ? t('view.pinned', { name: row.name }) : t('view.unpinned'));
  };

  const items: MenuItem[] = [
    ...views.map((row) => ({
      id: row.id,
      section: t('view.saved'),
      label: row.name,
      icon: <Icon name={row.icon ?? 'bookmark'} size={14} />,
      hint: row.id === activeId ? '✓'
        : row.id === pinned?.id ? t('view.isDefault')
          : row.shared === 0 ? t('view.private') : undefined,
      onSelect: () => apply(row),
    })),
    ...(active
      ? [
        {
          id: 'update',
          section: t('view.savedActions'),
          label: t('view.updateSaved', { name: active.name }),
          onSelect: () => save(active.name, active.shared !== 0, active.icon, active.id),
        },
        {
          id: 'rename',
          section: t('view.savedActions'),
          label: t('view.renameSaved'),
          onSelect: () => setEditing({ id: active.id, name: active.name, shared: active.shared !== 0, icon: active.icon }),
        },
        // Only where a project can hold one, and only for a view everybody has.
        ...(projectId && canWrite && active.shared !== 0
          ? [{
            id: 'pin',
            section: t('view.savedActions'),
            label: active.id === pinned?.id ? t('view.unpin') : t('view.pin'),
            onSelect: () => pin(active.id === pinned?.id ? undefined : active),
          }]
          : []),
        {
          id: 'share',
          section: t('view.savedActions'),
          label: t('share.action'),
          // A share points at a *saved* view: an unsaved set of filters is not
          // a thing a link can keep meaning tomorrow.
          onSelect: () => setSharing({ kind: 'tasks', view_id: active.id, project_id: projectId ?? null, name: active.name }),
        },
        {
          id: 'delete',
          section: t('view.savedActions'),
          label: t('view.deleteSaved'),
          danger: true,
          onSelect: async () => {
            if (!(await confirm(t('view.deleteConfirm', { name: active.name })))) return;
            remove('view', active.id);
            select('');
            toast(t('view.deleted', { name: active.name }));
          },
        },
      ]
      : []),
    {
      id: 'save-new',
      section: t('view.savedActions'),
      label: t('view.saveAsNew'),
      onSelect: () => setEditing({ name: '', shared: true, icon: null }),
    },
    // "Back to the default view" means whatever this project opens on: the
    // pinned view where there is one, the plain list where there is not. It is
    // hidden when the open view already *is* the pin, where it would do nothing.
    ...(activeId && activeId !== pinned?.id
      ? [{
        id: 'clear-active',
        section: t('view.savedActions'),
        label: t('view.leaveSaved'),
        onSelect: () => { select(''); onChange(pinned ? configOf(pinned) : DEFAULT_VIEW); },
      }]
      : []),
  ];

  return (
    <>
      <MenuButton variant="secondary" size="sm" items={items} search={views.length > 6}>
        <Icon name={active?.icon ?? 'bookmark'} size={14} />
        <span className={`truncate saved-view-name${active ? '' : ' hide-sm'}`} style={{ maxWidth: 140 }}>
          {active ? active.name : t('view.saved')}
        </span>
        {/* A dot rather than a word: it says "not saved" without taking a line. */}
        {modified && <span className="dot-modified" title={t('view.unsavedChanges')} aria-label={t('view.unsavedChanges')} />}
      </MenuButton>
      {sharing && <ShareSheet target={sharing} onClose={() => setSharing(null)} />}
      {editing && (
        <ViewNameSheet
          initial={editing}
          existing={views.filter((row) => row.id !== editing.id).map((row) => row.name)}
          onClose={() => setEditing(null)}
          onSave={(name, shared, icon) => { save(name, shared, icon, editing.id); setEditing(null); }}
        />
      )}
      {dialog}
    </>
  );
}

function ViewNameSheet({
  initial, existing, onClose, onSave,
}: {
  initial: { id?: string; name: string; shared: boolean; icon: string | null };
  existing: string[];
  onClose: () => void;
  onSave: (name: string, shared: boolean, icon: string | null) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [shared, setShared] = useState(initial.shared);
  const [icon, setIcon] = useState<string | null>(initial.icon);
  const trimmed = name.trim();
  // Two views called "Mine" in one menu is a trap, so say so before saving.
  const duplicate = existing.some((other) => other.toLowerCase() === trimmed.toLowerCase());
  const done = () => onSave(trimmed, shared, icon);

  return (
    <Sheet
      title={initial.id ? t('view.renameSaved') : t('view.saveAsNew')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={!trimmed || duplicate} onClick={done}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="view-name">{t('view.name')}</label>
        <input
          id="view-name"
          className="input"
          autoFocus
          value={name}
          placeholder={t('view.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && trimmed && !duplicate) done(); }}
        />
        {duplicate && <span className="text-[12px] text-danger">{t('view.nameTaken')}</span>}
      </div>

      {/* A dozen shapes, not a picker: the icon is here to make one row in a
          menu findable at a glance, and more choices make that harder. */}
      <div className="field">
        <label>{t('view.icon')}</label>
        <div className="flex items-center gap-2 flex-wrap icon-choices" role="radiogroup" aria-label={t('view.icon')}>
          {VIEW_ICONS.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={icon === choice}
              aria-label={choice}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), icon === choice && 'bg-active text-fg')}
              style={icon === choice ? { background: 'var(--bg-active)' } : undefined}
              onClick={() => setIcon(icon === choice ? null : choice)}
            >
              <Icon name={choice} size={15} />
            </button>
          ))}
        </div>
        <span className="text-[12px] text-muted">{t('view.iconHint')}</span>
      </div>

      <label className="check-row">
        <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
        <span>
          <span>{t('view.shareWithTeam')}</span>
          <span className="text-[12px] text-muted">{shared ? t('view.sharedHint') : t('view.privateHint')}</span>
        </span>
      </label>
    </Sheet>
  );
}
