/**
 * The rules a conversation follows, in the one place both sides can read them.
 *
 * The interesting problem in a chat that works offline is not the messages —
 * they are append-only rows and the sync engine already carries those. It is
 * the *channel*: two people can open a conversation with each other while both
 * are on a train, and when the tunnel ends there must be one conversation, not
 * two containing half the history each.
 *
 * So a direct conversation has no invented id. Its id is derived from who is in
 * it, which makes "create it" and "find it" the same operation and makes the
 * question of who created it first stop mattering.
 */

export type ChannelKind = 'channel' | 'direct';

/** What a person wants to hear about, per conversation. */
export type ChannelNotify = 'all' | 'mentions' | 'none';

/**
 * The id of the conversation between exactly these two people.
 *
 * Sorted, so it does not matter who opened it; prefixed, so it is obvious in a
 * database dump what kind of row it is; and built from the ids themselves
 * rather than a hash of them, because a hash can collide and a concatenation
 * of two unique strings cannot. Two people is the whole of it — see
 * `isDirectId` and the note on group conversations below.
 */
export function directChannelId(a: string, b: string): string {
  if (a === b) throw new Error('a direct conversation needs two different people');
  return `dm.${[a, b].sort().join('.')}`;
}

export const isDirectId = (id: string): boolean => /^dm\.[^.]+\.[^.]+$/.test(id);

/** The two people a direct id names, or null if it does not name two. */
export function directMembers(id: string): [string, string] | null {
  const parts = id.split('.');
  if (parts.length !== 3 || parts[0] !== 'dm') return null;
  return [parts[1], parts[2]];
}

/**
 * A conversation with three or more people is a **private channel with a
 * name**, not a bigger direct message. That is a product decision and a
 * technical one at once: a derived id only stays collision-free while it is a
 * concatenation, and a group people can name is a group people can find again.
 */
export const MAX_DIRECT_MEMBERS = 2;

export interface ChannelLike {
  id: string;
  kind: string;
  name?: string | null;
  is_private?: number | boolean;
  members?: string[] | null;
  archived_at?: number | null;
  deleted_at?: number | null;
}

export interface MessageLike {
  id: string;
  channel_id: string;
  author_id?: string | null;
  body?: string | null;
  created_at: number;
  deleted_at?: number | null;
}

/**
 * Whether somebody is in a conversation.
 *
 * An open channel has an empty member list, which means the workspace rather
 * than nobody — the alternative is writing every member into every channel and
 * keeping that list correct as people join and leave.
 */
export function isMember(channel: ChannelLike, userId: string): boolean {
  if (!channel.is_private) return true;
  return (channel.members ?? []).includes(userId);
}

/** Everything unread here, not counting your own. */
export function unreadCount(messages: MessageLike[], lastReadAt: number, userId: string): number {
  let count = 0;
  for (const message of messages) {
    if (message.deleted_at) continue;
    if (message.author_id === userId) continue;
    if (message.created_at > lastReadAt) count += 1;
  }
  return count;
}

/**
 * What to call a conversation on screen.
 *
 * A direct conversation has no name of its own — it is "the other person", and
 * which person that is depends on who is looking. `nameOf` resolves a user id;
 * an id it does not know stays an id rather than becoming a blank, because a
 * blank row in a list is unclickable in a way an ugly one is not.
 */
export function channelTitle(
  channel: ChannelLike,
  viewerId: string,
  nameOf: (userId: string) => string | undefined,
): string {
  if (channel.kind !== 'direct') return channel.name ?? '';
  const others = (channel.members ?? []).filter((id) => id !== viewerId);
  if (!others.length) return nameOf(viewerId) ?? '';
  return others.map((id) => nameOf(id) ?? id).join(', ');
}

/** Deterministic, so two devices marking the same channel read converge. */
export const readStateId = (channelId: string, userId: string): string => `${channelId}::${userId}`;

/**
 * Channel names are lowercase and dash-joined, the way every tool that has one
 * does it — not for tradition but because `#design review` and `#design-review`
 * are two channels that look like one.
 */
export function normaliseChannelName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/* --------------------------------------------------- what counts as urgent */

/**
 * Notification kinds somebody on "only what needs me" still wants delivered.
 *
 * One definition rather than one per channel, because a rule that differs by
 * channel is a rule nobody can predict — that sentence was in the code while
 * two sets quietly disagreed, which is how this came to be written down.
 */
export const IMPORTANT_KINDS = ['assigned', 'mention', 'invite', 'due_soon'] as const;

/**
 * ...and the one kind the *instant* channels add.
 *
 * A chat message is urgent or it is nothing: it belongs on a phone in a second
 * or not at all. Email here is batched into a digest on purpose, and a chat
 * message that arrives in a two-hour summary is a message answered too late to
 * matter — so it is important for Telegram and Web Push and deliberately not
 * for email. That is a real difference, and it is stated instead of hidden.
 */
export const INSTANT_ONLY_KINDS = ['message'] as const;

export const isImportantFor = (channel: 'email' | 'instant', kind: string): boolean =>
  (IMPORTANT_KINDS as readonly string[]).includes(kind)
  || (channel === 'instant' && (INSTANT_ONLY_KINDS as readonly string[]).includes(kind));
