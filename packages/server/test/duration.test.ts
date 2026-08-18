/**
 * Parsing what somebody typed into a duration box.
 *
 * The interesting part is not "does 90 mean 90" but whether the six shapes
 * people actually type all mean the same thing — a form that accepts one
 * spelling of an hour and a half is a form people stop using.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration, parseDuration } from '@kolibri/shared';

describe('reading a duration', () => {
  it('understands every spelling of ninety minutes', () => {
    for (const input of ['90', '90m', '1.5h', '1,5h', '1h30', '1h 30m', '1:30', ' 1h30m ']) {
      assert.equal(parseDuration(input), 90, `${input} is an hour and a half`);
    }
  });

  it('treats a bare number as minutes', () => {
    // The unit people leave off is the small one: "20" is twenty minutes,
    // never twenty hours.
    assert.equal(parseDuration('20'), 20);
    assert.equal(parseDuration('2'), 2);
  });

  it('says nothing rather than zero when there is no number', () => {
    // Zero is a legitimate entry; "I typed rubbish" is not the same answer.
    for (const input of ['', '   ', 'a while', 'h', '-']) {
      assert.equal(parseDuration(input), null, `${JSON.stringify(input)} is not a duration`);
    }
    assert.equal(parseDuration('0'), 0, 'but an explicit zero is a number');
  });

  it('rounds to whole minutes', () => {
    assert.equal(parseDuration('0.75h'), 45);
    assert.equal(parseDuration('1.51h'), 91, 'and rounds rather than truncating');
  });
});

describe('writing a duration', () => {
  it('says it the way a person would', () => {
    assert.equal(duration(45), '45m');
    assert.equal(duration(60), '1h');
    assert.equal(duration(150), '2h 30m');
    assert.equal(duration(1440), '24h', 'days are not a unit here — a working day is not 24h');
  });

  it('shows nothing as nothing, not as a zero', () => {
    assert.equal(duration(0), '—');
    assert.equal(duration(null), '—');
    assert.equal(duration(undefined), '—');
  });

  it('round-trips what it prints', () => {
    for (const minutes of [1, 7, 45, 60, 90, 150, 605]) {
      assert.equal(parseDuration(duration(minutes)), minutes, `${minutes} survives the round trip`);
    }
  });
});
