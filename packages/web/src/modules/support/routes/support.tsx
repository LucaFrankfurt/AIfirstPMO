/**
 * The support inbox: every conversation the workspace's widgets have opened,
 * newest first, and the one you are answering.
 *
 * The rows are ordinary synced entities, so the list reads offline and an
 * answer typed on a train goes when the tunnel ends — the same promise the team
 * chat makes. Only the things that are not rows go over the network directly:
 * making a task, and "typing".
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  awaitsReply, unreadByTeam, visitorLabel,
  type Conversation, type ConversationFile, type ConversationMessage, type Widget,
} from '@kolibri/shared';
import { Composer, Thread, type ThreadLine } from '../../../kernel/design-system/conversation';
import { cn } from '../../../kernel/design-system/cn';
import { relativeTime } from '../../../kernel/design-system/format';
import { useMinute } from '../../../kernel/design-system/minute';
import { useOpenTask } from '../../../kernel/design-system/navigation';
import { Avatar, Empty, Icon, useAction, useToast } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Select } from '../../../kernel/design-system/ui/field';
import { useT } from '../../../kernel/i18n/i18n';
import { useCanWrite, useFeature, useMe, useMemberMap, useMembers, useSession } from '../../../kernel/identity/session';
import { api } from '../../../kernel/sync/api';
import { now } from '../../../kernel/sync/clock';
import { create, update } from '../../../kernel/sync/mutations';
import { list, useQuery } from '../../../kernel/sync/store';

type Filter = 'open' | 'resolved';

/** A file as the app fetches it: through `/files`, with this member's own session. */
const fileUrl = (file: ConversationFile) => `/files/${file.hash}/${encodeURIComponent(file.name)}`;

/**
 * A field added to a row after devices had copies of it arrives as nothing on
 * those devices — see `withLists` in the meetings module. Every list field here
 * is read through this, so a row synced before `files` existed is not a crash.
 */
const filesOf = (message: ConversationMessage): ConversationFile[] => (Array.isArray(message.files) ? message.files : []);

export function SupportInbox() {
  useMinute();
  const t = useT();
  const navigate = useNavigate();
  const { id } = useParams();
  const enabled = useFeature('support');
  const [filter, setFilter] = useState<Filter>('open');
  const [widgetId, setWidgetId] = useState('');

  const widgets = useQuery(() => list('widget').sort((a, b) => a.name.localeCompare(b.name)), []);
  const conversations = useQuery(
    () => list('conversation', (row) => row.status === filter && (!widgetId || row.widget_id === widgetId))
      .sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at)),
    [filter, widgetId],
  );
  const current = useQuery(() => (id ? list('conversation', (row) => row.id === id)[0] : undefined), [id]);
  const widgetName = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget.name])), [widgets]);

  if (!enabled) return <Empty emoji="💬" title={t('support.off')} hint={t('support.offHint')} />;

  return (
    // The chat's own layout classes: one column on a phone, list beside the
    // conversation from 900px, and the page itself never scrolls.
    <div className="mx-auto max-w-[1180px] px-3 pb-2.5 pt-4 sm:px-6 sm:pt-5 chat">
        <aside className="chat-list" aria-label={t('support.title')}>
          <h1 className="m-0 mb-2" style={{ fontSize: 17 }}>{t('support.title')}</h1>
          {/* Two buttons rather than a tab strip: it filters one list, it does
              not switch between screens. */}
          <div className="mb-2 flex gap-1" role="group" aria-label={t('support.title')}>
            {(['open', 'resolved'] as const).map((name) => (
              <Button key={name} size="sm" variant={filter === name ? 'secondary' : 'ghost'} aria-pressed={filter === name} onClick={() => setFilter(name)}>
                {t(name === 'open' ? 'support.open' : 'support.resolved')}
              </Button>
            ))}
          </div>
          {widgets.length > 1 && (
            <Select inputSize="sm" className="mb-2 w-full" value={widgetId} aria-label={t('support.widget')} onChange={(event) => setWidgetId(event.target.value)}>
              <option value="">{t('support.allWidgets')}</option>
              {widgets.map((widget) => <option key={widget.id} value={widget.id}>{widget.name}</option>)}
            </Select>
          )}
          {!widgets.length && (
            <p className="text-[12.5px] text-muted">
              {t('support.noWidgets')} <Link className="text-accent" to="/settings?tab=widgets">{t('support.setUp')}</Link>
            </p>
          )}
          {widgets.length > 0 && !conversations.length && (
            <p className="text-[12.5px] text-muted">{t(filter === 'open' ? 'support.noneOpen' : 'support.noneResolved')}</p>
          )}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  widget={widgetName.get(conversation.widget_id) ?? ''}
                  active={conversation.id === id}
                  onOpen={() => navigate(`/support/${conversation.id}`)}
                />
              </li>
            ))}
          </ul>
        </aside>
        <section className="chat-main">
          {current
            ? <Answer key={current.id} conversation={current} widget={widgets.find((widget) => widget.id === current.widget_id)} onBack={() => navigate('/support')} />
            : <Empty emoji="💬" title={t('support.pick')} hint={t('support.pickHint')} />}
        </section>
    </div>
  );
}

function ConversationRow({ conversation, widget, active, onOpen }: {
  conversation: Conversation; widget: string; active: boolean; onOpen: () => void;
}) {
  const t = useT();
  const last = useQuery(
    () => list('conversationMessage', (row) => row.conversation_id === conversation.id)
      .sort((a, b) => b.created_at - a.created_at)[0],
    [conversation.id],
  );
  const unread = unreadByTeam(conversation);
  const said = last ? (last.body || filesOf(last).map((file) => file.name).join(', ')) : '';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-hover',
        active && 'bg-active',
      )}
    >
      <Avatar user={{ id: conversation.visitor_id, name: visitorLabel(conversation) }} size={28} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-semibold text-fg' : 'text-soft')}>
            {visitorLabel(conversation)}
          </span>
          <span className="flex-none text-[11px] tabular-nums text-muted">{relativeTime(conversation.last_message_at ?? conversation.created_at)}</span>
        </span>
        <span className="truncate text-[11.5px] text-muted">{widget}</span>
        {said && (
          <span className={cn('line-clamp-2 text-[12px] leading-[1.35]', unread ? 'text-soft' : 'text-muted')}>
            {last?.author === 'agent' && <>{t('support.you')} </>}{said}
          </span>
        )}
      </span>
      {unread && <span className="mt-1.5 size-2 flex-none rounded-full bg-accent" aria-label={t('support.unread')} />}
    </button>
  );
}

/** How often an open conversation asks whether the visitor is typing. */
const TYPING_POLL_MS = 3000;

function Answer({ conversation, widget, onBack }: { conversation: Conversation; widget?: Widget; onBack: () => void }) {
  const t = useT();
  const me = useMe();
  const toast = useToast();
  const action = useAction();
  const openTask = useOpenTask();
  const canWrite = useCanWrite();
  const { workspaceId } = useSession();
  const members = useMemberMap();
  const people = useMembers();
  const [typing, setTyping] = useState(false);
  const [attached, setAttached] = useState<ConversationFile[]>([]);

  const messages = useQuery(
    () => list('conversationMessage', (row) => row.conversation_id === conversation.id)
      .sort((a, b) => a.created_at - b.created_at),
    [conversation.id],
  );

  // Opening it is reading it, for the whole team: one person answering is
  // the team answering, so the inbox's dot goes for everybody.
  useEffect(() => {
    if (canWrite && unreadByTeam(conversation) && document.visibilityState === 'visible') {
      update('conversation', conversation.id, { agent_read_at: now() });
    }
  }, [conversation.id, conversation.last_message_at, canWrite]);

  useEffect(() => {
    let alive = true;
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      api.get<{ visitor: boolean }>(`/api/conversations/${conversation.id}/typing`)
        .then((answer) => { if (alive) setTyping(answer.visitor); })
        .catch(() => undefined);
    };
    ask();
    const timer = window.setInterval(ask, TYPING_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [conversation.id]);

  const lines: ThreadLine[] = messages.map((message) => {
    const agent = message.author === 'agent' || (!message.author && !!message.author_id);
    const author = agent ? members.get(message.author_id ?? '') : undefined;
    return {
      id: message.id,
      mine: agent,
      author: agent ? author?.name : visitorLabel(conversation),
      avatar: agent
        ? <Avatar user={author} size={26} />
        : <Avatar user={{ id: conversation.visitor_id, name: visitorLabel(conversation) }} size={26} />,
      body: message.body,
      at: message.created_at,
      files: filesOf(message).map((file) => ({ key: file.hash, name: file.name, type: file.type, src: fileUrl(file), width: file.width, height: file.height })),
    };
  });

  const send = (body: string) => {
    create('conversationMessage', {
      conversation_id: conversation.id,
      body,
      files: attached,
      // The server decides both; they are here so the line is drawn on the
      // right side before the server has said so.
      author: 'agent',
      author_id: me,
    });
    setAttached([]);
  };

  const attach = (file: File) => action.run(async () => {
    const stored = await api.upload(workspaceId, file, file.name || 'screenshot.png');
    setAttached((files) => [...files, {
      hash: stored.hash, name: stored.name, type: stored.mime, size: stored.size,
      width: stored.width ?? null, height: stored.height ?? null,
    }]);
  });

  const resolved = conversation.status === 'resolved';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="chat-header flex items-center gap-2">
        <Button variant="ghost" size="iconSm" className="min-[900px]:hidden" aria-label={t('support.back')} onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate">{visitorLabel(conversation)}</strong>
            <Chip className="h-5 px-2 leading-5" tone={conversation.verified ? 'on' : 'default'} title={t(conversation.verified ? 'support.verifiedHint' : 'support.unverifiedHint')}>
              {t(conversation.verified ? 'support.verified' : 'support.unverified')}
            </Chip>
          </span>
          <div className="truncate text-[12.5px] text-muted">
            {[conversation.visitor_email, widget?.name].filter(Boolean).join(' · ')}
          </div>
        </div>
        {canWrite && (
          <Select
            inputSize="sm"
            className="w-auto max-w-[150px]"
            aria-label={t('support.assignee')}
            value={conversation.assignee_id ?? ''}
            onChange={(event) => update('conversation', conversation.id, { assignee_id: event.target.value || null })}
          >
            <option value="">{t('support.unassigned')}</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </Select>
        )}
        {canWrite && (conversation.task_id ? (
          <Button size="sm" variant="ghost" onClick={() => openTask({ id: conversation.task_id! })}>
            <Icon name="check" size={13} /> <span className="hide-sm">{t('support.openTask')}</span>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            title={t('support.makeTaskHint')}
            onClick={() => action.run(async () => {
              const made = await api.post<{ task: { id: string } }>(`/api/conversations/${conversation.id}/task`, {});
              toast(t('support.taskMade'));
              openTask({ id: made.task.id });
            })}
          >
            <Icon name="plus" size={13} /> <span className="hide-sm">{t('support.makeTask')}</span>
          </Button>
        ))}
        {canWrite && (
          <Button
            size="sm"
            variant={resolved ? 'secondary' : 'primary'}
            onClick={() => update('conversation', conversation.id, { status: resolved ? 'open' : 'resolved' })}
          >
            {t(resolved ? 'support.reopen' : 'support.resolve')}
          </Button>
        )}
      </header>
      <Thread
        lines={lines}
        typing={typing ? visitorLabel(conversation) : false}
        seenAt={conversation.visitor_read_at}
        empty={<p className="text-center text-[12.5px] text-muted">{t('support.emptyThread')}</p>}
      />
      {awaitsReply(conversation) && conversation.visitor_email && (
        <p className="m-0 px-4 pb-1 text-[11.5px] text-muted">{t('support.emailFallback')}</p>
      )}
      {canWrite && (
        <Composer
          onSend={send}
          onAttach={attach}
          attached={attached.length ? (
            <div className="flex flex-wrap gap-1.5">
              {attached.map((file) => (
                <Chip key={file.hash} className="h-7 leading-7">
                  <Icon name="image" size={12} /> <span className="max-w-[160px] truncate">{file.name}</span>
                  <button type="button" aria-label={t('action.remove')} onClick={() => setAttached((files) => files.filter((one) => one.hash !== file.hash))}>
                    <Icon name="close" size={11} />
                  </button>
                </Chip>
              ))}
            </div>
          ) : undefined}
          onTyping={(typingNow) => void api.post(`/api/conversations/${conversation.id}/typing`, { typing: typingNow }).catch(() => undefined)}
          placeholder={t('support.answerPlaceholder', { name: visitorLabel(conversation) })}
        />
      )}
    </div>
  );
}
