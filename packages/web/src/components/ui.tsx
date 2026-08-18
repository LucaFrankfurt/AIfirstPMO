/** Shared primitives: icons, menus, sheets, avatars, toasts. */
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { Priority, StateGroup } from '@kolibri/shared';
import { colorFor, initials, PRIORITY_COLOR } from '../lib/format';
import { priorityKey, useT } from '../lib/i18n';
import { guideHref, type GuideTarget } from '../lib/guide';

/* ------------------------------------------------------------------- icons */

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13 6 5h12l2 8v6H4z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  dots: 'M12 6h.01M12 12h.01M12 18h.01',
  board: 'M4 4h5v16H4zM10.5 4h5v10h-5zM17 4h3v13h-3z',
  list: 'M4 6h16M4 12h16M4 18h16',
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
  bell: 'M18 10a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  bookmark: 'M6 4h12v17l-6-4-6 4z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  refresh: 'M20 11a8 8 0 1 0-.6 4M20 4v6h-6',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4M12 17.2h.01',
  sparkle: 'M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9zM18.5 3v3M20 4.5h-3',
};

/**
 * Icons that mean "forwards" or "away" rather than naming a thing. They are
 * mirrored under a right-to-left direction, where forwards is the other way.
 */
const DIRECTIONAL = new Set(['chevronLeft', 'chevronRight', 'send', 'logout']);

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={`${className ?? ''}${DIRECTIONAL.has(name) ? ' icon-dir' : ''}`.trim() || undefined}
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: 'none' }}
    >
      <path d={PATHS[name] ?? PATHS.dots} />
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
  const cls = group === 'completed' || group === 'cancelled' ? 'filled' : group === 'started' ? 'half' : '';
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

export function Sheet({
  title, children, onClose, footer, wide,
}: { title?: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return createPortal(
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : t('action.close')}>
        <div className="grabber" />
        {title && (
          <header>
            <strong className="grow truncate">{title}</strong>
            <button className="btn ghost icon" onClick={onClose} aria-label={t('action.close')}><Icon name="close" /></button>
          </header>
        )}
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
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

export function Menu({
  items, onClose, anchor, search, empty,
}: { items: MenuItem[]; onClose: () => void; anchor: DOMRect | null; search?: boolean; empty?: string }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: anchor?.bottom ?? 0, left: anchor?.left ?? 0 });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${typeof item.label === 'string' ? item.label : ''} ${item.hint ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !anchor) return;
    const margin = 8;
    const left = Math.min(Math.max(margin, anchor.left), window.innerWidth - box.width - margin);
    const below = anchor.bottom + 6;
    const top = below + box.height > window.innerHeight - margin
      ? Math.max(margin, anchor.top - box.height - 6)
      : below;
    setPosition({ top, left });
  }, [anchor, filtered.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('pointerdown', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onClick);
    };
  }, [onClose]);

  let lastSection: string | undefined;
  return createPortal(
    <div className="menu" ref={ref} style={position} role="menu">
      {search && (
        <input
          className="search" autoFocus placeholder={t('common.filterPlaceholder')} value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {filtered.length === 0 && <div className="section">{empty ?? t('common.nothingHere')}</div>}
      {filtered.map((item) => {
        const header = item.section && item.section !== lastSection ? item.section : null;
        lastSection = item.section;
        return (
          <div key={item.id}>
            {header && <div className="section">{header}</div>}
            <button
              role="menuitem"
              style={item.danger ? { color: 'var(--danger)' } : undefined}
              onClick={() => {
                item.onSelect?.();
                onClose();
              }}
            >
              {item.icon}
              <span className="grow truncate">{item.label}</span>
              {item.hint && <span className="muted" style={{ fontSize: 11.5 }}>{item.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/** Button that opens a menu anchored to itself. */
export function MenuButton({
  items, children, className = 'btn ghost', title, search, disabled, empty,
}: { items: MenuItem[]; children: ReactNode; className?: string; title?: string; search?: boolean; disabled?: boolean; empty?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className={className} title={title} disabled={disabled} type="button"
        onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
      >
        {children}
      </button>
      {anchor && <Menu items={items} anchor={anchor} onClose={() => setAnchor(null)} search={search} empty={empty} />}
    </>
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
      {hint && <span className="hint">{hint}</span>}
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
          <button className="btn" onClick={() => { request.resolve(false); setRequest(null); }}>{t('action.cancel')}</button>
          <button className="btn danger" onClick={() => { request.resolve(true); setRequest(null); }}>{request.confirmLabel ?? t('action.delete')}</button>
        </>
      }
    >
      {request.message}
    </Sheet>
  ) : null;

  return { confirm, dialog };
}
