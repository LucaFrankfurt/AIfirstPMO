/**
 * A visitor's side of a support conversation.
 *
 * Everything here talks to `/w/:widget/…` on this same origin — the iframe is
 * served by Kolibri, so no CORS is opened and no cookie is read. Who the
 * visitor is comes from one of two places: the host page, which hands over a
 * token its own server signed (asked for with `postMessage` and never put in a
 * URL), or the visitor themselves on an anonymous widget, who may leave a name
 * and an address.
 *
 * The host page and this frame say four things to each other, all as
 * `kolibri-chat:*` messages: "give me a token" and the answer, whether the
 * panel is open, how many answers are unread while it is not, and "close me".
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SUPPORT_TYPING_MS, type ConversationFile, type WidgetIdentity } from '@kolibri/shared';
import { Composer, Thread, type ThreadLine } from '../../kernel/design-system/conversation';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Button } from '../../kernel/design-system/ui/button';
import { Input } from '../../kernel/design-system/ui/field';
import { widgetLocale, widgetWords } from './words';

interface Config {
  id: string;
  name: string;
  greeting: string | null;
  color: string | null;
  identity: WidgetIdentity;
}

interface Line {
  id: string;
  author: 'visitor' | 'agent' | 'bot';
  agent: string | null;
  body: string;
  files: ConversationFile[];
  /** The knowledge pages a model's answer rests on, by title. */
  sources?: string[];
  created_at: number;
  seq: number;
  pending?: boolean;
  failed?: boolean;
}

type Stage = 'loading' | 'unavailable' | 'signin' | 'introduce' | 'ready' | 'ended';

const widgetId = decodeURIComponent(window.location.pathname.split('/')[2] ?? '');
const base = `/w/${encodeURIComponent(widgetId)}`;
const STORE = `kolibri.chat.${widgetId}`;
const framed = window.parent !== window;
/** One language for the life of the page: the visitor's browser's. */
const words = widgetWords(widgetLocale());

/** To the host page. Nothing here is a secret, so any origin may hear it — the frame decides who may hold it. */
const tell = (message: Record<string, unknown>) => {
  if (framed) window.parent.postMessage({ ...message, widget: widgetId }, '*');
};

/** Our session is over: expired, rotated away, or the conversation is gone. */
class Ended extends Error {}

async function call<T>(path: string, session = '', init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(session ? { 'x-widget-session': session } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (response.status === 401) throw new Ended();
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json() as Promise<T>;
}

/** The host page's token: asked for, and given up on after a while rather than waited for for ever. */
function askToken(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!framed) return resolve(null);
    const heard = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'kolibri-chat:token') return;
      done(typeof event.data.token === 'string' && event.data.token ? event.data.token : null);
    };
    const timer = window.setTimeout(() => done(null), 15_000);
    const done = (token: string | null) => {
      window.clearTimeout(timer);
      window.removeEventListener('message', heard);
      resolve(token);
    };
    window.addEventListener('message', heard);
    tell({ type: 'kolibri-chat:token-request' });
  });
}

/** An anonymous visitor's session, kept in this frame's own storage until it expires. */
function storedSession(): string {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { session: string; expiresAt: number } | null;
    return kept && kept.expiresAt > Date.now() ? kept.session : '';
  } catch {
    return '';
  }
}

/** Black or white, whichever reads on the site's colour. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

const merge = (lines: Line[], line: Line): Line[] =>
  [...lines.filter((one) => one.id !== line.id), line].sort((a, b) => a.created_at - b.created_at);

export function VisitorChat() {
  const [config, setConfig] = useState<Config | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [session, setSession] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [agentRead, setAgentRead] = useState<number | null>(null);
  const [agentTyping, setAgentTyping] = useState(false);
  const [attached, setAttached] = useState<ConversationFile[]>([]);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(true);
  const [images, setImages] = useState<Record<string, string>>({});
  /** Bumped to open the stream again after it closed for a reason that was not the session. */
  const [attempt, setAttempt] = useState(0);
  /** When the model handed over, or the visitor asked for a person. */
  const [handedOver, setHandedOver] = useState<number | null>(null);
  /** Resolved by the team or by the visitor; writing on reopens it. */
  const [resolved, setResolved] = useState(false);
  const retried = useRef(0);
  const readUpTo = useRef(0);
  const unread = useRef(0);

  /** Keep an anonymous visitor's session in this frame's storage, so the next page finds the chat. */
  const keep = (opened: { session: string; expiresAt: number }) => {
    try { localStorage.setItem(STORE, JSON.stringify({ session: opened.session, expiresAt: opened.expiresAt })); } catch { /* storage refused */ }
  };

  const begin = async (widget: Config) => {
    if (widget.identity === 'anonymous') {
      const kept = storedSession();
      setSession(kept);
      setStage(kept ? 'ready' : 'introduce');
      return;
    }
    const token = await askToken();
    if (!token) return setStage('signin');
    try {
      const opened = await call<{ session: string }>('/session', '', { method: 'POST', body: JSON.stringify({ token }) });
      setSession(opened.session);
      setStage('ready');
    } catch {
      setStage('signin');
    }
  };

  /** The session ran out: a signed visitor asks the host again, once; an anonymous one starts over. */
  const ended = () => {
    if (!config) return;
    if (config.identity === 'anonymous') {
      try { localStorage.removeItem(STORE); } catch { /* storage refused */ }
      setSession('');
      setStage('introduce');
    } else if (retried.current++ < 1) {
      setStage('loading');
      void begin(config);
    } else {
      setStage('ended');
    }
  };

  useEffect(() => {
    call<{ widget: Config }>('/config')
      .then(({ widget }) => {
        setConfig(widget);
        return begin(widget);
      })
      .catch(() => setStage('unavailable'));
    // The host says whether the panel is showing; an answer that arrives while
    // it is not counts as unread there.
    const heard = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === 'kolibri-chat:visibility') setOpen(!!event.data.open);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, []);

  // The thread, then the stream of what is said next.
  useEffect(() => {
    if (stage !== 'ready' || !session) return undefined;
    let source: EventSource | null = null;
    let alive = true;
    let typingTimer = 0;
    call<{ messages: Line[]; conversation: { agent_read_at: number | null; handover_at?: number | null; status: string } }>('/messages', session)
      .then((history) => {
        if (!alive) return;
        setLines(history.messages);
        setAgentRead(history.conversation.agent_read_at);
        setHandedOver(history.conversation.handover_at ?? null);
        setResolved(history.conversation.status === 'resolved');
        readUpTo.current = Math.max(readUpTo.current, ...history.messages.map((line) => line.created_at), 0);
        const after = Math.max(0, ...history.messages.map((line) => line.seq));
        source = new EventSource(`${base}/stream?session=${encodeURIComponent(session)}&after=${after}`);
        source.addEventListener('message', (event) => {
          const line = JSON.parse((event as MessageEvent).data) as Line;
          setLines((now) => merge(now, line));
          if (line.author !== 'visitor') setAgentTyping(false);
        });
        source.addEventListener('gone', (event) => {
          const { id } = JSON.parse((event as MessageEvent).data) as { id: string };
          setLines((now) => now.filter((line) => line.id !== id));
        });
        source.addEventListener('read', (event) => setAgentRead(JSON.parse((event as MessageEvent).data).agent_read_at));
        source.addEventListener('handover', (event) => setHandedOver(JSON.parse((event as MessageEvent).data).handover_at ?? null));
        source.addEventListener('status', (event) => setResolved(JSON.parse((event as MessageEvent).data).status === 'resolved'));
        source.addEventListener('typing', (event) => {
          const typing = !!JSON.parse((event as MessageEvent).data).agent;
          setAgentTyping(typing);
          window.clearTimeout(typingTimer);
          if (typing) typingTimer = window.setTimeout(() => setAgentTyping(false), SUPPORT_TYPING_MS);
        });
        source.addEventListener('end', () => { source?.close(); ended(); });
        /*
         * A closed source is not proof the session is over. Leaving the page
         * closes it too, with an error — and reading that as "ended" wiped an
         * anonymous visitor's stored session on every reload. So ask: a 401 is
         * the end; anything else, including a request the unload aborted, is not.
         */
        source.onerror = () => {
          if (source?.readyState !== EventSource.CLOSED || !alive) return;
          call('/messages', session).then(
            () => { if (alive) setAttempt((n) => n + 1); },
            (error) => { if (error instanceof Ended && alive) ended(); },
          );
        };
      })
      .catch((error) => { if (error instanceof Ended) ended(); else setStage('unavailable'); });
    return () => {
      alive = false;
      window.clearTimeout(typingTimer);
      source?.close();
    };
  }, [stage, session, attempt]);

  // Read while it is on screen; counted as unread for the host's badge while it is not.
  useEffect(() => {
    const newest = lines.filter((line) => line.author !== 'visitor').reduce((at, line) => Math.max(at, line.created_at), 0);
    if (!newest || newest <= readUpTo.current) return;
    if (open && document.visibilityState === 'visible') {
      readUpTo.current = newest;
      unread.current = 0;
      tell({ type: 'kolibri-chat:unread', count: 0 });
      void call('/read', session, { method: 'POST', body: '{}' }).catch(() => undefined);
    } else {
      unread.current = lines.filter((line) => line.author !== 'visitor' && line.created_at > readUpTo.current).length;
      tell({ type: 'kolibri-chat:unread', count: unread.current });
    }
  }, [lines, open, session]);

  // Pictures come through this session, so they are fetched with it and shown from memory.
  useEffect(() => {
    for (const file of lines.flatMap((line) => line.files)) {
      if (!file.type.startsWith('image/') || file.hash in images) continue;
      setImages((now) => ({ ...now, [file.hash]: '' }));
      fetch(`${base}/files/${file.hash}`, { headers: { 'x-widget-session': session } })
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('missing'))))
        .then((blob) => setImages((now) => ({ ...now, [file.hash]: URL.createObjectURL(blob) })))
        .catch(() => undefined);
    }
  }, [lines, session]);

  const send = async (body: string, files = attached, replacing?: string) => {
    setAttached([]);
    setNotice('');
    // Writing into a resolved chat reopens it; the server does the same.
    setResolved(false);
    const temp = replacing ?? `local-${Date.now()}`;
    setLines((now) => merge(now, { id: temp, author: 'visitor', agent: null, body, files, created_at: Date.now(), seq: 0, pending: true }));
    try {
      const { message } = await call<{ message: Line }>('/messages', session, { method: 'POST', body: JSON.stringify({ body, files }) });
      setLines((now) => merge(now.filter((line) => line.id !== temp), message));
    } catch (error) {
      if (error instanceof Ended) return ended();
      setLines((now) => now.map((line) => (line.id === temp ? { ...line, pending: false, failed: true } : line)));
    }
  };

  const attach = async (file: File) => {
    setNotice('');
    try {
      const response = await fetch(`${base}/files`, {
        method: 'POST',
        body: file,
        headers: {
          'content-type': file.type || 'image/png',
          'x-filename': encodeURIComponent(file.name || 'screenshot.png'),
          'x-widget-session': session,
        },
      });
      if (response.status === 401) return ended();
      if (!response.ok) throw new Error(`${response.status}`);
      const { file: stored } = await response.json() as { file: ConversationFile };
      setAttached((now) => [...now, stored]);
    } catch {
      setNotice(words.uploadFailed);
    }
  };

  /** The visitor is done. Nothing else changes: writing again reopens it. */
  const resolve = () => {
    setResolved(true);
    void call('/resolve', session, { method: 'POST', body: '{}' }).catch((error) => {
      if (error instanceof Ended) ended();
      else setResolved(false);
    });
  };

  /** A fresh conversation, under a session of its own; the stream follows the new session. */
  const startOver = async () => {
    setNotice('');
    try {
      const opened = await call<{ session: string; expiresAt: number }>('/conversations', session, { method: 'POST', body: '{}' });
      if (config?.identity === 'anonymous') keep(opened);
      setLines([]);
      setAgentRead(null);
      setHandedOver(null);
      setResolved(false);
      setSession(opened.session);
    } catch (error) {
      if (error instanceof Ended) ended();
      else setNotice(words.unavailable);
    }
  };

  const accent = config?.color ?? null;
  // The site's colour on the send button, the header and the visitor's own lines.
  const ink = accent ? inkFor(accent) : '';
  const style = (accent ? {
    '--thread-accent': accent,
    '--thread-accent-fg': ink,
    '--thread-mine-bg': accent,
    '--thread-mine-fg': ink,
    '--thread-mine-meta': ink === '#ffffff' ? 'rgb(255 255 255 / 75%)' : 'rgb(0 0 0 / 60%)',
  } : {}) as CSSProperties;

  const threadLines: ThreadLine[] = [
    ...(config?.greeting || stage === 'ready' ? [{
      id: 'greeting',
      mine: false,
      author: config?.name,
      avatar: <TeamMark />,
      body: config?.greeting || words.welcome,
      at: lines[0]?.created_at ?? Date.now(),
    }] : []),
    ...lines.map((line): ThreadLine => ({
      id: line.id,
      mine: line.author === 'visitor',
      author: line.author === 'bot' ? words.assistant : (line.agent ?? words.team),
      avatar: <TeamMark />,
      body: line.body,
      at: line.created_at,
      pending: line.pending,
      below: line.sources?.length
        ? <span className="mt-0.5 px-1 text-[11px] text-muted">{words.sources}: {line.sources.join(', ')}</span>
        : undefined,
      failed: line.failed ? (
        <button type="button" className="underline" onClick={() => void send(line.body, line.files, line.id)}>
          {words.sendFailed} {words.retry}
        </button>
      ) : undefined,
      files: line.files.map((file) => ({
        key: file.hash, name: file.name, type: file.type, src: images[file.hash] || null, width: file.width, height: file.height,
      })),
    })),
  ];

  return (
    <div className="flex h-full flex-col bg-bg" style={style}>
      <header
        className="flex flex-none items-center gap-2 px-4 py-3"
        style={{ background: 'var(--thread-accent, var(--accent))', color: 'var(--thread-accent-fg, var(--accent-fg))' }}
      >
        <strong className="min-w-0 flex-1 truncate text-[15px]">{config?.name ?? ''}</strong>
        {stage === 'ready' && !resolved && lines.length > 0 && (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium hover:bg-black/10"
            title={words.resolve}
            onClick={resolve}
          >
            <Icon name="check" size={14} /> {words.done}
          </button>
        )}
        {framed && (
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-black/10"
            aria-label={words.close}
            title={words.close}
            onClick={() => tell({ type: 'kolibri-chat:close' })}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
      {stage === 'loading' && <Middle>{words.connecting}</Middle>}
      {stage === 'unavailable' && <Middle>{words.unavailable}</Middle>}
      {stage === 'signin' && <Middle>{words.notSignedIn}</Middle>}
      {stage === 'ended' && <Middle>{words.ended}</Middle>}
      {stage === 'introduce' && config && (
        <Introduce
          greeting={config.greeting || words.welcome}
          onStart={async (values) => {
            const opened = await call<{ session: string; expiresAt: number }>('/session', '', { method: 'POST', body: JSON.stringify(values) });
            keep(opened);
            setSession(opened.session);
            setStage('ready');
          }}
        />
      )}
      {stage === 'ready' && (
        <>
          <Thread words={words} lines={threadLines} typing={agentTyping ? words.team : false} seenAt={agentRead} />
          {/* While the model is answering, a person is one click away; once one
              is coming, the visitor is told rather than left to wonder. */}
          {!handedOver && lines.some((line) => line.author === 'bot') && (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                className="rounded-full border border-line px-3 py-1 text-[12.5px] text-soft hover:bg-hover"
                onClick={() => {
                  setHandedOver(Date.now());
                  void call('/handover', session, { method: 'POST', body: '{}' }).catch(() => undefined);
                }}
              >
                {words.person}
              </button>
            </div>
          )}
          {!!handedOver && !lines.some((line) => line.author === 'agent' && line.created_at > handedOver) && lines.some((line) => line.author === 'bot') && (
            <p className="m-0 px-4 pb-1 text-center text-[12px] text-muted">{words.personComing}</p>
          )}
          {/* Resolved — by the team or by the visitor — is said, not left to be
              guessed from silence. Writing on reopens it; a new chat starts clean. */}
          {resolved && (
            <div className="mx-3 mb-1.5 flex flex-col items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2.5 text-center" role="status">
              <p className="m-0 text-[12.5px] text-soft">{words.resolvedNotice}</p>
              <button
                type="button"
                className="rounded-full px-3 py-1 text-[12.5px] font-medium"
                style={{ background: 'var(--thread-accent, var(--accent))', color: 'var(--thread-accent-fg, var(--accent-fg))' }}
                onClick={() => void startOver()}
              >
                {words.newChat}
              </button>
            </div>
          )}
          {notice && <p className="m-0 px-4 pb-1 text-[12px] text-danger">{notice}</p>}
          <Composer
            words={words}
            autoFocus
            onSend={(body) => send(body)}
            onAttach={(file) => void attach(file)}
            onTyping={(typing) => void call('/typing', session, { method: 'POST', body: JSON.stringify({ typing }) }).catch(() => undefined)}
            attached={attached.length ? (
              <div className="flex flex-wrap gap-1.5 text-[12px] text-muted">
                {attached.map((file) => (
                  <span key={file.hash} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5">
                    <Icon name="image" size={12} /> <span className="max-w-[160px] truncate">{file.name}</span>
                  </span>
                ))}
              </div>
            ) : undefined}
          />
        </>
      )}
      </main>
    </div>
  );
}

function Middle({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-6 text-center text-[13.5px] text-muted">{children}</div>;
}

/** The team's face on its lines: the widget's colour, a chat mark. */
function TeamMark() {
  return (
    <span
      className="inline-flex size-7 items-center justify-center rounded-full"
      style={{ background: 'var(--thread-accent, var(--accent))', color: 'var(--thread-accent-fg, var(--accent-fg))' }}
    >
      <Icon name="chat" size={14} />
    </span>
  );
}

/**
 * An anonymous visitor, before the first word: a name and an address, both
 * optional, and a field no person can see. A program filling in every input
 * it finds fills in that one too, and the server turns it away.
 */
function Introduce({ greeting, onStart }: { greeting: string; onStart: (values: Record<string, string>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <form
      className="flex flex-1 flex-col justify-end gap-3 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setFailed(false);
        try {
          await onStart({ name, email, website });
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="m-0 rounded-2xl border border-line bg-raised px-3 py-2 text-[14px]">{greeting}</p>
      <p className="m-0 text-[12.5px] text-muted">{words.introduce}</p>
      <Input value={name} autoComplete="name" placeholder={words.name} aria-label={words.name} onChange={(event) => setName(event.target.value)} />
      <Input type="email" value={email} autoComplete="email" placeholder={words.email} aria-label={words.email} onChange={(event) => setEmail(event.target.value)} />
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
        style={{ position: 'absolute', left: '-10000px', width: 200 }}
      />
      {failed && <p className="m-0 text-[12px] text-danger">{words.unavailable}</p>}
      <Button
        type="submit"
        variant="primary"
        disabled={busy}
        style={{ background: 'var(--thread-accent, var(--accent))', color: 'var(--thread-accent-fg, var(--accent-fg))' }}
      >
        {words.start}
      </Button>
      <p className="m-0 text-center text-[11.5px] text-muted">{words.replyByEmail}</p>
    </form>
  );
}
