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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { api } from '../lib/api';
import { create, remove, update } from '../lib/mutations';
import { list, byId, useQuery } from '../lib/store';
import { useT } from '../lib/i18n';
import { briefWhen, exactTime, relativeTime } from '../lib/format';
import { setTyping, useOnline, useTypists } from '../lib/presence';
import { useCanWrite, useMe, useMemberMap, usePeople, useSession } from '../session';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input } from '../components/ui/field';
import { navCount, navItem } from '../components/ui/nav';
import { Chip } from '../components/ui/chip';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Avatar, Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../components/ui';

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

/**
 * Everything unread, for the badge in the sidebar.
 *
 * Counted for a guest too. A read marker is the one thing somebody with no
 * write access may still write — it is a note they keep about their own
 * position, not content anybody else reads — and without it their count would
 * climb and never come down. See `guestWritable` in the entity registry.
 */
export function useUnreadMessages(me: string): number {
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
      total += unreadCount(messages, marker?.last_read_at ?? 0, me);
    }
    return total;
  }, [me]);
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
  const others = useMemo(() => [...colleagues.values()].filter((member) => member.id !== me), [colleagues, me]);

  return (
    /* The bottom padding clears the tab bar while there is one — it hides at
       900px, the same width at which the list appears beside the conversation
       — and then drops to a sliver: the composer is pinned, but a send button
       flush against the window edge reads as cut off even when every pixel of
       it is there. All three steps are `min-[…]` variants rather than mixing
       in `sm:`, because Tailwind emits arbitrary variants before named ones —
       a `sm:` rule would win the ≥900px tie by source order and the sliver
       would never apply. */
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pt-5 min-[640px]:pb-16 min-[900px]:pb-2.5 chat">
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
        {conversations.length === 0 && (others.length > 0 || !canWrite) && (
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
        {/* Alone in this workspace, the list below is empty — the usual state
            on a fresh instance, because signing up a second time makes a second
            workspace rather than joining the first. It is no longer a dead end:
            a direct conversation does not need a workspace in common. */}
        {canWrite && others.length === 0 && (
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

      {creating && <NewChannel onClose={() => setCreating(false)} onCreated={(created) => navigate(`/chat/${created}`)} />}
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

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    create('message', { channel_id: channel.id, body, reply_to: replyTo, workspace_id: channel.workspace_id ?? null });
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
   * Go to the message being quoted.
   *
   * Measured against the stream's own box rather than `offsetTop`, which is
   * relative to whichever ancestor happens to be positioned, and scrolled a
   * third of the way down so the quoted line lands with its context above it.
   */
  const jumpTo = (id: string) => {
    const box = stream.current;
    const target = box?.querySelector<HTMLElement>(`[data-message="${id}"]`);
    if (!box || !target) return;
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    target.classList.remove('found');
    // Reading the layout between the two flushes the class change, so the
    // animation restarts when the same message is jumped to twice.
    void target.offsetWidth;
    target.classList.add('found');
  };

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
          {channel.topic && <div className="text-muted text-[12.5px]">{channel.topic}</div>}
        </div>
        <NotifyMenu channel={channel} me={me} />
        {channel.kind !== 'direct' && canWrite && (
          <Button variant="ghost" size="iconSm" title={t('chat.manage')} onClick={() => setManaging(true)}>
            <Icon name="users" size={14} />
          </Button>
        )}
      </header>
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
        {messages.length === 0 && <p className="text-muted text-[12.5px]">{t('chat.emptyStream')}</p>}
        {messages.map((message, index) => {
          const author = members.get(message.author_id ?? '');
          // Consecutive lines from the same person within five minutes are one
          // block. A name and an avatar on every line turns a conversation into
          // a list of records.
          const previous = messages[index - 1];
          const grouped = previous
            && previous.author_id === message.author_id
            && message.created_at - previous.created_at < 5 * 60_000
            && !message.reply_to;
          const answered = message.reply_to ? messages.find((m) => m.id === message.reply_to) : undefined;

          return (
            <div
              className={cn('chat-message', grouped && 'grouped', tapped === message.id && 'tapped')}
              key={message.id}
              data-message={message.id}
              // Every line can be asked when it was said, not only the one at
              // the top of a block — and a relative stamp rendered once is
              // wrong by the time anybody reads it twice.
              title={exactTime(message.created_at)}
            >
              {grouped ? <span className="gutter" /> : <Avatar user={author} size={26} />}
              <div className="body">
                {!grouped && (
                  <div className="flex items-center gap-1.5">
                    <span className="who">{author?.name ?? t('common.someone')}</span>
                    <span className="when">{relativeTime(message.created_at)}</span>
                  </div>
                )}
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
                  <>
                    <Markdown source={message.body} />
                    {/* After the body rather than up beside the name: a
                        grouped line has no name row, so an edit to one went
                        unmarked — the one case the mark exists for. */}
                    {message.edited_at && <span className="when">{t('chat.edited')}</span>}
                  </>
                )}
                <Reactions message={message} me={me} canWrite={canWrite} />
              </div>
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
                {canWrite && <AddReaction message={message} me={me} />}
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

/* ---------------------------------------------------------------- reactions */

/** The handful worth having on a work tool. A full picker is a different product. */
const REACTIONS = ['👍', '🎉', '👀', '🙏', '😄', '🤔'] as const;

const toggleReaction = (message: Message, emoji: string, me: string): void => {
  const reactions = message.reactions ?? {};
  const people = reactions[emoji] ?? [];
  const next = { ...reactions, [emoji]: people.includes(me) ? people.filter((id) => id !== me) : [...people, me] };
  // An emoji nobody uses any more is removed rather than left as an empty list,
  // so the row does not slowly fill with invisible entries.
  if (!next[emoji].length) delete next[emoji];
  update('message', message.id, { reactions: next });
};

function Reactions({ message, me, canWrite }: { message: Message; me: string; canWrite: boolean }) {
  const t = useT();
  const members = usePeople();
  const used = Object.entries(message.reactions ?? {}).filter(([, people]) => people?.length);
  if (!used.length) return null;

  return (
    <div className="flex items-center flex-wrap reactions gap-1">
      {used.map(([emoji, people]) => (
        <button
          key={emoji}
          className={`reaction${people.includes(me) ? ' mine' : ''}`}
          disabled={!canWrite}
          title={people.map((id) => members.get(id)?.name ?? t('common.someone')).join(', ')}
          // Otherwise this announces as the emoji alone, and the count and the
          // names — the entire reason to look at a reaction — are mouse-only.
          aria-label={`${emoji} ${people.length} · ${people.map((id) => members.get(id)?.name ?? t('common.someone')).join(', ')}`}
          onClick={() => toggleReaction(message, emoji, me)}
        >
          <span aria-hidden>{emoji}</span> {people.length}
        </button>
      ))}
    </div>
  );
}

/**
 * Six emoji, in a row.
 *
 * This was a menu, and a menu is a column of full-width rows at least thirteen
 * rem across — so six characters came out as a tall ladder of mostly empty
 * space, tall enough to cover the composer. A picker is a different shape from
 * a list of commands, so it uses a different primitive.
 */
function AddReaction({ message, me }: { message: Message; me: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="iconSm" className={ACTION_SIZE} title={t('task.react')}>
          <Icon name="emoji" size={13} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex gap-0.5" aria-label={t('task.react')}>
        {REACTIONS.map((emoji) => {
          const mine = (message.reactions?.[emoji] ?? []).includes(me);
          return (
            <button
              key={emoji}
              className={cn('reaction-pick', mine && 'mine')}
              aria-pressed={mine}
              aria-label={emoji}
              onClick={() => {
                toggleReaction(message, emoji, me);
                setOpen(false);
              }}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
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

function NewChannel({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const tidy = useMemo(() => normaliseChannelName(name), [name]);
  const taken = useQuery(() => list('channel', (channel) => channel.name === tidy && !channel.deleted_at).length > 0, [tidy]);

  return (
    <Sheet
      title={t('chat.newTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary"
            disabled={!tidy || taken}
            onClick={() => {
              const id = create('channel', { name: tidy, topic: topic.trim() || null, is_private: isPrivate ? 1 : 0 });
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
        {taken && <p className="text-muted text-[12.5px]" style={{ color: 'var(--warn)' }}>{t('chat.nameTaken')}</p>}
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
