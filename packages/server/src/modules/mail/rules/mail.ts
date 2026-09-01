/**
 * The rules a connected mailbox lives by.
 *
 * Two of them do real work and both are about access rather than about shape,
 * which is unusual here — most entity rules tidy enums and clamp numbers. A
 * mailbox holds a credential to somebody else's mail server and a copy of what
 * is in it, and the two ways that goes wrong are somebody connecting one who
 * should not, and somebody *widening* one that was restricted. Neither is a
 * correction; both are refusals.
 *
 * The third thing this does is the reason `forgetMailbox` exists: deleting a
 * mailbox throws its messages away. Every other switch in this product hides
 * rows and keeps them, deliberately — a workspace that turns budgets off finds
 * its figures where it left them. Mail is the exception, because "we
 * disconnected that inbox" has to be able to mean it.
 */
import { canReadMailbox, foldAddress, isMailboxAccess } from '@kolibri/shared';
import { isEmailAddress } from '../../../kernel/mail/address.ts';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { hasFeature } from '../../../kernel/platform/features.ts';
import { isMailEncryption } from '../../../kernel/mail/mailbox.ts';
import { type EntityRule, parseIds, type WriteOpts } from '../../../kernel/write-path/repo.ts';
import { clearPassword } from '../mailboxes.ts';
import { forgetMailbox } from '../store.ts';

/** Only an owner or an admin connects a mailbox, or changes who may read one. */
function guardMailboxWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  const role = roleOf(opts.actorId, opts.workspaceId);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only a workspace owner or admin may connect or change a mailbox');
  }
  if (!hasFeature(opts.workspaceId, 'mail')) {
    throw badRequest('Mailboxes are switched off for this workspace');
  }
  // A mailbox nobody may read is a mailbox that still polls, still stores and
  // still costs — refused at the point somebody would create one, rather than
  // left as a row that quietly does nothing.
  const access = values.access ?? existing?.access ?? 'workspace';
  const members = values.members !== undefined ? parseIds(values.members) : parseIds(existing?.members);
  if (access === 'members' && !members.length) {
    throw badRequest('A restricted mailbox needs at least one person who may read it');
  }
  // An admin who restricts a mailbox and leaves themselves out of it has locked
  // themselves out of what they can still reconfigure, which is a state worth
  // preventing rather than explaining. They may still name only other people —
  // by adding them and removing themselves in that order, which is two
  // deliberate steps rather than one absent-minded one.
  if (access === 'members' && !canReadMailbox({ access: 'members', members }, opts.actorId) && !existing) {
    throw badRequest('Add yourself to a restricted mailbox, or somebody else has to');
  }
  const address = String(values.address ?? existing?.address ?? '');
  if (!isEmailAddress(address)) throw badRequest('A mailbox is named by an email address');
  // Two rows for one address in one workspace would poll it twice and return
  // every message twice from every search. The unique index refuses it too;
  // this is the sentence somebody can act on.
  const clash = get<Row>(
    `SELECT id FROM mailboxes WHERE workspace_id = ? AND lower(address) = ? AND id <> ? AND deleted_at IS NULL`,
    opts.workspaceId, foldAddress(address), id,
  );
  if (clash) throw badRequest(`${address} is already connected in this workspace`);
}

const roleOf = (userId: string, workspaceId: string): string =>
  String(get<Row>(
    `SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    userId, workspaceId,
  )?.role ?? '');

function applyMailboxInvariants(values: Record<string, unknown>, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  if (values.address !== undefined) {
    const folded = foldAddress(String(values.address));
    if (folded !== values.address) settle('address', folded);
  }
  if (values.access !== undefined && !isMailboxAccess(values.access)) settle('access', 'workspace');
  if (values.encryption !== undefined && !isMailEncryption(values.encryption)) settle('encryption', 'tls');
  if (values.port !== undefined) {
    const port = Math.round(Number(values.port));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) settle('port', 993);
    else if (port !== values.port) settle('port', port);
  }
  if (values.sync_days !== undefined) {
    const days = Math.round(Number(values.sync_days));
    // 0 means everything, which is a real answer here — somebody hunting for a
    // 2019 invoice wants it — so it is the floor rather than a refusal. The
    // ceiling is arbitrary and generous; what it prevents is a typo that asks
    // for the year 3000 and gets the same thing as 0 by accident.
    if (!Number.isFinite(days) || days < 0) settle('sync_days', 365);
    else if (days > 36_500) settle('sync_days', 36_500);
    else if (days !== values.sync_days) settle('sync_days', days);
  }
  for (const field of ['members', 'folders']) {
    if (values[field] === undefined) continue;
    const encoded = JSON.stringify(parseIds(values[field]));
    if (encoded !== values[field]) settle(field, encoded);
  }
}

export const mailRules = {
  entities: ['mailbox'] as const,
  defaults(entity, id, values, opts, setForced) {
    if (entity !== 'mailbox') return;
    if (!values.created_by) setForced('created_by', opts.actorId);
    // The username is the address at almost every provider, and the field
    // exists for the few where it is not. Defaulting it means the common case
    // is one field fewer to fill in, and the uncommon one is still expressible.
    if (!values.username && values.address) setForced('username', String(values.address));
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'mailbox') guardMailboxWrite(id, values, existing, opts);
  },
  invariants(entity, id, values, existing, forced) {
    if (entity === 'mailbox') applyMailboxInvariants(values, forced);
  },
  effects(entity, row) {
    if (entity !== 'mailbox' || !row.deleted_at) return;
    // Disconnecting means the copy goes, and so does the credential. A
    // tombstone that still had the password on it would be a password that
    // survives "delete", which is not what anybody pressing that button means.
    forgetMailbox(String(row.id));
    clearPassword(String(row.id));
  },
} satisfies EntityRule;
