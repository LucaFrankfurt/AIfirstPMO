/**
 * Conversations.
 *
 * The messages are ordinary synced rows, which is most of why this file is
 * short: sending works offline because every write here works offline, and a
 * message appears on the other person's screen because the change stream
 * already tells their device that something moved. There is no socket, no
 * second protocol, and nothing here that has to be reconnected.
 *
 * What is deliberately *not* here is a typing indicator and a presence dot.
 * Both are ephemeral state, and this app's realtime channel carries "something
 * changed up to seq N" and nothing else — on purpose, so that catching up after
 * a tunnel and hearing about a change live are one code path. Adding
 * per-keystroke state to it would mean a second mechanism with its own failure
 * modes, in exchange for a feature nobody has ever needed to do their work.
 * `docs/chat.md` says so out loud rather than leaving it to be noticed.
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
import { useCanWrite, useMe, useMemberMap, usePeople, useSession } from '../session';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Avatar, Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../components/ui';

/* --------------------------------------------------------------- the pieces */

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
    <div className="page chat">
      <aside className="chat-list">
        <div className="row" style={{ marginBottom: 8 }}>
          <h1 className="grow" style={{ fontSize: 17, margin: 0 }}>{t('chat.title')}</h1>
          {canWrite && (
            <button className="btn sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} /> {t('chat.new')}
            </button>
          )}
        </div>

        {/* "Start a channel, or write to somebody below" is only useful advice
            while there is somebody below. Alone, the hint further down says the
            true thing instead, and two hints where one is wrong is worse. */}
        {conversations.length === 0 && (others.length > 0 || !canWrite) && (
          <p className="hint" style={{ fontSize: 12.5 }}>{t('chat.noneYet')}</p>
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
        {canWrite && <h2 className="nav-section" style={{ marginTop: 14 }}>{t('chat.people')}</h2>}
        {/* Alone in this workspace, the list below is empty — the usual state
            on a fresh instance, because signing up a second time makes a second
            workspace rather than joining the first. It is no longer a dead end:
            a direct conversation does not need a workspace in common. */}
        {canWrite && others.length === 0 && (
          <p className="hint" style={{ fontSize: 12.5 }}>{t('chat.aloneHint')}</p>
        )}
        {canWrite && others.map((member) => (
          <button
            key={member.id}
            className="nav-item"
            onClick={() => navigate(`/chat/${openDirect(me, member.id)}`)}
          >
            <Avatar user={member} size={20} />
            <span className="grow truncate">{member.name}</span>
          </button>
        ))}
        {canWrite && (
          <button className="nav-item chat-find" onClick={() => setFinding(true)}>
            <Icon name="search" size={16} />
            <span className="grow truncate">{t('chat.findPerson')}</span>
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
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={onOpen}>
      <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} size={15} />
      <span className="grow truncate">{title}</span>
      {unread > 0 && <span className="count">{unread}</span>}
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
  };

  const title = channelTitle(channel, me, (id) => members.get(id)?.name);

  return (
    <>
      <header className="chat-header row">
        {/* On a phone the conversation is the whole screen, so this is the only
            way back to the list. Hidden where the list is already beside it. */}
        <button className="btn ghost sm icon chat-back" aria-label={t('chat.backToList')} onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <Icon name={channel.kind === 'direct' ? 'chat' : 'hash'} size={16} />
        <div className="grow">
          <strong>{title}</strong>
          {channel.topic && <div className="muted" style={{ fontSize: 12 }}>{channel.topic}</div>}
        </div>
        <NotifyMenu channel={channel} me={me} />
        {channel.kind !== 'direct' && canWrite && (
          <button className="btn ghost sm icon" title={t('chat.manage')} onClick={() => setManaging(true)}>
            <Icon name="users" size={14} />
          </button>
        )}
      </header>
      {managing && <ChannelSettings channel={channel} me={me} onClose={() => setManaging(false)} onGone={onBack} />}

      <div className="chat-stream">
        {messages.length === 0 && <p className="hint" style={{ fontSize: 12.5 }}>{t('chat.emptyStream')}</p>}
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
                  <div className="row" style={{ gap: 6 }}>
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
                <button className="btn ghost sm icon" title={t('chat.reply')} onClick={() => setReplyTo(message.id)}>
                  <Icon name="link" size={12} />
                </button>
                {message.author_id === me && (
                  <>
                    <button className="btn ghost sm icon" title={t('action.edit')} onClick={() => setEditing(message.id)}>
                      <Icon name="bolt" size={12} />
                    </button>
                    <button
                      className="btn ghost sm icon"
                      title={t('action.delete')}
                      onClick={async () => {
                        if (await confirm(t('chat.deleteMessage'))) remove('message', message.id);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
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
          <div className="row quoted-draft">
            <Icon name="link" size={12} />
            <span className="grow truncate">
              {t('chat.replyingTo', {
                name: members.get(messages.find((m) => m.id === replyTo)?.author_id ?? '')?.name ?? t('common.someone'),
              })}
            </span>
            <button className="btn ghost sm icon" aria-label={t('annotate.clear')} onClick={() => setReplyTo(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          minHeight={54}
          placeholder={t('chat.placeholder', { where: title })}
          onSubmit={send}
        />
        <button className="btn primary" disabled={!draft.trim()} onClick={send}>
          <Icon name="send" size={14} /> {t('chat.send')}
        </button>
      </div>
      ) : (
        /* A guest can read an open channel and cannot write anywhere. Saying so
           here beats a composer that takes a paragraph and then refuses it. */
        <div className="chat-composer">
          <p className="hint" style={{ fontSize: 12.5, margin: 0 }}>{t('chat.readOnly')}</p>
        </div>
      )}
      {dialog}
    </>
  );
}

function EditBox({ initial, onDone }: { initial: string; onDone: (body: string) => void }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <div className="col" style={{ gap: 6 }}>
      <MarkdownEditor value={value} onChange={setValue} minHeight={54} onSubmit={() => onDone(value)} />
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" onClick={() => onDone(value)}>{t('action.save')}</button>
        <button className="btn sm" onClick={() => onDone(initial)}>{t('action.cancel')}</button>
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
      className="btn ghost sm"
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
    <div className="row wrap reactions" style={{ gap: 4 }}>
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
      className="btn ghost sm icon"
      label={t('task.react')}
      items={REACTIONS.map((emoji) => ({
        id: emoji,
        label: <span style={{ fontSize: 16 }}>{emoji}</span>,
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
        <input
          id="channel-topic"
          className="input"
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
            <div className="row" key={id} style={{ gap: 8, padding: '4px 0' }}>
              <Avatar user={members.get(id)} size={22} />
              <span className="grow truncate">{members.get(id)?.name ?? id}</span>
              {channel.created_by === id && <span className="chip">{t('chat.opened')}</span>}
              {(mayManage || id === me) && inside.length > 1 && (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    if (id === me && !(await confirm(t('chat.confirmLeave')))) return;
                    setMembers(inside.filter((other) => other !== id));
                    if (id === me) { onClose(); onGone(); }
                  }}
                >
                  {id === me ? t('chat.leave') : t('chat.remove')}
                </button>
              )}
            </div>
          ))}

          {mayManage && !!outside.length && (
            <>
              <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{t('chat.addSomebody')}</h3>
              {outside.map((member) => (
                <button
                  key={member.id}
                  className="nav-item"
                  onClick={() => {
                    setMembers([...inside, member.id]);
                    toast(t('chat.added', { name: member.name }));
                  }}
                >
                  <Avatar user={member} size={22} />
                  <span className="grow truncate">{member.name}</span>
                  <Icon name="plus" size={13} />
                </button>
              ))}
            </>
          )}

          <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('chat.whoCanAdd')}</h3>
          <p className="hint" style={{ marginBottom: 8, fontSize: 12 }}>{t('chat.whoCanAddHint')}</p>
          <div className="row wrap" style={{ gap: 6 }}>
            {(['members', 'admins'] as const).map((policy) => (
              <button
                key={policy}
                className={`btn sm${(channel.invite_policy ?? 'members') === policy ? ' active' : ''}`}
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
        <p className="hint" style={{ fontSize: 12.5 }}>{t('chat.openChannelHint')}</p>
      )}

      <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{t('chat.closing')}</h3>
      <p className="hint" style={{ marginBottom: 8, fontSize: 12 }}>{t('chat.closingHint')}</p>
      <div className="row wrap" style={{ gap: 6 }}>
        <button
          className="btn sm"
          onClick={() => {
            update('channel', channel.id, { archived_at: Date.now() });
            toast(t('chat.archived'));
            onClose();
            onGone();
          }}
        >
          <Icon name="archive" size={13} /> {t('chat.archive')}
        </button>
        {mayRetitle && (
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!(await confirm(t('chat.confirmDelete')))) return;
              remove('channel', channel.id);
              onClose();
              onGone();
            }}
          >
            <Icon name="trash" size={13} /> {t('action.delete')}
          </button>
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
          <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button
            className="btn primary"
            disabled={!tidy || taken}
            onClick={() => {
              const id = create('channel', { name: tidy, topic: topic.trim() || null, is_private: isPrivate ? 1 : 0 });
              toast(t('chat.created', { name: `#${tidy}` }));
              onCreated(id);
              onClose();
            }}
          >
            {t('chat.create')}
          </button>
        </>
      }
    >
        <div className="field">
          <label htmlFor="new-channel-name">{t('chat.name')}</label>
          <input
            id="new-channel-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            placeholder="design-review"
          />
        </div>
        {/* Shown before it is saved, because "#Design Review" quietly becoming
            "#design-review" afterwards is a surprise. */}
        {tidy && tidy !== name && <p className="hint" style={{ fontSize: 12 }}>{t('chat.willBeCalled', { name: `#${tidy}` })}</p>}
        {taken && <p className="hint" style={{ fontSize: 12, color: 'var(--warn)' }}>{t('chat.nameTaken')}</p>}
        <div className="field">
          <label htmlFor="new-channel-topic">{t('chat.topic')}</label>
          <input
            id="new-channel-topic"
            className="input"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder={t('chat.topicHint')}
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
          <span>
            <strong>{t('chat.private')}</strong>
            <span className="hint">{t('chat.privateHint')}</span>
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
        <input
          id="find-person"
          className="input"
          value={query}
          autoFocus
          placeholder={t('chat.findPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && <p className="hint warn">{error}</p>}
      {!error && people.length === 0 && <p className="hint">{t('chat.findNobody')}</p>}
      {people.map((person) => (
        <button
          key={person.id}
          className="nav-item"
          onClick={() => {
            onPick(person.id);
            onClose();
          }}
        >
          <Avatar user={person} size={22} />
          <span className="grow truncate">{person.name}</span>
          <span className="muted truncate" style={{ fontSize: 11.5 }}>{person.email}</span>
        </button>
      ))}
    </Sheet>
  );
}
