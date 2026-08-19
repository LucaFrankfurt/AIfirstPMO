/**
 * Time-based one-time passwords.
 *
 * Checked against RFC 6238's published test vectors rather than against
 * itself: an implementation that agrees with its own bugs passes any test you
 * write from it, and the whole point is agreeing with the app on somebody's
 * phone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, codeFor, currentCode, generateRecoveryCodes, generateSecret, otpauthUri, verifyCode } from '../src/lib/totp.ts';

/** The RFC's SHA-1 key, "12345678901234567890", as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const STEP = 30;

describe('agreeing with the standard', () => {
  it('reproduces the published test vectors', () => {
    // From RFC 6238 appendix B, the SHA-1 rows. If this passes, an
    // authenticator app and this code will show the same six digits.
    for (const [seconds, expected] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ] as const) {
      assert.equal(codeFor(RFC_SECRET, Math.floor(seconds / STEP)), expected, `at ${seconds}s`);
    }
  });

  it('reads back what it wrote in base32', () => {
    for (const text of ['', 'a', 'hello', '12345678901234567890']) {
      assert.equal(base32Decode(base32Encode(Buffer.from(text))).toString(), text);
    }
  });

  it('ignores the spaces and lower case people paste', () => {
    const secret = generateSecret();
    const messy = secret.toLowerCase().replace(/(.{4})/g, '$1 ');
    assert.equal(codeFor(messy, 1), codeFor(secret, 1));
  });
});

describe('checking a typed code', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the current one', () => {
    assert.ok(verifyCode(secret, currentCode(secret, now), now));
  });

  it('accepts one step either side, because clocks drift', () => {
    const step = Math.floor(now / 1000 / STEP);
    assert.ok(verifyCode(secret, codeFor(secret, step - 1), now), 'a code from thirty seconds ago');
    assert.ok(verifyCode(secret, codeFor(secret, step + 1), now), 'and one from thirty seconds ahead');
  });

  it('refuses one that is further out than that', () => {
    const step = Math.floor(now / 1000 / STEP);
    assert.equal(verifyCode(secret, codeFor(secret, step - 3), now), false);
    assert.equal(verifyCode(secret, codeFor(secret, step + 3), now), false);
  });

  it('refuses rubbish without throwing', () => {
    for (const input of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(verifyCode(secret, input as any, now), false, `${JSON.stringify(input)} is not a code`);
    }
  });

  it('is not fooled by a different secret', () => {
    assert.equal(verifyCode(generateSecret(), currentCode(secret, now), now), false);
  });
});

describe('what the user is handed', () => {
  it('builds a URI an authenticator app can scan', () => {
    const uri = otpauthUri('ABCDEFGH', 'ada@example.com');
    assert.match(uri, /^otpauth:\/\/totp\/Kolibri%3Aada%40example\.com\?/);
    assert.match(uri, /secret=ABCDEFGH/);
    assert.match(uri, /issuer=Kolibri/, 'the issuer appears as a parameter too, because apps differ');
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });

  it('makes recovery codes that are distinct and readable', () => {
    const codes = generateRecoveryCodes(8);
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8, 'no duplicates');
    assert.ok(codes.every((code) => /^[0-9a-f]{4}-[0-9a-f]{6}$/.test(code)), 'grouped so they can be read aloud');
  });
});
