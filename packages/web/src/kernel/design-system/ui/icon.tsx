/**
 * The icon set: one drawing per name, at whatever size it is asked for.
 *
 * On its own so that something small — the support widget's page, inside a
 * stranger's iframe — can draw an icon without importing every dialog, menu
 * and popover the app has.
 *
 * The drawings are lucide's now, and nothing else's. There were two sources:
 * seventy-one paths drawn by hand here, and `lucide-react` in the one file
 * that needed an icon the hand-drawn set did not have. Two sources is two
 * stroke weights, two corner styles, two ideas of how big a glyph sits in its
 * box, and the second one grows every time somebody needs a shape the first
 * lacks. The names stay — five hundred call sites say `<Icon name="board">`
 * and have no reason to know where the drawing comes from.
 *
 * What the hand-drawn set had learned is kept, as choices of glyph:
 *
 *   - `list` is bulleted and `menu` is three bare lines. They were once the
 *     same drawing, and a phone's header showed two hamburgers that did
 *     different things (design.md, "Two controls must not be the same
 *     drawing").
 *   - `sliders` is the display control's own glyph, not a `filter` funnel.
 *   - `cycle` and `refresh` are different arrows: one is an iteration of the
 *     team's work, the other is "fetch again".
 *
 * Each name maps to one component and no two names to the same one; a
 * duplicate here would be the hamburger problem again.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Archive, Bell, Bookmark, Calendar, ChartGantt, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleAlert, CircleHelp, ClipboardList, Clock, CloudOff, Copy, CornerLeftUp, EllipsisVertical, FileText,
  Folder, Funnel, Globe, GripVertical, Hash, Headset, House, Image, Inbox, IterationCw, LayoutDashboard,
  Layers, Link, List, LogOut, Mail, MapPin, Maximize2, Menu, MessageSquare, Minimize2, Minus, Moon,
  PanelLeft, Paperclip, Pause, Pencil, Play, Plus, RefreshCw, Redo2, Reply, Scan, Search, SendHorizontal,
  Settings, ShieldCheck, SlidersHorizontal, SmilePlus, Sparkles, SquareKanban, StickyNote, Sun, Table, Tag,
  Target, Trash2, Undo2, Users, Wallet, X, Zap,
} from 'lucide-react';
import { cn } from '../cn';

const ICONS = {
  home: House,
  inbox: Inbox,
  // An envelope, for the connected mailboxes. Distinct from `inbox`, which is
  // the tray of notifications and would be read as the same place.
  mail: Mail,
  search: Search,
  plus: Plus,
  minus: Minus,
  check: Check,
  close: X,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  dots: EllipsisVertical,
  board: SquareKanban,
  list: List,
  calendar: Calendar,
  agenda: ClipboardList,
  page: FileText,
  folder: Folder,
  users: Users,
  cycle: IterationCw,
  settings: Settings,
  filter: Funnel,
  archive: Archive,
  trash: Trash2,
  attach: Paperclip,
  image: Image,
  send: SendHorizontal,
  link: Link,
  sun: Sun,
  moon: Moon,
  logout: LogOut,
  chat: MessageSquare,
  headset: Headset,
  globe: Globe,
  hash: Hash,
  bell: Bell,
  menu: Menu,
  sidebar: PanelLeft,
  sliders: SlidersHorizontal,
  bolt: Zap,
  pencil: Pencil,
  reply: Reply,
  emoji: SmilePlus,
  bookmark: Bookmark,
  table: Table,
  gantt: ChartGantt,
  target: Target,
  // "The way up", above a sub-task's title: to the parent.
  hierarchy: CornerLeftUp,
  copy: Copy,
  grip: GripVertical,
  refresh: RefreshCw,
  play: Play,
  pause: Pause,
  help: CircleHelp,
  sparkle: Sparkles,
  shield: ShieldCheck,
  wallet: Wallet,
  stack: Layers,
  tag: Tag,
  canvas: LayoutDashboard,
  note: StickyNote,
  pin: MapPin,
  undo: Undo2,
  redo: Redo2,
  fit: Scan,
  expand: Maximize2,
  collapse: Minimize2,
  alert: CircleAlert,
  clock: Clock,
  offline: CloudOff,
} satisfies Record<string, LucideIcon>;

/**
 * Icons that mean "forwards" or "away" rather than naming a thing. They are
 * mirrored under a right-to-left direction, where forwards is the other way.
 * `sidebar` is here because the column it draws is on the start side, and
 * under right-to-left so is the sidebar.
 */
const DIRECTIONAL = new Set(['chevronLeft', 'chevronRight', 'send', 'logout', 'reply', 'sidebar']);

/**
 * The names above, as a type. `Icon` itself still takes any string — plenty of
 * callers pass a name that came out of the database — but a hard-coded list of
 * icons can be typed against this and a shape that does not exist becomes a
 * compile error rather than a quiet fallback.
 */
export type IconName = keyof typeof ICONS;

/**
 * One drawing, at `size`. The stroke is a little under lucide's 2 because the
 * app draws most of its icons at 14–16px, where 2 reads as bold; it is the
 * weight the hand-drawn set used, so a screen keeps its colour.
 *
 * A name nobody mapped draws the "more" dots: a quiet shape that is plainly
 * not the thing that was meant, rather than nothing at all.
 */
export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  const Drawing = (ICONS as Record<string, LucideIcon>)[name] ?? EllipsisVertical;
  return (
    <Drawing
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth={false}
      aria-hidden="true"
      className={cn(DIRECTIONAL.has(name) && 'icon-dir', 'flex-none', className)}
    />
  );
}
