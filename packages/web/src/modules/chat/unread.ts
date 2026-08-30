/**
 * Everything unread, for the badge in the sidebar.
 *
 * Here rather than inside the chat screen because two other screens ask for it
 * — the shell's sidebar and *My work* — and reaching into a route file to get
 * it made that screen impossible to replace. It is the same move as `asMoney`
 * and `useSeesMoney` before it: the shared thing goes down to where all its
 * callers can reach it, and none of the callers are rearranged.
 */
import { useMemo } from 'react';
import { findMentions, type Mentionable, type Message } from '@kolibri/shared';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { usePeople } from '../../kernel/identity/session';

/**
 * What the badge in the sidebar is counting.
 *
 * The same thing the bell menu promises, which it did not used to be: a
 * channel set to "only when I am named" still poured every message into the
 * badge, so the menu taught one contract and the number followed another —
 * and a number that counts things you asked not to hear about is a number
 * people stop reading.
 *
 * A direct message always counts; a channel counts everything on "all" and
 * only what names you on "mentions". `findMentions` is the rule the server
 * notifies by, so the badge and the notification cannot disagree.
 */
function countsForBadge(
  message: Message,
  notify: string | undefined,
  kind: string,
  people: Mentionable[],
  me: string,
): boolean {
  if (notify === 'none') return false;
  const level = notify ?? (kind === 'direct' ? 'all' : 'mentions');
  if (level === 'all' || kind === 'direct') return true;
  return findMentions(people, message.body ?? '').includes(me);
}

/**
 * Everything unread, for the badge in the sidebar.
 *
 * Counted for a guest too. A read marker is the one thing somebody with no
 * write access may still write — it is a note they keep about their own
 * position, not content anybody else reads — and without it their count would
 * climb and never come down. See `guestWritable` in the entity registry.
 */
export function useUnreadMessages(me: string): number {
  const people = usePeople();
  const roster = useMemo(() => [...people.values()], [people]);
  return useQuery(() => {
    const markers = new Map(list('channelRead', (marker) => marker.user_id === me).map((m) => [m.channel_id, m]));
    const byChannel = new Map<string, Message[]>();
    for (const message of list('message', (message) => !message.deleted_at)) {
      const bucket = byChannel.get(message.channel_id);
      if (bucket) bucket.push(message);
      else byChannel.set(message.channel_id, [message]);
    }
    let total = 0;
    for (const [channelId, messages] of byChannel) {
      const marker = markers.get(channelId);
      if (marker?.notify === 'none') continue;
      const channel = byId('channel', channelId);
      if (!channel || channel.deleted_at || channel.archived_at) continue;
      const since = marker?.last_read_at ?? 0;
      for (const message of messages) {
        if (message.deleted_at || message.author_id === me || message.created_at <= since) continue;
        if (countsForBadge(message, marker?.notify, channel.kind, roster, me)) total += 1;
      }
    }
    return total;
  }, [me, roster]);
}
