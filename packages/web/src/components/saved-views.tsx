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
import { list, useQuery } from '../lib/store';
import { useMe, useSession } from '../session';
import { Icon, MenuButton, Sheet, useConfirm, useToast, type MenuItem } from './ui';
import type { GroupBy } from './task-parts';
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
  const [editing, setEditing] = useState<{ id?: string; name: string; shared: boolean } | null>(null);

  const views = useQuery(
    () => list('view', (row) => row.workspace_id === workspaceId
      && (row.project_id ?? null) === (projectId ?? null)
      // A private view is nobody else's business, including in the list.
      && (row.shared !== 0 || row.owner_id === me)).sort(byOrder),
    [workspaceId, projectId, me],
  );

  const active = views.find((row) => row.id === activeId);
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

  const save = (name: string, shared: boolean, id?: string) => {
    if (id) {
      update('view', id, { name, shared: shared ? 1 : 0, ...rowOf(view) });
      toast(t('view.saveUpdated', { name }));
      return;
    }
    const created = create('view', {
      workspace_id: workspaceId,
      project_id: projectId ?? null,
      team_id: null,
      name,
      icon: null,
      owner_id: me,
      shared: shared ? 1 : 0,
      sort_order: orderKey(views[views.length - 1]?.sort_order ?? null, null),
      ...rowOf(view),
    });
    select(created);
    toast(t('view.saveCreated', { name }));
  };

  const items: MenuItem[] = [
    ...views.map((row) => ({
      id: row.id,
      section: t('view.saved'),
      label: row.name,
      hint: row.id === activeId ? '✓' : row.shared === 0 ? t('view.private') : undefined,
      onSelect: () => apply(row),
    })),
    ...(active
      ? [
        {
          id: 'update',
          section: t('view.savedActions'),
          label: t('view.updateSaved', { name: active.name }),
          onSelect: () => save(active.name, active.shared !== 0, active.id),
        },
        {
          id: 'rename',
          section: t('view.savedActions'),
          label: t('view.renameSaved'),
          onSelect: () => setEditing({ id: active.id, name: active.name, shared: active.shared !== 0 }),
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
      onSelect: () => setEditing({ name: '', shared: true }),
    },
    ...(activeId
      ? [{
        id: 'clear-active',
        section: t('view.savedActions'),
        label: t('view.leaveSaved'),
        onSelect: () => { select(''); onChange(DEFAULT_VIEW); },
      }]
      : []),
  ];

  return (
    <>
      <MenuButton className="btn sm" items={items} search={views.length > 6}>
        <Icon name="bookmark" size={14} />
        <span className="truncate" style={{ maxWidth: 140 }}>
          {active ? active.name : t('view.saved')}
        </span>
        {/* A dot rather than a word: it says "not saved" without taking a line. */}
        {modified && <span className="dot-modified" title={t('view.unsavedChanges')} aria-label={t('view.unsavedChanges')} />}
      </MenuButton>
      {editing && (
        <ViewNameSheet
          initial={editing}
          existing={views.filter((row) => row.id !== editing.id).map((row) => row.name)}
          onClose={() => setEditing(null)}
          onSave={(name, shared) => { save(name, shared, editing.id); setEditing(null); }}
        />
      )}
      {dialog}
    </>
  );
}

function ViewNameSheet({
  initial, existing, onClose, onSave,
}: {
  initial: { id?: string; name: string; shared: boolean };
  existing: string[];
  onClose: () => void;
  onSave: (name: string, shared: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [shared, setShared] = useState(initial.shared);
  const trimmed = name.trim();
  // Two views called "Mine" in one menu is a trap, so say so before saving.
  const duplicate = existing.some((other) => other.toLowerCase() === trimmed.toLowerCase());

  return (
    <Sheet
      title={initial.id ? t('view.renameSaved') : t('view.saveAsNew')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button className="btn primary" disabled={!trimmed || duplicate} onClick={() => onSave(trimmed, shared)}>
            {t('action.save')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="view-name">{t('view.name')}</label>
        <input
          id="view-name"
          autoFocus
          value={name}
          placeholder={t('view.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && trimmed && !duplicate) onSave(trimmed, shared); }}
        />
        {duplicate && <span className="hint warn">{t('view.nameTaken')}</span>}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
        <span>
          <span>{t('view.shareWithTeam')}</span>
          <span className="hint">{shared ? t('view.sharedHint') : t('view.privateHint')}</span>
        </span>
      </label>
    </Sheet>
  );
}
