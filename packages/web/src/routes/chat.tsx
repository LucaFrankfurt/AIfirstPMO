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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  canManageMembers,
  channelTitle,
  directChannelId,
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
import { relativeTime } from '../lib/format';
import { setTyping, useOnline, useTypists } from '../lib/presence';
import { useCanWrite, useMe, useMemberMap, usePeople, useSession } from '../session';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Button } from '../components/ui/button';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Input } from '../components/ui/field';
import { navCount, navItem } from '../components/ui/nav';
import { Chip } from '../components/ui/chip';
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


/** Conversations this device knows about, newest activity first. */
function useConversations(me: string) {
  return useQuery(() => {
    const channels = list('channel', (channel) => !channel.deleted_at && !channel.archived_at);
    const lastAt = new Map<string, number>();
    for (const message of list('message', (message) => !message.deleted_at)) {
      const at = lastAt.get(message.channel_id) ?? 0;
      if (message.created_at > at) lastAt.set(message.channel_id, message.created_at);
    }
    return channels
      // A direct conversation with nothing in it yet is a row somebody's
      // device made on the way to typing; it is not a conversation until
      // there is something in it.
      .filter((channel) => channel.kind !== 'direct' || lastAt.has(channel.id))
      .sort((a, b) => (lastAt.get(b.id) ?? b.created_at) - (lastAt.get(a.id) ?? a.created_at));
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
    <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5 chat">
      <aside className="chat-list">
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
          <p className="text-[12px] text-muted text-[12.5px]">{t('chat.noneYet')}</p>
        )}

        {conversations.map((channel) => (
          <ConversationRow
            key={channel.id}
            channel={channel}
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
          <p className="text-[12px] text-muted text-[12.5px]">{t('chat.aloneHint')}</p>
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
        {current
          ? <Conversation channel={current} me={me} onBack={() => navigate('/chat')} />
          : <Empty emoji="💬" title={t('chat.pickTitle')} hint={t('chat.pickHint')} guide="collab" />}
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

function ConversationRow({ channel, me, active, title, onOpen }: {
  channel: Channel;
  me: string;
  active: boolean;
  title: string;
  onOpen: () => void;
}) {
  const unread = useUnread(channel.id, me);
  // Only a direct conversation has a dot: a channel is not a person, and
  // "somebody in here is online" is not a fact anybody acts on.
  const partner = partnerOf(channel, me);
  return (
    <button className={cn(navItem({ active }), 'chat-row')} onClick={onOpen}>
      <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} size={15} />
      <span className="flex-1 min-w-0 truncate">{title}</span>
      {partner && <PresenceDot userId={partner} />}
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
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const messages = useQuery(
    () => list('message', (message) => message.channel_id === channel.id && !message.deleted_at)
      .sort((a, b) => a.created_at - b.created_at),
    [channel.id],
  );

  const markerId = readStateId(channel.id, me);
  const marker = useQuery(() => byId('channelRead', markerId), [markerId]);
  const latest = messages.at(-1)?.created_at ?? 0;

  // Reading is what marks it read. Written on a change rather than on every
  // render, and only forwards: a marker that went backwards would make a
  // conversation somebody has just read unread again on their other device.
  useEffect(() => {
    if (!latest || latest <= (marker?.last_read_at ?? 0)) return;
    if (marker) update('channelRead', markerId, { last_read_at: latest });
    else create('channelRead', { id: markerId, channel_id: channel.id, last_read_at: latest, workspace_id: channel.workspace_id ?? null }, markerId);
  }, [latest, marker, markerId, channel.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, channel.id]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    create('message', { channel_id: channel.id, body, reply_to: replyTo, workspace_id: channel.workspace_id ?? null });
    setDraft('');
    setReplyTo(null);
    setTyping(null);
  };

  // Switching conversations, or closing this one, stops the line over there.
  useEffect(() => () => setTyping(null), [channel.id]);

  const title = channelTitle(channel, me, (id) => members.get(id)?.name);
  const partner = partnerOf(channel, me);

  return (
    <>
      <header className="chat-header flex items-center gap-2">
        {/* On a phone the conversation is the whole screen, so this is the only
            way back to the list. Hidden where the list is already beside it. */}
        <Button variant="ghost" size="iconSm" className="chat-back" aria-label={t('chat.backToList')} onClick={onBack}>
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

      <div className="chat-stream">
        {messages.length === 0 && <p className="text-[12px] text-muted text-[12.5px]">{t('chat.emptyStream')}</p>}
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
            <div className={`chat-message${grouped ? ' grouped' : ''}`} key={message.id}>
              {grouped ? <span className="gutter" /> : <Avatar user={author} size={26} />}
              <div className="body">
                {!grouped && (
                  <div className="flex items-center gap-2 gap-1.5">
                    <span className="who">{author?.name ?? t('common.someone')}</span>
                    <span className="when">{relativeTime(message.created_at)}</span>
                    {message.edited_at && <span className="when">· {t('chat.edited')}</span>}
                  </div>
                )}
                {answered && (
                  <div className="quoted">
                    <Icon name="link" size={11} />
                    {' '}
                    {members.get(answered.author_id ?? '')?.name ?? t('common.someone')}:
                    {' '}
                    {String(answered.body).slice(0, 80)}
                  </div>
                )}
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
                <Reactions message={message} me={me} canWrite={canWrite} />
              </div>
              <div className="chat-actions">
                {canWrite && <AddReaction message={message} me={me} />}
                <Button variant="ghost" size="iconSm" title={t('chat.reply')} onClick={() => setReplyTo(message.id)}>
                  <Icon name="link" size={12} />
                </Button>
                {message.author_id === me && (
                  <>
                    <Button variant="ghost" size="iconSm" title={t('action.edit')} onClick={() => setEditing(message.id)}>
                      <Icon name="bolt" size={12} />
                    </Button>
                    <Button variant="ghost" size="iconSm"
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
        <div ref={bottom} />
      </div>

      {canWrite ? (
      <div className="chat-composer">
        {replyTo && (
          <div className="flex items-center gap-2 quoted-draft">
            <Icon name="link" size={12} />
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
        <Typing channelId={channel.id} me={me} />
        <MarkdownEditor
          value={draft}
          onChange={(next) => {
            setDraft(next);
            // The empty composer is not "still typing" — somebody who deletes
            // what they wrote and walks away should not leave the line up for
            // the other person to keep watching.
            setTyping(next.trim() ? channel.id : null);
          }}
          minHeight={54}
          placeholder={t('chat.placeholder', { where: title })}
          onSubmit={send}
        />
        <Button variant="primary" disabled={!draft.trim()} onClick={send}>
          <Icon name="send" size={14} /> {t('chat.send')}
        </Button>
      </div>
      ) : (
        /* A guest can read an open channel and cannot write anywhere. Saying so
           here beats a composer that takes a paragraph and then refuses it. */
        <div className="chat-composer">
          <p className="text-[12px] text-muted text-[12.5px] m-0">{t('chat.readOnly')}</p>
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
 * somebody is trying to read it.
 */
function Typing({ channelId, me }: { channelId: string; me: string }) {
  const t = useT();
  const members = usePeople();
  const who = useTypists(channelId, me);
  const name = (id: string) => members.get(id)?.name ?? t('common.someone');

  const text = who.length === 0 ? ''
    : who.length === 1 ? t('chat.typing', { name: name(who[0]) })
    : who.length === 2 ? t('chat.typingTwo', { first: name(who[0]), second: name(who[1]) })
    : t('chat.typingMany');

  return (
    <p className="m-0 h-[15px] truncate text-[11.5px] text-muted" aria-live="polite">{text}</p>
  );
}

function EditBox({ initial, onDone }: { initial: string; onDone: (body: string) => void }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-2 gap-1.5">
      <MarkdownEditor value={value} onChange={setValue} minHeight={54} onSubmit={() => onDone(value)} />
      <div className="flex items-center gap-2 gap-1.5">
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
    <div className="flex items-center gap-2 flex-wrap reactions gap-1">
      {used.map(([emoji, people]) => (
        <button
          key={emoji}
          className={`reaction${people.includes(me) ? ' mine' : ''}`}
          disabled={!canWrite}
          title={people.map((id) => members.get(id)?.name ?? t('common.someone')).join(', ')}
          onClick={() => toggleReaction(message, emoji, me)}
        >
          <span aria-hidden>{emoji}</span> {people.length}
        </button>
      ))}
    </div>
  );
}

function AddReaction({ message, me }: { message: Message; me: string }) {
  const t = useT();
  return (
    <MenuButton
      variant="ghost" size="iconSm"
      label={t('task.react')}
      items={REACTIONS.map((emoji) => ({
        id: emoji,
        label: <span className="text-base">{emoji}</span>,
        hint: (message.reactions?.[emoji] ?? []).includes(me) ? '✓' : undefined,
        onSelect: () => toggleReaction(message, emoji, me),
      }))}
    >
      <Icon name="sparkle" size={12} />
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
          <p className="text-[12px] text-muted mb-2 text-[12.5px]">{t('chat.whoCanAddHint')}</p>
          <div className="flex items-center gap-2 flex-wrap gap-1.5">
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
        <p className="text-[12px] text-muted text-[12.5px]">{t('chat.openChannelHint')}</p>
      )}

      <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('chat.closing')}</h3>
      <p className="text-[12px] text-muted mb-2 text-[12.5px]">{t('chat.closingHint')}</p>
      <div className="flex items-center gap-2 flex-wrap gap-1.5">
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
        {tidy && tidy !== name && <p className="text-[12px] text-muted text-[12.5px]">{t('chat.willBeCalled', { name: `#${tidy}` })}</p>}
        {taken && <p className="text-[12px] text-muted text-[12.5px]" style={{ color: 'var(--warn)' }}>{t('chat.nameTaken')}</p>}
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
          if (!cancelled) setPeople(found.filter((person) => person.id !== me));
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
