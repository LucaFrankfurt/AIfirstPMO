/**
 * The checks, checked.
 *
 * `modules.mjs` and `figures.mjs` are the only things standing between this
 * repository's architecture and its description of itself. Nothing stood
 * behind *them*: every rule here was proved once, by breaking the tree by hand
 * and watching the check complain, and then the proof was thrown away. A
 * regression in either script — a regex that stops matching, a walk that
 * returns nothing — would leave every check passing and every table quietly
 * wrong, which is precisely the failure both scripts exist to prevent.
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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * `data` is a running instance's database, `test` and `dist` are skipped by the
 * walker anyway: leaving all three out is most of the bytes, and the cases run
 * a few dozen times.
 */
const SKIP = /[/\\](node_modules|dist|data|public|test)([/\\]|$)/;

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'kolibri-checks-'));
  made.push(dir);
  for (const entry of ['scripts', 'docs', 'README.md', 'TODO.md']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  cpSync(join(ROOT, 'packages'), join(dir, 'packages'), { recursive: true, filter: (src) => !SKIP.test(src) });

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
    break: (t) => t.edit('docs/modules.md', 'There are **16** capabilities', 'There are **14** capabilities'),
    says: /STALE +docs\/modules\.md: capabilities — says 14, is 16/,
  },
  {
    what: 'a spelled figure at the start of a sentence',
    script: 'figures.mjs',
    break: (t) => t.edit('docs/modules.md', 'Seventeen imports across', 'Twelve imports across'),
    says: /imports from one capability to another — says Twelve, is Seventeen/,
  },
  {
    what: 'a figure written with the thousands separator',
    script: 'figures.mjs',
    break: (t) => t.edit('docs/modules.md', 'Of the **3 606** ways', 'Of the **3 607** ways'),
    says: /says 3 607, is 3 606/,
  },
  {
    what: 'a bolded number that is neither claimed nor recorded',
    script: 'figures.mjs',
    break: (t) => t.edit('docs/modules.md', '## The rules, and who enforces them',
      'The tree has **4711** corners.\n\n## The rules, and who enforces them'),
    says: /UNMARKED docs\/modules\.md:\d+: \*\*4711\*\* is neither checked nor recorded as history/,
  },
];

describe('the checks catch what they were written to catch', { concurrency: 8 }, () => {
  for (const broken of BREAKS) {
    it(broken.what, async () => {
      const t = tree();
      broken.break(t);
      const { code, out } = await t.run(broken.script);
      assert.match(out, broken.says);
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
    ['a plain numeral', 'There are **16** capabilities', 'There are **12** capabilities'],
    ['a spelled figure that starts a sentence', 'Seventeen imports across', 'Twelve imports across'],
    ['a figure with a thousands separator', 'Of the **3 606** ways', 'Of the **3 999** ways'],
    ['a figure written as a word mid-sentence', 'imports across fifteen module pairs', 'imports across nine module pairs'],
  ];
  for (const [what, right, wrong] of restores) {
    it(what, async () => {
      const t = tree();
      const before = t.read('docs/modules.md');
      t.edit('docs/modules.md', right, wrong);
      assert.equal((await t.run('figures.mjs')).code, 1, 'the wrong figure was not reported');
      await t.run('figures.mjs', '--fix');
      assert.equal(t.read('docs/modules.md'), before, 'the document did not come back byte for byte');
    });
  }
});

describe('and stay useful when something else is broken', { concurrency: 2 }, () => {
  it('reflowing a paragraph does not raise a false alarm', async () => {
    const t = tree();
    t.edit('docs/modules.md',
      'There are **16** capabilities and **15** edges\nbetween them.',
      'There are **16**\ncapabilities and **15**\nedges between them.');
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
