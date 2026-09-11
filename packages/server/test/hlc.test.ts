/**
 * Which of two concurrent edits wins, when the two devices disagree about the
 * time.
 *
 * An HLC is meant to make that question answerable without a shared clock, and
 * it half does: `observe` drags a clock that is *behind* forward, so such a
 * device catches up on the first exchange. Nothing walks back one that is
 * ahead. A browser five minutes fast stamps every write five minutes into the
 * future, and last-writer-wins then means that browser wins every field it
 * touches — including the ones somebody else edited afterwards — for as long as
 * its clock stays wrong. It is the same disagreement that made every "geändert
 * vor …" in the interface read five minutes too old, and it has the same fix:
 * the wall clock a stamp is made from is the server's, not the device's.
 *
 * So `Clock` is handed one. These pin the handing over, and the ordering that
 * depends on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Clock, hlcGreater, timestampOf } from '@kolibri/shared';

describe('the clock a stamp is made from', () => {
  it('is the one it was given, not this machine\'s', () => {
    const pinned = 1_700_000_000_000;
    const device = new Clock('device', () => pinned);
    assert.equal(timestampOf(device.now()), pinned);
  });

  it('is this machine\'s when nobody says otherwise', () => {
    // The server is the timeline, so it reads its own clock and passes nothing.
    const stamp = timestampOf(new Clock('server').now());
    assert.ok(Math.abs(stamp - Date.now()) < 1000);
  });

  it('leaves a fast device unable to win a field it edited first', () => {
    // Both read the workspace's clock, however wrong their own are. Ada's
    // device is five minutes fast and Bob's five slow; Bob edits second.
    let shared = 1_700_000_000_000;
    const ada = new Clock('ada', () => shared);
    const bob = new Clock('bob', () => shared);

    const adaWrote = ada.now();
    shared += 2_000;
    const bobWrote = bob.now();

    assert.ok(hlcGreater(bobWrote, adaWrote), 'the later edit wins, not the faster clock');
  });

  it('still refuses to go backwards within one device', () => {
    // A stopped clock, or an offset that improves between two writes: the
    // counter has to carry the order that the millis no longer can.
    const stopped = new Clock('stopped', () => 1_700_000_000_000);
    const first = stopped.now();
    const second = stopped.now();
    assert.ok(hlcGreater(second, first), 'two writes in the same millisecond are still ordered');
  });

  it('still catches up to a stamp from further ahead', () => {
    // The half an HLC always had, and it is not made redundant by the above: a
    // device that has been offline since before the clock was last measured can
    // still arrive stamped from behind, and has to come forward.
    const ahead = new Clock('ahead', () => 1_700_000_060_000);
    const behind = new Clock('behind', () => 1_700_000_000_000);

    const fromAhead = ahead.now();
    behind.observe(fromAhead);
    assert.ok(hlcGreater(behind.now(), fromAhead), 'observing pulls it forward');
  });
});
