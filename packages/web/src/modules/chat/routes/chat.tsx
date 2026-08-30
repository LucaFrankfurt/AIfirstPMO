/**
 * Conversations.
 *
 * The messages are ordinary synced rows, which is most of why this file is
 * short: sending works offline because every write here works offline, and a
 * message appears on the other person's screen because the change stream
 * already tells their device that something moved. There is no socket, no
 * second protocol, and nothing here that has to be reconnected.
 *
 * The one exception is the presence dot and the typing line, and they keep the
 * exception honest: they are not rows, they never touch the sync cursor, and
 * they are delivered under their own event name on the same connection. See
 * `lib/presence.ts` on this side and `lib/presence.ts` on the server. A device
 * that ignores them entirely loses a dot and nothing else.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  canManageMembers,
  channelTitle,
  directChannelId,
  excerpt,
  messageOrder,
  normaliseChannelName,
  readStateId,
  unreadCount,
  type Channel,
  type Message,
} from '@kolibri/shared';
import { api } from '../../../kernel/sync/api';
import { create, remove, update } from '../../../kernel/sync/mutations';
import { list, byId, useQuery } from '../../../kernel/sync/store';
import { useT } from '../../../kernel/i18n/i18n';
import { briefWhen, clockTime, exactTime, longDate } from '../../../kernel/design-system/format';
import { isPendingRow, subscribeSync } from '../../../kernel/sync/sync';
import { setTyping, useOnline, useOnlineIds, useTypists } from '../presence';
import { useCanWrite, useMe, useMemberMap, usePeople, useSession } from '../../../kernel/identity/session';
import { Markdown, MarkdownEditor } from '../../pages/Markdown';
import { Button } from '../../../kernel/design-system/ui/button';
import { buttonVariants } from '../../../kernel/design-system/ui/button';
import { cn } from '../../../kernel/design-system/cn';
import { Input } from '../../../kernel/design-system/ui/field';
import { navCount, navItem } from '../../../kernel/design-system/ui/nav';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Avatar, Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../../../kernel/design-system/ui';
import { Reactions, ReactionPicker } from '../../work/reactions';

/* --------------------------------------------------------------- the pieces */

/**
 * Here or not.
 *
 * Presence is shown as a dot or as nothing, never as green against red: the
 * absent state is an absence, so the one reader in twelve who cannot separate
 * the two hues is reading a shape rather than a colour. The word is on the
 * tooltip and in the accessible name either way.
 */
function PresenceDot({ userId, className }: { userId: string; className?: string }) {
  const t = useT();
  const online = useOnline(userId);
  if (!online) return null;
  return (
    <span
      className={cn('inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-ok', className)}
      title={t('presence.online')}
      aria-label={t('presence.online')}
      role="img"
    />
  );
}

/** The other half of a direct conversation, or nothing for a channel. */
const partnerOf = (channel: Channel, me: string): string | undefined =>
  (channel.kind === 'direct' ? (channel.members ?? []).find((id) => id !== me) : undefined);

/**
 * Whether Enter sends.
 *
 * Where the primary pointer is fine there is a keyboard in front of somebody,
 * and Enter-to-send is what every messenger has taught their hands. Where it
 * is coarse — a phone, a tablet — the return key is how you get a second
 * line, and the send button is under your thumb anyway. Shift+Enter breaks a
 * line either way, and Cmd/Ctrl+Enter keeps sending everywhere.
 */
const SEND_ON_ENTER = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches;

/**
 * How big a button in the bar over a message is.
 *
 * Set at the call sites rather than in the stylesheet, because `cn` merges
 * Tailwind classes and so replaces the variant's own `size-8` — which a rule
 * in `@layer components` could never do. It matters that this is one number:
 * the trailing gutter that keeps message text out from under the bar is sized
 * against the bar's width, and the two have to agree.
 */
const ACTION_SIZE = 'size-[26px]';

/** How many messages a conversation draws at once, and grows by. */
const PAGE = 60;

/**
 * A clock that ticks once a minute, for everything that says "3 minutes ago".
 *
 * Those were worked out once, when the message was drawn, and then never
 * again — so a conversation left open said "now" about something said an hour
 * ago. One interval for the whole screen rather than one per message, and it
 * only exists while something is watching it.
 */
const minute = {
  at: 0,
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};

function subscribeMinute(listener: () => void): () => void {
  minute.listeners.add(listener);
  minute.timer ??= setInterval(() => {
    minute.at = Date.now();
    for (const each of minute.listeners) each();
  }, 60_000);
  return () => {
    minute.listeners.delete(listener);
    if (!minute.listeners.size) {
      clearInterval(minute.timer);
      minute.timer = undefined;
    }
  };
}

const useMinute = (): number => useSyncExternalStore(subscribeMinute, () => minute.at, () => 0);

/**
 * The day a line was said, as a person would say it.
 *
 * Today and yesterday by name, because a date for either reads as further
 * away than it is; anything older as the date itself.
 */
function dayLabel(at: number, t: ReturnType<typeof useT>): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= midnight) return t('chat.today');
  if (at >= midnight - 86_400_000) return t('chat.yesterday');
  return longDate(at);
}

/**
 * A mark on your own line while it is still on this device.
 *
 * The promise this whole app is built on — write it on a train, it sends
 * itself when the tunnel ends — was invisible: a message waiting in the
 * outbox looked exactly like one that had arrived, which leaves somebody
 * wondering precisely when they were told not to have to.
 */
function Unsent({ id }: { id: string }) {
  const t = useT();
  const waiting = useSyncExternalStore(
    subscribeSync,
    () => isPendingRow('message', id),
    () => false,
  );
  if (!waiting) return null;
  return (
    <span className="chat-unsent" title={t('chat.unsentHint')}>
      <Icon name="refresh" size={11} /> {t('chat.unsent')}
    </span>
  );
}

/**
 * Unsent words, kept per conversation.
 *
 * `Conversation` below is keyed by channel, so switching conversations drops
 * its state — that is the fix for a draft following you into the wrong room
 * and sitting one click from the wrong audience. This map is the other half:
 * what you were writing is waiting when you come back. A plain module map
 * rather than a row, because a draft is this device's business and nobody
 * else's.
 */
const drafts = new Map<string, string>();


/**
 * Conversations this device knows about, newest activity first — each with the
 * last thing said in it.
 *
 * The last message, not just its time: a list of bare names cannot answer the
 * question people open it with, which is what happened while they were away.
 * It costs nothing extra — the walk to find the newest was already here.
 */
function useConversations(me: string) {
  return useQuery(() => {
    const channels = list('channel', (channel) => !channel.deleted_at && !channel.archived_at);
    const last = new Map<string, Message>();
    for (const message of list('message', (message) => !message.deleted_at)) {
      const held = last.get(message.channel_id);
      if (!held || messageOrder(held, message) < 0) last.set(message.channel_id, message);
    }
    const when = (channel: Channel) => last.get(channel.id)?.created_at ?? channel.created_at;
    return channels
      // A direct conversation with nothing in it yet is a row somebody's
      // device made on the way to typing; it is not a conversation until
      // there is something in it.
      .filter((channel) => channel.kind !== 'direct' || last.has(channel.id))
      // The id breaks activity-time ties, so two devices agree on the order.
      .sort((a, b) => when(b) - when(a) || (a.id < b.id ? -1 : 1))
      .map((channel) => ({ channel, last: last.get(channel.id) }));
  }, [me]);
}

/** How many messages in this conversation this person has not seen. */
function useUnread(channelId: string, me: string): number {
  return useQuery(() => {
    const marker = byId('channelRead', readStateId(channelId, me));
    if (marker?.notify === 'none') return 0;
    return unreadCount(
      list('message', (message) => message.channel_id === channelId),
      marker?.last_read_at ?? 0,
      me,
    );
  }, [channelId, me]);
}


/* ---------------------------------------------------------------- the screen */

export function Chat() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const { id } = useParams();
  // Two different lists, deliberately. Names are looked up in everybody this
  // device knows, because a conversation can be with somebody in none of your
  // workspaces. The shortcut below is the workspace's people — the ones you
  // work with — and somebody outside it is reached through the search.
  const members = usePeople();
  const colleagues = useMemberMap();
  const canWrite = useCanWrite();
  const conversations = useConversations(me);
  const [creating, setCreating] = useState(false);
  const [finding, setFinding] = useState(false);

  const current = useQuery(() => (id ? byId('channel', id) : undefined), [id]);
  const nameOf = (userId: string) => members.get(userId)?.name;
  const here = useOnlineIds();
  const archived = useQuery(
    () => list('channel', (channel) => !!channel.archived_at && !channel.deleted_at).length,
    [],
  );

  /**
   * People to start with, which is not the same as people.
   *
   * Anybody you are already talking to has a row above with the last thing
   * said in it; repeating them here as a bare name is the same person twice,
   * offering less. What is left is the shortcut this section is for — somebody
   * you work with and have not written to — sorted so the ones who are here
   * now come first, since "can I ask them right now" is the question this
   * list gets asked.
   */
  const others = useMemo(() => {
    const talking = new Set(conversations.map(({ channel }) => partnerOf(channel, me)).filter(Boolean));
    return [...colleagues.values()]
      .filter((member) => member.id !== me && !talking.has(member.id))
      .sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id))
        || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [colleagues, me, conversations, here]);

  return (
    /* One sliver of bottom padding at every width, because the composer is
       pinned to the bottom of a full-height column and a send button flush
       against the edge of the window reads as cut off even when every pixel of
       it is there.
       It used to step down from 80px on a phone, on the theory that it had to
       clear the tab bar. It does not: the bar is a sibling of the scrolling
       content and takes its own height out of the column. So all that padding
       ever did was hold the composer eighty pixels off the bar with nothing in
       between — on the screen with the least room to spare. */
    <div className="mx-auto max-w-[1180px] px-3 pb-2.5 pt-4 sm:px-6 sm:pt-5 chat">
      <aside className="chat-list" aria-label={t('chat.title')}>
        <div className="flex items-center gap-2 mb-2">
          <h1 className="flex-1 min-w-0 m-0" style={{ fontSize: 17 }}>{t('chat.title')}</h1>
          {canWrite && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} /> {t('chat.new')}
            </Button>
          )}
        </div>

        {/* "Start a channel, or write to somebody below" is only useful advice
            while there is somebody below. Alone, the hint further down says the
            true thing instead, and two hints where one is wrong is worse. */}
        {conversations.length === 0 && (colleagues.size > 1 || !canWrite) && (
          <p className="text-muted text-[12.5px]">{t('chat.noneYet')}</p>
        )}

        {conversations.map(({ channel, last }) => (
          <ConversationRow
            key={channel.id}
            channel={channel}
            last={last}
            me={me}
            active={channel.id === id}
            title={channelTitle(channel, me, nameOf)}
            onOpen={() => navigate(`/chat/${channel.id}`)}
          />
        ))}

        {/* Starting a conversation is a write, and a guest has none. A list of
            people that refuses on click is worse than no list. */}
        {canWrite && <h2 className="nav-section mt-3.5">{t('chat.people')}</h2>}
        {/* Alone in this workspace — the usual state on a fresh instance,
            because signing up a second time makes a second workspace rather
            than joining the first. It is no longer a dead end: a direct
            conversation does not need a workspace in common. Asked of the
            workspace rather than of the list below, which is also empty when
            you are simply already talking to everybody in it. */}
        {canWrite && colleagues.size <= 1 && (
          <p className="text-muted text-[12.5px]">{t('chat.aloneHint')}</p>
        )}
        {canWrite && others.map((member) => (
          <button
            key={member.id}
            className={cn(navItem(), 'chat-person')}
            onClick={() => navigate(`/chat/${openDirect(me, member.id)}`)}
          >
            <Avatar user={member} size={20} />
            <span className="flex-1 min-w-0 truncate">{member.name}</span>
            <PresenceDot userId={member.id} />
          </button>
        ))}
        {canWrite && (
          <button className={cn(navItem(), 'chat-find')} onClick={() => setFinding(true)}>
            <Icon name="search" size={16} />
            <span className="flex-1 min-w-0 truncate">{t('chat.findPerson')}</span>
          </button>
        )}

        {/* Archiving hid a channel from this list and said nothing about where
            it went, which made it a one-way door out of the only screen that
            mentions it. It has always been restorable from Settings → Data;
            this is the sign pointing there. */}
        {archived > 0 && (
          <Link className={cn(navItem(), 'mt-3.5')} to="/settings?tab=data&show=archived">
            <Icon name="archive" size={15} />
            <span className="flex-1 min-w-0 truncate">{t('chat.archivedChannels', { count: archived })}</span>
          </Link>
        )}
      </aside>

      <section className="chat-main">
        {/* The key is load-bearing: without it React reuses one Conversation
            across channels, and its draft, reply target and edit state follow
            you into whichever room you open next — a paragraph meant for the
            team, one click from sending to a client. */}
        {current
          ? <Conversation key={current.id} channel={current} me={me} onBack={() => navigate('/chat')} />
          : <Empty emoji="💬" title={t('chat.pickTitle')} hint={t('chat.pickHint')} guide="chat" />}
      </section>

      {creating && <NewChannel me={me} onClose={() => setCreating(false)} onCreated={(created) => navigate(`/chat/${created}`)} />}
      {finding && (
        <FindPerson
          me={me}
          onClose={() => setFinding(false)}
          onPick={(them) => navigate(`/chat/${openDirect(me, them)}`)}
        />
      )}
    </div>
  );
}

/**
 * Open the direct conversation with somebody.
 *
 * The id is derived, so this is the same operation as finding it: if the row
 * is already there — because they wrote first, or because this device has done
 * this before — nothing is created.
 */
function openDirect(me: string, them: string): string {
  const id = directChannelId(me, them);
  // No workspace, deliberately: the other person may not be in the one that is
  // open, and may be in none of the same ones. The server enforces this too —
  // it is here so the row this device shows before the round trip is the row
  // that comes back. See `crossWorkspace` in the entity registry.
  if (!byId('channel', id)) {
    create('channel', { id, kind: 'direct', is_private: 1, members: [me, them], workspace_id: null }, id);
  }
  return id;
}

function ConversationRow({ channel, last, me, active, title, onOpen }: {
  channel: Channel;
  last?: Message;
  me: string;
  active: boolean;
  title: string;
  onOpen: () => void;
}) {
  const t = useT();
  const members = usePeople();
  const unread = useUnread(channel.id, me);
  // Only a direct conversation has a dot: a channel is not a person, and
  // "somebody in here is online" is not a fact anybody acts on.
  const partner = partnerOf(channel, me);

  // Who said it, where that is not already obvious. A direct conversation is
  // named after the other person, so their name on every line is noise — but
  // "You:" is worth saying in both, because whether the last word was yours
  // decides whether the row is waiting for you.
  const author = last?.author_id === me
    ? t('chat.youSaid')
    : channel.kind === 'direct' ? undefined : members.get(last?.author_id ?? '')?.name;
  const said = excerpt(last?.body ?? '', 60);

  return (
    <button className={cn(navItem({ active }), 'chat-row', unread > 0 && 'unread')} onClick={onOpen}>
      <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} size={15} />
      <span className="chat-row-body">
        <span className="chat-row-line">
          <span className="chat-row-title truncate">{title}</span>
          {partner && <PresenceDot userId={partner} />}
          <span className="chat-row-when">{briefWhen(last?.created_at)}</span>
        </span>
        {said && (
          <span className="chat-row-said truncate">
            {author ? `${author}: ` : ''}{said}
          </span>
        )}
      </span>
      {unread > 0 && <span className={navCount}>{unread}</span>}
    </button>
  );
}

/* ---------------------------------------------------------- one conversation */

function Conversation({ channel, me, onBack }: { channel: Channel; me: string; onBack: () => void }) {
  const t = useT();
  const members = usePeople();
  const { confirm, dialog } = useConfirm();
  const canWrite = useCanWrite();
  const [draft, setDraftState] = useState(() => drafts.get(channel.id) ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  /** Which message has been asked for its actions, where there is no hover. */
  const [tapped, setTapped] = useState<string | null>(null);
  /** The find-in-conversation box: null when it is not open. */
  const [needle, setNeedle] = useState<string | null>(null);
  /**
   * How far back this screen is drawing.
   *
   * The whole history used to be sorted and markdown-rendered on every visit,
   * which is nothing at thirty messages and visible at a few thousand — a
   * number an active channel reaches in weeks, and one this screen only
   * started being able to reach at all once the history could be scrolled.
   * Grows as somebody scrolls back into it.
   */
  const [reach, setReach] = useState(PAGE);
  const stream = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Lines that arrived while the reader was up in the history. */
  const [waiting, setWaiting] = useState(0);
  /**
   * Whether the reader is at the newest line. Maintained on scroll rather
   * than measured when a message arrives, because by then the new message has
   * already grown the container and the answer would depend on how tall it
   * is. Starts true: a conversation opens at its newest line.
   */
  const stuck = useRef(true);
  /** How many lines the last layout pass had, so the next one knows the delta. */
  const counted = useRef(0);

  // Not a value, a heartbeat: it re-renders this screen once a minute so the
  // "3 minutes ago" stamps below are worked out again instead of standing
  // still at whatever they said when the message was drawn.
  useMinute();

  const setDraft = (next: string) => {
    setDraftState(next);
    if (next) drafts.set(channel.id, next);
    else drafts.delete(channel.id);
  };

  const messages = useQuery(
    () => list('message', (message) => message.channel_id === channel.id && !message.deleted_at)
      .sort(messageOrder),
    [channel.id],
  );

  /**
   * What the stream is actually drawing.
   *
   * Searching and scrolling back are two different questions and this answers
   * whichever was asked: a search looks through the whole conversation and
   * shows what matches, and otherwise the newest `reach` messages are drawn
   * with everything older left undrawn until somebody goes looking for it.
   */
  const hunting = needle !== null && needle.trim().length > 0;
  const found = useMemo(() => {
    if (!hunting) return [];
    const query = needle!.trim().toLowerCase();
    return messages.filter((message) => String(message.body ?? '').toLowerCase().includes(query));
  }, [hunting, needle, messages]);
  const drawn = hunting ? found : messages.slice(Math.max(0, messages.length - reach));
  const older = !hunting && messages.length > drawn.length;

  const markerId = readStateId(channel.id, me);
  const marker = useQuery(() => byId('channelRead', markerId), [markerId]);
  const latest = messages.at(-1)?.created_at ?? 0;

  /**
   * Reading is what marks it read — and a tab in the background is not being
   * read. Without the check, a conversation left open behind another window
   * marks everything that arrives as seen: the badge never lights, the other
   * devices agree it was read, and nobody ever read a word. The heartbeat next
   * door has always asked this question; this had not.
   *
   * Written on a change rather than on every render, and only forwards: a
   * marker that went backwards would make a conversation somebody has just
   * read unread again on their other device.
   */
  useEffect(() => {
    if (!latest || latest <= (marker?.last_read_at ?? 0)) return;
    const mark = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      if (marker) update('channelRead', markerId, { last_read_at: latest });
      else create('channelRead', { id: markerId, channel_id: channel.id, last_read_at: latest, workspace_id: channel.workspace_id ?? null }, markerId);
    };
    mark();
    // Whatever arrived while the tab was away is caught up the moment it comes
    // back, rather than waiting for the next message to arrive.
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [latest, marker, markerId, channel.id, channel.workspace_id]);

  const toBottom = () => {
    const el = stream.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setWaiting(0);
  };

  // A new message moves the view only for a reader who is already at the
  // bottom — somebody scrolled up is reading, and dragging them down
  // mid-sentence is worse than the new message arriving a scroll away. They
  // are told it arrived instead, and one click catches them up. A layout
  // effect, so the first render is never painted at the top of the history.
  useLayoutEffect(() => {
    const el = stream.current;
    const arrived = messages.length - counted.current;
    counted.current = messages.length;
    if (el && stuck.current) {
      el.scrollTop = el.scrollHeight;
      setWaiting(0);
    } else if (arrived > 0) {
      setWaiting((held) => held + arrived);
    }
  }, [messages.length]);

  /**
   * Reaching further back must not move what is on screen.
   *
   * Drawing sixty older messages puts sixty messages' worth of height *above*
   * the reader, and the browser keeps `scrollTop` — so the line they were
   * reading jumps to the top and they have to find it again. The height the
   * stream had is recorded as the reach grows, and the scroll is moved by
   * however much it gained, which leaves the same line under the same eye.
   */
  const heldHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = stream.current;
    if (!el || heldHeight.current === null) return;
    el.scrollTop += el.scrollHeight - heldHeight.current;
    heldHeight.current = null;
  }, [reach]);

  const reachBack = () => {
    const el = stream.current;
    if (!el || heldHeight.current !== null) return;
    heldHeight.current = el.scrollHeight;
    setReach((far) => far + PAGE);
  };

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    create('message', {
      channel_id: channel.id,
      body,
      reply_to: replyTo,
      workspace_id: channel.workspace_id ?? null,
      // Said by whoever is typing. The server stamps this from the session
      // whatever arrives, so it cannot be claimed — it is here because until
      // the round trip finished the row had no author at all, and your own
      // message came up under a grey "?" as something *Someone* said. On a
      // train that is the whole conversation.
      author_id: me,
    });
    setDraft('');
    setReplyTo(null);
    setTyping(null);
  };

  // Choosing to reply is choosing to write, so the caret goes where the
  // writing happens. Without this the chip appeared above a box the cursor was
  // not in, and the next thing typed went wherever it had been.
  const startReply = (id: string) => {
    setReplyTo(id);
    composer.current?.focus();
  };

  /**
   * Go to a message, wherever it is.
   *
   * Two things can be in the way. It may be older than what is drawn, so the
   * reach is opened far enough to include it first; and it may be hidden
   * behind a search, so the search closes. Either way the scroll happens after
   * the render that puts it on screen, which is what `pending` is for.
   */
  const [pendingJump, setPendingJump] = useState<string | null>(null);

  const scrollToMessage = (id: string) => {
    const box = stream.current;
    const target = box?.querySelector<HTMLElement>(`[data-message="${id}"]`);
    if (!box || !target) return false;
    // Measured against the stream's own box rather than `offsetTop`, which is
    // relative to whichever ancestor happens to be positioned, and left a
    // third of the way down so the line lands with its context above it.
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    target.classList.remove('found');
    // Reading the layout between the two flushes the class change, so the
    // animation restarts when the same message is jumped to twice.
    void target.offsetWidth;
    target.classList.add('found');
    return true;
  };

  const jumpTo = (id: string) => {
    const at = messages.findIndex((message) => message.id === id);
    if (at < 0) return;
    if (needle !== null) setNeedle(null);
    const needed = messages.length - at + 10;
    if (needed > reach) setReach(needed);
    // A message already drawn can be gone to now; anything else has to wait
    // for the render that draws it.
    if (needle === null && needed <= reach && scrollToMessage(id)) return;
    setPendingJump(id);
  };

  useLayoutEffect(() => {
    if (pendingJump && scrollToMessage(pendingJump)) setPendingJump(null);
  }, [pendingJump, reach, needle]);

  // Switching conversations, or closing this one, stops the line over there.
  useEffect(() => () => setTyping(null), [channel.id]);

  const title = channelTitle(channel, me, (id) => members.get(id)?.name);
  const partner = partnerOf(channel, me);

  return (
    <>
      <header className="chat-header flex items-center gap-2">
        {/* On a phone the conversation is the whole screen, so this is the
            only way back to the list. Hidden from 900px up — the width at
            which the list appears beside it, not the generic 700px helper,
            which would leave a band with neither the list nor the way back.
            A utility rather than a stylesheet rule: the button's own
            `inline-flex` utility beats anything `@layer components` says. */}
        <Button variant="ghost" size="iconSm" className="min-[900px]:hidden" aria-label={t('chat.backToList')} onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
        </Button>
        <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} size={16} />
        <div className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            <strong className="truncate">{title}</strong>
            {partner && <PresenceDot userId={partner} />}
          </span>
          {/* Truncated rather than wrapped: a long topic used to take the
              header to three lines on a phone, which is a tenth of the screen
              spent on a sentence nobody is reading twice. The whole of it is
              in the tooltip and in the settings sheet. */}
          {channel.topic && (
            <div className="text-muted truncate text-[12.5px]" title={channel.topic}>{channel.topic}</div>
          )}
        </div>
        {/* Search reaches every message in this conversation and none outside
            it — the local mirror already holds them, so this asks nothing of
            the network and works with none. */}
        <Button
          variant="ghost" size="iconSm"
          title={t('chat.find')}
          aria-expanded={needle !== null}
          onClick={() => setNeedle(needle === null ? '' : null)}
        >
          <Icon name="search" size={14} />
        </Button>
        <NotifyMenu channel={channel} me={me} />
        {channel.kind !== 'direct' && canWrite && (
          <Button variant="ghost" size="iconSm" title={t('chat.manage')} onClick={() => setManaging(true)}>
            <Icon name="users" size={14} />
          </Button>
        )}
      </header>
      {needle !== null && (
        <div className="chat-search">
          <Icon name="search" size={13} />
          <input
            autoFocus
            className="chat-search-box"
            value={needle}
            placeholder={t('chat.findPlaceholderHere')}
            aria-label={t('chat.find')}
            onChange={(event) => setNeedle(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setNeedle(null); }}
          />
          <span className="text-muted text-[12px] tabular-nums">
            {hunting ? t('chat.matches', { count: found.length }) : ''}
          </span>
          <Button variant="ghost" size="iconSm" aria-label={t('annotate.clear')} onClick={() => setNeedle(null)}>
            <Icon name="close" size={12} />
          </Button>
        </div>
      )}
      {managing && <ChannelSettings channel={channel} me={me} onClose={() => setManaging(false)} onGone={onBack} />}

      <div
        className="chat-stream"
        ref={stream}
        onScroll={() => {
          const el = stream.current;
          if (!el) return;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          // Scrolling down to the newest line is reading it; the notice about
          // it has done its job and goes.
          if (stuck.current && waiting) setWaiting(0);
        }}
      >
        {messages.length === 0 && (
          <div className="chat-blank">
            <p className="m-0">{t('chat.emptyStream')}</p>
            {/* Three things this box can do that nothing on screen says it
                can. The empty conversation is the one moment there is room to
                say them. */}
            {canWrite && <p className="text-muted m-0 text-[12px]">{t('chat.emptyHint')}</p>}
          </div>
        )}
        {hunting && found.length === 0 && (
          <p className="text-muted text-[12.5px]">{t('chat.noMatches')}</p>
        )}
        {older && (
          <button className="chat-earlier" onClick={reachBack}>
            {t('chat.earlier', { count: messages.length - drawn.length })}
          </button>
        )}
        {drawn.map((message, index) => {
          const author = members.get(message.author_id ?? '');
          // Consecutive lines from the same person within five minutes are one
          // block. A name and an avatar on every line turns a conversation into
          // a list of records. Never while searching: two results from the same
          // person an hour apart are not a block, and the second would lose the
          // name and time that make it findable.
          const previous = drawn[index - 1];
          const grouped = !hunting && previous
            && previous.author_id === message.author_id
            && message.created_at - previous.created_at < 5 * 60_000
            && !message.reply_to;
          const answered = message.reply_to ? messages.find((m) => m.id === message.reply_to) : undefined;
          // Which side of the conversation this is. The single most useful
          // thing a chat can say about a line, and this one used to say it
          // only by printing a name above every block.
          const mine = message.author_id === me;
          // A name belongs on somebody else's first line in a room with more
          // than two people in it. In a direct conversation both names are in
          // the header already, and repeating them down the page is noise.
          const named = !mine && !grouped && channel.kind !== 'direct';
          // A new calendar day gets a line saying so. Without it yesterday
          // evening and this morning read as one conversation.
          const dayBefore = previous ? new Date(previous.created_at).toDateString() : null;
          const day = new Date(message.created_at).toDateString();

          return (
            <Fragment key={message.id}>
            {!hunting && day !== dayBefore && (
              <div className="chat-day"><span>{dayLabel(message.created_at, t)}</span></div>
            )}
            <div
              className={cn('chat-message', grouped && 'grouped', mine && 'mine', tapped === message.id && 'tapped')}
              key={message.id}
              data-message={message.id}
              // Every line can be asked when it was said, not only the one at
              // the top of a block — and a relative stamp rendered once is
              // wrong by the time anybody reads it twice.
              title={exactTime(message.created_at)}
            >
              {/* Only the other person gets a face: yours is not news to you,
                  and on a phone it is a third of the width of the line. */}
              {!mine && (grouped ? <span className="gutter" /> : <Avatar user={author} size={26} />)}
              <div className="body">
                <div className="bubble">
                {named && <span className="who">{author?.name ?? t('common.someone')}</span>}
                {/* The quote is a way back to what was said, so it is a button
                    — and `orphan` is the same "it is not there any more" this
                    class already means beside a comment. The answer outlives
                    the question, and saying so beats dropping the quote and
                    leaving a reply that answers nothing visible. */}
                {message.reply_to && (answered ? (
                  <button className="quoted" title={t('chat.jumpToReplied')} onClick={() => jumpTo(answered.id)}>
                    <Icon name="reply" size={11} />
                    {' '}
                    {/* One string rather than a name, a colon and a body glued
                        together here: the punctuation between somebody's name
                        and their words is a translator's decision. The body is
                        the words and not the markdown — `**ship it**` in a
                        quote should read as what somebody said. */}
                    {t('chat.quoted', {
                      name: members.get(answered.author_id ?? '')?.name ?? t('common.someone'),
                      said: excerpt(answered.body ?? '', 80),
                    })}
                  </button>
                ) : (
                  <p className="quoted orphan">
                    <Icon name="reply" size={11} /> <em>{t('chat.replyGone')}</em>
                  </p>
                ))}
                {editing === message.id ? (
                  <EditBox
                    initial={message.body}
                    onDone={(body) => {
                      if (body.trim() && body !== message.body) update('message', message.id, { body: body.trim() });
                      setEditing(null);
                    }}
                  />
                ) : (
                  <Markdown source={message.body} />
                )}
                {/* When it was said, and anything else true about the line,
                    tucked into the corner of the bubble the way a messenger
                    puts it — the last paragraph reserves the room for it. */}
                <span className="meta">
                  {message.edited_at && <span>{t('chat.edited')}</span>}
                  {mine && <Unsent id={message.id} />}
                  <span className="when" title={exactTime(message.created_at)}>{clockTime(message.created_at)}</span>
                </span>
                </div>
                {/* A search result is out of its context by definition, so it
                    carries a way back into it. */}
                {hunting && (
                  <button className="chat-in-context" onClick={() => jumpTo(message.id)}>
                    {t('chat.inContext')}
                  </button>
                )}
                <Reactions kind="message" id={message.id} reactions={message.reactions} canWrite={canWrite} />
              {/* Shown only where there is no hover to reveal the bar with. */}
              <button
                className="chat-more"
                aria-label={t('chat.messageActions')}
                aria-expanded={tapped === message.id}
                onClick={() => setTapped(tapped === message.id ? null : message.id)}
              >
                <Icon name="dots" size={14} />
              </button>
              <div className="chat-actions">
                {canWrite && (
                  <ReactionPicker kind="message" id={message.id} reactions={message.reactions}>
                    <Button variant="ghost" size="iconSm" className={ACTION_SIZE} title={t('task.react')}>
                      <Icon name="emoji" size={13} />
                    </Button>
                  </ReactionPicker>
                )}
                <Button variant="ghost" size="iconSm" className={ACTION_SIZE} title={t('chat.reply')} onClick={() => startReply(message.id)}>
                  <Icon name="reply" size={13} />
                </Button>
                {message.author_id === me && (
                  <>
                    <Button variant="ghost" size="iconSm" className={ACTION_SIZE} title={t('action.edit')} onClick={() => setEditing(message.id)}>
                      <Icon name="pencil" size={13} />
                    </Button>
                    <Button variant="ghost" size="iconSm" className={ACTION_SIZE}
                      title={t('action.delete')}
                      onClick={async () => {
                        if (await confirm(t('chat.deleteMessage'))) remove('message', message.id);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </Button>
                  </>
                )}
              </div>
              </div>
            </div>
            </Fragment>
          );
        })}
      </div>

      {/* Reading history while a conversation moves: the stream stays where it
          was, and this says what is waiting below rather than dragging the
          reader to it. */}
      {waiting > 0 && (
        <button className="chat-jump" onClick={toBottom}>
          <Icon name="chevronDown" size={13} />
          {t('chat.waiting', { count: waiting })}
        </button>
      )}

      {canWrite ? (
      <div className="chat-composer">
        {replyTo && (
          <div className="flex items-center gap-2 quoted-draft">
            <Icon name="reply" size={12} />
            <span className="flex-1 min-w-0 truncate">
              {t('chat.replyingTo', {
                name: members.get(messages.find((m) => m.id === replyTo)?.author_id ?? '')?.name ?? t('common.someone'),
              })}
            </span>
            <Button variant="ghost" size="iconSm" aria-label={t('annotate.clear')} onClick={() => setReplyTo(null)}>
              <Icon name="close" size={12} />
            </Button>
          </div>
        )}
        <Typing
          channelId={channel.id}
          me={me}
          idle={SEND_ON_ENTER && draft.trim() ? t('chat.enterHint') : undefined}
        />
        <MarkdownEditor
          value={draft}
          onChange={(next) => {
            setDraft(next);
            // The empty composer is not "still typing" — somebody who deletes
            // what they wrote and walks away should not leave the line up for
            // the other person to keep watching.
            setTyping(next.trim() ? channel.id : null);
          }}
          placeholder={t('chat.placeholder', { where: title })}
          onSubmit={send}
          submitOnEnter={SEND_ON_ENTER}
          fieldRef={composer}
          compact
          actions={(
            <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={send}>
              <Icon name="send" size={13} /> {t('chat.send')}
            </Button>
          )}
        />
      </div>
      ) : (
        /* A guest can read an open channel and cannot write anywhere. Saying so
           here beats a composer that takes a paragraph and then refuses it. */
        <div className="chat-composer">
          <p className="text-muted text-[12.5px] m-0">{t('chat.readOnly')}</p>
        </div>
      )}
      {dialog}
    </>
  );
}

/**
 * "Anna is typing…", above the composer.
 *
 * It occupies a fixed line whether or not anybody is typing, because a line
 * that appears and disappears shoves the entire conversation up and down while
 * somebody is trying to read it. While the line would be empty it can carry
 * `idle` instead — the "Enter sends" hint lives there, in space already paid
 * for. The live region is the inner span, so the hint coming and going is
 * never read out as somebody typing.
 */
function Typing({ channelId, me, idle }: { channelId: string; me: string; idle?: string }) {
  const t = useT();
  const members = usePeople();
  const who = useTypists(channelId, me);
  const name = (id: string) => members.get(id)?.name ?? t('common.someone');

  const text = who.length === 0 ? ''
    : who.length === 1 ? t('chat.typing', { name: name(who[0]) })
    : who.length === 2 ? t('chat.typingTwo', { first: name(who[0]), second: name(who[1]) })
    : t('chat.typingMany');

  return (
    <p className="m-0 h-[15px] truncate text-[11.5px] text-muted">
      <span aria-live="polite">{text}</span>
      {!text && idle}
    </p>
  );
}

function EditBox({ initial, onDone }: { initial: string; onDone: (body: string) => void }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-1.5">
      {/* Same shape as the composer: editing a line in place should feel like
          writing it did, not like opening a document. */}
      <MarkdownEditor value={value} onChange={setValue} autoFocus compact onSubmit={() => onDone(value)} submitOnEnter={SEND_ON_ENTER} />
      <div className="flex items-center gap-1.5">
        <Button variant="primary" size="sm" onClick={() => onDone(value)}>{t('action.save')}</Button>
        <Button size="sm" onClick={() => onDone(initial)}>{t('action.cancel')}</Button>
      </div>
    </div>
  );
}

/** What this person wants told to them about this conversation. */
function NotifyMenu({ channel, me }: { channel: Channel; me: string }) {
  const t = useT();
  const markerId = readStateId(channel.id, me);
  const marker = useQuery(() => byId('channelRead', markerId), [markerId]);
  const current = marker?.notify ?? (channel.kind === 'direct' ? 'all' : 'mentions');

  const choose = (notify: 'all' | 'mentions' | 'none') => {
    if (marker) update('channelRead', markerId, { notify });
    else create('channelRead', { id: markerId, channel_id: channel.id, notify, last_read_at: 0, workspace_id: channel.workspace_id ?? null }, markerId);
  };

  return (
    <MenuButton
      variant="ghost" size="sm"
      label={t('chat.notify')}
      items={(['all', 'mentions', 'none'] as const).map((option) => ({
        id: option,
        label: t(`chat.notify.${option}` as 'chat.notify.all'),
        hint: current === option ? '✓' : undefined,
        onSelect: () => choose(option),
      }))}
    >
      <Icon name="bell" size={13} />
    </MenuButton>
  );
}

/* -------------------------------------------------------- channel settings */

/**
 * Who is in a channel, who may change that, and how to get out of it.
 *
 * The membership list is an ordinary synced field, so all of this works
 * offline — and so the *rule* about who may change it has to live on the
 * server as well, which it does. This screen only offers what the rule would
 * allow, which is a courtesy rather than the enforcement.
 */
/**
 * Change what a channel is called.
 *
 * Applied when the field is left rather than on every keystroke, because the
 * name is normalised on the way in and rewriting it under the cursor while
 * somebody is still typing is the surprise `chat.willBeCalled` exists to
 * avoid. A name another channel already holds is refused here with a reason —
 * including "the other one is archived", which is otherwise a collision with
 * something invisible.
 */
function RenameChannel({ channel, allowed }: { channel: Channel; allowed: boolean }) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState(channel.name ?? '');
  const tidy = normaliseChannelName(name);
  const clash = useQuery(
    () => list('channel', (other) => other.id !== channel.id && other.name === tidy && !other.deleted_at)[0],
    [tidy, channel.id],
  );

  const apply = () => {
    if (!tidy || clash || tidy === channel.name) {
      setName(channel.name ?? '');
      return;
    }
    update('channel', channel.id, { name: tidy });
    toast(t('chat.renamed', { name: `#${tidy}` }));
  };

  return (
    <div className="field">
      <label htmlFor="channel-name">{t('chat.name')}</label>
      <Input
        id="channel-name"
        value={name}
        disabled={!allowed}
        onChange={(event) => setName(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
      {tidy && tidy !== name && (
        <p className="text-muted m-0 text-[12.5px]">{t('chat.willBeCalled', { name: `#${tidy}` })}</p>
      )}
      {clash && (
        <p className="m-0 text-[12.5px]" style={{ color: 'var(--warn)' }}>
          {clash.archived_at ? t('chat.nameTakenArchived') : t('chat.nameTaken')}
        </p>
      )}
    </div>
  );
}

function ChannelSettings({ channel, me, onClose, onGone }: {
  channel: Channel;
  me: string;
  onClose: () => void;
  onGone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const members = usePeople();
  const { confirm, dialog } = useConfirm();
  const colleagues = useMemberMap();
  const { role } = useSession();
  const isAdmin = role === 'owner' || role === 'admin';
  const mayManage = canManageMembers(channel, me, isAdmin);
  const mayRetitle = channel.created_by === me || isAdmin;

  const inside = (channel.members ?? []);
  // Whom you may add is the workspace's people: a private channel lives in a
  // workspace, so somebody outside it has nothing to be added to.
  const outside = [...colleagues.values()].filter((member) => !inside.includes(member.id));

  const setMembers = (next: string[]) => update('channel', channel.id, { members: next });

  return (
    <Sheet title={`#${channel.name}`} onClose={onClose}>
      {/* The permission for this has been called `mayRetitle` all along, and
          until now there was no title to change: a name chosen once was a name
          forever, however wrong it turned out to be. */}
      <RenameChannel channel={channel} allowed={mayRetitle} />
      <div className="field">
        <label htmlFor="channel-topic">{t('chat.topic')}</label>
        <Input
          id="channel-topic"
          defaultValue={channel.topic ?? ''}
          disabled={!mayRetitle}
          placeholder={t('chat.topicHint')}
          onBlur={(event) => update('channel', channel.id, { topic: event.target.value.trim() || null })}
        />
      </div>

      {/* An open channel has no member list — everyone in the workspace is in
          it — so there is nothing here to manage. */}
      {channel.is_private ? (
        <>
          <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('chat.members', { count: inside.length })}</h3>
          {inside.map((id) => (
            <div className="flex items-center gap-2" key={id} style={{ gap: 8, padding: '4px 0' }}>
              <Avatar user={members.get(id)} size={22} />
              <span className="flex-1 min-w-0 truncate">{members.get(id)?.name ?? id}</span>
              {channel.created_by === id && <Chip>{t('chat.opened')}</Chip>}
              {(mayManage || id === me) && inside.length > 1 && (
                <Button variant="ghost" size="sm"
                  onClick={async () => {
                    if (id === me && !(await confirm(t('chat.confirmLeave')))) return;
                    setMembers(inside.filter((other) => other !== id));
                    if (id === me) { onClose(); onGone(); }
                  }}
                >
                  {id === me ? t('chat.leave') : t('chat.remove')}
                </Button>
              )}
            </div>
          ))}

          {mayManage && !!outside.length && (
            <>
              <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('chat.addSomebody')}</h3>
              {outside.map((member) => (
                <button
                  key={member.id}
                  className={navItem()}
                  onClick={() => {
                    setMembers([...inside, member.id]);
                    toast(t('chat.added', { name: member.name }));
                  }}
                >
                  <Avatar user={member} size={22} />
                  <span className="flex-1 min-w-0 truncate">{member.name}</span>
                  <Icon name="plus" size={13} />
                </button>
              ))}
            </>
          )}

          <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('chat.whoCanAdd')}</h3>
          <p className="text-muted mb-2 text-[12.5px]">{t('chat.whoCanAddHint')}</p>
          <div className="flex items-center flex-wrap gap-1.5">
            {(['members', 'admins'] as const).map((policy) => (
              <button
                key={policy}
                className={cn(buttonVariants({ size: 'sm' }), (channel.invite_policy ?? 'members') === policy && 'bg-active text-fg')}
                style={(channel.invite_policy ?? 'members') === policy ? { background: 'var(--bg-active)' } : undefined}
                aria-pressed={(channel.invite_policy ?? 'members') === policy}
                disabled={!mayRetitle}
                onClick={() => update('channel', channel.id, { invite_policy: policy })}
              >
                {t(policy === 'members' ? 'chat.policyMembers' : 'chat.policyAdmins')}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-muted text-[12.5px]">{t('chat.openChannelHint')}</p>
      )}

      <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('chat.closing')}</h3>
      <p className="text-muted mb-2 text-[12.5px]">{t('chat.closingHint')}</p>
      <div className="flex items-center flex-wrap gap-1.5">
        <Button size="sm"
          onClick={() => {
            update('channel', channel.id, { archived_at: Date.now() });
            toast(t('chat.archived'));
            onClose();
            onGone();
          }}
        >
          <Icon name="archive" size={13} /> {t('chat.archive')}
        </Button>
        {mayRetitle && (
          <Button variant="danger" size="sm"
            onClick={async () => {
              if (!(await confirm(t('chat.confirmDelete')))) return;
              remove('channel', channel.id);
              onClose();
              onGone();
            }}
          >
            <Icon name="trash" size={13} /> {t('action.delete')}
          </Button>
        )}
      </div>
      {dialog}
    </Sheet>
  );
}

/* ------------------------------------------------------------- new channel */

function NewChannel({ me, onClose, onCreated }: { me: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const toast = useToast();
  const colleagues = useMemberMap();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [invited, setInvited] = useState<string[]>([]);
  const tidy = useMemo(() => normaliseChannelName(name), [name]);
  const taken = useQuery(
    () => list('channel', (channel) => channel.name === tidy && !channel.deleted_at)[0],
    [tidy],
  );

  const others = useMemo(
    () => [...colleagues.values()].filter((member) => member.id !== me),
    [colleagues, me],
  );

  return (
    <Sheet
      title={t('chat.newTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary"
            disabled={!tidy || !!taken}
            onClick={() => {
              const id = create('channel', {
                name: tidy,
                topic: topic.trim() || null,
                is_private: isPrivate ? 1 : 0,
                // Whoever opened it is in it; the server settles this too, and
                // sending it means the row this device draws before the round
                // trip is the row that comes back.
                ...(isPrivate ? { members: [me, ...invited] } : {}),
              });
              toast(t('chat.created', { name: `#${tidy}` }));
              onCreated(id);
              onClose();
            }}
          >
            {t('chat.create')}
          </Button>
        </>
      }
    >
        <div className="field">
          <label htmlFor="new-channel-name">{t('chat.name')}</label>
          <Input
            id="new-channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            placeholder="design-review"
          />
        </div>
        {/* Shown before it is saved, because "#Design Review" quietly becoming
            "#design-review" afterwards is a surprise. */}
        {tidy && tidy !== name && <p className="text-muted text-[12.5px]">{t('chat.willBeCalled', { name: `#${tidy}` })}</p>}
        {/* A collision with an archived channel used to read as a collision
            with nothing: the name is taken by a room that is not in the list
            and cannot be found from here. Saying which it is turns a dead end
            into a decision. */}
        {taken && (
          <p className="m-0 text-[12.5px]" style={{ color: 'var(--warn)' }}>
            {taken.archived_at ? t('chat.nameTakenArchived') : t('chat.nameTaken')}
          </p>
        )}
        <div className="field">
          <label htmlFor="new-channel-topic">{t('chat.topic')}</label>
          <Input
            id="new-channel-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder={t('chat.topicHint')}
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
          <span>
            <strong>{t('chat.private')}</strong>
            <span className="text-[12px] text-muted">{t('chat.privateHint')}</span>
          </span>
        </label>

        {/* Three or more people is a private channel with a name — a sound
            model, reached until now by making the channel, opening its
            settings and adding people one at a time, each with its own toast.
            The same choice belongs where the channel is being made. */}
        {isPrivate && !!others.length && (
          <>
            <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('chat.whoElse')}</h3>
            {others.map((member) => {
              const picked = invited.includes(member.id);
              return (
                <button
                  key={member.id}
                  className={cn(navItem({ active: picked }))}
                  aria-pressed={picked}
                  onClick={() => setInvited(picked
                    ? invited.filter((id) => id !== member.id)
                    : [...invited, member.id])}
                >
                  <Avatar user={member} size={22} />
                  <span className="flex-1 min-w-0 truncate">{member.name}</span>
                  <Icon name={picked ? 'check' : 'plus'} size={13} />
                </button>
              );
            })}
          </>
        )}
    </Sheet>
  );
}

/**
 * Find somebody to write to, anywhere on this instance.
 *
 * The list beside this one is the workspace's members, which is the right
 * shortcut for the people somebody works with every day — and the wrong answer
 * to "can I message this colleague at all". A direct conversation is between
 * two people, not inside an organisation: it needs no workspace in common, and
 * requiring one would mean two people on the same instance had to be put in the
 * same project before they could say hello.
 *
 * So the search asks the server rather than the synced cache. Everybody's
 * account is not workspace data and is deliberately not synced to every device
 * — this is a way to find one person, not a copy of the address book.
 */
function FindPerson({ me, onClose, onPick }: { me: string; onClose: () => void; onPick: (userId: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string; email: string; avatar_url?: string | null }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // A short wait, so typing a name is one request rather than eight.
    const timer = setTimeout(() => {
      api.get<typeof people>(`/api/people?q=${encodeURIComponent(query.trim())}`)
        .then((found) => {
          if (cancelled) return;
          setPeople(found.filter((person) => person.id !== me));
          // A search that has recovered stops apologising for the one before.
          setError('');
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : t('common.somethingWentWrong'));
        });
    }, query ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, me, t]);

  return (
    <Sheet title={t('chat.findTitle')} onClose={onClose}>
      <div className="field">
        <label htmlFor="find-person">{t('chat.findLabel')}</label>
        <Input
          id="find-person"
          value={query}
          autoFocus
          placeholder={t('chat.findPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {!error && people.length === 0 && <p className="text-[12px] text-muted">{t('chat.findNobody')}</p>}
      {people.map((person) => (
        <button
          key={person.id}
          className={navItem()}
          onClick={() => {
            onPick(person.id);
            onClose();
          }}
        >
          <Avatar user={person} size={22} />
          <span className="flex-1 min-w-0 truncate">{person.name}</span>
          <span className="text-muted truncate text-[11.5px]">{person.email}</span>
        </button>
      ))}
    </Sheet>
  );
}
