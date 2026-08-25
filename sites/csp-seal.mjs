/**
 * Hash the inline scripts and styles Astro's CSP pass missed.
 *
 * `security.csp` hashes the inline code Astro itself emits, which is nearly
 * all of it — but not quite. Starlight ships two plain `<script>` elements
 * that come out unhashed, and the visible result was small and quiet: the
 * `Ctrl K` chip on the search button stayed hidden, because the one line that
 * un-hides it never ran. Nothing errored where anybody was looking.
 *
 * So this walks the built HTML afterwards and, for every inline `<script>` and
 * `<style>` still without a matching hash, adds one. Everything in `dist` came
 * out of the build, so hashing it is exactly what Astro would have done; a
 * script *injected* later still has no hash and still does not run, which is
 * the whole point of the policy.
 *
 * Doing it here rather than by pasting two hashes into the config is
 * deliberate: pasted hashes are correct until the next Starlight release
 * changes a line of that script, and then they are wrong in the same quiet
 * way.
 *
 *   node sites/csp-seal.mjs docs/dist
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.html')) files.push(path);
  }
})(dist);

const META = /(<meta http-equiv="content-security-policy" content=")([^"]*)(")/i;
/* Inline only: an element with a `src` loads from an origin `script-src 'self'`
   already decides on, and has no body to hash. */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
const INLINE_STYLE = /<style(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/style>/gi;

/** The hash of an element's exact body, which is what a browser compares. */
const sha256 = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

let sealed = 0;
let touched = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const meta = html.match(META);
  if (!meta) continue;

  let policy = meta[2];
  const added = [];

  const add = (directive, hash) => {
    if (policy.includes(hash)) return;
    // `decodeURIComponent`-free string work: the policy is plain ASCII here.
    const pattern = new RegExp(`(${directive}\\s)([^;]*)`, 'i');
    if (!pattern.test(policy)) return;
    policy = policy.replace(pattern, (_, head, rest) => `${head}${rest.trim()} ${hash}`);
    added.push(hash);
  };

  for (const [, , body] of html.matchAll(INLINE_SCRIPT)) {
    if (body.trim()) add('script-src', sha256(body));
  }
  for (const [, , body] of html.matchAll(INLINE_STYLE)) {
    // A policy that already allows every inline style has nothing to gain from
    // a hash, and CSP ignores hashes beside `'unsafe-inline'` anyway.
    if (body.trim() && !/style-src[^;]*'unsafe-inline'/i.test(policy)) add('style-src', sha256(body));
  }

  if (!added.length) continue;
  writeFileSync(file, html.replace(META, `$1${policy}$3`));
  sealed += added.length;
  touched++;
}

console.log(
  files.length === 0
    ? `No HTML under ${dist}`
    : `csp-seal: ${sealed} hash(es) added across ${touched} of ${files.length} pages`,
);
