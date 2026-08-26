import type { ImportResult, SessionInfo, TaskReview } from '@kolibri/shared';
import { currentLocale, translate } from './i18n';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isOffline = (err: unknown): boolean => err instanceof TypeError || (err instanceof ApiError && err.status === 0);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : translate(currentLocale(), 'common.networkUnavailable'), 'offline');
  }

  const text = await response.text();
  const payload = text ? safeParse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.message ?? response.statusText, payload?.error ?? 'error');
  }
  return payload as T;
}

const safeParse = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
};

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, json(body ?? {})),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  config: () => request<{
    allowSignup: boolean; hasUsers: boolean; maxUploadBytes: number; version: string;
    sso: { label: string; only: boolean } | null;
    /** Null when no model is configured on this server. */
    ai: { provider: string } | null;
  }>('/api/config'),
  session: () => request<SessionInfo>('/api/session'),
  login: (email: string, password: string) => request<SessionInfo>('/api/auth/login', json({ email, password })),
  register: (body: { email: string; name: string; password: string; workspace?: string; invite?: string }) =>
    // The language goes with the sign-up so the starter project's workflow,
    // labels and templates are seeded in it rather than in English.
    request<SessionInfo>('/api/auth/register', json({ ...body, locale: currentLocale() })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', json({})),

  /**
   * Uploads go up as a raw body with the filename in a header — no multipart
   * boilerplate, and the browser can stream a large file straight through.
   */
  upload: async (
    workspaceId: string,
    file: Blob,
    name: string,
    link?: { task_id?: string; page_id?: string; comment_id?: string; thumb_url?: string },
  ) => {
    const query = new URLSearchParams(Object.entries(link ?? {}).filter(([, v]) => !!v) as [string, string][]);
    return request<{ url: string; hash: string; name: string; mime: string; size: number; width?: number; height?: number; attachment?: any }>(
      `/api/workspaces/${workspaceId}/files?${query}`,
      {
        method: 'POST',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(name) },
      },
    );
  },

  /**
   * An export archive, up as a raw body — the same shape an upload takes, and
   * for the same reason: the file is already one blob and multipart would only
   * wrap it in a second copy of itself.
   */
  postArchive: <T>(path: string, archive: ArrayBuffer) =>
    request<T>(path, { method: 'POST', body: archive, headers: { 'content-type': 'application/zip' } }),

  search: (workspaceId: string, query: string, kind?: string) =>
    request<{ results: { kind: string; id: string; title: string; snippet: string; project_id: string | null }[] }>(
      `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}${kind ? `&kind=${kind}` : ''}`,
    ),

  activity: (taskId: string) => request<any[]>(`/api/tasks/${taskId}/activity`),
  /**
   * Ask a model to read a task back.
   *
   * Slower than everything else in here — a model takes seconds, not
   * milliseconds — and nothing is written by it: what comes back is a
   * suggestion the person decides about. See `docs/ai.md`.
   */
  review: (taskId: string) => request<TaskReview>(`/api/tasks/${taskId}/review`, json({})),
  import: (workspaceId: string, body: {
    csv: string; project_id: string; mapping: Record<string, string>; delimiter?: string; dry_run: boolean;
  }) => request<ImportResult>(`/api/workspaces/${workspaceId}/import`, json(body)),
  members: (workspaceId: string) => request<any[]>(`/api/workspaces/${workspaceId}/members`),
  tokens: () => request<any[]>('/api/tokens'),
  calendar: () => request<{ url: string | null }>('/api/me/calendar'),
  calendarOn: () => request<{ url: string }>('/api/me/calendar', json({})),
  calendarRotate: () => request<{ url: string }>('/api/me/calendar/rotate', json({})),
  calendarOff: () => request<{ url: null }>('/api/me/calendar', { method: 'DELETE' }),
  sessions: () => request<any[]>('/api/sessions'),
  revokeSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  audit: (workspaceId: string, before?: number) =>
    request<{ entries: any[]; oldest: number | null }>(
      `/api/workspaces/${workspaceId}/audit${before ? `?before=${before}` : ''}`,
    ),
  startTwoFactor: () => request<{ secret: string; uri: string }>('/api/me/2fa', json({})),
  confirmTwoFactor: (code: string) => request<{ recovery_codes: string[] }>('/api/me/2fa/confirm', json({ code })),
  disableTwoFactor: (password: string) => request<{ ok: boolean }>('/api/me/2fa/off', json({ password })),
  createToken: (body: { name: string; workspaceId?: string; scopes?: string }) => request<{ token: string; id: string }>('/api/tokens', json(body)),
  revokeToken: (id: string) => request<{ ok: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' }),
  invites: (workspaceId: string) => request<any[]>(`/api/workspaces/${workspaceId}/invites`),
  createInvite: (workspaceId: string, role: string) => request<{ code: string; url: string }>(`/api/workspaces/${workspaceId}/invites`, json({ role })),
  acceptInvite: (code: string) => request<{ workspaceId: string; session: SessionInfo }>(`/api/invites/${code}/accept`, json({})),
  automationRuns: (id: string) => request<any[]>(`/api/automations/${id}/runs`),
  applyTemplate: (id: string, body: { project_id?: string; assignees?: string[] }) =>
    request<any>(`/api/templates/${id}/apply`, json(body)),
  pageVersions: (pageId: string) => request<any[]>(`/api/pages/${pageId}/versions`),
  pageVersion: (pageId: string, versionId: string) => request<any>(`/api/pages/${pageId}/versions/${versionId}`),
  restoreVersion: (pageId: string, versionId: string) => request<any>(`/api/pages/${pageId}/versions`, json({ restore: versionId })),
};
