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
  useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { VariantProps } from 'class-variance-authority';
import type { Priority, StateGroup } from '@kolibri/shared';
import { isDoneGroup, matchesTerms, parseTerms } from '@kolibri/shared';
import { colorFor, initials, PRIORITY_COLOR } from './format';
import { priorityKey, useT, type Translate } from '../i18n/i18n';
import type { GuideTarget } from '../../modules/guide/guide';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import {
  Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger,
} from './ui/menu';
import { isGroup, menuMatches } from './menu-search';
import { useNarrow } from './narrow';
import { buttonVariants, hasText } from './ui/button';
import { Input } from './ui/field';
import { cn } from './cn';

/* ------------------------------------------------------------------- icons */

import { Icon, type IconName } from './ui/icon';

export { Icon, type IconName };

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
      {/* Urgent is a shape of its own, not just a redder "high" (UX-10). */}
      {priority === 'urgent' ? (
        <svg width="12" height="11" viewBox="0 0 12 11" aria-hidden="true">
          <rect width="12" height="11" rx="2.5" fill="currentColor" />
          <path d="M6 2.6v3.5M6 8.3v.01" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : [1, 2, 3].map((n) => <i key={n} className={n <= level ? 'on' : ''} />)}
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
  title, children, onClose, footer, wide, dirty,
}: { title?: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean; dirty?: boolean }) {
  const t = useT();
  const discard = useConfirm();
  // Escape, the backdrop and the X ask first when something typed would be lost (UX-13).
  const dismiss = () => {
    if (!dirty) return onClose();
    void discard.confirm(t('sheet.discardChanges'), t('sheet.discard')).then((ok) => { if (ok) onClose(); });
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next) dismiss(); }}>
      {/* `sheet` is kept as a hook, not a style — the CSS that used to draw it
          is gone, and this is what tests and the odd screen-specific rule use
          to find the surface. */}
      <DialogContent className="sheet" wide={wide} closeLabel={t('action.close')} aria-describedby={undefined}>
        {title
          ? <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          : <VisuallyHiddenTitle>{t('action.close')}</VisuallyHiddenTitle>}
        <DialogBody>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
        {discard.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** Whether a form's state has moved from what it opened with — for `Sheet`'s `dirty`. */
export function useDirty(value: unknown): boolean {
  const [start] = useState(() => JSON.stringify(value));
  return JSON.stringify(value) !== start;
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
  /** A heading above the row. For a handful of commands that belong together. */
  section?: string;
  /**
   * Leave the menu open after this row is chosen.
   *
   * For a row that ticks something in a list rather than doing something: a
   * filter of three people took three trips through the menu, because every
   * row closed it — the list behind changed after the first, and the menu
   * that would have taken the second was gone.
   */
  keepOpen?: boolean;
}

/**
 * A drawer of rows, for a list that grows with the workspace.
 *
 * The distinction this makes is the whole point: a `section` is a heading over
 * a few commands that belong together, and a group is a *list* — labels,
 * projects, people, states — which is where menus got their length. The page's
 * own menu was 39 rows on a three-project demo, 1140px of it below the fold,
 * and what had scrolled away were the commands.
 *
 * A group is named by its caller rather than decided by a count, because a
 * count is a budget somebody spends: the question is not "is this list long
 * today" but "does this list grow with the workspace".
 */
export interface MenuGroup {
  id: string;
  /** The word on the row that opens the drawer. */
  label: string;
  icon?: ReactNode;
  /** Shown on that row — usually what is chosen now. */
  hint?: string;
  items: MenuItem[];
  /** A search box inside, for a drawer that can hold a hundred names. */
  search?: boolean;
  /** What the drawer says when it is empty. */
  empty?: string;
}

export type MenuEntry = MenuItem | MenuGroup;

/** Whether an entry is a drawer. The one place anything asks. */
export const isMenuGroup = (entry: MenuEntry): entry is MenuGroup => isGroup(entry);

/**
 * The rows inside a drawer, with the drawer's own search box.
 *
 * One body, two shapes around it. On a window wide enough the drawer stands
 * beside the menu (`MenuDrawer`); on a phone it replaces the menu's contents
 * in place, because beside does not exist there. What is *in* the drawer is
 * the same thing either way, so it is written once — the alternative was two
 * copies of a search box, and the one in the shape nobody tests is the one
 * that stops folding accents.
 *
 * Its query lives here rather than above, so closing a drawer clears it:
 * unmounting is the reset, and neither shape has to remember to do it.
 */
function DrawerRows({ group }: { group: MenuGroup }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const terms = useMemo(() => parseTerms(query), [query]);
  const rows = useMemo(
    () => (terms.length
      ? group.items.filter((item) => matchesTerms(`${typeof item.label === 'string' ? item.label : ''} ${item.hint ?? ''}`, terms))
      : group.items),
    [group.items, terms],
  );
  return (
    <>
      {group.search && (
        <Input
          className="mb-1 h-8 text-[13px]"
          placeholder={t('common.filterPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) event.stopPropagation();
          }}
        />
      )}
      {rows.length === 0 && (
        <div className="px-2 py-2 text-[12.5px] text-muted">{group.empty ?? t('common.nothingHere')}</div>
      )}
      {rows.map((item) => (
        <MenuItemRow key={item.id} item={item} />
      ))}
    </>
  );
}

/** What a drawer's row says, in either shape: its word, what is chosen, a chevron. */
const drawerFace = (group: MenuGroup) => (
  <>
    {group.icon}
    <span className="flex-1 min-w-0 truncate">{group.label}</span>
    {group.hint && <span className="text-[11.5px] text-muted truncate max-w-[9rem]">{group.hint}</span>}
    <Icon name="chevronRight" size={13} />
  </>
);

/** A drawer that opens beside the menu. The shape for a window with room. */
function MenuDrawer({ group }: { group: MenuGroup }) {
  return (
    <MenuSub>
      <MenuSubTrigger data-drawer={group.id}>{drawerFace(group)}</MenuSubTrigger>
      <MenuSubContent>
        <DrawerRows group={group} />
      </MenuSubContent>
    </MenuSub>
  );
}

/**
 * A drawer that opens *into* the menu. The shape for a phone.
 *
 * `preventDefault` is the whole trick: a menu item closes the menu when it is
 * chosen, and this one is not a choice, it is a step further in.
 *
 * It carries the same `data-drawer` as the row that opens one sideways, so
 * `check:menus` opens both shapes with one selector — a check that could only
 * find the desktop shape is a check that would have gone on missing this.
 */
const MenuDrillRow = ({ group, open }: { group: MenuGroup; open: () => void }) => (
  <MenuItem
    data-drawer={group.id}
    onSelect={(event) => { event.preventDefault(); open(); }}
  >
    {drawerFace(group)}
  </MenuItem>
);

/** One row, wherever it is standing. */
const MenuItemRow = ({ item }: { item: MenuItem }) => (
  <MenuItem
    danger={item.danger}
    onSelect={(event) => {
      if (item.keepOpen) event.preventDefault();
      item.onSelect?.();
    }}
  >
    {item.icon}
    <span className="flex-1 min-w-0 truncate">{item.label}</span>
    {item.hint && <span className="text-[11.5px] text-muted">{item.hint}</span>}
  </MenuItem>
);

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
 *
 * `items` may now hold drawers as well as rows — see `MenuGroup`. A search
 * flattens them, so typing never requires knowing which drawer something was
 * filed in; `menuMatches` beside this is that rule, and is tested without a
 * browser.
 */
export function MenuButton({
  items, children, className, variant = 'ghost', size = 'default', title, label, search, disabled, empty, align = 'start',
}: {
  items: MenuEntry[];
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
  /**
   * Which edge of the button the menu hangs from.
   *
   * `end` for a button whose words change while its menu is open and that
   * grows from its right edge — the filter button in a header is both. Hung
   * from the left, the menu jumped by the width of the count the first tick
   * added, and the drawer that tick was made in closed under the pointer.
   */
  align?: 'start' | 'end';
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  /**
   * The same reading of a search box the rest of the app does.
   *
   * It was `toLowerCase().includes()`, and the ten lists behind this one are
   * exactly where that hurts: they are people, labels, states and projects.
   * `jorg` did not find "Jörg Müller", and a colleague you can only reach by
   * spelling the umlaut is a picker half a German company types around. The
   * words also stand on their own now, so "muller jorg" finds him too.
   */
  const terms = useMemo(() => parseTerms(query), [query]);
  const filtered = useMemo(() => menuMatches(items, terms), [items, terms]);

  /*
   * On a phone a drawer opens into the menu rather than beside it, so the menu
   * has a *level*: either the entries it was given, or the rows of one drawer.
   * Held by id rather than by the group itself, because `items` is rebuilt on
   * every render by most callers and holding the object would pin a stale one.
   */
  const narrow = useNarrow();
  const [drilled, setDrilled] = useState<string | null>(null);
  const level = drilled ? items.find((entry) => isGroup(entry) && entry.id === drilled) as MenuGroup | undefined : undefined;

  /*
   * Stepping in unmounts the row that was focused, and focus falls to
   * `<body>` — where arrow keys do nothing and Escape closes the page's
   * dialog instead of the menu. So the new level takes the focus itself.
   *
   * Found by the class rather than by an id of ours: Radix puts its own id on
   * the content and points the trigger's `aria-controls` at it, so an id
   * passed down here wins the spread and leaves that attribute naming an
   * element that does not exist — a menu a screen reader is told about and
   * cannot find. Only one sheet is ever open, so the class is enough.
   */
  useEffect(() => {
    // A window dragged wide while a drawer is open: the drawer has somewhere
    // to go now, so the menu goes back to showing what it was asked to show.
    if (!narrow) { setDrilled(null); return; }
    document.querySelector<HTMLElement>('.menu-sheet [role=menuitem]')?.focus();
  }, [drilled, narrow]);

  let lastSection: string | undefined;
  return (
    <Menu onOpenChange={(open) => { if (!open) { setQuery(''); setDrilled(null); } }}>
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
      <MenuContent align={align} sheet={narrow}>
        {level ? (
          <>
            {/* The way out, and the only thing on the level that says where you are. */}
            <MenuItem onSelect={(event) => { event.preventDefault(); setDrilled(null); }}>
              <Icon name="chevronLeft" size={13} />
              <span className="flex-1 min-w-0 truncate font-medium">{level.label}</span>
            </MenuItem>
            <MenuSeparator />
            <DrawerRows group={level} />
          </>
        ) : (
          <>
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
            {filtered.map((entry) => {
              if (isGroup(entry)) {
                lastSection = undefined;
                return narrow
                  ? <MenuDrillRow key={entry.id} group={entry} open={() => setDrilled(entry.id)} />
                  : <MenuDrawer key={entry.id} group={entry} />;
              }
              const header = entry.section && entry.section !== lastSection ? entry.section : null;
              lastSection = entry.section;
              return (
                <Fragment key={entry.id}>
                  {header && <MenuLabel>{header}</MenuLabel>}
                  <MenuItemRow item={entry} />
                </Fragment>
              );
            })}
          </>
        )}
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

/** What a failed request says: the server's words, or a generic line. */
export const failure = (error: unknown, t: Translate): string =>
  (error instanceof Error && error.message) || t('common.somethingWentWrong');

/**
 * A button's request, one at a time, and a toast when it fails (UX-08).
 * The ref refuses a second click that lands before `busy` has re-rendered.
 */
export function useAction() {
  const t = useT();
  const toast = useToast();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      toast(failure(error, t));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [t, toast]);
  return { busy, run };
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
      {guide && renderHint?.(guide)}
    </div>
  );
}

/**
 * How to draw the link into the guide, filled in by the guide.
 *
 * `Empty` wants to offer the right explanation and has no business knowing
 * where the guide keeps it — this file used to import `guideHref` and build the
 * link itself, which is the design system depending on a capability. It takes
 * the target and asks for a hint; `modules/guide/hint.tsx` says what one looks
 * like, and a build without the guide simply shows none.
 */
let renderHint: ((to: GuideTarget) => ReactNode) | null = null;

/** @port the link into the guide that `Empty` offers */
export function provideGuideHint(render: (to: GuideTarget) => ReactNode): void {
  renderHint = render;
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

/** Small confirm dialog — used before anything destructive. The button says the verb, "Delete" only by default (UX-04). */
export function useConfirm() {
  const t = useT();
  const [request, setRequest] = useState<{ message: string; confirmLabel?: string; title?: string; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (message: string, confirmLabel?: string, title?: string) =>
      new Promise<boolean>((resolve) => setRequest({ message, confirmLabel, title, resolve })),
    [],
  );

  const dialog = request ? (
    <Sheet
      title={request.title ?? t('action.confirmTitle')}
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
