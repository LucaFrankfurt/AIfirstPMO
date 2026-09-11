/**
 * The clock the workspace shares, and the bug that made it necessary.
 *
 * Everything Kolibri stores is stamped by the server; the browser rendered
 * those instants against its own clock. Where the two machines disagreed — five
 * minutes is an ordinary amount for a container whose host suspended, or for a
 * laptop nobody has pointed at NTP — a task saved one second ago read "5
 * minutes ago", and so did every other relative time on the screen at once,
 * because the difference is the same everywhere. It was reported as a
 * formatting bug and it was not one: `relativeTime` computed exactly the right
 * answer to the wrong question.
 *
 * The first test below is the one that would have caught it. It is written from
 * the reader's side deliberately — a server stamp, rendered — because that is
 * the claim that matters, and an assertion about the offset arithmetic alone
 * would have passed just as happily while the screen said five minutes.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clockOffset, lastSample, now, observeServerTime } from '../src/kernel/sync/clock.ts';
import { relativeTime } from '../src/kernel/design-system/format.ts';

/** One round trip, answered instantly by a server whose clock reads `serverNow`. */
const heardFrom = (serverNow: number, rtt = 0): void => {
  const sentAt = Date.now();
  observeServerTime(serverNow, sentAt, sentAt + rtt);
};

/** Back to a server that agrees with this device, so tests do not leak state. */
beforeEach(() => heardFrom(Date.now()));

describe('a device whose clock disagrees with the server', () => {
  it('shows what the server stamped a moment ago as a moment ago', () => {
    // The server is five minutes behind this device. A row it stamps *now*
    // therefore carries a timestamp five minutes in this device's past.
    const skew = 5 * 60_000;
    heardFrom(Date.now() - skew);
    const justSaved = Date.now() - skew;

    assert.equal(relativeTime(justSaved), 'now', 'the task was saved this second, on the clock that stamped it');
  });

  it('is just as wrong in the other direction, and just as fixed', () => {
    // A browser that is five minutes *behind* the server reads every stamp as
    // being in the future, which `Intl` renders as "in 5 minutes".
    const skew = 5 * 60_000;
    heardFrom(Date.now() + skew);
    assert.equal(relativeTime(Date.now() + skew), 'now');
  });

  it('still counts real time, rather than flattening everything to now', () => {
    heardFrom(Date.now() - 5 * 60_000);
    const stampedTenMinutesAgo = Date.now() - 5 * 60_000 - 10 * 60_000;
    assert.equal(relativeTime(stampedTenMinutesAgo), '10 minutes ago');
  });
});

describe('what one round trip says about the two clocks', () => {
  it('puts the server somewhere in the middle of the request, not at either end', () => {
    const sentAt = Date.now();
    const rtt = 400;
    // A server that agrees with this device answers with the midpoint of the
    // round trip — so the measured offset is zero, not half the round trip.
    observeServerTime(sentAt + rtt / 2, sentAt, sentAt + rtt);

    assert.equal(clockOffset(), 0);
    assert.equal(lastSample()?.rtt, rtt, 'the round trip is kept: it is the bound on how wrong the offset can be');
  });

  it('follows the newest reading, because a server can correct its own clock', () => {
    heardFrom(Date.now() - 60_000);
    assert.ok(Math.abs(clockOffset() + 60_000) < 1000, 'a minute behind');

    heardFrom(Date.now());
    assert.ok(Math.abs(clockOffset()) < 1000, 'and caught up again once the server said so');
  });

  it('keeps the last good reading when a response carries nonsense', () => {
    heardFrom(Date.now() - 60_000);
    const measured = clockOffset();

    observeServerTime(Number.NaN, Date.now(), Date.now());
    observeServerTime(0, Date.now(), Date.now());
    // A proxy that rewrote the header, or a response that never had one: the
    // reading is dropped rather than allowed to reset the clock to this device.
    assert.equal(clockOffset(), measured);
  });

  it('leaves a device that agrees with its server exactly where it was', () => {
    heardFrom(Date.now());
    // The overwhelmingly common case, and the one a change here would break
    // most quietly: two machines that agree must stay agreeing.
    assert.ok(Math.abs(now() - Date.now()) < 1000);
  });
});
