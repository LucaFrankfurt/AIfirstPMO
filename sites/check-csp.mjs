/**
 * Nothing the page needs is blocked by its own Content-Security-Policy.
 *
 * A policy that is too strict does not fail loudly. The one that shipped here
 * blocked two of Starlight's inline scripts, and the whole visible symptom was
 * that the `Ctrl K` chip on the search button never appeared — with the reason
 * in a console nobody had open. That is exactly the class of bug a test exists
 * for: real, small, and invisible to anybody not looking for it.
 *
 * So this walks the built site in a browser, listens for
 * `securitypolicyviolation`, and exercises the parts that only run when
 * somebody presses something — the search box, the copy button — because a
 * policy that is fine on load and wrong on click is the common case.
 *
 *   node sites/check-csp.mjs sites/docs http://127.0.0.1:4300
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const site = resolve(process.argv[2] ?? '.');
const origin = (process.argv[3] ?? 'http://127.0.0.1:4300').replace(/\/$/, '');
const dist = join(site, 'dist');

const pages = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.html')) pages.push(path);
  }
})(dist);

/* A sample of routes rather than all of them: the policy is generated per
   page from the same components, so the interesting variety is one of each
   *kind* of page, not forty of the same kind. The first is always the home
   page, which is the one carrying the search box. */
const routes = [
  '/',
  ...pages
    .map((f) => f.slice(dist.length).replace(/\/index\.html$/, '/'))
    .filter((r) => r !== '/' && !r.endsWith('404.html'))
    .slice(0, 6),
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failures = 0;

for (const theme of ['light', 'dark']) {
  for (const route of routes) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript((value) => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__violations.push(
          `${event.violatedDirective} ${event.blockedURI}${event.sample ? ` — ${event.sample.slice(0, 60)}` : ''}`,
        );
      });
      try {
        localStorage.setItem('kolibri-theme', value);
        localStorage.setItem('starlight-theme', value);
      } catch {
        /* Blocked site data still gets the load-time check below. */
      }
    }, theme);

    await page.goto(origin + route, { waitUntil: 'networkidle' });

    // The things that only run when somebody presses them. Each is optional:
    // the demo site has no search box and the docs site has no copy button.
    if (await page.locator('button[data-open-modal]').count()) {
      await page.click('button[data-open-modal]');
      await page.waitForTimeout(400);
      await page.fill('.pagefind-ui__search-input', 'cycle').catch(() => {});
      await page.waitForTimeout(2000);
    }
    if (await page.locator('[data-copy]').count()) {
      await page.click('[data-copy]');
      await page.waitForTimeout(300);
    }
    if (await page.locator('#theme').count()) {
      await page.click('#theme');
      await page.waitForTimeout(200);
    }

    const violations = await page.evaluate(() => window.__violations ?? []);
    for (const violation of new Set(violations)) {
      failures++;
      console.log(`  ✗ ${theme} ${route} — ${violation}`);
    }
    await page.close();
  }
}

/* One assertion that is not about violations: the search shortcut hint. It is
   un-hidden by an inline script, so it is the thing that goes quiet first when
   the policy is wrong, and a violation-free page that still hides it would
   mean the script was dropped rather than blocked. */
if (basename(site) === 'docs') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const visible = await page.locator('button[data-open-modal] kbd').first().isVisible();
  if (!visible) {
    failures++;
    console.log('  ✗ the search button’s shortcut hint is hidden — its inline script did not run');
  }
  await page.close();
}

await browser.close();
console.log(
  failures
    ? `\n${failures} thing(s) the policy blocks that the page needs.`
    : `${routes.length} route(s) × 2 themes: the policy blocks nothing the page needs.`,
);
process.exit(failures ? 1 : 0);
