/**
 * The icons, held to the promise the picker makes.
 *
 * The promise is "this shows up on your colleague's machine", and it is exactly
 * the kind of claim that rots: somebody adds a nicer-looking emoji, it renders
 * on the laptop they added it on, and it is a grey rectangle on the phone in
 * the next room. Nobody who can see the problem is looking at the list.
 *
 * So the mechanical half is checked here. Three failures are worth naming,
 * because all three are invisible to whoever introduces them:
 *
 * - **A ZWJ sequence** — 👨‍💻, 👩‍🔬, 🏳️‍🌈 — is several emoji joined by U+200D. A
 *   system that does not know the combination draws the parts, so one icon
 *   becomes two or three side by side and the row it was meant to label gets
 *   wider than the column.
 * - **A skin-tone modifier** does the same, and adds a choice nobody asked this
 *   field to make.
 * - **A code point newer than Unicode 6.0** is the plain case: no glyph, one
 *   box. It is the reason the ranges stop where they do rather than at the end
 *   of the block.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ICON_CHOICES, isSafeEmoji, SAFE_RANGES } from '../src/kernel/design-system/emoji-set.ts';

const points = (value: string): number[] => [...value].map((char) => char.codePointAt(0) ?? 0);

describe('the icons offered for a project, a page or a template', () => {
  it('is a set worth having — enough to choose from, few enough to scan', () => {
    assert.ok(ICON_CHOICES.length > 40, `only ${ICON_CHOICES.length} to choose from`);
    assert.ok(ICON_CHOICES.length < 120, `${ICON_CHOICES.length} is a full picker, which is a different product`);
  });

  it('offers each one once', () => {
    assert.deepEqual(
      ICON_CHOICES.filter((one, at) => ICON_CHOICES.indexOf(one) !== at),
      [],
      'a duplicate is a wasted cell and a confusing one',
    );
  });

  it('carries nothing a 2012 phone would draw as a box', () => {
    const late = ICON_CHOICES.filter((emoji) => !isSafeEmoji(emoji));
    assert.deepEqual(late, [], `outside the ranges that shipped with Unicode 6.0: ${late.join(' ')}`);
  });

  it('joins nothing, because a joined emoji comes apart', () => {
    for (const emoji of ICON_CHOICES) {
      assert.ok(!points(emoji).includes(0x200d), `${emoji} is a ZWJ sequence`);
      assert.ok(
        !points(emoji).some((code) => code >= 0x1f3fb && code <= 0x1f3ff),
        `${emoji} carries a skin-tone modifier`,
      );
      assert.ok(
        !points(emoji).some((code) => code >= 0x1f1e6 && code <= 0x1f1ff),
        `${emoji} is a flag, and flags are the least portable emoji there are`,
      );
    }
  });

  it('is one glyph wide, so a row of them lines up', () => {
    for (const emoji of ICON_CHOICES) {
      const code = points(emoji);
      assert.ok(code.length <= 2, `${emoji} is ${code.length} code points`);
      if (code.length === 2) assert.equal(code[1], 0xfe0f, `${emoji}'s second code point is not a variation selector`);
    }
  });
});

describe('deciding whether a stored icon is one of ours', () => {
  it('recognises the ones in the set, with or without a variation selector', () => {
    assert.equal(isSafeEmoji('📄'), true);
    assert.equal(isSafeEmoji('⚠️'), true);
    assert.equal(isSafeEmoji('⚠'), true, 'the same symbol without the selector is the same symbol');
  });

  it('refuses what it exists to refuse', () => {
    assert.equal(isSafeEmoji('👨‍💻'), false, 'a ZWJ sequence');
    assert.equal(isSafeEmoji('🧭'), false, 'Unicode 9.0, and a box on anything older');
    assert.equal(isSafeEmoji('🗂'), false, 'Unicode 7.0, from the tail of the block the ranges stop before');
    assert.equal(isSafeEmoji('🤝'), false, 'Unicode 9.0');
    assert.equal(isSafeEmoji(''), false);
    assert.equal(isSafeEmoji('ab'), false, 'two letters are not an emoji');
  });

  it('says no to a letter, which is what the old text box happily stored', () => {
    assert.equal(isSafeEmoji('P'), false);
    assert.equal(isSafeEmoji('..'), false);
  });

  it('reads the ranges rather than a copy of them', () => {
    // A scan that finds nothing passes everything: if the ranges ever came back
    // empty, every assertion above about what is refused would still hold.
    assert.ok(SAFE_RANGES.length > 4);
    for (const [from, to] of SAFE_RANGES) assert.ok(from <= to, `range ${from}–${to} is backwards`);
  });
});
