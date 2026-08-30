/**
 * That every route file is actually plugged in.
 *
 * `auth.ts` was 41 endpoints across eight concerns and is five files now. The
 * split is worth having and it introduces one way to go wrong that one file did
 * not have: a `register…Routes` that nothing calls is a file that compiles,
 * imports cleanly, passes the typechecker, and serves 404 for everything in it.
 * No test would fail; the endpoints would simply be gone.
 *
 * So the registrations are checked against the files rather than trusted to a
 * convention. Comments are stripped first, because the failure this is for is a
 * call somebody commented out — the same lesson as `wiring.test.ts`, which
 * passed against exactly that before it stripped them.
 *
 * What this cannot check is that a route then answers correctly; `api.test.ts`
 * and the rest do that through the running server.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const root = new URL('../src', import.meta.url).pathname;
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/** The source with its comments taken out. See the note above. */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Every `routes/` file, wherever it is.
 *
 * There is no one `src/routes` any more: a module keeps its endpoints in its
 * own `routes/`, which is also how the layering rule is expressed now. So this
 * looks for the directory by name rather than by path, and a module that grows
 * one is covered without anybody remembering to come here.
 */
function routeSources(dir = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const here = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...routeSources(here));
    else if (entry.name.endsWith('.ts') && relative(root, join(root, dir)).split('/').includes('routes')) out.push(here);
  }
  return out;
}
const routeFiles = routeSources().sort();
const index = code('index.ts');

describe('every route file is registered', () => {
  it('finds a register function in each one', () => {
    for (const file of routeFiles) {
      assert.match(
        code(file),
        /^export function register\w*Routes\(/m,
        `${file} exports no register…Routes function — is it a route file at all?`,
      );
    }
  });

  it('and index.ts calls every one of them', () => {
    for (const file of routeFiles) {
      const name = code(file).match(/^export function (register\w*Routes)\(/m)![1];
      assert.match(
        index,
        new RegExp(`^${name}\\(router\\);`, 'm'),
        `${file} exports ${name} but index.ts never calls it, so none of its endpoints exist`,
      );
    }
  });

  it('and every endpoint in them is reachable at one path', () => {
    const seen = new Map<string, string>();
    for (const file of routeFiles) {
      for (const m of code(file).matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
        const key = `${m[1].toUpperCase()} ${m[2]}`;
        const first = seen.get(key);
        assert.equal(first, undefined, `${key} is registered in both ${first} and ${file}`);
        seen.set(key, file);
      }
    }
    // A floor rather than an exact count: this is here to catch a whole file
    // going missing, not to be edited every time somebody adds an endpoint.
    assert.ok(seen.size > 100, `only ${seen.size} routes found — a file is probably not being read`);
  });
});
