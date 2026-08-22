/**
 * The projects you were just in, kept on this device.
 *
 * Not synced, for the same reason the folded sidebar branches are not: where I
 * have been is a fact about this browser, not about the workspace, and pushing
 * it as one would have two people's histories fighting over one list.
 *
 * A task sheet deliberately does not count as a visit. `/t/WEB-42` opens *over*
 * whatever you were looking at rather than taking you anywhere, and recording
 * it would reshuffle the strip on the screen behind the sheet — a list that
 * rearranges itself while you are not looking at it is worse than one that is a
 * navigation out of date.
 *
 * Containers *do* count, unlike in `active-project`. There the question is
 * "where does a new task go", which a container cannot answer; here it is
 * "where have you been", which it can.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Project } from '@kolibri/shared';
import { useLocation } from 'react-router-dom';
import { routeSubject } from './active-project';
import { byId, useQuery } from './store';

/**
 * How many to remember — comfortably more than any screen shows, so archiving
 * or deleting one thins the strip instead of emptying it.
 */
const KEEP = 12;

const KEY = (workspaceId: string) => `kolibri.recents.${workspaceId}`;

const EMPTY: string[] = [];

const listeners = new Set<() => void>();
let cache: { workspaceId: string; ids: string[] } | undefined;

function read(workspaceId: string): string[] {
  if (!workspaceId) return EMPTY;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY(workspaceId)) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : EMPTY;
  } catch {
    // A private window, or somebody else's JSON sitting in our key. Either way
    // the honest answer is "no history", not a crash on the home screen.
    return EMPTY;
  }
}

/**
 * The identity has to be stable across renders — `useSyncExternalStore` compares
 * snapshots by reference and would loop forever on a fresh array each time.
 */
function snapshot(workspaceId: string): string[] {
  if (cache?.workspaceId !== workspaceId) cache = { workspaceId, ids: read(workspaceId) };
  return cache.ids;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const announce = () => { for (const listener of [...listeners]) listener(); };

/** Another tab moved on. Drop what we cached rather than argue with it. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key && !event.key.startsWith('kolibri.recents.')) return;
    cache = undefined;
    announce();
  });
}

export function recordVisit(workspaceId: string, projectId: string): void {
  if (!workspaceId || !projectId) return;
  const current = snapshot(workspaceId);
  if (current[0] === projectId) return;
  const ids = [projectId, ...current.filter((id) => id !== projectId)].slice(0, KEEP);
  cache = { workspaceId, ids };
  try { localStorage.setItem(KEY(workspaceId), JSON.stringify(ids)); } catch { /* private window */ }
  announce();
}

/**
 * Watch the address bar and remember where it went.
 *
 * Mounted once, in the shell, so every route is seen — including the ones
 * reached by a link inside a task sheet.
 */
export function useRecordVisits(workspaceId: string): void {
  const { pathname } = useLocation();
  const projectId = useQuery(() => {
    const subject = routeSubject(pathname);
    if (!subject || subject.entity === 'task') return undefined;
    const id = subject.entity === 'project' ? subject.ref : byId(subject.entity, subject.ref)?.project_id;
    const project = byId('project', id);
    // Archived is left out on the way in rather than on the way out: it is not
    // somewhere you would want offered back, and keeping it would push a live
    // project off the end of the list to make room.
    return project && !project.archived ? project.id : undefined;
  }, [pathname]);

  useEffect(() => {
    if (projectId) recordVisit(workspaceId, projectId);
  }, [workspaceId, projectId]);
}

/** The last few projects, resolved and still real. */
export function useRecentProjects(workspaceId: string, limit: number): Project[] {
  const ids = useSyncExternalStore(subscribe, () => snapshot(workspaceId), () => EMPTY);
  return useQuery(
    () => ids
      .map((id) => byId('project', id))
      .filter((project): project is Project => !!project && !project.archived)
      .slice(0, limit),
    [ids, limit],
  );
}
