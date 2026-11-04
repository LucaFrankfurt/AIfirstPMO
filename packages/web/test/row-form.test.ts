/**
 * What an edit form sends: only the fields changed since it opened, so a
 * save does not quietly undo somebody else's edit to a field it never touched.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { installBrowser } from './browser.ts';

installBrowser();

const { applyChanges, byId, reset } = await import('../src/kernel/sync/store');
const { update } = await import('../src/kernel/sync/mutations');
const { changedFields } = await import('../src/kernel/design-system/row-form');

describe('changedFields', () => {
  const opened = { id: 'p1', name: 'Hosting', description: null, price: 100, capabilities: ['a', 'b'], note: '' };

  it('keeps only what differs from the row as it was opened', () => {
    const patch = { name: 'Hosting', description: 'Now with backups', price: 100, capabilities: ['a', 'b'] };
    assert.deepEqual(changedFields(patch, opened), { description: 'Now with backups' });
  });

  it('is empty when the form was saved untouched', () => {
    assert.deepEqual(changedFields({ name: 'Hosting', price: 100, capabilities: ['a', 'b'] }, opened), {});
  });

  it('reads null, absent, an empty string and an empty list as the same nothing', () => {
    assert.deepEqual(changedFields({ description: '', note: null, vendor: null, tags: [] }, opened), {});
  });

  it('still sends a field cleared or set to zero', () => {
    assert.deepEqual(changedFields({ name: null, price: 0 }, opened), { name: null, price: 0 });
  });

  it('compares lists and objects by value, order included', () => {
    assert.deepEqual(changedFields({ capabilities: ['b', 'a'] }, opened), { capabilities: ['b', 'a'] });
    assert.deepEqual(changedFields({ weights: { likely: 50 } }, { weights: { likely: 50 } }), {});
  });
});

describe('two people editing one row', () => {
  beforeEach(() => reset());

  it('keeps the other edit when this form saves', () => {
    applyChanges({ product: [{ id: 'p1', name: 'Hosting', description: null, acquisition_cost: 100 }] } as never);
    const opened = byId('product', 'p1')!;

    // Somebody else changes the acquisition cost while the form is open.
    applyChanges({ product: [{ id: 'p1', name: 'Hosting', description: null, acquisition_cost: 120 }] } as never);

    // The form only changed the description, but it holds every field as it opened.
    const patch = { name: 'Hosting', description: 'Now with backups', acquisition_cost: 100 };
    update('product', 'p1', changedFields(patch, opened));

    const row = byId('product', 'p1')!;
    assert.equal(row.acquisition_cost, 120);
    assert.equal(row.description, 'Now with backups');
  });
});
