/**
 * Where a page stands among its siblings, and what a dated entry is called.
 *
 * Pure and apart from the store, like `links.ts` beside it, because both
 * halves are read on the server and on the device and have to agree there
 * character for character: a tree that one device draws in one order and the
 * next in another is a tree nobody can give directions in.
 */
import { compareOrder, orderKey } from '../../kernel/registry/order.ts';
import { pageKey } from './links.ts';

/** The least a row has to say to be put in order. */
export interface OrderedPage {
  id: string;
  sort_order?: string | null;
  created_at?: number;
}

/**
 * Siblings in the order the tree draws them.
 *
 * The key first, as it always was — and then, where two keys are *equal*, the
 * order they were written in and finally the id. The tie-break is the change.
 * Every page an assistant created arrived with the column's default `V`, so on
 * the first real instance 41 of the 56 top-level pages shared one key, and
 * their order was whatever order the device's store happened to hold them in:
 * the order each row was first pulled, which is the order of its last edit on
 * a fresh device and of something else on an old one. Nobody chose it, and two
 * people looking at the same wiki could not have agreed on it.
 */
export const comparePages = (a: OrderedPage, b: OrderedPage): number =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '')
  || (a.created_at ?? 0) - (b.created_at ?? 0)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * New keys for the siblings that share one, so that they stop sharing it.
 *
 * Only the second and later of each tied run move; the first keeps its key,
 * so a sibling list that was never tied writes nothing at all and running this
 * twice is a no-op. Each moved row lands strictly between the key before it
 * and the next *different* key after it, in `comparePages` order — the order
 * the tree already draws them in, so nothing visibly moves.
 *
 * Why it is needed beyond the tie-break above: a drag between two tied pages
 * asks `orderKey` for a key between two equal keys, and the only answer it has
 * is "just after both" — which is after the whole tied run. With 41 pages on
 * one key, dropping a page into the middle of them put it at the end.
 */
export function untie<T extends OrderedPage>(siblings: readonly T[]): { id: string; sort_order: string }[] {
  const rows = [...siblings].sort(comparePages);
  const moved: { id: string; sort_order: string }[] = [];
  let previous: string | null = null;
  rows.forEach((row, at) => {
    const key = row.sort_order ?? '';
    if (previous === null || key > previous) {
      previous = key;
      return;
    }
    const floor: string = previous;
    const next = rows.slice(at + 1).map((later) => later.sort_order ?? '').find((later) => later > floor) ?? null;
    const fresh = orderKey(floor, next);
    moved.push({ id: row.id, sort_order: fresh });
    previous = fresh;
  });
  return moved;
}

/**
 * A day as `2026-11-18`, in the given time zone.
 *
 * One format, always, because the titles this goes into are the thing that
 * had seven: `16.11.2026`, `2026-11-12`, `13 Nov 2026`, `KW 46`, `14 Oktober`
 * — on one wiki, for one kind of document. ISO sorts as text, reads the same
 * in every language this app speaks, and cannot be mistaken for a month.
 *
 * Assembled from parts rather than taken from a locale that happens to print
 * it this way, so an engine whose locale data differs cannot change it.
 */
export function localDay(at: number, timeZone?: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(at));
    const part = (type: string) => parts.find((one) => one.type === type)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  } catch {
    // An unknown time zone name: the day in UTC is a better answer than none.
  }
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * What the next entry of a series is called.
 *
 * The series' own title and the day, and a counter only when that exact title
 * is already taken — a second meeting on one day is real, and two pages with
 * one title is the `duplicate` finding: every `[[link]]` to the second lands on
 * the first. `taken` holds titles as `pageKey` folds them, which is how links
 * resolve, so "Weekly · 2026-11-18" and "weekly · 2026-11-18" are the same.
 */
export function seriesEntryTitle(series: string, day: string, taken: ReadonlySet<string> = new Set()): string {
  const base = `${series.trim() || 'Untitled'} · ${day}`;
  if (!taken.has(pageKey(base))) return base;
  for (let n = 2; ; n++) {
    const next = `${base} (${n})`;
    if (!taken.has(pageKey(next))) return next;
  }
}

/** The least a page has to say to be found as a series. */
export interface SeriesCandidate {
  id: string;
  title: string;
  series?: number;
  archived?: number;
  is_template?: number;
  deleted_at?: number | null;
  created_at?: number;
  parent_id?: string | null;
  access?: string;
}

/** A page entries may still be filed under: a series nobody archived, deleted or made a template. */
const liveSeries = (page: SeriesCandidate | undefined): boolean =>
  !!page && !!page.series && !page.archived && !page.is_template && !page.deleted_at;

/**
 * The series the earlier entries of something already hang under.
 *
 * Asked before the title, because a title is a weak tie: a series somebody
 * renamed is not found by its old name, and a meeting filed by a German
 * colleague's screen is looked for under "Protokolle: Weekly" while the
 * English one asks for another. Where the minutes of earlier meetings went is
 * the answer that does not depend on either. `entries` in the order to trust
 * them — the most recent first.
 */
export function seriesAbove<T extends SeriesCandidate>(pages: readonly T[], entries: readonly string[]): T | undefined {
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (const id of entries) {
    const parent = byId.get(byId.get(id)?.parent_id ?? '');
    if (liveSeries(parent)) return parent;
  }
  return undefined;
}

/**
 * The series a title names, if there is one — the oldest, if there are several.
 *
 * By title because that is all a meeting knows about where its minutes go: a
 * weekly is a run of meetings with one name, and nothing else ties them. Folded
 * the way links fold titles (`pageKey`), so renaming "weekly" to "Weekly" does
 * not start a second series. Archived and template pages are not candidates —
 * filing this week's minutes under an archived page is filing them nowhere.
 */
export function findSeries<T extends SeriesCandidate>(pages: readonly T[], title: string): T | undefined {
  const key = pageKey(title);
  return pages
    .filter((page) => liveSeries(page) && pageKey(page.title) === key)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || (a.id < b.id ? -1 : 1))[0];
}

/**
 * The day an entry is *for*: the date in its title, which the series wrote
 * there — or the day it was made, for an entry written by hand.
 *
 * Not the day it was made alone: minutes filed a week late for an older
 * meeting are titled with the meeting's day and would otherwise sit at the top
 * of the series as the newest, dated the day somebody got round to them.
 */
export const entryDay = (page: { title?: string | null; created_at: number }): string =>
  (page.title ?? '').match(/(\d{4}-\d{2}-\d{2})(?!.*\d{4}-\d{2}-\d{2})/)?.[1] ?? localDay(page.created_at);
