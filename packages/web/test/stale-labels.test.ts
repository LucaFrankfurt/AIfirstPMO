/**
 * A screen that shows an age has to keep showing the right one.
 *
 * This reads the source rather than running it, for the same reason
 * `reachable.test.ts` does: the failure is invisible while anybody is looking
 * at it. A relative time is worked out once, as the component renders, and it
 * is correct at that instant — it only starts lying afterwards, quietly, and
 * nobody reviews a screen by leaving it open for an hour. The conversation view
 * had a ticker for its own messages and every other screen in the app had the
 * same bug without one, which is how a "vor 2 Minuten" was still there at
 * lunchtime.
 *
 * So the rule is mechanical: a file that renders an age subscribes to the
 * minute. `useMinute()` is one line at the top of the component and the whole
 * app shares one interval — see `kernel/design-system/minute.ts`.
 *
 * A file that only computes an age for something other than the screen — a
 * toast that is written once and does not update, a string handed to the
 * clipboard — has nothing to subscribe to. There is no such file today. When
 * there is, name it below with the reason rather than widening the rule: a
 * count of allowed exceptions is a budget somebody will spend.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Files that render a timestamp's age without the subscription, and why. */
const NOT_ON_SCREEN: Record<string, string> = {};

/** The helpers whose output goes stale the moment it is drawn. */
const AGES = /\brelativeTime\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('an age on screen', () => {
  it('is re-read once a minute, everywhere it is shown', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      const relative = path.slice(SRC.length);
      // The formatter itself, which is where `relativeTime` is written.
      if (relative === 'kernel/design-system/format.ts') continue;
      const source = readFileSync(path, 'utf8');
      if (!AGES.test(source)) continue;
      if (source.includes('useMinute()')) continue;
      if (relative in NOT_ON_SCREEN) continue;
      offenders.push(relative);
    }

    assert.deepEqual(offenders, [], 'these render an age that will stand still: call useMinute()');
  });

  it('is counted in at least the screens we know about', () => {
    // A guard on the guard. If `relativeTime` were renamed and the regex above
    // stopped matching, the test would pass by finding nothing at all.
    const seen = walk(SRC).filter((path) => AGES.test(readFileSync(path, 'utf8')));
    assert.ok(seen.length > 10, `only ${seen.length} files matched — is the pattern still right?`);
  });
});
