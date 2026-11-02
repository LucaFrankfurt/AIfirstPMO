/**
 * Shared test helpers.
 *
 * `node:assert` has deepEqual but nothing for "these fields, whatever else is there",
 * which is how most of these tests want to talk about a stored row or an error.
 */
import assert from 'node:assert/strict';

/**
 * Assert that `actual` has every field of `expected` with an equal value, recursing
 * into plain objects; other fields of `actual` are ignored. Returns true so it can be
 * the validation function of `assert.rejects`.
 */
export function matches(actual: unknown, expected: Record<string, unknown>): true {
  assert.ok(actual !== null && typeof actual === 'object', `expected an object, got ${String(actual)}`);
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    const isPlainObject =
      value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
    if (isPlainObject) matches(record[key], value as Record<string, unknown>);
    else assert.deepEqual(record[key], value, `field "${key}"`);
  }
  return true;
}
