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
import { useThreadWords } from '../../../kernel/design-system/thread-words';
import { cn } from '../../../kernel/design-system/cn';
import { briefWhen } from '../../../kernel/design-system/format';
import { useMinute } from '../../../kernel/design-system/minute';
import { useOpenTask } from '../../../kernel/design-system/navigation';
import { Avatar, Empty, Icon, MenuButton, useAction, useToast } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { Select } from '../../../kernel/design-system/ui/field';
import { navItem } from '../../../kernel/design-system/ui/nav';
import { useI18n, useT } from '../../../kernel/i18n/i18n';
import { useCanWrite, useFeature, useMe, useMemberMap, useMembers, useSession } from '../../../kernel/identity/session';
import { api } from '../../../kernel/sync/api';
import { now } from '../../../kernel/sync/clock';
import { create, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../../kernel/sync/store';

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
          <ul className="m-0 flex list-none flex-col p-0">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  widget={widgets.length > 1 ? widgetName.get(conversation.widget_id) ?? '' : ''}
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

/**
 * One conversation in the list, drawn like a row of the team chat's list: who,
 * when, and what was said last — two lines, so a dozen fit without scrolling.
 * The widget is named only when there is more than one to tell apart.
 */
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
  const who = last?.author === 'agent' ? `${t('support.you')} ` : '';
  return (
    <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} className={cn(navItem({ active }), 'chat-row', unread && 'unread')}>
      <Avatar user={{ id: conversation.visitor_id, name: visitorLabel(conversation) }} size={22} />
      <span className="chat-row-body">
        <span className="chat-row-line">
          <span className="chat-row-title truncate">{visitorLabel(conversation)}</span>
          <span className="chat-row-when">{briefWhen(conversation.last_message_at ?? conversation.created_at)}</span>
        </span>
        {(said || widget) && (
          <span className="chat-row-said truncate">{[widget, `${who}${said}`.trim()].filter(Boolean).join(' · ')}</span>
        )}
      </span>
      {unread && <span className="size-2 flex-none rounded-full bg-accent" aria-label={t('support.unread')} />}
    </button>
  );
}

/**
 * Whether the server has a model, asked once per page.
 *
 * The workspace switch is in the session; whether a key is configured is the
 * server's to say, and `/api/config` says it without a session at all.
 */
let modelConfigured: Promise<boolean> | null = null;
function useModelConfigured(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    modelConfigured ??= api.config().then((config) => !!config.ai).catch(() => false);
    let alive = true;
    void modelConfigured.then((value) => { if (alive) setOn(value); });
    return () => { alive = false; };
  }, []);
  return on;
}

/** How often an open conversation asks whether the visitor is typing. */
const TYPING_POLL_MS = 3000;

function Answer({ conversation, widget, onBack }: { conversation: Conversation; widget?: Widget; onBack: () => void }) {
  const t = useT();
  const { locale } = useI18n();
  const words = useThreadWords();
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
  // Held here rather than in the box, so a suggested reply can be put in it.
  const [draft, setDraft] = useState('');
  const modelOn = useModelConfigured();
  const aiSwitch = useFeature('ai');
  // Read defensively: rows synced before these columns existed have neither.
  const assistant = widget?.assistant ?? 'off';
  const assistantAnswering = assistant === 'answer' && !conversation.handover_at && modelOn && aiSwitch;
  const canSuggest = canWrite && assistant !== 'off' && modelOn && aiSwitch;

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
    const bot = message.author === 'bot';
    const agent = message.author === 'agent' || (!message.author && !!message.author_id);
    const author = agent ? members.get(message.author_id ?? '') : undefined;
    const sources = Array.isArray(message.sources) ? message.sources : [];
    return {
      id: message.id,
      // The model writes for the team, so its lines are on the team's side,
      // marked as its own.
      mine: agent || bot,
      author: agent ? author?.name : visitorLabel(conversation),
      avatar: agent
        ? <Avatar user={author} size={26} />
        : <Avatar user={{ id: conversation.visitor_id, name: visitorLabel(conversation) }} size={26} />,
      body: message.body,
      at: message.created_at,
      meta: bot ? <span>{t('support.assistantLabel')}</span> : undefined,
      below: sources.length ? <span className="mt-0.5 px-1 text-[11px] text-muted">{t('support.sources')}: {sources.join(', ')}</span> : undefined,
      files: filesOf(message).map((file) => ({ key: file.hash, name: file.name, type: file.type, src: fileUrl(file), width: file.width, height: file.height })),
    };
  });

  const suggest = () => action.run(async () => {
    const drafted = await api.post<{ answer: string; handover: boolean }>(`/api/conversations/${conversation.id}/suggest`, {});
    if (drafted.answer) setDraft(drafted.answer);
    else toast(t('support.suggestNothing'));
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
  const assignee = conversation.assignee_id ? members.get(conversation.assignee_id) : undefined;
  // The task the conversation became — unless it has been deleted since, which
  // leaves nothing to open and the conversation free to become one again.
  const task = useQuery(() => byId('task', conversation.task_id), [conversation.task_id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="chat-header flex items-center gap-2">
        <Button variant="ghost" size="iconSm" className="min-[900px]:hidden" aria-label={t('support.back')} onClick={onBack}>
          <Icon name="chevronLeft" size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <strong className="truncate">{visitorLabel(conversation)}</strong>
            {assistantAnswering && (
              <Chip className="h-5 px-2 leading-5" tone="on" title={t('support.assistantAnsweringHint')}>{t('support.assistantAnswering')}</Chip>
            )}
            <Chip className="h-5 px-2 leading-5" tone={conversation.verified ? 'on' : 'default'} title={t(conversation.verified ? 'support.verifiedHint' : 'support.unverifiedHint')}>
              {t(conversation.verified ? 'support.verified' : 'support.unverified')}
            </Chip>
          </span>
          <div className="truncate text-[12.5px] text-muted">
            {[conversation.visitor_email, widget?.name].filter(Boolean).join(' · ')}
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-none items-center gap-1">
            <MenuButton
              size="sm"
              label={t('support.assignee')}
              title={t('support.assignee')}
              search={people.length > 8}
              align="end"
              items={[
                { id: '', label: t('support.unassigned'), onSelect: () => update('conversation', conversation.id, { assignee_id: null }) },
                ...people.map((person) => ({
                  id: person.id,
                  label: person.name,
                  icon: <Avatar user={person} size={16} />,
                  onSelect: () => update('conversation', conversation.id, { assignee_id: person.id }),
                })),
              ]}
            >
              {assignee ? <Avatar user={assignee} size={18} /> : <Icon name="users" size={14} />}
              <span className="hide-sm max-w-[140px] truncate">{assignee?.name ?? t('support.unassigned')}</span>
            </MenuButton>
            {task ? (
              <Button size="sm" variant="ghost" title={task.identifier ?? undefined} onClick={() => openTask({ id: task.id })}>
                <Icon name="check" size={13} /> <span className="hide-sm">{t('support.openTask')}</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy}
                title={t('support.makeTaskHint')}
                onClick={() => action.run(async () => {
                  const made = await api.post<{ task: { id: string } }>(`/api/conversations/${conversation.id}/task`, { locale });
                  toast(t('support.taskMade'));
                  openTask({ id: made.task.id });
                })}
              >
                <Icon name="plus" size={13} /> <span className="hide-sm">{t('support.makeTask')}</span>
              </Button>
            )}
            <Button
              size="sm"
              variant={resolved ? 'secondary' : 'primary'}
              aria-label={t(resolved ? 'support.reopen' : 'support.resolve')}
              title={t(resolved ? 'support.reopen' : 'support.resolve')}
              onClick={() => update('conversation', conversation.id, { status: resolved ? 'open' : 'resolved' })}
            >
              <Icon name={resolved ? 'undo' : 'check'} size={13} /> <span className="hide-sm">{t(resolved ? 'support.reopen' : 'support.resolve')}</span>
            </Button>
          </div>
        )}
      </header>
      <Thread
        words={words}
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
          words={words}
          value={draft}
          onValueChange={setDraft}
          onSend={send}
          onAttach={attach}
          status={canSuggest ? (
            <div className="mb-1.5 flex">
              <Button size="sm" variant="ghost" disabled={action.busy} onClick={suggest}>
                <Icon name="sparkle" size={13} /> {t('support.suggest')}
              </Button>
            </div>
          ) : undefined}
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
