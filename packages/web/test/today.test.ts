/** Today on the screen is the reader's own date, not UTC's (WEB-15). */
process.env.TZ = 'Europe/Berlin';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { today } from '../src/kernel/design-system/format.ts';

afterEach(() => mock.timers.reset());

describe('today', () => {
  it('has already turned in Berlin half an hour before UTC midnight', () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T23:30:00Z') });
    assert.equal(today(), '2026-11-05');
  });
});
