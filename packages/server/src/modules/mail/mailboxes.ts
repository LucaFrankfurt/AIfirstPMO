/**
 * Which mailboxes a person may read, and the credential to open one.
 *
 * Everything that reads mail comes through here first — the REST routes, the
 * MCP tools, the search, the analytics — because a mailbox is the only thing in
 * this product where "may I see it" and "may I see the rows underneath it" are
 * answered by two different tables, and a query that forgot the first is a
 * query that reads somebody's payroll inbox.
 *
 * So there is exactly one function that answers it and every reader takes its
 * result as a list of ids to constrain on. That is `visibleProjectIds`'s shape,
 * deliberately: it is the arrangement in this repository that has never leaked,
 * because a caller who forgets it gets no rows rather than all of them.
 */
import { canReadMailbox, isMailboxAccess, type Mailbox, type MailboxScope } from '@kolibri/shared';
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';
import { hasFeature } from '../../kernel/platform/features.ts';
import { seal } from '../../kernel/platform/seal.ts';
import type { MailboxConfig } from '../../kernel/mail/mailbox.ts';
import { accessTokenFor, PURPOSE, storedCredential } from './oauth.ts';

/**
 * Every mailbox in this workspace this person may read.
 *
 * Returns nothing at all when the feature is off, rather than the rows with a
 * screen hidden in front of them. The switch has to mean something at the read
 * path or it is decoration: a workspace that turned mail off and still answered
 * `search_mail` over MCP would have turned off the screens and nothing else.
 */
export function visibleMailboxes(userId: string, workspaceId: string): Row[] {
  if (!hasFeature(workspaceId, 'mail')) return [];
  const rows = all<Row>(
    `SELECT * FROM mailboxes WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY address`,
    workspaceId,
  );
  return rows.filter((row) => canReadMailbox(scopeOf(row), userId));
}

/** The ids alone, which is what a query needs. Empty is a real answer. */
export const visibleMailboxIds = (userId: string, workspaceId: string): string[] =>
  visibleMailboxes(userId, workspaceId).map((row) => String(row.id));

/**
 * One mailbox, by id or by address, if this person may read it.
 *
 * By address as well as by id because that is how somebody refers to one out
 * loud — "look in support@" — and an assistant relaying a person's words should
 * not have to look up a uuid first. Both are scoped to the workspace and both
 * go through the same visibility check; there is no path here that takes an id
 * and trusts it.
 */
export function findMailbox(ref: string, userId: string, workspaceId: string): Row | undefined {
  const wanted = ref.trim().toLowerCase();
  return visibleMailboxes(userId, workspaceId).find(
    (row) => String(row.id) === ref || String(row.address).toLowerCase() === wanted,
  );
}

/**
 * The two columns the access rule reads, off a raw row.
 *
 * An `access` the column should not hold reads as `members`, which with an
 * empty list means nobody. That is the direction a corrupted or hand-edited row
 * should fail in: a value nobody recognises opening an inbox to the whole
 * workspace is the one outcome worth writing a line of code to prevent.
 */
export const scopeOf = (row: Row): MailboxScope => ({
  access: isMailboxAccess(row.access) ? row.access : 'members',
  members: parseList(row.members),
});

const parseList = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** What the API adds to a synced row: how it signs in, never what with. */
export type MailboxView = Mailbox & {
  has_password: boolean;
  auth: 'none' | 'password' | 'oauth';
  provider: string;
};

/** A row as the API returns it: the JSON columns parsed, the counts as numbers. */
export function mailboxView(row: Row): MailboxView {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    address: String(row.address),
    name: String(row.name ?? ''),
    host: String(row.host ?? ''),
    port: Number(row.port ?? 993),
    encryption: String(row.encryption ?? 'tls') as Mailbox['encryption'],
    username: String(row.username ?? ''),
    folders: parseList(row.folders),
    access: String(row.access ?? 'workspace') as Mailbox['access'],
    members: parseList(row.members),
    enabled: Number(row.enabled ?? 1),
    sync_days: Number(row.sync_days ?? 365),
    created_by: row.created_by ? String(row.created_by) : null,
    last_sync_at: row.last_sync_at ? Number(row.last_sync_at) : null,
    last_error: row.last_error ? String(row.last_error) : null,
    last_status: String(row.last_status ?? 'never') as Mailbox['last_status'],
    message_count: Number(row.message_count ?? 0),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    deleted_at: row.deleted_at ? Number(row.deleted_at) : null,
    seq: Number(row.seq ?? 0),
    // Whether, never what. The screen needs to show "set" or "not set" and a
    // Change button; it never needs the characters, and a field that could
    // return them is a field somebody will eventually log.
    has_password: hasPassword(String(row.id)),
    // Which *kind* of credential, so the screen can offer a password box or a
    // Connect button rather than both. Derived here rather than stored on the
    // mailbox row: the row syncs to every device, and how an inbox is signed
    // in to is not something a device needs a copy of.
    auth: authKind(String(row.id)),
    provider: storedCredential(String(row.id))?.provider ?? '',
  };
}

/** `none`, `password` or `oauth` — what this mailbox would sign in with today. */
export function authKind(mailboxId: string): 'none' | 'password' | 'oauth' {
  const stored = storedCredential(mailboxId);
  return stored ? stored.kind : 'none';
}

/* ------------------------------------------------------------- credentials */

export function setPassword(mailboxId: string, password: string, byUserId: string): void {
  // Setting a password clears any OAuth state, rather than leaving a refresh
  // token beside it. Two credentials on one mailbox is a question nobody wants
  // to answer at sign-in time, and a stale refresh token that outlives the
  // decision to stop using it is a grant nobody remembers making.
  run(
    `INSERT INTO mailbox_credentials (mailbox_id, secret, kind, provider, access_token, expires_at, updated_at, updated_by)
     VALUES (?, ?, 'password', '', NULL, NULL, ?, ?)
     ON CONFLICT (mailbox_id) DO UPDATE SET
       secret = excluded.secret, kind = 'password', provider = '',
       access_token = NULL, expires_at = NULL,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    mailboxId, seal(PURPOSE, password), Date.now(), byUserId,
  );
}

export const clearPassword = (mailboxId: string): void => {
  run(`DELETE FROM mailbox_credentials WHERE mailbox_id = ?`, mailboxId);
};

export const hasPassword = (mailboxId: string): boolean =>
  !!get<Row>(`SELECT 1 AS ok FROM mailbox_credentials WHERE mailbox_id = ?`, mailboxId);

/**
 * A mailbox row plus a usable credential, ready to hand to a transport.
 *
 * Async because half the credentials expire: an OAuth mailbox whose access
 * token has gone stale is renewed here, which is a request to the provider. A
 * password mailbox does no I/O and resolves immediately.
 *
 * Null when there is no credential *or* when the seal will not open — the two
 * are the same answer to the only caller there is, which is the poller, and it
 * reports both as "cannot sign in". Distinguishing them would mean the error a
 * user sees depending on whether their instance secret changed, which is a
 * sentence nobody could act on. A refresh that is *refused*, on the other hand,
 * throws: "the consent was revoked" is a different afternoon from "no password
 * stored", and the screen should say which.
 */
export async function credentialsFor(row: Row): Promise<MailboxConfig | null> {
  const stored = storedCredential(String(row.id));
  if (!stored) return null;

  const base = {
    host: String(row.host ?? ''),
    port: Number(row.port ?? 993),
    encryption: String(row.encryption ?? 'tls') as MailboxConfig['encryption'],
    username: String(row.username || row.address || ''),
  };

  if (stored.kind === 'oauth') {
    const accessToken = await accessTokenFor(String(row.id));
    return accessToken ? { ...base, credential: { kind: 'oauth', accessToken } } : null;
  }
  return stored.secret === null ? null : { ...base, credential: { kind: 'password', password: stored.secret } };
}

/** Which folders to poll. Empty means INBOX, stated once. */
export const foldersOf = (row: Row): string[] => {
  const listed = parseList(row.folders).filter(Boolean);
  return listed.length ? listed : ['INBOX'];
};
