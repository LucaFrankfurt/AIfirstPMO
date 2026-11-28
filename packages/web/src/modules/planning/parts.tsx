/**
 * What the cycle and module screens share: which projects a scope can name,
 * the tasks a narrower one would strand, the way back to the list.
 */
import { coversProject, type ProjectScope } from '@kolibri/shared';
import type { Crumb } from '../../kernel/design-system/chrome';
import { Icon } from '../../kernel/design-system/ui/icon';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useSession } from '../../kernel/identity/session';

/**
 * The projects a cycle or a milestone could be given to.
 *
 * The same list QuickAdd offers, and scoped the same way: this workspace's (the
 * local store holds the ones from before a switch too), not archived, and no
 * containers — a container holds projects rather than tasks, so it is not
 * somewhere a cycle's work can be.
 */
export function useScopeTargets() {
  const { workspaceId } = useSession();
  return useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived && !p.is_container)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
}

/**
 * The work a chosen scope would leave behind.
 *
 * Only ever on an edit — a cycle or a milestone being made holds nothing yet.
 * `coversProject` is the same function the server's SQL mirrors, so what this
 * warns about and what `update_cycle` reports cannot disagree.
 */
export function useStranded(field: 'cycle_id' | 'module_id', id: string | undefined, settled: ProjectScope) {
  const projects = (settled.projects ?? []).join(',');
  return useQuery(
    () => (id
      ? list('task', (task) => task[field] === id && !coversProject(settled, task.project_id))
      : []),
    [field, id, settled.project_id, projects],
  );
}

/**
 * The way back out of a cycle or a milestone.
 *
 * Neither has a list of its own — both are a tab inside a project — so the
 * trail names the project and the tab, which is exactly the screen somebody
 * came from. `?tab=` is already how a link points at one, so this is the same
 * address the tab strip writes.
 *
 * A cycle or milestone several projects run has no single project to go back
 * to; the comments on both screens say so about scoping a view, and it is the
 * same fact here. Those get the project list, which is the honest answer rather
 * than picking one of the projects and calling it the parent.
 */
export function planningCrumbs(projectId: string | null | undefined, tab: 'cycles' | 'modules', label: string): Crumb[] {
  const project = projectId ? byId('project', projectId) : undefined;
  return [
    { to: '/projects', label, icon: <Icon name="board" size={13} /> },
    ...(project ? [{ to: `/projects/${project.id}?tab=${tab}`, label: project.name, icon: project.icon }] : []),
  ];
}
