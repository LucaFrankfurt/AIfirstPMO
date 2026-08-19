/**
 * Extensionless imports, for Node.
 *
 * The web sources are written for a bundler, so they import `./store` rather
 * than `./store.ts`. Node's ESM resolver needs the extension. Rather than
 * rewrite two hundred imports to suit the test runner, the test runner is
 * taught the one rule the bundler already follows.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '/index.ts'];

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const extension of CANDIDATES) {
      const candidate = new URL(base.href + extension);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}
