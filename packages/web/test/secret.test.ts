/**
 * The two questions the vault screen asks about a secret without opening it.
 *
 * Both are arithmetic over dates, both are shown in three places — the row, the
 * count on the filter bar, the sort — and all three have to agree or the
 * feature is worse than a spreadsheet. Which is the whole reason they are a
 * function in `shared` rather than an expression in a component.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { byEnvironmentOrder, daysUntilRotation, maskSecret, orderKeys, rotation, strength } from '@kolibri/shared';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const ago = (days: number) => NOW - days * DAY;

describe('rotation', () => {
  it('says nothing about a secret nobody undertook to rotate', () => {
    // The important half: painting every secret amber trains people to ignore
    // the colour, and most secrets never get a cadence.
    assert.equal(rotation({ rotated_at: ago(900), rotate_after_days: 0 }, NOW), 'unset');
    assert.equal(rotation({ rotated_at: ago(900), rotate_after_days: null }, NOW), 'unset');
  });

  it('walks fresh, due, overdue', () => {
    assert.equal(rotation({ rotated_at: ago(10), rotate_after_days: 90 }, NOW), 'fresh');
    assert.equal(rotation({ rotated_at: ago(89), rotate_after_days: 90 }, NOW), 'fresh');
    assert.equal(rotation({ rotated_at: ago(91), rotate_after_days: 90 }, NOW), 'due');
    assert.equal(rotation({ rotated_at: ago(120), rotate_after_days: 90 }, NOW), 'overdue');
  });

  it('measures a never-rotated secret from when it was written down', () => {
    // Which is the honest reading of "this value has been the same since then".
    assert.equal(rotation({ created_at: ago(400), rotated_at: null, rotate_after_days: 90 }, NOW), 'overdue');
  });

  it('counts the days to go, and past', () => {
    assert.equal(daysUntilRotation({ rotated_at: ago(80), rotate_after_days: 90 }, NOW), 10);
    assert.equal(daysUntilRotation({ rotated_at: ago(100), rotate_after_days: 90 }, NOW), -10);
    assert.equal(daysUntilRotation({ rotated_at: ago(10), rotate_after_days: 0 }, NOW), null);
  });
});

describe('maskSecret', () => {
  it('shows enough to tell four keys apart', () => {
    assert.equal(maskSecret('sk-live-abcdefgh1234'), '••••1234');
  });

  it('shows nothing at all of a short one', () => {
    // Four of the last characters of an eight-character password is half of it.
    assert.equal(maskSecret('hunter2!'), '••••••••');
    assert.equal(maskSecret(''), '••••••••');
  });
});

describe('strength', () => {
  it('gives length more weight than punctuation, which is the one true thing about passwords', () => {
    assert.equal(strength('correct horse battery staple'), 'strong');
    assert.equal(strength('P@ss1!'), 'weak');
    assert.equal(strength('Tr0ub4dor&3xyz'), 'fair');
  });
});

describe('byEnvironmentOrder', () => {
  /*
   * The case that was live. A workspace is seeded with `production, staging,
   * development, shared` and `orderKeys(4)` gives them `C O b n` — so locale
   * collation, which sorts letters first and case second, read them back as
   * `development, production, shared, staging`: alphabetical by accident, with
   * production buried in the middle of a list it is meant to head. Three
   * screens did it, identically, in three places.
   */
  it('reads a key as a base-62 fraction and not as a word', () => {
    const names = ['production', 'staging', 'development', 'shared'];
    const keys = orderKeys(names.length);
    assert.deepEqual(keys, ['C', 'O', 'b', 'n'], 'the seeded keys have changed — this case rests on their case');

    const rows = names.map((name, index) => ({ name, sort_order: keys[index] }));
    assert.deepEqual([...rows].reverse().sort(byEnvironmentOrder).map((row) => row.name), names);
    // The comparison that was there, kept as what this asserts against.
    assert.ok('C'.localeCompare('b') > 0, 'locale collation no longer inverts these');
  });

  it('falls back on the name, which is a word and compares like one', () => {
    const rows = [
      { name: 'Zurich', sort_order: 'V' },
      { name: 'Ärger', sort_order: 'V' },
      { name: 'amber', sort_order: 'V' },
    ];
    assert.deepEqual(rows.sort(byEnvironmentOrder).map((row) => row.name), ['amber', 'Ärger', 'Zurich']);
  });

  it('puts an environment with no key at the front rather than throwing', () => {
    const rows = [{ name: 'has one', sort_order: 'V' }, { name: 'has none', sort_order: null }];
    assert.deepEqual(rows.sort(byEnvironmentOrder).map((row) => row.name), ['has none', 'has one']);
  });
});
