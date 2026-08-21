import { useLocation } from 'react-router-dom';
import { byId, list, useQuery } from './store';

/**
 * Which project the screen is about.
 *
 * Pressing `c` from a project board and being asked *which project* is the kind
 * of question a tool should not have to ask — the answer is on screen. The
 * board's own button already knew; the global one, the keyboard shortcut and
 * the phone's + did not, and fell back to whichever project was used last.
 *
 * The route parsing is separated from the store lookup on purpose: it is the
 * half with the edge cases (`/projects/new` is not a project, `/t/WEB-42` names
 * one only indirectly) and the half that can be tested without a browser.
 */

/** A route that names a project, or points at something that belongs to one. */
export interface RouteSubject {
  entity: 'project' | 'cycle' | 'module' | 'task';
  ref: string;
}

const AT: { prefix: string; entity: RouteSubject['entity'] }[] = [
  { prefix: '/projects/', entity: 'project' },
  { prefix: '/cycles/', entity: 'cycle' },
  { prefix: '/modules/', entity: 'module' },
  { prefix: '/t/', entity: 'task' },
];

/**
 * What a path is about, if anything.
 *
 * `/projects/new` is the one that has to be excluded by name: it matches the
 * prefix and is a form, not a project, and treating "new" as an id would file
 * the next task into nothing.
 */
export function routeSubject(pathname: string): RouteSubject | undefined {
  for (const { prefix, entity } of AT) {
    if (!pathname.startsWith(prefix)) continue;
    // One segment only — `/projects/x/anything` is still about `x`, but an
    // empty ref is not about anything.
    const ref = pathname.slice(prefix.length).split('/')[0];
    if (!ref || (entity === 'project' && ref === 'new')) return undefined;
    return { entity, ref: decodeURIComponent(ref) };
  }
  return undefined;
}

/**
 * The project a new task should go to by default, given where you are.
 *
 * A container is skipped rather than returned: it holds projects, not tasks, so
 * it is not somewhere a task can go — the create form leaves it out of its own
 * menu for the same reason, and handing it one it cannot show would leave the
 * form pointing at nothing.
 *
 * `undefined` is a real answer, and the right one from *My work* or the inbox:
 * the form then falls back to the last project used, which is the best guess
 * available when the screen is not about a project at all.
 */
export function useActiveProject(): string | undefined {
  const { pathname } = useLocation();
  return useQuery(() => {
    const subject = routeSubject(pathname);
    if (!subject) return undefined;
    const projectId = subject.entity === 'project'
      ? subject.ref
      // A task can be addressed by row id or by `WEB-42`; both have to land on
      // the same project, because both are what people paste.
      : subject.entity === 'task'
        ? (byId('task', subject.ref) ?? list('task', (task) => task.identifier === subject.ref)[0])?.project_id
        : byId(subject.entity, subject.ref)?.project_id;
    if (!projectId) return undefined;
    const project = byId('project', projectId);
    return project && !project.archived && !project.is_container ? project.id : undefined;
  }, [pathname]);
}
