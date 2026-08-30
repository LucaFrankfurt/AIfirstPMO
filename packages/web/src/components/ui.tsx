/**
 * Shared primitives: icons, menus, sheets, avatars, toasts.
 *
 * The interactive ones — the dialog, the menu, the tooltip — are Radix
 * underneath and styled with Tailwind in `components/ui/`. The API here is
 * unchanged on purpose: forty screens import `Sheet` and `MenuButton`, and the
 * point of the port was the behaviour they get for free, not a rewrite of every
 * call site.
 */
import {
  createContext, Fragment, useCallback, useContext, useEffect, useId,
  useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { VariantProps } from 'class-variance-authority';
import { Link } from 'react-router-dom';
import type { Priority, StateGroup } from '@kolibri/shared';
import { isDoneGroup } from '@kolibri/shared';
import { colorFor, initials, PRIORITY_COLOR } from '../lib/format';
import { priorityKey, useT } from '../lib/i18n';
import { guideHref, type GuideTarget } from '../lib/guide';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from '../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from './ui/menu';
import { buttonVariants, hasText } from './ui/button';
import { Input } from '../components/ui/field';
import { cn } from '../lib/cn';

/* ------------------------------------------------------------------- icons */

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13 6 5h12l2 8v6H4z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  dots: 'M12 6h.01M12 12h.01M12 18h.01',
  board: 'M4 4h5v16H4zM10.5 4h5v10h-5zM17 4h3v13h-3z',
  // Bulleted, so the list *layout* is not the same drawing as a menu.
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  calendar: 'M4 7h16v13H4zM4 11h16M8 3v4M16 3v4',
  page: 'M6 3h8l4 4v14H6zM14 3v4h4',
  folder: 'M3 7h6l2 2h10v10H3z',
  users: 'M3 20c0-3 2.7-5 6-5s6 2 6 5M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM16 20c0-2.4 1-3.6 2.5-4.3M17 11a3 3 0 1 0 0-6',
  cycle: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  archive: 'M3 6h18v3H3zM5 9v11h14V9M10 13h4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  attach: 'M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 1 1-3-3l7-7',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4L16 12l4 4M9 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  send: 'M4 12 21 4l-7 17-2.5-6.5z',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z',
  logout: 'M15 12H4m0 0 4-4m-4 4 4 4M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8',
  chat: 'M4 5h16v10H9l-4 4v-4H4z',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h16M3 15h16',
  bell: 'M18 10a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  // Three lines with a knob on each: display options, not another menu. It
  // exists because `list` and `menu` were the same three strokes, and the
  // header put both of them side by side on a phone — the layout switcher
  // showing the current layout, and the display menu — so the row read as two
  // hamburgers that did different things.
  sliders: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  // Three that exist because a chat had to borrow: editing was a lightning
  // bolt, replying was a chain link, and reacting was a sparkle — a toolbar of
  // metaphors nobody could guess, revealed only on hover, which is the same as
  // unlabelled. The originals still mean priority, links and the assistant.
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  reply: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v2',
  emoji: 'M11 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.5 11h.01M13.5 11h.01M8 15c1 1.5 5 1.5 6 0M19 3v4M21 5h-4',
  bookmark: 'M6 4h12v17l-6-4-6 4z',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M3 15h18',
  gantt: 'M4 6h9M7 12h11M4 18h7M3 3v18',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  // Up and over: the line a sub-task follows to reach what it sits under.
  hierarchy: 'M18 20h-7a4 4 0 0 1-4-4V5M4 8l3-4 3 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  refresh: 'M20 11a8 8 0 1 0-.6 4M20 4v6h-6',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4M12 17.2h.01',
  sparkle: 'M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9zM18.5 3v3M20 4.5h-3',
  shield: 'M12 3l7.5 3v5.6c0 4-3 7.7-7.5 9.4-4.5-1.7-7.5-5.4-7.5-9.4V6zM9 12l2.2 2.2L15.5 10',
  // A pocket with a clasp: money kept, rather than money moving. Deliberately
  // not a coin or a currency symbol — one is unreadable at 15px and the other
  // would name a currency the workspace may not use.
  wallet: 'M4 7h13a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11M16 13h.01',
  // Three slabs stacked: machines in a rack, and the same drawing whether what
  // is stacked is hardware or a subscription. Not a cloud — half this register
  // is not in one.
  stack: 'M4 6.5 12 3l8 3.5-8 3.5zM4 12l8 3.5 8-3.5M4 17.5 12 21l8-3.5',
} satisfies Record<string, string>;

/**
 * Icons that mean "forwards" or "away" rather than naming a thing. They are
 * mirrored under a right-to-left direction, where forwards is the other way.
 */
const DIRECTIONAL = new Set(['chevronLeft', 'chevronRight', 'send', 'logout', 'reply']);

/**
 * The names above, as a type. `Icon` itself still takes any string — plenty of
 * callers pass a name that came out of the database — but a hard-coded list of
 * icons can be typed against this and a shape that does not exist becomes a
 * compile error rather than a row of three quiet dots.
 */
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={cn(`${className ?? ''}${DIRECTIONAL.has(name) ? ' icon-dir' : ''}`.trim() || undefined, 'flex-none')}
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
     
    >
      <path d={(PATHS as Record<string, string>)[name] ?? PATHS.dots} />
    </svg>
  );
}

/* ----------------------------------------------------------------- avatars */

export function Avatar({ user, size = 22 }: { user?: { id: string; name?: string; avatar_url?: string | null }; size?: number }) {
  if (!user) {
    return (
      <span className="avatar" style={{ width: size, height: size, background: 'var(--bg-active)', color: 'var(--fg-muted)', fontSize: size * 0.45 }}>
        ?
      </span>
    );
  }
  return (
    <span
      className="avatar"
      title={user.name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: user.avatar_url ? `center/cover url(${user.avatar_url})` : colorFor(user.id),
      }}
    >
      {user.avatar_url ? '' : initials(user.name)}
    </span>
  );
}

export function AvatarStack({ users, size = 22, max = 3 }: { users: any[]; size?: number; max?: number }) {
  if (!users.length) return null;
  return (
    <span className="avatar-stack">
      {users.slice(0, max).map((user) => <Avatar key={user.id} user={user} size={size} />)}
      {users.length > max && (
        <span className="avatar" style={{ width: size, height: size, background: 'var(--bg-active)', color: 'var(--fg-soft)', fontSize: size * 0.4 }}>
          +{users.length - max}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------- state & priority */

export function StateDot({ group, color, size = 12 }: { group?: StateGroup | string; color?: string; size?: number }) {
  const cls = isDoneGroup(group) ? 'filled' : group === 'started' ? 'half' : '';
  return <span className={`state-dot ${cls}`} style={{ color: color ?? 'var(--fg-muted)', width: size, height: size }} />;
}

export function PriorityBars({ priority }: { priority: Priority }) {
  const t = useT();
  const level = { urgent: 3, high: 3, medium: 2, low: 1, none: 0 }[priority] ?? 0;
  return (
    <span className="priority-bars" style={{ color: PRIORITY_COLOR[priority] }} title={t(priorityKey(priority))}>
      {[1, 2, 3].map((n) => <i key={n} className={n <= level ? 'on' : ''} />)}
    </span>
  );
}

/* ------------------------------------------------------------------ sheets */

/**
 * A sheet: the app's one modal surface, now a real dialog underneath.
 *
 * The call site is unchanged — render it when it should be open, give it an
 * `onClose` — because forty screens do exactly that and this change is about
 * behaviour, not about churning them. What is new is everything a dialog is
 * supposed to do and this one could not: focus is trapped inside it, Tab cannot
 * wander onto the screen behind, focus returns to whatever opened it, the rest
 * of the page is hidden from a screen reader, and the page underneath keeps its
 * scroll position instead of jumping to the top on close.
 */
export function Sheet({
  title, children, onClose, footer, wide,
}: { title?: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* `sheet` is kept as a hook, not a style — the CSS that used to draw it
          is gone, and this is what tests and the odd screen-specific rule use
          to find the surface. */}
      <DialogContent className="sheet" wide={wide} closeLabel={t('action.close')} aria-describedby={undefined}>
        {title
          ? <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          : <VisuallyHiddenTitle>{t('action.close')}</VisuallyHiddenTitle>}
        <DialogBody>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/** A dialog must have a title even when the design shows none. */
const VisuallyHiddenTitle = ({ children }: { children: ReactNode }) => (
  <DialogTitle className="sr-only">{children}</DialogTitle>
);

/* -------------------------------------------------------------- lightbox */

/**
 * A picture at the size it was uploaded, over everything else.
 *
 * Opened by clicking any image in rendered markdown. Escape and a click on the
 * backdrop both close it, because both are what people try.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return createPortal(
    <div className="lightbox" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <img src={src} alt={alt ?? ''} />
      <Button variant="ghost" size="icon" className="lightbox-close" onClick={onClose} aria-label={t('action.close')}>
        <Icon name="close" />
      </Button>
      <a className={cn(buttonVariants({ size: 'sm' }), 'lightbox-open')} href={src} target="_blank" rel="noreferrer">{t('common.openOriginal')}</a>
    </div>,
    document.body,
  );
}

/**
 * Click-to-enlarge for every image inside a subtree.
 *
 * A delegated listener rather than a prop on each image, because the markdown
 * renderer produces plain HTML and has no components to hand one to.
 */
export function useLightbox(): { open: (event: ReactMouseEvent) => void; lightbox: ReactNode } {
  const [shown, setShown] = useState<{ src: string; alt?: string } | null>(null);
  return {
    open: (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName !== 'IMG') return;
      const image = target as HTMLImageElement;
      // An image inside a link is the link's business.
      if (image.closest('a')) return;
      setShown({ src: image.currentSrc || image.src, alt: image.alt });
    },
    lightbox: shown ? <Lightbox src={shown.src} alt={shown.alt} onClose={() => setShown(null)} /> : null,
  };
}

/* ------------------------------------------------------------------- menus */

export interface MenuItem {
  id: string;
  label: ReactNode;
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect?: () => void;
  section?: string;
}

/**
 * A menu, anchored to the button that opens it.
 *
 * Same `items` array as before — the screens pass a list of `{ id, label,
 * icon, onSelect }` and nothing about that changes. Underneath it is now a real
 * menu: arrow keys and Home/End move through it, typing jumps to an item,
 * Escape closes and gives the button its focus back, and it flips above the
 * button when there is no room below instead of hanging off the window.
 *
 * The optional search box stays, because typeahead is not the same thing as
 * filtering when a list is forty people long. Keys typed in it are kept from
 * the menu's own typeahead, which would otherwise move the highlight while
 * somebody is trying to type a name.
 */
export function MenuButton({
  items, children, className, variant = 'ghost', size = 'default', title, label, search, disabled, empty,
}: {
  items: MenuItem[];
  children: ReactNode;
  /** Extra classes. The look of the trigger comes from `variant` and `size`. */
  className?: string;
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  title?: string;
  /**
   * Accessible name. An icon-only menu button otherwise announces as "button"
   * and nothing else, which is the whole of what a screen reader gets.
   */
  label?: string;
  search?: boolean;
  disabled?: boolean;
  empty?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${typeof item.label === 'string' ? item.label : ''} ${item.hint ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);

  let lastSection: string | undefined;
  return (
    <Menu onOpenChange={(open) => { if (!open) setQuery(''); }}>
      <MenuTrigger asChild>
        <button
          className={cn(buttonVariants({ variant, size }), className)}
          title={title}
          // Only when the trigger has no words of its own. A label that
          // replaces visible text is a control voice-control users can see and
          // cannot say — see `hasText` in `ui/button.tsx`.
          aria-label={label ?? (hasText(children) ? undefined : title)}
          disabled={disabled}
          type="button"
        >
          {children}
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {search && (
          <Input
            className="mb-1 h-8 text-[13px]"
            autoFocus
            placeholder={t('common.filterPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Everything except the keys that mean "leave the box": otherwise
              // the menu's typeahead moves the highlight as somebody types.
              if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) event.stopPropagation();
            }}
          />
        )}
        {filtered.length === 0 && (
          <div className="px-2 py-2 text-[12.5px] text-muted">{empty ?? t('common.nothingHere')}</div>
        )}
        {filtered.map((item) => {
          const header = item.section && item.section !== lastSection ? item.section : null;
          lastSection = item.section;
          return (
            <Fragment key={item.id}>
              {header && <MenuLabel>{header}</MenuLabel>}
              <MenuItem danger={item.danger} onSelect={() => item.onSelect?.()}>
                {item.icon}
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
                {item.hint && <span className="text-[11.5px] text-muted">{item.hint}</span>}
              </MenuItem>
            </Fragment>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(message: string, action?: Toast['action']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, action?: Toast['action']) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-2), { id, message, action }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), action ? 7000 : 3200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="toast-host">
          {toasts.map((toast) => (
            <div className="toast" key={toast.id} role="status">
              <span>{toast.message}</span>
              {toast.action && (
                <button onClick={() => {
                  toast.action!.run();
                  setToasts((current) => current.filter((t) => t.id !== toast.id));
                }}>
                  {toast.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------- misc */

export function Empty({
  emoji = '🌱', title, hint, action, guide,
}: {
  emoji?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** An empty screen is when an explanation is most wanted — offer the right one. */
  guide?: GuideTarget;
}) {
  return (
    <div className="empty">
      <div className="emoji">{emoji}</div>
      <strong style={{ color: 'var(--fg)' }}>{title}</strong>
      {hint && <span style={{ maxWidth: 340 }}>{hint}</span>}
      {action}
      {guide && <GuideHint to={guide} />}
    </div>
  );
}

/** A quiet link into the part of the guide that explains the screen you are on. */
export function GuideHint({ to, className = '' }: { to: GuideTarget; className?: string }) {
  const t = useT();
  return (
    <Link className={`guide-hint ${className}`} to={guideHref(to)}>
      <Icon name="help" size={13} />
      {t('guide.explainThis')}
    </Link>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {typeof children === 'object' && children !== null && 'props' in (children as any)
        ? <div>{children}</div>
        : children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </div>
  );
}

export function Progress({ value, total }: { value: number; total: number }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="progress" title={`${percent}%`}>
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Small confirm dialog — used before anything destructive. */
export function useConfirm() {
  const t = useT();
  const [request, setRequest] = useState<{ message: string; confirmLabel?: string; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (message: string, confirmLabel?: string) =>
      new Promise<boolean>((resolve) => setRequest({ message, confirmLabel, resolve })),
    [],
  );

  const dialog = request ? (
    <Sheet
      title={t('action.confirmTitle')}
      onClose={() => {
        request.resolve(false);
        setRequest(null);
      }}
      footer={
        <>
          <Button onClick={() => { request.resolve(false); setRequest(null); }}>{t('action.cancel')}</Button>
          <Button variant="danger" onClick={() => { request.resolve(true); setRequest(null); }}>{request.confirmLabel ?? t('action.delete')}</Button>
        </>
      }
    >
      {request.message}
    </Sheet>
  ) : null;

  return { confirm, dialog };
}
