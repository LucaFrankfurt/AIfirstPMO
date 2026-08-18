/**
 * The catalogues are only useful if they stay in step. TypeScript already
 * enforces that every locale has every key — these tests cover what the type
 * system cannot see: placeholders that were dropped in translation, plural
 * forms that exist on one side only, and strings the interface still hard-codes.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-i18n-${process.pid}`;

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const webSrc = join(root, 'packages/web/src');

after(() => rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true }));

/** Read a catalogue as data rather than importing it: no JSX, no React. */
function readCatalogue(file: string): Map<string, string> {
  const source = readFileSync(file, 'utf8');
  const entries = new Map<string, string>();
  // 'key': 'value', — values may contain escaped quotes but never a raw newline.
  const pattern = /^\s*'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',$/gm;
  for (const match of source.matchAll(pattern)) {
    entries.set(match[1], match[2].replace(/\\'/g, "'"));
  }
  return entries;
}

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('web catalogues', () => {
  const en = readCatalogue(join(webSrc, 'locales/en.ts'));
  const de = readCatalogue(join(webSrc, 'locales/de.ts'));

  it('parses both catalogues', () => {
    assert.ok(en.size > 300, `expected a full English catalogue, got ${en.size} keys`);
    assert.equal(de.size, en.size);
  });

  it('has the same keys in both directions', () => {
    const missingInDe = [...en.keys()].filter((key) => !de.has(key));
    const extraInDe = [...de.keys()].filter((key) => !en.has(key));
    assert.deepEqual(missingInDe, [], 'keys missing from de.ts');
    assert.deepEqual(extraInDe, [], 'keys in de.ts that English does not have');
  });

  it('keeps every placeholder in the translation', () => {
    const broken: string[] = [];
    for (const [key, value] of en) {
      const translated = de.get(key)!;
      if (placeholders(value).join() !== placeholders(translated).join()) {
        broken.push(`${key}: "${value}" vs "${translated}"`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it('keeps plural forms complete', () => {
    for (const catalogue of [en, de]) {
      for (const key of catalogue.keys()) {
        if (key.endsWith('_one')) assert.ok(catalogue.has(`${key.slice(0, -4)}_other`), `${key} has no _other`);
        if (key.endsWith('_other')) assert.ok(catalogue.has(`${key.slice(0, -6)}_one`), `${key} has no _one`);
      }
    }
  });

  it('translates every key that is actually used', () => {
    const used = new Set<string>();
    for (const file of walk(webSrc)) {
      if (file.includes('/locales/')) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(match[1]);
    }
    const unknown = [...used].filter((key) => !en.has(key) && !en.has(`${key}_other`));
    assert.deepEqual(unknown, [], 'keys used in the interface but missing from the catalogue');
  });

  it('leaves no user-visible string hard-coded in the interface', () => {
    // A sentence in a JSX attribute that renders as text, or bare prose between
    // tags, means a screen that stays English no matter what the user picked.
    const offenders: string[] = [];
    const attribute = /\s(?:title|placeholder|aria-label|hint|empty|label)="([A-Z][^"]{2,})"/g;
    const prose = />\s*([A-Z][a-z]+(?:\s+[A-Za-z]+){1,})\s*</g;

    for (const file of walk(webSrc)) {
      if (file.includes('/locales/')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(attribute)) offenders.push(`${relative(root, file)}: ${match[0].trim()}`);
      for (const match of source.matchAll(prose)) offenders.push(`${relative(root, file)}: >${match[1]}<`);
    }
    assert.deepEqual(offenders, []);
  });
});

describe('server catalogue', () => {
  it('keeps the locales in step', async () => {
    const { LOCALES, translate } = await import('../src/lib/i18n.ts');
    const keys = Object.keys(LOCALES.en);
    for (const [name, catalogue] of Object.entries(LOCALES)) {
      assert.deepEqual(Object.keys(catalogue), keys, `${name} has different keys`);
      for (const key of keys) {
        assert.deepEqual(
          placeholders((LOCALES.en as Record<string, string>)[key]),
          placeholders((catalogue as Record<string, string>)[key]),
          `${name}.${key} lost a placeholder`,
        );
      }
    }
    assert.equal(
      translate('de', 'notify.assigned', { identifier: 'WEB-1', title: 'Ship it' }),
      'Zugewiesen: WEB-1 Ship it',
    );
  });

  it('falls back rather than showing a key', async () => {
    const { translate } = await import('../src/lib/i18n.ts');
    // An unknown locale is not reachable through the API, but a stale database
    // row could still carry one — it must not surface as raw key text.
    assert.equal(translate('fr' as 'en', 'mail.openKolibri'), 'Open Kolibri');
  });
});
