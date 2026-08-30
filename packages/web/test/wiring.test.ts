/**
 * That the sync stream has its listeners hung off it.
 *
 * `sync.ts` used to call into `modules/chat/presence` by name, which made the
 * sync engine know which capability wanted its frames. It offers `onStream`
 * now and knows nothing about who takes it — a better shape, with the same new
 * way to go wrong the server's version has: a build that never calls
 * `installEffects` renders perfectly, opens the stream, and shows nobody as
 * online for ever. Nothing in the diff would say so.
 *
 * So the entry point is checked against the list, with comments stripped,
 * because the way this actually breaks is a call somebody commented out.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(import.meta.dirname, '..', 'src');
const code = (file: string): string =>
  readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the sync stream is wired up', () => {
  it('the entry point installs the effects', () => {
    assert.match(
      code('main.tsx'),
      /^installEffects\(\);/m,
      'main.tsx never calls installEffects(), so nothing is listening to the stream',
    );
  });

  it('and does it before the app can mount and open one', () => {
    const body = code('main.tsx');
    assert.ok(
      body.indexOf('installEffects();') < body.indexOf('createRoot('),
      'installEffects() runs after createRoot(), so the first frames arrive with nobody listening',
    );
  });

  it('everything the wiring calls is a real installer somewhere', () => {
    const wiring = code('wiring.ts');
    const called = [...wiring.matchAll(/^\s*(install\w+)\(\);$/gm)].map((m) => m[1]);
    assert.ok(called.length, 'wiring.ts installs nothing at all');
    for (const name of called) {
      const from = wiring.match(new RegExp(`import \\{ ${name} \\} from '([^']+)'`))?.[1];
      assert.ok(from, `wiring.ts calls ${name} without importing it`);
      const base = from!.replace(/^\.\//, '');
      const source = ['.ts', '.tsx'].map((ext) => { try { return code(base + ext); } catch { return null; } }).find(Boolean);
      assert.ok(source, `${name} is imported from ${from}, which is not a file`);
      assert.match(source!, new RegExp(`export const ${name}\\b|export function ${name}\\b`),
        `${from} does not export ${name}`);
    }
  });

  /*
   * The point of the whole exercise, stated as an assertion: the sync engine
   * used to call into `modules/chat/presence` by name. It offers `onStream`
   * now, and nothing above it is allowed back in.
   */
  it('the sync engine imports no capability', () => {
    const source = code('kernel/sync/sync.ts');
    assert.doesNotMatch(source, /from '[^']*\/modules\//, 'sync.ts imports a capability again');
  });
});
