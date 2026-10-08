/**
 * What a search leaves of a menu that has drawers in it.
 *
 * Typing is the one gesture that should not have to know where something was
 * filed. Somebody who knows a label is called "Bug" should find it by typing
 * `bug`, not by remembering that labels moved into a drawer — so a query
 * flattens the menu: every row that matches comes back at the top level, and
 * the drawer it came out of is written beside it, because eight workspaces'
 * worth of "Bug" are eight different labels and the only thing telling them
 * apart is where each one lives.
 *
 * `parseTerms`/`matchesTerms` and not `toLowerCase().includes()`, for the
 * reason the rest of the app uses them: `jorg` has to find "Jörg Müller", and
 * "muller jorg" has to find him too. The hint is searched along with the label
 * — on a flattened row that hint is the project's name, which is the only way
 * `bug website` can mean the one you want.
 *
 * No React here on purpose: this is the part worth testing.
 */
import { matchesTerms, type SearchTerm } from '@kolibri/shared';

export interface SearchableItem {
  id: string;
  label: unknown;
  hint?: string;
}

export interface SearchableGroup<I> {
  id: string;
  label: string;
  items: I[];
}

export type Entry<I> = I | SearchableGroup<I>;

/** A drawer is an entry that holds rows. */
export const isGroup = <I>(entry: Entry<I>): entry is SearchableGroup<I> =>
  Array.isArray((entry as SearchableGroup<I>).items);

/** What a row is matched against: its own words, and where it came from. */
const words = (item: SearchableItem, from?: string): string =>
  `${typeof item.label === 'string' ? item.label : ''} ${item.hint ?? ''} ${from ?? ''}`;

/**
 * The entries a query leaves, flattened out of their drawers.
 *
 * An empty query gives the menu back untouched — drawers and all — because
 * that is the shape the menu is *for*. Only a search flattens, and only for as
 * long as somebody is typing.
 */
export function menuMatches<I extends SearchableItem>(
  entries: readonly Entry<I>[],
  terms: readonly SearchTerm[],
  /** How a flattened row says which drawer it came out of. */
  from: (item: I, group: SearchableGroup<I>) => I = (item, group) => ({ ...item, hint: group.label }),
): Entry<I>[] {
  if (!terms.length) return [...entries];
  const out: Entry<I>[] = [];
  for (const entry of entries) {
    if (!isGroup(entry)) {
      if (matchesTerms(words(entry), terms)) out.push(entry);
      continue;
    }
    for (const item of entry.items) {
      if (matchesTerms(words(item, entry.label), terms)) out.push(from(item, entry));
    }
  }
  return out;
}

/** How many rows a menu offers in all, drawers counted. Used by its own tests. */
export const menuSize = <I>(entries: readonly Entry<I>[]): number =>
  entries.reduce((count, entry) => count + (isGroup(entry) ? entry.items.length : 1), 0);
