import { useCallback } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';
import type { Task } from '@kolibri/shared';
import { byId, list, useQuery } from '../sync/store';
import { nextTaskState } from './task-stack.ts';

/**
 * Tasks live at `/t/:id` so they can be linked and shared, but they open as a
 * sheet over whatever you were looking at. We remember that screen in the
 * router state; a direct link (no state) falls back to "My work" behind it.
 *
 * The stack arithmetic lives in `task-stack.ts` — no imports, so it can be
 * tested without a browser.
 */
export function useOpenTask(): (task: Task | { id: string }) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (task) => navigate(`/t/${task.id}`, { state: nextTaskState(location) }),
    [navigate, location],
  );
}

export const backgroundOf = (location: Location): Location | undefined =>
  (location.state as { background?: Location } | null)?.background;

export { stackDepth } from './task-stack.ts';

/**
 * The task a `/t/...` link names, whether that is a row id or `WEB-42`.
 *
 * Both are worth supporting for the same reason: the id is what the app links
 * to internally and never changes, and the identifier is what people actually
 * write — in a chat message, in a commit, in a note to themselves. A reference
 * typed as `WEB-42` has to land on the same sheet as a link clicked in a list,
 * or it is decoration.
 *
 * Unknown either way, the ref is handed back unchanged so the detail view can
 * say it cannot find it, rather than opening something else.
 */
export function useTaskRef(ref: string): string {
  return useQuery(
    () => (byId('task', ref) ? ref : list('task', (task) => task.identifier === ref)[0]?.id ?? ref),
    [ref],
  );
}
