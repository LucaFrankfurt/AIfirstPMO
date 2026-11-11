/**
 * A conversation on screen: the thread and the box you answer in.
 *
 * One component for three places — the team chat, the support inbox, and a
 * visitor's window on somebody else's site — so the three look and behave
 * alike and a fix to one is a fix to all. They know nothing about where their
 * lines come from: a caller hands over lines already decided (whose side, what
 * to show, what can be done to them) and gets a thread that groups, dates,
 * scrolls, offers the actions and says "seen".
 *
 * The drawing lives in `app.css` under `.thread*`, with the reasons beside the
 * rules: the bubble, its squared corner, the time tucked into it, the bar of
 * actions beside it on a pointer and behind a dot-button on a finger. It was
 * the team chat's, and was moved down rather than redrawn.
 *
 * Colours: your own lines take `--thread-mine-bg` / `--thread-mine-fg` when a
 * surrounding element sets them (a widget sets its site's colour), and the
 * accent's tint otherwise. The send button and the focused field take
 * `--thread-accent` / `--thread-accent-fg`, or the app's accent.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { cn } from './cn';
import { Icon } from './ui/icon';

/**
 * The words and clocks a thread speaks in, handed in rather than looked up.
 *
 * So that this file imports neither the app's catalogue nor its formatters:
 * the support widget's page carries thirty words of its own instead of the
 * app's three thousand. Inside the app, `useThreadWords` builds this from the
 * catalogue.
 */
export interface ThreadWords {
  today: string;
  yesterday: string;
  sending: string;
  seen: string;
  typing: string;
  typingNamed: (name: string) => string;
  actions: string;
  attach: string;
  placeholder: string;
  send: string;
  /** Just the clock, for the corner of a bubble. */
  clock: (at: number) => string;
  /** The whole moment, for a hover. */
  exact: (at: number) => string;
  /** A day named in full, for the line between days. */
  day: (at: number) => string;
}

export interface ThreadFile {
  key: string;
  name: string;
  type: string;
  /** Where to draw it from, once known. A picture with none shows its name. */
  src?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ThreadLine {
  id: string;
  /** This side of the conversation: drawn on the right, in the accent's tint. */
  mine: boolean;
  /** Whose line it is, named on the first line of a block from the other side. Leave it out to name nobody. */
  author?: string;
  /** A face beside the first line of a block from the other side. */
  avatar?: ReactNode;
  /** A string is drawn as plain text; anything else as given — rendered markdown, an edit box. */
  body: ReactNode;
  at: number;
  files?: ThreadFile[];
  /** Still on its way. */
  pending?: boolean;
  /** Could not be sent; the caller says what to do about it. */
  failed?: ReactNode;
  /** Starts a block of its own even when it would join the one before — a reply, say. */
  breaks?: boolean;
  /** Inside the bubble, over the words: the line this one answers. */
  quote?: ReactNode;
  /** In the bubble's corner before the time: "edited", "not sent yet". */
  meta?: ReactNode;
  /** Under the bubble: reactions, a way back into context. */
  below?: ReactNode;
  /** What can be done to the line: shown on hover and focus, and behind a dot-button on a touch screen. */
  actions?: ReactNode;
}

/** Lines from one side within this long of each other read as one block. */
const BLOCK_MS = 5 * 60_000;

function dayOf(at: number, words: ThreadWords): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= midnight) return words.today;
  if (at >= midnight - 86_400_000) return words.yesterday;
  return words.day(at);
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The lines, oldest at the top.
 *
 * By default it keeps itself at the bottom while you are there — somebody
 * scrolled up to read an earlier answer is not yanked down by a new one, and
 * your own line always brings you down. The team chat steers its own scrolling
 * (it reaches back sixty lines at a time and jumps to a search hit), so it
 * turns that off with `follow={false}` and holds the box through `boxRef`.
 */
export function Thread({
  words, lines, typing, seenAt, empty, before, grouped = true, days = true, follow = true, boxRef, onScroll, className,
}: {
  words: ThreadWords;
  lines: ThreadLine[];
  /** The other side is typing: who, or `true` for "somebody". */
  typing?: string | boolean;
  /** The other side has read everything up to here. */
  seenAt?: number | null;
  /** Shown while there is nothing yet: a greeting, a hint. */
  empty?: ReactNode;
  /** Above the lines: the way further back, a note about a search. */
  before?: ReactNode;
  /** Off while searching: two hits an hour apart are not one block. */
  grouped?: boolean;
  /** Off while searching, for the same reason. */
  days?: boolean;
  follow?: boolean;
  boxRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  /** Which line has been asked for its actions, where there is no hover. */
  const [tapped, setTapped] = useState<string | null>(null);
  const last = lines[lines.length - 1];

  const attach = useCallback((element: HTMLDivElement | null) => {
    box.current = element;
    if (typeof boxRef === 'function') boxRef(element);
    else if (boxRef) (boxRef as { current: HTMLDivElement | null }).current = element;
  }, [boxRef]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!follow || !el) return;
    if (atBottom.current || last?.mine) el.scrollTop = el.scrollHeight;
  }, [follow, lines.length, last?.id, last?.mine, typing]);

  // The last line of yours the other side has read — the one place "seen" is said.
  const newestMine = [...lines].reverse().find((line) => line.mine);
  const seen = seenAt && newestMine && !newestMine.pending && newestMine.at <= seenAt ? newestMine.id : undefined;

  const joins = (a?: ThreadLine, b?: ThreadLine) =>
    grouped && !!a && !!b && !b.breaks && a.mine === b.mine && a.author === b.author
    && Math.abs(b.at - a.at) < BLOCK_MS && sameDay(a.at, b.at);

  return (
    <div
      ref={attach}
      role="log"
      className={cn('thread', className)}
      onScroll={() => {
        const el = box.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        onScroll?.();
      }}
    >
      {before}
      {!lines.length && empty}
      {lines.map((line, index) => {
        const previous = lines[index - 1];
        const newDay = days && (!previous || !sameDay(previous.at, line.at));
        const first = newDay || !joins(previous, line);
        const said = line.body !== null && line.body !== undefined && line.body !== false && line.body !== '';
        const time = (
          <span className="thread-meta">
            {line.meta}
            <span className="tabular-nums">{line.pending ? words.sending : words.clock(line.at)}</span>
          </span>
        );
        return (
          <Fragment key={line.id}>
            {newDay && <div className="thread-day" role="separator"><span>{dayOf(line.at, words)}</span></div>}
            <div
              className={cn('thread-line', !first && 'grouped', line.mine && 'mine', tapped === line.id && 'tapped')}
              data-line={line.id}
            >
              {/* Only the other side gets a face: yours is not news to you, and
                  on a phone it is a third of the width of the line. */}
              {!line.mine && (first && line.avatar ? line.avatar : <span className="thread-gutter" />)}
              <div className="thread-body">
                {!!line.files?.length && <Files files={line.files} mine={line.mine} />}
                {said && (
                  <div className="thread-bubble" title={words.exact(line.at)} style={line.pending ? { opacity: 0.65 } : undefined}>
                    {first && !line.mine && line.author && <span className="thread-who">{line.author}</span>}
                    {line.quote}
                    {typeof line.body === 'string'
                      ? <div className="md"><p className="whitespace-pre-wrap break-words">{line.body}</p></div>
                      : line.body}
                    {time}
                  </div>
                )}
                {/* A line that is only a picture still says when. */}
                {!said && <span className="mt-0.5 flex gap-1.5 px-1 text-[11px] text-muted">{line.meta}{line.pending ? words.sending : words.clock(line.at)}</span>}
                {line.failed && <div className="mt-1 px-1 text-[11.5px] text-danger">{line.failed}</div>}
                {line.id === seen && <span className="mt-0.5 px-1 text-[11px] text-muted">{words.seen}</span>}
                {line.below}
                {line.actions && (
                  <>
                    {/* Shown only where there is no hover to reveal the bar with. */}
                    <button
                      type="button"
                      className="thread-more"
                      aria-label={words.actions}
                      aria-expanded={tapped === line.id}
                      onClick={() => setTapped(tapped === line.id ? null : line.id)}
                    >
                      <Icon name="dots" size={14} />
                    </button>
                    <div className="thread-actions">{line.actions}</div>
                  </>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
      {typing && (
        <div className="thread-line" aria-label={typeof typing === 'string' ? words.typingNamed(typing) : words.typing}>
          <span className="thread-gutter" />
          <TypingDots />
        </div>
      )}
    </div>
  );
}

function Files({ files, mine }: { files: ThreadFile[]; mine: boolean }) {
  return (
    <div className={cn('mb-1 flex flex-wrap gap-1.5', mine ? 'justify-end' : 'justify-start')}>
      {files.map((file) => (file.type.startsWith('image/') && file.src ? (
        <a key={file.key} href={file.src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-line">
          <img
            src={file.src}
            alt={file.name}
            width={file.width ?? undefined}
            height={file.height ?? undefined}
            className="block h-auto max-h-60 w-auto max-w-[240px] object-cover"
          />
        </a>
      ) : (
        <a
          key={file.key}
          href={file.src ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-[240px] items-center gap-1.5 rounded-xl border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-fg"
        >
          <Icon name="attach" size={13} />
          <span className="truncate">{file.name}</span>
        </a>
      )))}
    </div>
  );
}

/** Three dots, breathing. Still when somebody asked for less motion. */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 rounded-2xl border border-line bg-raised px-3 py-2.5">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-1.5 rounded-full bg-muted motion-safe:animate-pulse"
          style={{ animationDelay: `${dot * 180}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Whether Enter sends.
 *
 * On a keyboard it does, and Shift+Enter breaks the line. Where the pointer is
 * coarse — a phone — the return key is how you get a second line and the send
 * button is under your thumb anyway. Cmd/Ctrl+Enter sends everywhere.
 */
export const SEND_ON_ENTER = typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches;

/** How often "still typing" is said while somebody keeps typing. */
const TYPING_EVERY_MS = 3000;

/**
 * The box you answer in.
 *
 * Two ways to use it. Alone, it is a plain field that grows with what is
 * written, sends on Enter, takes a pasted or chosen picture when the caller
 * accepts files, and says "typing" — once every few seconds while it lasts and
 * once when it stops. With `field`, the caller brings its own editor (the team
 * chat's, with its mention and reference menus) and owns the text; this then
 * draws the frame around it and hands it the send button to place, so the
 * button is the same everywhere.
 */
export function Composer({
  words, onSend, onTyping, onAttach, attached, placeholder, disabled, autoFocus, className, status, field, canSend: allowed,
}: {
  words: ThreadWords;
  /** With `field`, called with an empty string: the caller holds the text. */
  onSend: (text: string) => void | Promise<unknown>;
  onTyping?: (typing: boolean) => void;
  /** Offered when given: a button, and pasting a picture. */
  onAttach?: (file: File) => void;
  /** What is waiting to go with the next message — a reply, a picture; a message may then be empty. */
  attached?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** A line over the field, always there: who is typing, how to send. */
  status?: ReactNode;
  /** The caller's own editor, given the send button to place. */
  field?: (send: ReactNode) => ReactNode;
  /** With `field`: whether there is anything to send. */
  canSend?: boolean;
}) {
  const [text, setText] = useState('');
  const own = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const saidTyping = useRef(0);

  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    // `scrollHeight` leaves out the border, and the box is sized with it: two
    // pixels short, and the field scrolls by two pixels on every line.
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [text]);

  // Leaving with half a sentence typed is still leaving.
  useEffect(() => () => { if (saidTyping.current) onTyping?.(false); }, []);

  const typed = (value: string) => {
    setText(value);
    if (!onTyping) return;
    if (!value.trim()) {
      if (saidTyping.current) onTyping(false);
      saidTyping.current = 0;
    } else if (Date.now() - saidTyping.current > TYPING_EVERY_MS) {
      saidTyping.current = Date.now();
      onTyping(true);
    }
  };

  const canSend = !disabled && (field ? !!allowed : (!!text.trim() || !!attached));
  const send = () => {
    if (!canSend) return;
    if (field) {
      void onSend('');
      return;
    }
    const value = text.trim();
    setText('');
    if (saidTyping.current) onTyping?.(false);
    saidTyping.current = 0;
    void onSend(value);
    own.current?.focus();
  };

  const sendButton = (
    <button
      type="button"
      className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-[var(--thread-accent,var(--accent))] text-[var(--thread-accent-fg,var(--accent-fg))] transition-opacity disabled:opacity-30"
      title={words.send}
      aria-label={words.send}
      disabled={!canSend}
      onClick={send}
    >
      <Icon name="send" size={15} />
      {/* The same word again as text, for whatever finds a button by what it
          says — the walkthrough's `button:has-text(…)`, a user's own script. */}
      <span className="sr-only">{words.send}</span>
    </button>
  );

  return (
    <div className={cn('flex-none border-t border-line bg-bg px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]', className)}>
      {status}
      {attached && <div className="mb-2">{attached}</div>}
      {field ? field(sendButton) : (
        // The field is the pill, with the buttons beside it, so the focus ring
        // sits on the element that has the focus — where a keyboard user looks
        // for it, and where `check:a11y` measures it.
        <div className="flex items-end gap-1.5">
          {onAttach && (
            <>
              <button
                type="button"
                className="inline-flex size-9 flex-none items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                aria-label={words.attach}
                title={words.attach}
                disabled={disabled}
                onClick={() => picker.current?.click()}
              >
                <Icon name="image" size={16} />
              </button>
              <input
                ref={picker}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) onAttach(file);
                }}
              />
            </>
          )}
          <textarea
            ref={own}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={placeholder ?? words.placeholder}
            aria-label={placeholder ?? words.placeholder}
            className={cn(
              'max-h-40 min-h-9 min-w-0 flex-1 resize-none rounded-[18px] border border-line-strong bg-raised px-3.5 py-2 text-[14px] leading-[1.4] text-fg placeholder:text-muted',
              'focus-visible:border-[var(--thread-accent,var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--thread-accent,var(--accent))]',
            )}
            onChange={(event) => typed(event.target.value)}
            onPaste={(event) => {
              if (!onAttach) return;
              const file = [...event.clipboardData.files].find((candidate) => candidate.type.startsWith('image/'));
              if (!file) return;
              event.preventDefault();
              onAttach(file);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              if (event.metaKey || event.ctrlKey || (SEND_ON_ENTER && !event.shiftKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          {sendButton}
        </div>
      )}
    </div>
  );
}
