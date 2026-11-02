// Two fix-ups after `tsc` has written dist/esm and dist/cjs.
//
// 1. The package root says "type": "module", so Node would read dist/cjs/*.js as ESM.
//    A one-line package.json scopes dist/cjs back to CommonJS — the standard way to
//    ship both formats from one source tree without renaming files to .cjs.
//
// 2. The sources import with `.ts`, like the rest of this repository, and
//    rewriteRelativeImportExtensions turns those into `.js` in the emitted JavaScript —
//    but not in the emitted declarations. A consumer's TypeScript would then meet
//    `from './types.ts'` in a .d.ts, which it refuses unless it allows importing .ts
//    extensions itself. So relative specifiers in every .d.ts are rewritten the same way.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;

writeFileSync(join(dist, 'cjs', 'package.json'), '{ "type": "commonjs" }\n');

const RELATIVE_TS = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)\.tsx?(['"])/g;
let rewritten = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.d.ts')) {
      const text = readFileSync(full, 'utf8');
      const next = text.replace(RELATIVE_TS, '$1$2.js$3');
      if (next !== text) {
        writeFileSync(full, next);
        rewritten++;
      }
    }
  }
})(dist);
console.log(`postbuild: dist/cjs marked CommonJS; ${rewritten} declaration file(s) rewritten to .js specifiers`);
