/**
 * The checks, checked.
 *
 * `modules.mjs`, `figures.mjs` and `openapi.mjs` are the only things standing
 * between this repository's architecture, its description of itself and the API
 * document clients are generated from. Nothing stood behind *them*: every rule
 * here was proved once, by breaking the tree by hand and watching the check
 * complain, and then the proof was thrown away. A regression in any of the
 * three — a regex that stops matching, a walk that returns nothing — would
 * leave every check passing and every table quietly wrong, which is precisely
 * the failure they exist to prevent.
 *
 * So each proof is a case here. A case copies the tree, breaks one thing in
 * the copy, runs the checker against the copy, and asserts it says so. The
 * copies are separate directories, so the cases cannot interfere and the real
 * tree is never touched — `--fix` inside a case rewrites the copy's documents.
 *
 * Two of the cases break the *script* rather than the tree, which is the point
 * of the file: sabotage the capability walk or the port scan and the generated
 * tables stop matching what they describe, so the check fails rather than
 * agreeing with itself.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A copy of everything the two checkers read, and nothing they do not.
 *
 * `data` is a running instance's database and `dist` is skipped by the walker
 * anyway: leaving them out is most of the bytes, and the cases run a few dozen
 * times. `test` is copied — `openapi.mjs` does not read it, but leaving a
 * directory out of a tree that claims to be a copy is how the last three
 * omissions were found, one failure at a time.
 */
const SKIP = /[/\\](node_modules|dist|data|public)([/\\]|$)/;
const SITES_SKIP = /[/\\](node_modules|dist|out|assets)([/\\]|$)/;

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'kolibri-checks-'));
  made.push(dir);
  // Every top-level document rather than a list of them: `figures.mjs` grew a
  // claim against `CLAUDE.md` and the named list did not, so ten cases failed
  // on a missing file instead of on what they were testing.
  const top = readdirSync(ROOT).filter((name) => name.endsWith('.md'));
  // `package.json` is in the list because `openapi.mjs` reads the version out of
  // it: a copy without it failed on ENOENT rather than on the break under test.
  for (const entry of ['scripts', 'docs', 'package.json', ...top]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  cpSync(join(ROOT, 'packages'), join(dir, 'packages'), { recursive: true, filter: (src) => !SKIP.test(src) });
  // `sites` is here for one file: `figures.mjs` grew a claim against
  // `sites/video/src/product.ts`, which is where the MCP tool count reaches a
  // marketing slide. Its own filter rather than `SKIP`, because the three sites
  // together are 540 MB of rendered video, screen captures and dependencies on
  // top of 1.9 MB of source, and these cases build the tree a few dozen times.
  cpSync(join(ROOT, 'sites'), join(dir, 'sites'), { recursive: true, filter: (src) => !SITES_SKIP.test(src) });
  // Linked rather than copied: `openapi.mjs` reads the tree with the TypeScript
  // compiler, so a copy that cannot resolve `typescript` fails on the import
  // instead of on the thing the case is about. A link costs nothing and lets
  // the copied scripts resolve exactly what the real ones do.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');

  const read = (file) => readFileSync(join(dir, file), 'utf8');
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  return {
    dir,
    read,
    write,
    /** Replace `from` with `to`, and fail loudly if the text has moved. */
    edit(file, from, to) {
      const text = read(file);
      assert.ok(text.includes(from), `${file} no longer contains:\n${from}`);
      write(file, text.replace(from, to));
    },
    /**
     * Put a different number inside a claim, without naming what it says today.
     *
     * A case that spells out "There are **18** capabilities" is itself a figure
     * in prose, and it rots exactly the way `figures.mjs` exists to stop prose
     * rotting: the eighteenth capability made five of these cases fail on the
     * literal rather than on the rule they were written for. So the words
     * around the number are the fixture and the number is *found* — the case
     * proves that a wrong figure is reported, which is a fact about the checker
     * rather than about this month's module count.
     *
     * `pattern` must capture the figure and nothing else; `wrong` is handed
     * what is there and returns something that is not.
     */
    restate(file, pattern, wrong) {
      const text = read(file);
      const found = text.match(pattern);
      assert.ok(found, `${file} no longer contains anything matching ${pattern}`);
      const [whole, was] = found;
      const now = wrong(was);
      assert.notEqual(now, was, `${pattern} was already ${was}`);
      write(file, text.replace(whole, whole.replace(was, now)));
      return { was, now };
    },
    prepend(file, text) {
      write(file, text + read(file));
    },
    /** The checker, against this copy. A non-zero exit is an answer, not a throw. */
    async run(script, ...args) {
      try {
        const { stdout, stderr } = await run('node', [join(dir, 'scripts', script), ...args], { cwd: dir });
        return { code: 0, out: `${stdout}${stderr}` };
      } catch (failed) {
        return { code: failed.code ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      }
    },
  };
}

/*
 * A figure that is not the one in the document, written the way that one was.
 *
 * `figures.mjs` reads a claim spelled or in digits, spaced over a thousand or
 * not, and writes the correction back in the same form. A case that broke a
 * spelled figure with digits would therefore be testing the wrong half of it.
 */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty'];
const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const otherNumeral = (was) => {
  const next = Number(was.replace(/\s/g, '')) + 1;
  return /\s/.test(was) ? spaced(next) : String(next);
};
const otherWord = (was) => {
  const at = WORDS.indexOf(was.toLowerCase());
  const next = WORDS[(at + 1) % WORDS.length];
  return was[0] === was[0].toUpperCase() ? next[0].toUpperCase() + next.slice(1) : next;
};

const STRAY = 'packages/server/src/stray.ts';
const S3 = 'packages/server/src/adapters/s3/backend.ts';

/*
 * One break each, and what the checker has to say about it. Every one of these
 * was run by hand when the rule it exercises was written; this is that same
 * run, kept.
 */
const BREAKS = [
  {
    what: 'a source file that belongs to no module',
    script: 'modules.mjs',
    break: (t) => t.write(STRAY, 'export const stray = 1;\n'),
    says: /unplaced: server\/src\/stray\.ts/,
  },
  {
    what: 'a module directory nothing describes',
    script: 'modules.mjs',
    break: (t) => t.write('packages/server/src/modules/telepathy/telepathy.ts', 'export const soon = 1;\n'),
    says: /undescribed: the telepathy directory exists but ABOUT says nothing about it/,
  },
  {
    what: 'a description for a module that is not there',
    script: 'modules.mjs',
    break: (t) => t.edit('scripts/modules.mjs', "const ABOUT = {\n", "const ABOUT = {\n  'telepathy': ['Reading the room.'],\n"),
    says: /stale description: ABOUT still describes telepathy/,
  },
  {
    what: 'shared reaching into server',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/shared/src/index.ts',
      "import { env as __probe } from '../../server/src/kernel/platform/env.ts';\nvoid __probe;\n"),
    says: /package boundary: shared\/src\/index\.ts -> server\/src\/kernel\/platform\/env\.ts/,
  },
  {
    what: 'something other than the shell importing a routes file',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/server/src/kernel/platform/http.ts',
      "import { registerAuthRoutes as __probe } from '../identity/routes/auth.ts';\nvoid __probe;\n"),
    says: /layering: server\/src\/kernel\/platform\/http\.ts -> server\/src\/kernel\/identity\/routes\/auth\.ts/,
  },
  {
    what: 'two files that can reach each other',
    script: 'modules.mjs',
    break: (t) => {
      t.prepend('packages/server/src/kernel/platform/ids.ts', "import { csp as __a } from './csp.ts';\nvoid __a;\n");
      t.prepend('packages/server/src/kernel/platform/csp.ts', "import { newId as __b } from './ids.ts';\nvoid __b;\n");
    },
    says: /import knot: server\/src\/kernel\/platform\/csp\.ts \+ server\/src\/kernel\/platform\/ids\.ts/,
  },
  {
    what: 'the kernel reaching for an adapter',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/server/src/kernel/platform/settings.ts',
      "import { headerSafe as __probe } from '../../adapters/mail/headers.ts';\nvoid __probe;\n"),
    says: /ring points outward: server\/src\/kernel\/platform\/settings\.ts -> server\/src\/adapters\/mail\/headers\.ts/,
  },
  {
    what: 'two capabilities that lean on each other',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/web/src/modules/planning/gantt.tsx',
      "import { HORIZON_DAYS as __probe } from '../work/overview';\nvoid __probe;\n"),
    says: /module cycle: capability\/planning <-> capability\/work/,
  },
  {
    what: 'a cycle between two kernel modules, which rule 6 used not to look for',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/server/src/kernel/i18n/i18n.ts',
      "import { registerBackend as __probe } from '../files/storage.ts';\nvoid __probe;\n"),
    says: /module cycle: kernel\/files <-> kernel\/i18n/,
  },
  {
    what: 'a port nothing fills any more',
    script: 'modules.mjs',
    break: (t) => {
      t.edit(S3, "import { registerBackend, type Backend } from '../../kernel/files/storage.ts';",
        "import { type Backend } from '../../kernel/files/storage.ts';");
      t.edit(S3, "export const installS3Storage = (): void => registerBackend('s3', backend);",
        'export const installS3Storage = (): void => undefined;');
    },
    says: /port nobody fills: kernel\/files offers `registerBackend`/,
  },
  {
    what: 'a port filled from its own ring, where a direct import would have been legal',
    script: 'modules.mjs',
    break: (t) => t.prepend('packages/server/src/kernel/identity/auth.ts',
      "import { registerBackend as __probe } from '../files/storage.ts';\nvoid __probe;\n"),
    says: /port filled from the wrong side: kernel\/files's `registerBackend` is filled by kernel\/identity/,
  },
  {
    what: 'a @port tag on something that is not an exported function',
    script: 'modules.mjs',
    break: (t) => t.edit('packages/server/src/kernel/files/storage.ts',
      "const backends = new Map<StorageKind, Backend>([['disk', disk]]);",
      "/** @port a place to put bytes, on the wrong thing */\nconst backends = new Map<StorageKind, Backend>([['disk', disk]]);"),
    says: /storage\.ts: 2 `@port` tags, 1 of them on an exported function/,
  },
  {
    what: 'a hand-edited cell in the document’s generated tables',
    script: 'modules.mjs',
    break: (t) => t.edit('docs/modules.md', '| `chat` | — | — |', '| `chat` | `work` | — |'),
    says: /docs\/modules\.md: the module tables are out of date/,
  },
  {
    what: 'a hand-edited cell in the page’s generated blocks',
    script: 'modules.mjs',
    break: (t) => t.edit('docs/module-map.html', '<span class="k">source files</span>',
      '<span class="k">source documents</span>'),
    says: /docs\/module-map\.html: the generated blocks are out of date/,
  },
  {
    what: 'a marker deleted from the page',
    script: 'modules.mjs',
    break: (t) => t.edit('docs/module-map.html', '<!-- generated: legend -->', ''),
    says: /docs\/module-map\.html: no `<!-- generated: legend -->` marker/,
  },
  {
    what: 'the capability walk sabotaged, so the tables describe nothing',
    script: 'modules.mjs',
    break: (t) => t.edit('scripts/modules.mjs', 'function moduleUses(ring) {',
      'function moduleUses(ring) {\n  if (ring === "capability") return new Map();'),
    says: /the module tables are out of date/,
  },
  {
    what: 'the port scan sabotaged, so the ports table empties',
    script: 'modules.mjs',
    break: (t) => t.edit('scripts/modules.mjs', 'function ports() {\n  const found = [];',
      'function ports() {\n  const found = [];\n  if (sources.length) return found;'),
    says: /the module tables are out of date/,
  },
  {
    what: 'a figure that no longer matches what it counts',
    script: 'figures.mjs',
    break: (t) => t.restate('docs/modules.md', /There are \*\*(\d+)\*\* capabilities/, otherNumeral),
    says: ({ was, now }) => new RegExp(`STALE +docs/modules\\.md: capabilities — says ${now}, is ${was}`),
  },
  {
    what: 'a spelled figure at the start of a sentence',
    script: 'figures.mjs',
    break: (t) => t.restate('docs/modules.md', /([A-Z][a-z]+) imports across/, otherWord),
    says: ({ was, now }) =>
      new RegExp(`imports from one capability to another — says ${now}, is ${was}`),
  },
  {
    what: 'a figure written with the thousands separator',
    script: 'figures.mjs',
    break: (t) => t.restate('docs/modules.md', /Of the \*\*(\d{1,3}(?: \d{3})+)\*\* ways/, otherNumeral),
    says: ({ was, now }) => new RegExp(`says ${now}, is ${was}`),
  },
  {
    what: 'a "remaining" note whose count has quietly grown',
    script: 'figures.mjs',
    break: (t) => {
      const said = Number(t.read('docs/modules.md').match(/\*\*(\d+)\*\* `if \(entity === …\)` branches are left/)[1]);
      t.edit('packages/server/src/adapters/webhooks/effects.ts',
        "  if (entity === 'budget') {",
        "  if (entity === 'label') { void 0; }\n  if (entity === 'budget') {");
      return { was: said, now: said + 1 };
    },
    says: ({ was, now }) => new RegExp(`branches left in the three effects — says ${was}, is ${now}`),
  },
  {
    what: 'a "remaining" note about files, when a file joins them',
    script: 'figures.mjs',
    break: (t) => {
      const said = Number(t.read('docs/modules.md').match(/The \*\*(\d+)\*\* files sit under the adapter/)[1]);
      t.write('packages/server/src/adapters/mcp/tools/telepathy.ts', 'export const TOOLS = [];\n');
      return { was: said, now: said + 1 };
    },
    says: ({ was, now }) =>
      new RegExp(`MCP tool files still under the adapter — says ${was}, is ${now}`),
  },
  {
    what: 'a figure that reached a rendered slide and was left behind',
    script: 'figures.mjs',
    break: (t) => t.restate('sites/video/src/product.ts', /count: (\d+), prompts/, otherNumeral),
    says: ({ was, now }) =>
      new RegExp(`STALE +sites/video/src/product\\.ts: MCP tools — says ${now}, is ${was}`),
  },
  {
    what: 'a bolded number that is neither claimed nor recorded',
    script: 'figures.mjs',
    break: (t) => t.edit('docs/modules.md', '## The rules, and who enforces them',
      'The tree has **4711** corners.\n\n## The rules, and who enforces them'),
    says: /UNMARKED docs\/modules\.md:\d+: \*\*4711\*\* is neither checked nor recorded as history/,
  },
  {
    what: 'a route added and the API document not regenerated',
    script: 'openapi.mjs',
    break: (t) => t.edit('packages/server/src/kernel/search/routes/search.ts',
      'export function registerSearchRoutes(router: Router): void {',
      "export function registerSearchRoutes(router: Router): void {\n  router.get('/api/telepathy', () => ({ read: 'your mind' }));"),
    says: /docs\/openapi\.json no longer matches the tree/,
  },
  {
    what: 'a field added to an entity and the API document not regenerated',
    script: 'openapi.mjs',
    break: (t) => t.edit('packages/shared/src/kernel/registry/types.ts',
      'export interface Mailbox extends Base {', 'export interface Mailbox extends Base {\n  hunch: string;'),
    says: /docs\/openapi\.json no longer matches the tree/,
  },
  {
    what: 'a route whose path is built rather than written, which cannot be documented',
    script: 'openapi.mjs',
    break: (t) => t.edit('packages/server/src/kernel/search/routes/search.ts',
      'export function registerSearchRoutes(router: Router): void {',
      "export function registerSearchRoutes(router: Router): void {\n  const where = '/api/guess';\n  router.get(where, () => ({}));"),
    says: /router\.get\(\) with a path this cannot read: where/,
  },
  {
    what: 'two routes that would generate the same client method name',
    script: 'openapi.mjs',
    break: (t) => t.edit('packages/server/src/kernel/search/routes/search.ts',
      'export function registerSearchRoutes(router: Router): void {',
      // An *interior* parameter is dropped from the name, so these two are
      // `getSearchNear` twice. Two trailing parameters would not collide — the
      // first version of this case used those and proved nothing.
      "export function registerSearchRoutes(router: Router): void {\n  router.get('/api/search/:q/near', () => ({}));\n  router.get('/api/search/near', () => ({}));"),
    says: /two routes want the operationId getSearchNear/,
  },
];

describe('the checks catch what they were written to catch', { concurrency: 8 }, () => {
  for (const broken of BREAKS) {
    it(broken.what, async () => {
      const t = tree();
      // What the break did, for a case whose message quotes the figure it
      // found rather than one typed here. See `restate`.
      const found = broken.break(t);
      const { code, out } = await t.run(broken.script);
      assert.match(out, typeof broken.says === 'function' ? broken.says(found) : broken.says);
      assert.equal(code, 1, `${broken.script} reported it and then exited 0:\n${out}`);
    });
  }
});

describe('and pass on a tree with nothing wrong with it', { concurrency: 2 }, () => {
  it('modules.mjs', async () => {
    const { code, out } = await tree().run('modules.mjs');
    assert.equal(code, 0, out);
    assert.match(out, /rules hold \(0 layering, 0 knot and 0 ring exceptions, all named\)/);
  });

  it('figures.mjs', async () => {
    const { code, out } = await tree().run('figures.mjs');
    assert.equal(code, 0, out);
    assert.match(out, /figures across \d+ files, all matching what they count/);
  });
});

describe('--fix writes back what was there, in the form it was in', { concurrency: 4 }, () => {
  const restores = [
    ['a plain numeral', /There are \*\*(\d+)\*\* capabilities/, otherNumeral],
    ['a spelled figure that starts a sentence', /([A-Z][a-z]+) imports across/, otherWord],
    ['a figure with a thousands separator', /Of the \*\*(\d{1,3}(?: \d{3})+)\*\* ways/, otherNumeral],
    ['a figure written as a word mid-sentence', /imports across ([a-z]+) module pairs/, otherWord],
  ];
  for (const [what, pattern, wrong] of restores) {
    it(what, async () => {
      const t = tree();
      const before = t.read('docs/modules.md');
      t.restate('docs/modules.md', pattern, wrong);
      assert.equal((await t.run('figures.mjs')).code, 1, 'the wrong figure was not reported');
      await t.run('figures.mjs', '--fix');
      assert.equal(t.read('docs/modules.md'), before, 'the document did not come back byte for byte');
    });
  }
});

describe('and stay useful when something else is broken', { concurrency: 2 }, () => {
  it('reflowing a paragraph does not raise a false alarm', async () => {
    const t = tree();
    // The sentence as it stands, rewrapped rather than retyped: the two figures
    // in it are counted, so naming them here would make this case go stale
    // every time a capability lands. What is under test is the line break.
    const sentence = t.read('docs/modules.md').match(/There are \*\*\d+\*\* capabilities and \*\*\d+\*\* edges\nbetween them\./);
    assert.ok(sentence, 'the sentence this case rewraps has moved');
    t.edit('docs/modules.md', sentence[0],
      sentence[0].replace(/ /g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, ' ')
        .replace('capabilities', '\ncapabilities').replace('edges', '\nedges'));
    const { code, out } = await t.run('figures.mjs');
    assert.equal(code, 0, out);
  });

  it('figures.mjs still reports figures when modules.mjs is failing its own rules', async () => {
    const t = tree();
    t.write(STRAY, 'export const stray = 1;\n');
    assert.equal((await t.run('modules.mjs')).code, 1, 'the stray file was supposed to break modules.mjs');
    const { out } = await t.run('figures.mjs');
    assert.doesNotMatch(out, /modules\.mjs printed no module graph/);
    assert.match(out, /figures across \d+ files|STALE/);
  });
});
