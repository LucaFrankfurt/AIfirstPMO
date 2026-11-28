/** A button that opens a menu of commands, with drawers for the lists that grow with a workspace. */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { matchesTerms, parseTerms } from '@kolibri/shared';
import { useT } from '../../i18n/i18n';
import { buttonVariants, hasText } from './button';
import {
  Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger,
} from './menu';
import { isGroup, menuMatches } from '../menu-search';
import { useNarrow } from '../narrow';
import { Input } from './field';
import { cn } from '../cn';
import { Icon } from './icon';

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
          className="mb-1 h-8 text-body"
          placeholder={t('common.filterPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) event.stopPropagation();
          }}
        />
      )}
      {rows.length === 0 && (
        <div className="px-2 py-2 text-label text-muted">{group.empty ?? t('common.nothingHere')}</div>
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
    {group.hint && <span className="text-caption text-muted truncate max-w-[9rem]">{group.hint}</span>}
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
    {item.hint && <span className="text-caption text-muted">{item.hint}</span>}
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
                className="mb-1 h-8 text-body"
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
              <div className="px-2 py-2 text-label text-muted">{empty ?? t('common.nothingHere')}</div>
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
