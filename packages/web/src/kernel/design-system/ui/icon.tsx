/**
 * The icon set: one stroke drawing per name, at whatever size it is asked for.
 *
 * On its own so that something small — the support widget's page, inside a
 * stranger's iframe — can draw an icon without importing `ui.tsx` and, through
 * it, every dialog, menu and popover the app has. `ui.tsx` re-exports both
 * names, so the forty screens that import them from there are unchanged.
 */
import { cn } from '../cn';

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13 6 5h12l2 8v6H4z',
  // An envelope, for the connected mailboxes. Distinct from `inbox`, which is
  // the tray of notifications and would be read as the same place.
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  // Its partner, for the pair of zoom keys over a diagram.
  minus: 'M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  dots: 'M12 5h.01M12 12h.01M12 19h.01',
  board: 'M4 4h5v16H4zM10.5 4h5v10h-5zM17 4h3v13h-3z',
  // Bulleted, so the list *layout* is not the same drawing as a menu.
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  calendar: 'M4 7h16v13H4zM4 11h16M8 3v4M16 3v4',
  agenda: 'M9 3.5h6v3H9zM7.5 5H5v16h14V5h-2.5M8.5 11h7M8.5 15h7M8.5 19h4',
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
  // A headset, for support: people outside answered by people inside. Not
  // `chat`, which the team's own conversations already wear in the sidebar.
  headset: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2v1zm16 0a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2v1zM18 17v1a3 3 0 0 1-3 3h-3',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h16M3 15h16',
  bell: 'M18 10a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  // A window with a column down its start side: the button that folds one away.
  sidebar: 'M4 5h16v14H4zM9 5v14',
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
  // A swing ticket with its hole: a thing with a price on it. Not a shopping
  // trolley — this is the catalogue somebody maintains, not a checkout — and
  // not a box, which is already what `stack` says about servers.
  tag: 'M3 12.3V5a2 2 0 0 1 2-2h7.3a2 2 0 0 1 1.4.6l6.7 6.7a2 2 0 0 1 0 2.8l-7.3 7.3a2 2 0 0 1-2.8 0l-6.7-6.7a2 2 0 0 1-.6-1.4ZM7.5 7.5h.01',
  // Four frames of different sizes laid out side by side: a canvas page, as
  // opposed to `page`, which is one sheet of text.
  canvas: 'M3 4h8v7H3zM13 4h8v4h-8zM13 10h8v10h-8zM3 13h8v7H3z',
  // A sheet with its corner folded: a sticky note on a canvas.
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
  // A map pin: a comment left at a point rather than on a passage.
  pin: 'M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  // Four corners pulled out to the edges: show everything there is.
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  // Shapes for states that were only a colour (UX-10): late, due today, no connection.
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V13M12 16.5h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  offline: 'M3 3l18 18M8.5 6.3A6 6 0 0 1 17.7 10 4 4 0 0 1 20.4 16.5M16.5 18H7a4.5 4.5 0 0 1-1.3-8.8',
} satisfies Record<string, string>;

/**
 * Icons that mean "forwards" or "away" rather than naming a thing. They are
 * mirrored under a right-to-left direction, where forwards is the other way.
 * `sidebar` is here because the column it draws is on the start side, and
 * under right-to-left so is the sidebar.
 */
const DIRECTIONAL = new Set(['chevronLeft', 'chevronRight', 'send', 'logout', 'reply', 'sidebar']);

/**
 * Icons drawn heavier than the rest, by name.
 *
 * The three dots of a "more" menu are the case. They are drawn as round caps
 * on strokes of no length, so a dot is exactly as wide as the stroke — and at
 * the shared 1.7 that was one pixel at the 14px most menus use, a faint smudge
 * in the corner of a task that people reported as "where is the menu". At 4
 * each dot is the size the rest of the icon set draws a dot at, and they sit
 * further apart so they still read as three.
 *
 * By name, so the fallback for a name nobody drew keeps the old weight: a row
 * of three quiet dots is the right way for an unknown icon to look.
 */
const STROKE: Partial<Record<string, number>> = { dots: 4 };

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
      stroke="currentColor" strokeWidth={STROKE[name] ?? 1.7} strokeLinecap="round" strokeLinejoin="round"
     
    >
      <path d={(PATHS as Record<string, string>)[name] ?? PATHS.dots} />
    </svg>
  );
}
