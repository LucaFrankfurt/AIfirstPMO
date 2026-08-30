/**
 * The rules a channel, a message and a read marker live by.
 *
 * The three guards are why `EntityRule` has a `guards` hook at all. They are
 * permission checks — who may write into a private conversation, whose message
 * this is to edit, whose read marker this is to move — and they were `if
 * (entity === … && !opts.system)` branches at the top of `writeEntity`. The
 * `!opts.system` half belongs to the hook now rather than to each rule, because
 * a check a module has to remember to gate is a check that will be forgotten.
 *
 * `docs/modules.md` says plainly that modules are not a permission boundary.
 * Moving these must not make one optional, and does not: a rule that is not
 * registered is not there at all, which is what `wiring.ts` and its test exist
 * to prevent.
 */

import { canManageMembers, directMembers, normaliseChannelName } from '@kolibri/shared';
import { get, type Row } from '../../db/index.ts';
import { badRequest, forbidden } from '../http.ts';
import { canSeeChannel, type EntityRule, parseIds, resendUser, safeJson, type WriteOpts } from '../repo.ts';

const isWorkspaceAdmin = (workspaceId: string, userId: string): boolean => !!get(
  `SELECT 1 FROM workspace_members
    WHERE workspace_id = ? AND user_id = ? AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
  workspaceId, userId,
);
/**
 * A message belongs where its conversation belongs.
 *
 * Which for a direct conversation is nowhere: it has no workspace, so neither
 * do the things said in it. Without this the channel would sit outside every
 * workspace while its messages sat inside the sender's, and the other person —
 * who may not be in that workspace — would receive a conversation with nothing
 * in it. Not forced through `forced`, because the client never sent a value
 * here worth correcting out loud; it is bookkeeping, not a refused write.
 */
function followChannelWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const channelId = String(values.channel_id ?? existing?.channel_id ?? '');
  if (!channelId) return;
  const channel = get<Row>(`SELECT workspace_id FROM channels WHERE id = ?`, channelId);
  if (channel) values.workspace_id = channel.workspace_id ?? null;
}
/**
 * What a conversation is allowed to be.
 *
 * A direct channel is the pair it names and nothing else. Its id already
 * encodes its members — that is what makes two people opening one at the same
 * time converge — so the members are read back *from the id* rather than
 * trusted from the payload. A client that sent a different list was either
 * confused or trying something; either way the id wins, because the id is what
 * the other device will have derived too.
 */
function applyChannelInvariants(id: string, values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>): void {
  const kind = String(values.kind ?? existing?.kind ?? 'channel');

  if (kind === 'direct') {
    const pair = directMembers(id);
    if (pair) {
      const members = JSON.stringify(pair);
      if (String(values.members ?? existing?.members ?? '') !== members) {
        values.members = members;
        forced.members = pair;
      }
    }
    // And it belongs to no workspace. Two people may have none in common, or
    // several; filing their conversation under one of them would mean it
    // vanished when either switched, and would make "can we talk at all" a
    // question about org charts. See `crossWorkspace` in the registry.
    if (values.workspace_id !== null) {
      values.workspace_id = null;
      forced.workspace_id = null;
    }
    // Always private, and never named: what to call it depends on who is
    // looking at it, so it has no name to store.
    if (Number(values.is_private ?? existing?.is_private ?? 0) !== 1) {
      values.is_private = 1;
      forced.is_private = 1;
    }
    return;
  }

  // A named channel keeps its name in the one shape that makes two of them
  // impossible to confuse.
  if (values.name !== undefined) {
    const tidy = normaliseChannelName(String(values.name ?? ''));
    if (tidy !== values.name) {
      values.name = tidy;
      forced.name = tidy;
    }
  }
  // An open channel has no member list; a private one that lost its last
  // member would be invisible to everybody including its author.
  if (values.is_private !== undefined && !Number(values.is_private)) {
    values.members = '[]';
    forced.members = [];
  }
}
/**
 * A message is written once and then it is somebody's words.
 *
 * The body may be edited by its author — that is what `edited_at` records, and
 * it is stamped here rather than trusted, because "edited" is a claim about
 * this server's clock. Everything else about a message is fixed: it cannot
 * change channel, it cannot change who said it, and it cannot change what it
 * answered — an edit rewrites the words, not the conversation around them.
 */
function applyMessageInvariants(values: Record<string, unknown>, existing: Row | undefined, forced: Record<string, unknown>, opts: WriteOpts): void {
  if (!existing) return;
  for (const fixed of ['channel_id', 'author_id', 'reply_to'] as const) {
    if (values[fixed] !== undefined && values[fixed] !== existing[fixed]) {
      values[fixed] = existing[fixed];
      forced[fixed] = existing[fixed];
    }
  }
  if (values.body !== undefined && String(values.body) !== String(existing.body ?? '')) {
    values.edited_at = Date.now();
    forced.edited_at = values.edited_at;
  }
  if (values.reactions !== undefined && !opts.system) {
    const settled = JSON.stringify(reconcileReactions(values.reactions, existing.reactions, opts.actorId));
    if (settled !== values.reactions) {
      values.reactions = settled;
      forced.reactions = JSON.parse(settled);
    }
  }
}
/**
 * A reaction is your own name in a list, and only yours is yours to move.
 *
 * The client sends the whole map because that is the field it holds, and a
 * field merges last-writer-wins — so two people reacting in the same moment
 * used to end with one of the two reactions, and an offline device could
 * arrive holding a map from before somebody else's. Worse, nothing stopped a
 * doctored map from removing everybody else's reactions, because "only the
 * reactions field changed" was the whole of the check.
 *
 * So the incoming map is not taken as the answer. It is read for one thing —
 * whether *this* person is on each emoji — and everybody else's entries are
 * carried across from the row as it stands. Concurrent reactions merge, and
 * the only reaction a write can move is the writer's own.
 */
function reconcileReactions(incoming: unknown, existing: unknown, actorId: string): Record<string, string[]> {
  const before = parseReactionMap(existing);
  const wanted = parseReactionMap(incoming);
  const merged: Record<string, string[]> = {};
  for (const emoji of new Set([...Object.keys(before), ...Object.keys(wanted)])) {
    const others = (before[emoji] ?? []).filter((userId) => userId !== actorId);
    const people = (wanted[emoji] ?? []).includes(actorId) ? [...others, actorId] : others;
    // An emoji nobody uses any more leaves rather than lingering as an empty
    // list, so the row does not fill up with invisible entries.
    if (people.length) merged[emoji] = people;
  }
  return merged;
}
function parseReactionMap(value: unknown): Record<string, string[]> {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [emoji, people] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(people)) out[emoji] = [...new Set(people.map(String))];
  }
  return out;
}
/**
 * Who may change a conversation.
 *
 * The membership list is an ordinary synced field, which is what makes adding
 * somebody to a channel work offline — and would also make *adding yourself*
 * work, if this were not here. Only somebody already in a conversation may
 * change it. A private channel's id is a UUID nobody can guess, so this is the
 * second lock rather than the only one, but a membership list that anybody can
 * append their own name to is not a membership list.
 *
 * On creation there is only one rule: a direct conversation must be one the
 * person is actually in. Its id names its two members, so anything else is a
 * row about two other people.
 */
function guardChannelWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (!existing) {
    const pair = directMembers(id);
    if (String(values.kind ?? '') === 'direct' || pair) {
      if (!pair) throw badRequest('A direct conversation\'s id is dm.<a>.<b>');
      if (!pair.includes(opts.actorId)) throw forbidden('That conversation is between two other people');
    }
    return;
  }
  if (!canSeeChannel(opts.actorId, id)) throw forbidden('You are not in that conversation');

  // The membership list is the one field with its own rule, set per channel:
  // `members` lets anybody in it invite, `admins` narrows that to its creator
  // and the workspace's owners. Being in the channel is required either way —
  // `admins` widens who counts, it never lets an outsider manage a room.
  if (values.members !== undefined) {
    const before = parseIds(existing.members);
    const after = parseIds(values.members);
    // Leaving is always yours to do. Somebody who can only take their own name
    // off the list is not managing the room, and a room you cannot leave
    // without asking permission is not one anybody should be added to.
    const onlyLeaving = before.includes(opts.actorId)
      && !after.includes(opts.actorId)
      && before.every((id) => id === opts.actorId || after.includes(id))
      && after.every((id) => before.includes(id));

    if (!onlyLeaving && !canManageMembers(
      { ...existing, members: before } as never,
      opts.actorId,
      isWorkspaceAdmin(String(existing.workspace_id), opts.actorId),
    )) {
      throw forbidden('Only an admin of this conversation can change who is in it');
    }
    // The last person out cannot leave the room standing with nobody in it:
    // it would be invisible to everybody and impossible to reopen.
    if (Number(existing.is_private) && !after.length) {
      throw badRequest('A private conversation needs at least one person in it');
    }
  }
  // Who may invite is itself an admin decision, or the setting protects nothing.
  if (values.invite_policy !== undefined
    && existing.created_by !== opts.actorId
    && !isWorkspaceAdmin(String(existing.workspace_id), opts.actorId)) {
    throw forbidden('Only the person who opened this conversation, or an admin, can change that');
  }
}
/**
 * Whether this person may say this here.
 *
 * Two separate refusals, and they are separate on purpose. Writing into a
 * conversation somebody cannot see is the one that matters — the sync filter
 * would never have shown it to them, so a message arriving for it is either a
 * confused client or somebody trying it. Editing is narrower still: a message
 * is somebody's words, and the only person who may change them is the person
 * who said them.
 */
function guardMessageWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  if (existing) {
    if (!existing.author_id || existing.author_id === opts.actorId) return;
    // A reaction is the one thing you may do to somebody else's words, and it
    // is not a change to them: it is your own name in a list beside them. So
    // it is allowed, and only it — anything alongside it is an edit.
    const reactingOnly = Object.keys(values).every((field) => field === 'reactions');
    if (!reactingOnly) throw forbidden('Only the author can change a message');
    if (!canSeeChannel(opts.actorId, String(existing.channel_id))) {
      throw forbidden('You are not in that conversation');
    }
    return;
  }
  const channelId = String(values.channel_id ?? '');
  if (!canSeeChannel(opts.actorId, channelId)) {
    throw forbidden('You are not in that conversation');
  }
  const channel = get<Row>(`SELECT archived_at FROM channels WHERE id = ?`, channelId);
  if (channel?.archived_at) throw badRequest('That conversation is archived');
  // A reply answers something said in the same conversation. The client only
  // offers replies to what is on screen, so anything else arriving here is a
  // stale draft or somebody probing — and a quote resolved across rooms would
  // read words to people who may not see the room they were said in.
  if (values.reply_to != null) {
    const answered = get<Row>(`SELECT channel_id FROM messages WHERE id = ?`, String(values.reply_to));
    if (!answered || String(answered.channel_id) !== channelId) {
      throw badRequest('A reply must answer a message in the same conversation');
    }
  }
}
/**
 * A read marker belongs to exactly one person and says so in its id.
 *
 * The id is `<channel>::<user>` so two of somebody's devices marking the same
 * conversation read converge on one row instead of racing to make two. That
 * makes the id load-bearing, so it is checked rather than assumed: an id
 * naming somebody else is refused outright rather than quietly rewritten,
 * because rewriting it would leave the client believing something else.
 */
function guardReadStateWrite(id: string, values: Record<string, unknown>, existing: Row | undefined, opts: WriteOpts): void {
  const separator = id.lastIndexOf('::');
  if (separator < 0) throw badRequest('A read marker id is <channel>::<user>');
  const channelId = id.slice(0, separator);
  const userId = id.slice(separator + 2);
  if (userId !== opts.actorId) throw forbidden('That read marker is somebody else\'s');
  if (!existing && !canSeeChannel(opts.actorId, channelId)) {
    throw forbidden('You are not in that conversation');
  }
  values.channel_id = channelId;
}



export const chatRules = {
  entities: ['channel', 'message', 'channelRead'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'channel') {
      if (!values.created_by) setForced('created_by', opts.actorId);
      // Whoever opened it is in it. A private channel its own creator cannot see
      // is a row nobody will ever find again — but an import restoring an open
      // channel is not somebody opening one, so it is not put in the list.
      const members = parseIds(values.members);
      if (!opts.system && values.kind !== 'direct' && !members.includes(opts.actorId)) {
        members.push(opts.actorId);
        setForced('members', JSON.stringify(members));
      }
    }
    if (entity === 'message') {
      // Said by whoever is saying it. This is not a field a *client* gets to
      // choose: the whole of "who wrote this" is the session it arrived on. An
      // import is the exception, and only because it has already done the work
      // of deciding — it matches people by email and falls back to the importer
      // itself. Overriding it here would have thrown that away silently.
      if (!opts.system || !values.author_id) setForced('author_id', opts.actorId);
    }
    if (entity === 'channelRead') {
      setForced('user_id', opts.actorId);
      if (!values.notify) {
        // Being written to directly is the case where silence would be wrong.
        const kind = get<Row>(`SELECT kind FROM channels WHERE id = ?`, values.channel_id ?? '')?.kind;
        setForced('notify', kind === 'direct' ? 'all' : 'mentions');
      }
    }
  },
  guards(entity, id, values, existing, opts) {
    if (entity === 'channel') guardChannelWrite(id, values, existing, opts);
    if (entity === 'message') guardMessageWrite(id, values, existing, opts);
    if (entity === 'channelRead') guardReadStateWrite(id, values, existing, opts);
  },
  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'channel') applyChannelInvariants(id, values, existing, forced);
    if (entity === 'message') applyMessageInvariants(values, existing, forced, opts);
    if (entity === 'message' || entity === 'channelRead') followChannelWorkspace(values, existing);
  },
  effects(entity, row, before, changed, opts) {
    // Opening a direct conversation with somebody outside your workspaces makes
    // the two of you visible to each other for the first time. Being allowed to
    // see a row is not the same as receiving it — see `resendUser` — so both
    // names are sent again, or the conversation arrives titled with a raw id.
    if (entity === 'channel' && !before && row.kind === 'direct') {
      for (const userId of parseIds(row.members)) resendUser(userId);
    }
  },
} satisfies EntityRule;
