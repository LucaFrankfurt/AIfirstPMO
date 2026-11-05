/** Today is a day on somebody's calendar, not UTC's (WEB-15). */
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayIn } from '@kolibri/shared';

const lateEvening = Date.parse('2026-11-04T23:30:00Z');

describe('today in a time zone', () => {
  it('is already tomorrow in Berlin half an hour before UTC midnight', () => {
    assert.equal(todayIn('Europe/Berlin', lateEvening), '2026-11-05');
    assert.equal(todayIn('UTC', lateEvening), '2026-11-04');
  });

  it('is still yesterday in New York in the evening', () => {
    assert.equal(todayIn('America/New_York', Date.parse('2026-11-05T01:00:00Z')), '2026-11-04');
  });

  it('falls back to the runtime zone when none is given or it is unknown', () => {
    // Tokyo, set above: 08:30 on the 5th, where UTC still says the 4th.
    assert.equal(todayIn(null, lateEvening), '2026-11-05');
    assert.equal(todayIn('', lateEvening), '2026-11-05');
    assert.equal(todayIn('Mars/Olympus_Mons', lateEvening), '2026-11-05');
  });
});
