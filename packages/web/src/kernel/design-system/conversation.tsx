/**
 * A conversation on screen: the thread and the box you answer in.
 *
 * The accent is `--thread-accent` (and `--thread-accent-fg` for what is written
 * on it) when a surrounding element sets one, and the app's accent otherwise:
 * a widget carries its site's colour, the inbox carries Kolibri's.
 *
 * Built for support, where the same two pieces have to work in two very
 * different places — the team's inbox inside the app, and a visitor's iframe
 * on somebody else's site — and so they know nothing about where the messages
 * come from. A caller hands over lines already decided (whose side, what to
 * show) and gets a thread that groups, dates, scrolls and says "seen".
 *
 * What it deliberately leaves out: reactions, replies to a line, editing in
 * place. Those belong to the team chat and can be layered on there; a support
 * thread is a question and its answers.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { clockTime, exactTime, longDate } from './format';
import { Icon } from './ui';
import { useT } from '../i18n/i18n';

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
  /** This side of the conversation: drawn on the right, in the accent. */
  mine: boolean;
  /** Whose line it is, said over the first line of a block from the other side. */
  author?: string;
  /** A face for that first line. */
  avatar?: ReactNode;
  /** The words, already rendered — plain text here, markdown in the team chat. */
  body: ReactNode;
  at: number;
  files?: ThreadFile[];
  /** Still on its way. */
  pending?: boolean;
  /** Could not be sent; the caller says what to do about it. */
  failed?: ReactNode;
}

/** Lines from one side within this long of each other read as one block. */
const BLOCK_MS = 5 * 60_000;

function dayOf(at: number, t: ReturnType<typeof useT>): string {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= midnight) return t('chat.today');
  if (at >= midnight - 86_400_000) return t('chat.yesterday');
  return longDate(at);
}

/**
 * The lines, oldest at the top, kept at the bottom while you are there.
 *
 * "While you are there" is the part that matters: somebody scrolled up to
 * read an earlier answer is not yanked back down by a new one. Your own line
 * always brings you down, because you have just written it and want to see it.
 */
export function Thread({ lines, typing, seenAt, empty, className }: {
  lines: ThreadLine[];
  /** The other side is typing: who, or `true` for "somebody". */
  typing?: string | boolean;
  /** The other side has read everything up to here. */
  seenAt?: number | null;
  /** Shown while there is nothing yet: a greeting, a hint. */
  empty?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const last = lines[lines.length - 1];

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (atBottom.current || last?.mine) el.scrollTop = el.scrollHeight;
  }, [lines.length, last?.id, last?.mine, typing]);

  // The last line of yours the other side has read — the one place "seen" is said.
  const seen = seenAt
    ? [...lines].reverse().find((line) => line.mine && !line.pending && line.at <= seenAt)?.id
    : undefined;
  const newestMine = [...lines].reverse().find((line) => line.mine)?.id;

  return (
    <div
      ref={box}
      role="log"
      aria-live="polite"
      className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-4', className)}
      onScroll={() => {
        const el = box.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {!lines.length && empty && <div className="my-auto">{empty}</div>}
      {lines.map((line, index) => {
        const previous = lines[index - 1];
        const next = lines[index + 1];
        const day = new Date(line.at).toDateString();
        const newDay = !previous || new Date(previous.at).toDateString() !== day;
        const joins = (a?: ThreadLine, b?: ThreadLine) =>
          !!a && !!b && a.mine === b.mine && a.author === b.author && Math.abs(b.at - a.at) < BLOCK_MS
          && new Date(a.at).toDateString() === new Date(b.at).toDateString();
        const first = newDay || !joins(previous, line);
        const lastOfBlock = !joins(line, next);
        return (
          <Fragment key={line.id}>
            {newDay && (
              <div className="my-3 flex items-center gap-3 text-[11.5px] text-muted" role="separator">
                <span className="h-px flex-1 bg-line" />
                <span>{dayOf(line.at, t)}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <div className={cn('flex items-end gap-2', line.mine ? 'justify-end' : 'justify-start', first ? 'mt-3' : 'mt-0.5')}>
              {!line.mine && (
                <span className="flex w-7 flex-none justify-center">{lastOfBlock ? line.avatar : null}</span>
              )}
              <div className={cn('flex min-w-0 max-w-[78%] flex-col', line.mine ? 'items-end' : 'items-start')}>
                {first && !line.mine && line.author && (
                  <span className="mb-1 px-1 text-[11.5px] font-medium text-muted">{line.author}</span>
                )}
                {!!line.files?.length && <Files files={line.files} mine={line.mine} />}
                {hasBody(line.body) && (
                  <div
                    title={exactTime(line.at)}
                    className={cn(
                      'whitespace-pre-wrap break-words px-3 py-2 text-[14px] leading-[1.45]',
                      line.mine
                        ? 'bg-[var(--thread-accent,var(--accent))] text-[var(--thread-accent-fg,var(--accent-fg))]'
                        : 'border border-line bg-raised text-fg',
                      // The corner nearest the next line of the same block is
                      // squared off, so a block reads as one shape.
                      line.mine
                        ? cn('rounded-2xl', !first && 'rounded-tr-md', !lastOfBlock && 'rounded-br-md')
                        : cn('rounded-2xl', !first && 'rounded-tl-md', !lastOfBlock && 'rounded-bl-md'),
                      line.pending && 'opacity-60',
                    )}
                  >
                    {line.body}
                  </div>
                )}
                {line.failed && <div className="mt-1 px-1 text-[11.5px] text-danger">{line.failed}</div>}
                {lastOfBlock && !line.failed && (
                  <span className="mt-1 px-1 text-[11px] tabular-nums text-muted">
                    {line.pending ? t('thread.sending') : clockTime(line.at)}
                    {line.id === seen && line.id === newestMine && <> · {t('thread.seen')}</>}
                  </span>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
      {typing && (
        <div className="mt-3 flex items-end gap-2" aria-label={typeof typing === 'string' ? t('thread.typingNamed', { name: typing }) : t('thread.typing')}>
          <span className="w-7 flex-none" />
          <TypingDots />
        </div>
      )}
    </div>
  );
}

const hasBody = (body: ReactNode): boolean => body !== null && body !== undefined && body !== false && body !== '';

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
 * button is under your thumb anyway. The team chat made the same call.
 */
const SEND_ON_ENTER = typeof window !== 'undefined' && !window.matchMedia?.('(pointer: coarse)').matches;

/** How often "still typing" is said while somebody keeps typing. */
const TYPING_EVERY_MS = 3000;

/**
 * The box you answer in.
 *
 * Grows with what is written up to a few lines, sends on Enter, takes a pasted
 * or chosen picture when the caller accepts files, and says "typing" — once
 * every few seconds while it lasts and once when it stops — so the caller does
 * not have to.
 */
export function Composer({ onSend, onTyping, onAttach, attached, placeholder, disabled, autoFocus, className }: {
  onSend: (text: string) => void | Promise<unknown>;
  onTyping?: (typing: boolean) => void;
  /** Offered when given: a button, and pasting a picture. */
  onAttach?: (file: File) => void;
  /** What is waiting to go with the next message; a message may then be empty. */
  attached?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const saidTyping = useRef(0);

  useLayoutEffect(() => {
    const el = field.current;
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

  const canSend = !disabled && (!!text.trim() || !!attached);
  const send = () => {
    if (!canSend) return;
    const value = text.trim();
    setText('');
    if (saidTyping.current) onTyping?.(false);
    saidTyping.current = 0;
    void onSend(value);
    field.current?.focus();
  };

  return (
    <div className={cn('border-t border-line bg-bg px-3 pb-3 pt-2', className)}>
      {attached && <div className="mb-2">{attached}</div>}
      {/* The field is the pill, with the buttons beside it, so the focus ring
          sits on the element that has the focus — where a keyboard user looks
          for it, and where `check:a11y` measures it. */}
      <div className="flex items-end gap-1.5">
        {onAttach && (
          <>
            <button
              type="button"
              className="inline-flex size-9 flex-none items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
              aria-label={t('thread.attach')}
              title={t('thread.attach')}
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
          ref={field}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder ?? t('thread.placeholder')}
          aria-label={placeholder ?? t('thread.placeholder')}
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
        <button
          type="button"
          className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-[var(--thread-accent,var(--accent))] text-[var(--thread-accent-fg,var(--accent-fg))] transition-opacity disabled:opacity-30"
          aria-label={t('thread.send')}
          title={t('thread.send')}
          disabled={!canSend}
          onClick={send}
        >
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  );
}
