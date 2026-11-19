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

import { CHAT_MESSAGE_MAX, canManageMembers, directMembers, normaliseChannelName } from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import {
  canSeeChannel, type EntityRule, isWorkspaceAdmin, parseIds, resendUser, settleAuthored, type WriteOpts,
} from '../../../kernel/write-path/repo.ts';
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
  if (existing) {
    for (const field of CHANNEL_FIXED) {
      if (values[field] === undefined || values[field] === existing[field]) continue;
      values[field] = existing[field];
      forced[field] = existing[field];
    }
  }
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
 * Which columns an edit may not touch, and nothing else — `settleAuthored` in
 * the kernel does the rest, shared with the one other entity that is somebody's
 * words. It cannot change channel, it cannot change who said it, and it cannot
 * change what it answered: an edit rewrites the words, not the conversation
 * around them.
 */
const MESSAGE_FIXED = ['channel_id', 'author_id', 'reply_to'] as const;

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
  /*
   * Coming back from the trash. The write path turns this into `deleted_at:
   * null`, and the visibility question below found no channel at all for a
   * deleted one — so "both are undoable from the trash" was true of nobody:
   * the restore was refused as "you are not in that conversation", measured.
   * Asked of the channel as it was, and put back by whoever may delete it.
   */
  const restoring = !!existing.deleted_at && values.deleted_at === null;
  if (!canSeeChannel(opts.actorId, id, { deleted: restoring })) throw forbidden('You are not in that conversation');
  if (restoring && !ownsChannel(existing, opts.actorId)) {
    throw forbidden('Only the person who opened this conversation, or an admin, can change that');
  }

  /*
   * What a room is, and whether it stands, is its owner's to change: whoever
   * opened it, or an owner or admin of the workspace. A direct conversation
   * belongs to both of its people equally.
   *
   * The screen has always said so — rename, topic and delete sit behind
   * `mayRetitle`, and there is no switch for privacy at all — but the server
   * asked only whether you were in the room. Measured before this: a plain
   * member of an `admins`-only channel was refused an invite and then set
   * `is_private: 0`, and the whole history synced to the workspace; another
   * made an open channel private with only himself in it, and its creator lost
   * it; another renamed and deleted a channel somebody else had opened.
   *
   * Compared rather than present: a client resends what it already has — two
   * people opening the same direct conversation both send its whole row — and
   * a field sent back unchanged is not somebody changing it.
   */
  const changes = (field: 'is_private' | 'name' | 'topic' | 'project_id'): boolean => {
    if (values[field] === undefined) return false;
    if (field === 'is_private') return Number(values.is_private) !== Number(existing.is_private ?? 0);
    if (field === 'name') return normaliseChannelName(String(values.name ?? '')) !== String(existing.name ?? '');
    return (values[field] ?? null) !== (existing[field] ?? null);
  };
  const reshaping = (['is_private', 'name', 'topic', 'project_id'] as const).some(changes);
  if ((reshaping || opts.op === 'delete') && !ownsChannel(existing, opts.actorId)) {
    throw forbidden('Only the person who opened this conversation, or an admin, can change that');
  }
  // A room going private keeps the people it names. Made private with nobody
  // on its list, it would be invisible to everybody, its owner included.
  if (changes('is_private') && Number(values.is_private) && !parseIds(values.members ?? existing.members).length) {
    throw badRequest('A private conversation needs at least one person in it');
  }

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
  if (values.invite_policy !== undefined && !ownsChannel(existing, opts.actorId)) {
    throw forbidden('Only the person who opened this conversation, or an admin, can change that');
  }
}

/** Whoever opened a room, an owner or admin of its workspace, or either person in a direct conversation. */
function ownsChannel(channel: Row, userId: string): boolean {
  if (String(channel.kind) === 'direct') return parseIds(channel.members).includes(userId);
  return channel.created_by === userId || isWorkspaceAdmin(String(channel.workspace_id), userId);
}

/**
 * What a conversation is, and who opened it, are fixed once it exists.
 *
 * `kind` decides everything else: turned to `direct`, a named channel lost its
 * workspace and kept one name on its list — measured, and out of the trash's
 * reach as well. `created_by` decides who owns it, so a client that could
 * write it could make itself the owner. Both go back to what is stored rather
 * than refusing the write, for the reason the members of a direct conversation
 * do: a device resending the row it has is not trying anything.
 */
const CHANNEL_FIXED = ['kind', 'created_by'] as const;
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
    if (entity === 'message' && existing) settleAuthored('message', values, existing, forced, opts, MESSAGE_FIXED);
    // Cut rather than refused, as a support line is: the sender's device is
    // told the stored text (`forced`), and a message lost to a 400 in the
    // outbox is worse than one shown shorter. Not an import, whose author
    // decided what to bring and was matched to it already.
    if (entity === 'message' && !opts.system && typeof values.body === 'string' && values.body.length > CHAT_MESSAGE_MAX) {
      values.body = values.body.slice(0, CHAT_MESSAGE_MAX);
      forced.body = values.body;
    }
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
