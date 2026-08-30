/**
 * Everything this instance holds about one person, as a document they can
 * read.
 *
 * Not an import format and not a backup: nothing reads this back. It answers a
 * different question — *what do you have on me* — and the honest answer to
 * that is a file somebody can open, not a promise that they could get it if
 * they asked.
 *
 * What it includes is drawn per table rather than per feature, because the
 * question is about the database and not about the screens: a feature list
 * goes stale the moment a table gains a column, and the way this goes wrong is
 * by quietly leaving something out.
 *
 * What it leaves out is only ever **secrets**, and each one for the same
 * reason — handing it back in a file makes a copy of it that the person cannot
 * revoke:
 *
 *   - the password hash, the two-factor secret and the recovery codes,
 *   - session and API token hashes, and the calendar feed's token,
 *   - the push subscription's endpoint and keys, which are a capability to
 *     send to that browser.
 *
 * The *existence* of each of those is in the file, with its dates. Knowing you
 * have four devices signed in is the useful half, and it is the half that is
 * not a credential.
 */
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { notFound } from '../../kernel/platform/http.ts';

export const PERSONAL_FORMAT = 'kolibri.person/1';

export interface PersonalDoc {
  format: string;
  exported_at: string;
  account: Record<string, unknown>;
  workspaces: { name: string; role: string; joined: string | null }[];
  teams: { workspace: string; name: string; role: string }[];
  projects: { workspace: string; name: string; role: string }[];
  tasks: { assigned: Record<string, unknown>[]; created: Record<string, unknown>[] };
  comments: Record<string, unknown>[];
  pages: Record<string, unknown>[];
  time_entries: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  files: Record<string, unknown>[];
  saved_views: Record<string, unknown>[];
  /** Signed-in devices and issued tokens — what they are, never the secret. */
  devices: Record<string, unknown>[];
  api_tokens: Record<string, unknown>[];
  /** Channels a notification can go to, and whether each is switched on. */
  delivery: Record<string, unknown>;
}

const at = (value: unknown): string | null => (value ? new Date(Number(value)).toISOString() : null);

export function exportPerson(userId: string): PersonalDoc {
  const user = get<Row>(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, userId);
  if (!user) throw notFound('No such account');

  const workspaces = all<Row>(
    `SELECT w.name, m.role, m.created_at FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND m.deleted_at IS NULL`,
    userId,
  ).map((row) => ({ name: String(row.name), role: String(row.role), joined: at(row.created_at) }));

  const taskColumns = `t.identifier, t.title, t.description, t.priority, t.start_date, t.due_date,
                       t.estimate, t.completed_at, t.archived, t.created_at,
                       p.name AS project, s.name AS state`;
  const taskFrom = `FROM tasks t
                      JOIN projects p ON p.id = t.project_id
                      LEFT JOIN states s ON s.id = t.state_id
                     WHERE t.deleted_at IS NULL`;

  return {
    format: PERSONAL_FORMAT,
    exported_at: new Date().toISOString(),
    account: {
      name: user.name,
      email: user.email,
      avatar_url: user.avatar_url,
      timezone: user.timezone,
      locale: user.locale,
      bio: user.bio,
      digest: user.digest,
      instance_admin: !!user.is_admin,
      created_at: at(user.created_at),
      last_seen_at: at(user.last_seen_at),
      two_factor: user.totp_confirmed_at ? { enabled: true, confirmed_at: at(user.totp_confirmed_at) } : { enabled: false },
    },
    workspaces,
    teams: all<Row>(
      `SELECT w.name AS workspace, t.name, tm.role FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         JOIN workspaces w ON w.id = tm.workspace_id
        WHERE tm.user_id = ? AND tm.deleted_at IS NULL`,
      userId,
    ).map((row) => ({ workspace: String(row.workspace), name: String(row.name), role: String(row.role) })),
    projects: all<Row>(
      `SELECT w.name AS workspace, p.name, pm.role FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         JOIN workspaces w ON w.id = pm.workspace_id
        WHERE pm.user_id = ? AND pm.deleted_at IS NULL`,
      userId,
    ).map((row) => ({ workspace: String(row.workspace), name: String(row.name), role: String(row.role) })),
    tasks: {
      // `json_each` rather than a LIKE on the JSON: an id is a substring of
      // nothing else, but a query that relies on that is one schema change
      // away from being wrong.
      assigned: all<Row>(
        `SELECT ${taskColumns} ${taskFrom}
           AND EXISTS (SELECT 1 FROM json_each(t.assignees) WHERE json_each.value = ?)
         ORDER BY t.created_at`,
        userId,
      ),
      created: all<Row>(`SELECT ${taskColumns} ${taskFrom} AND t.created_by = ? ORDER BY t.created_at`, userId),
    },
    comments: all<Row>(
      `SELECT c.body, c.created_at, c.updated_at, t.identifier AS task, p.title AS page
         FROM comments c
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN pages p ON p.id = c.page_id
        WHERE c.author_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at`,
      userId,
    ),
    pages: all<Row>(
      `SELECT title, content, created_at, updated_at FROM pages
        WHERE created_by = ? AND deleted_at IS NULL ORDER BY created_at`,
      userId,
    ),
    time_entries: all<Row>(
      `SELECT e.minutes, e.spent_on, e.note, e.created_at, t.identifier AS task, p.name AS project
         FROM time_entries e
         LEFT JOIN tasks t ON t.id = e.task_id
         LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.user_id = ? AND e.deleted_at IS NULL ORDER BY e.spent_on`,
      userId,
    ),
    // Their own messages, in every room — including the direct ones, where
    // half of the conversation is theirs and the other half is somebody
    // else's and so is not in this file.
    messages: all<Row>(
      `SELECT m.body, m.created_at, m.edited_at, c.name AS channel, c.kind
         FROM messages m
         LEFT JOIN channels c ON c.id = m.channel_id
        WHERE m.author_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at`,
      userId,
    ),
    notifications: all<Row>(
      `SELECT kind, title, body, read_at, created_at FROM notifications
        WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5000`,
      userId,
    ),
    files: all<Row>(
      `SELECT hash, name, mime, size, created_at FROM files WHERE created_by = ? ORDER BY created_at`,
      userId,
    ),
    saved_views: all<Row>(
      `SELECT name, layout, filters, group_by, order_by, shared, created_at FROM views
        WHERE owner_id = ? AND deleted_at IS NULL`,
      userId,
    ),
    devices: all<Row>(
      `SELECT user_agent, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at`,
      userId,
    ).map((row) => ({
      user_agent: row.user_agent,
      created_at: at(row.created_at),
      last_used_at: at(row.last_used_at),
      expires_at: at(row.expires_at),
    })),
    api_tokens: all<Row>(
      `SELECT name, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE user_id = ?`,
      userId,
    ).map((row) => ({
      name: row.name,
      scopes: row.scopes,
      created_at: at(row.created_at),
      last_used_at: at(row.last_used_at),
      expires_at: at(row.expires_at),
      revoked_at: at(row.revoked_at),
    })),
    delivery: {
      email_digest: user.digest,
      telegram: user.telegram_chat_id ? { linked: true, linked_at: at(user.telegram_linked_at), preference: user.telegram_prefs } : { linked: false },
      calendar_feed: user.calendar_token ? 'a subscription URL has been issued' : 'none issued',
      push_devices: Number(get<Row>(`SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?`, userId)?.n ?? 0),
    },
  };
}
