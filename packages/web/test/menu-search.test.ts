/**
 * What a search leaves of a menu that has drawers in it.
 *
 * The drawers are what stopped menus being 195 rows long. They also introduce
 * the one way a menu can get *worse*: something that used to be visible is now
 * behind a row, and somebody who knows what they are looking for has to guess
 * which row. Typing is the escape hatch, so these are the cases that keep it
 * open — a query flattens the drawers, and every flattened row still says
 * where it came from, because in a workspace with eight projects the eight
 * labels called "Bug" are told apart by nothing else.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTerms } from '@kolibri/shared';
import { isGroup, menuMatches, menuSize, type Entry, type SearchableItem } from '../src/kernel/design-system/menu-search.ts';

const row = (id: string, label: string, hint?: string): SearchableItem => ({ id, label, hint });

const MENU: Entry<SearchableItem>[] = [
  row('archive', 'Archive'),
  row('delete', 'Delete'),
  {
    id: 'labels',
    label: 'Labels',
    items: [
      row('l1', 'Bug', 'Website'),
      row('l2', 'Bug', 'Mobile app'),
      row('l3', 'Design Review'),
    ],
  },
  {
    id: 'project',
    label: 'Move to project',
    items: [row('p1', 'Website'), row('p2', 'Mobile app')],
  },
];

const ids = (entries: Entry<SearchableItem>[]) => entries.map((entry) => entry.id);
const find = (query: string) => menuMatches(MENU, parseTerms(query));

describe('a menu with drawers in it', () => {
  it('is handed back untouched when nobody is searching', () => {
    assert.deepEqual(ids(find('')), ['archive', 'delete', 'labels', 'project']);
    assert.equal(menuSize(MENU), 7, 'two commands and five rows in drawers');
  });

  it('knows which entries are drawers', () => {
    assert.deepEqual(MENU.filter(isGroup).map((group) => group.id), ['labels', 'project']);
  });
});

describe('what a query leaves', () => {
  /** The whole point: nobody should have to know which drawer something is in. */
  it('reaches into the drawers and flattens what it finds', () => {
    assert.deepEqual(ids(find('bug')), ['l1', 'l2']);
  });

  it('still finds the commands', () => {
    assert.deepEqual(ids(find('arch')), ['archive']);
  });

  /**
   * Eight projects each seeded a label called "Bug". The name alone names
   * nothing, so the drawer's own word is searched too — which is what makes
   * `bug website` mean one of the two rather than both.
   */
  it('reads the drawer and the hint, so two rows of one name can be told apart', () => {
    assert.deepEqual(ids(find('bug website')), ['l1']);
    assert.deepEqual(ids(find('bug mobile')), ['l2']);
  });

  it('matches a drawer by its own name, bringing its rows out', () => {
    assert.deepEqual(ids(find('labels')), ['l1', 'l2', 'l3']);
  });

  /** A flattened row says where it came from, or the list is eight "Bug"s. */
  it('writes the drawer beside each row it lifts out', () => {
    const [first] = find('bug') as SearchableItem[];
    assert.equal(first.hint, 'Labels');
  });

  it('finds nothing rather than everything when nothing matches', () => {
    assert.deepEqual(ids(find('zzz')), []);
  });

  /**
   * The same folding the rest of the app does. `jorg` has to find "Jörg", or a
   * colleague is reachable only by somebody who can type an umlaut.
   */
  it('folds accents and takes the words in any order', () => {
    const people: Entry<SearchableItem>[] = [{
      id: 'assignee',
      label: 'Assignee',
      items: [row('u1', 'Jörg Müller'), row('u2', 'Ada Lovelace')],
    }];
    assert.deepEqual(menuMatches(people, parseTerms('jorg')).map((one) => one.id), ['u1']);
    assert.deepEqual(menuMatches(people, parseTerms('muller jorg')).map((one) => one.id), ['u1']);
  });
});
