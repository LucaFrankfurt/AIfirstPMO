/**
 * What a mailbox is, and who is allowed to look inside it.
 *
 * A mailbox here is not a folder — it is an *account*: `support@calendoora.de`
 * with a host, a login and a password, connected once so that everybody who
 * should see it can search it without knowing the password. That is the whole
 * point of putting mail in a work OS rather than in a mail client: three people
 * share one inbox, and none of them should have to hold its credentials.
 *
 * Which makes access the first question rather than the last one, and the
 * reason this file is in `shared`: the server enforces it, the sync filter
 * repeats it in SQL, and the client greys out what it may not open. Three
 * places, one rule — the way `coversProject` is one rule for cycles and
 * modules.
 *
 * The rule is deliberately the *channel* rule and not the *project* rule.
 * A project is joined; an inbox is entrusted. `admin@` holds payroll and
 * `support@` holds nothing anybody minds, and those are two different lists of
 * people that no project membership happens to describe.
 */
import type { MailboxAccessLevel } from '../../kernel/registry/types.ts';

/**
 * Who may read a mailbox — the two values `MailboxAccessLevel` names.
 *
 *   `workspace` — everybody in the workspace. The ordinary shared inbox.
 *   `members`   — exactly the people listed. Nobody else, admins included.
 *
 * The second half of that sentence is the decision. An owner can *reconfigure*
 * a restricted mailbox — it is their instance — but they do not silently read
 * it, and the read paths do not carry an admin bypass. A rule with an exception
 * for whoever is senior enough is not a rule anybody can be told about, and
 * "the founder can read the tax inbox" is a sentence somebody should have to
 * write down rather than discover.
 */
export interface MailboxScope {
  access?: MailboxAccessLevel | null;
  members?: readonly string[] | null;
}

export const isMailboxAccess = (value: unknown): value is MailboxAccessLevel =>
  value === 'workspace' || value === 'members';

/**
 * May this person read this mailbox? The one place that question is answered.
 *
 * An empty `members` list on a restricted mailbox means **nobody**, which is
 * the opposite of the convention `channels.members` and `cycles.projects`
 * follow, where empty means everything. The inversion is deliberate and it is
 * the only one in the repository, so it is worth the paragraph: an empty list
 * everywhere else is a shorthand somebody chose ("all projects"), whereas an
 * empty list here is what you get by removing the last person from a private
 * inbox — and the reading where that opens `admin@` to the whole company is
 * not a reading anybody wants to be surprised by. Fail closed.
 */
export function canReadMailbox(scope: MailboxScope, userId: string): boolean {
  if ((scope.access ?? 'workspace') === 'workspace') return true;
  return (scope.members ?? []).includes(userId);
}

/**
 * An address as it is compared, not as it is displayed.
 *
 * Case-folded whole, because a domain is case-insensitive by RFC and a local
 * part is case-*sensitive* by RFC and case-insensitive at every mail provider
 * anybody actually uses. Following the RFC here would mean `Rechnung@x.de` and
 * `rechnung@x.de` counting as two correspondents in the same report, which is
 * a statistic that is wrong in a way nobody would report as a bug.
 */
export const foldAddress = (raw: string): string => raw.trim().toLowerCase();

/** The domain half, for grouping senders by who they work for. */
export function domainOf(address: string): string {
  const at = foldAddress(address).lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}
