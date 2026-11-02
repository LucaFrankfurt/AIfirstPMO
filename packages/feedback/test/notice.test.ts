// The privacy notice — derived from the target, not hardcoded.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { screenshotDefaultOn, screenshotNotice } from '../src/kernel/feedback/notice.ts';
import { de, en } from '../src/kernel/feedback/messages.ts';

const selfHosted = { name: 'kolibri', trustBoundary: 'self_hosted' as const, label: 'Kolibri' };
const thirdParty = { name: 'linear', trustBoundary: 'third_party' as const, label: 'Linear' };

describe('screenshotDefaultOn', () => {
  it('attaches by default only inside our own trust boundary', () => {
    assert.equal(screenshotDefaultOn(selfHosted), true);
    // The whole point of trustBoundary on the target: a SaaS target flips this to
    // opt-in without anyone having to remember to.
    assert.equal(screenshotDefaultOn(thirdParty), false);
  });
});

describe('screenshotNotice', () => {
  it('names both what the screenshot contains and where it goes', () => {
    const notice = screenshotNotice(selfHosted);
    assert.ok(notice.includes('any data visible in it'));
    assert.ok(notice.includes('Kolibri'));
    assert.ok(notice.includes('self-hosted'));
  });

  it('warns explicitly when the target is external', () => {
    const notice = screenshotNotice(thirdParty);
    assert.ok(notice.includes('Linear'));
    assert.ok(notice.includes('external system'));
    assert.ok(!notice.includes('self-hosted'));
  });

  it('speaks the configured language', () => {
    assert.ok(screenshotNotice(selfHosted, de).includes('selbst-betriebenen Kolibri'));
    assert.ok(screenshotNotice(thirdParty, de).includes('externes System'));
    assert.equal(screenshotNotice(selfHosted), screenshotNotice(selfHosted, en));
  });

  it("takes an app's own wording for one case without losing the other", () => {
    const messages = { ...de, notice: { ...de.notice, selfHosted: (l: string) => `Kundendaten → ${l}` } };
    assert.equal(screenshotNotice(selfHosted, messages), 'Kundendaten → Kolibri');
    assert.ok(screenshotNotice(thirdParty, messages).includes('extern'));
  });
});
