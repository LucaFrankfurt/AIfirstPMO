import { useCallback } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';
import type { Task } from '@kolibri/shared';

/**
 * Tasks live at `/t/:id` so they can be linked and shared, but they open as a
 * sheet over whatever you were looking at. We remember that screen in the
 * router state; a direct link (no state) falls back to "My work" behind it.
 */
export function useOpenTask(): (task: Task | { id: string }) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (task) => {
      const background = (location.state as { background?: Location } | null)?.background ?? location;
      navigate(`/t/${task.id}`, { state: { background } });
    },
    [navigate, location],
  );
}

export const backgroundOf = (location: Location): Location | undefined =>
  (location.state as { background?: Location } | null)?.background;
