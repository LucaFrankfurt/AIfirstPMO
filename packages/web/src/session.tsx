import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionInfo, User, WorkspaceFeatures, WorkspaceRole } from '@kolibri/shared';
import { api, ApiError } from './lib/api';
import * as idb from './lib/idb';
import { byId, list, useQuery } from './lib/store';
import { signOutLocal, start } from './lib/sync';

interface SessionValue {
  ready: boolean;
  session: SessionInfo | null;
  /** `two_factor` is derived by the server; the secret itself never leaves it. */
  user: (User & { two_factor?: boolean }) | null;
  workspaceId: string;
  role: WorkspaceRole;
  setWorkspace: (id: string) => void;
  signIn: (session: SessionInfo) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** True when the cached session is used because the network is unreachable. */
  offlineSession: boolean;
}

const Context = createContext<SessionValue | null>(null);
const WORKSPACE_KEY = 'kolibri.workspace';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [offlineSession, setOfflineSession] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(WORKSPACE_KEY) ?? '');

  const adopt = useCallback(async (next: SessionInfo, cached = false) => {
    setSession(next);
    setOfflineSession(cached);
    if (!cached) await idb.setMeta('session', next);
    const preferred = next.workspaces.find((w) => w.id === localStorage.getItem(WORKSPACE_KEY)) ?? next.workspaces[0];
    if (preferred) {
      setWorkspaceId(preferred.id);
      localStorage.setItem(WORKSPACE_KEY, preferred.id);
      await start(preferred.id);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const live = await api.session();
        if (!cancelled) await adopt(live);
      } catch (err) {
        // Offline start-up: fall back to the cached session so the app opens.
        const cached = await idb.getMeta<SessionInfo>('session');
        if (!cancelled && cached && err instanceof ApiError && err.status === 0) await adopt(cached, true);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  useEffect(() => {
    const onSignedOut = () => {
      setSession(null);
      void signOutLocal();
    };
    window.addEventListener('kolibri:signed-out', onSignedOut);
    return () => window.removeEventListener('kolibri:signed-out', onSignedOut);
  }, []);

  const value = useMemo<SessionValue>(() => ({
    ready,
    session,
    user: session?.user ?? null,
    workspaceId,
    role: session?.workspaces.find((w) => w.id === workspaceId)?.role ?? 'member',
    offlineSession,
    setWorkspace: (id: string) => {
      localStorage.setItem(WORKSPACE_KEY, id);
      setWorkspaceId(id);
      void start(id);
    },
    signIn: async (next: SessionInfo) => {
      await adopt(next);
    },
    signOut: async () => {
      try {
        await api.logout();
      } catch {
        /* signing out locally matters more than telling the server */
      }
      await signOutLocal();
      await idb.setMeta('session', null);
      localStorage.removeItem(WORKSPACE_KEY);
      setSession(null);
      setWorkspaceId('');
    },
    refresh: async () => {
      const live = await api.session();
      setSession(live);
      await idb.setMeta('session', live);
    },
  }), [ready, session, workspaceId, offlineSession, adopt]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Context);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/**
 * Whether this person may write in this workspace.
 *
 * A guest is refused by the server, correctly — but showing them a New task
 * button that will fail is a worse experience than not showing it. One hook, so
 * the answer is in one place rather than repeated as `role !== 'guest'` in
 * fifteen components.
 */
export function useCanWrite(): boolean {
  return useSession().role !== 'guest';
}

/**
 * Whether a feature is switched on in the workspace being looked at.
 *
 * One hook rather than `session.workspaces.find(...)` in each place that cares,
 * for the same reason `useCanWrite` exists: a rule spelled out at five call
 * sites is a rule that will be spelled out differently at the sixth.
 */
export function useFeature(name: keyof WorkspaceFeatures): boolean {
  const { session, workspaceId } = useSession();
  return !!session?.workspaces.find((workspace) => workspace.id === workspaceId)?.features?.[name];
}

/**
 * The same question, asked of several features at once.
 *
 * A screen that renders a list of feature-gated things cannot call `useFeature`
 * per row — hooks do not go in loops — so it gets the predicate instead. Same
 * lookup, once.
 */
export function useFeatures(): (name: keyof WorkspaceFeatures) => boolean {
  const { session, workspaceId } = useSession();
  const features = session?.workspaces.find((workspace) => workspace.id === workspaceId)?.features;
  return (name) => !!features?.[name];
}

/** The signed-in user's id — used constantly, so it gets its own hook. */
export function useMe(): string {
  return useSession().user?.id ?? '';
}

/** Workspace members, straight from the synced cache. */
export function useMembers(): User[] {
  const { workspaceId } = useSession();
  return useQuery(() => {
    const users = list('member', (m) => m.workspace_id === workspaceId)
      .map((m) => byId('user', m.user_id))
      .filter((u): u is User => !!u);
    return users.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [workspaceId]);
}

/**
 * Everybody this device knows a name for.
 *
 * `useMembers` is *the workspace's* people, which is the right list for
 * assigning work and for putting somebody in a channel. It is the wrong list
 * for a direct conversation: that can be with somebody in none of your
 * workspaces, and their `user` row is synced precisely so they have a name
 * here. Looking them up in the member map instead is how a conversation ends up
 * titled with a raw id and its messages signed "someone".
 */
export function usePeople(): Map<string, User> {
  return useQuery(() => new Map(list('user', (user) => !user.deleted_at).map((user) => [user.id, user])), []);
}

/** Lookup helper for rendering assignee avatars without repeated scans. */
export function useMemberMap(): Map<string, User> {
  const members = useMembers();
  return useMemo(() => new Map(members.map((user) => [user.id, user])), [members]);
}

/**
 * Whether this person may see money at all.
 *
 * Owners and admins; everybody else is not merely hidden from the figures, a
 * member's device never receives a rate row in the first place. Asked here
 * rather than from the rate screens, because the same question is asked by the
 * timesheet, by project insights and by settings — three different areas that
 * should not have to import one another to find out. See `docs/modules.md`.
 */
export function useSeesMoney(): boolean {
  const { role } = useSession();
  return role === 'owner' || role === 'admin';
}
