/**
 * Every menu in the app, and whether it fits.
 *
 * This exists because of a screenshot: three pictures of the *same* menu at
 * three scroll positions, with eight rows all called "Bug" and the commands
 * somewhere above the fold. Measured afterwards, the page's own menu was 39
 * rows with 1140px of it out of sight, and the task filter was 49 with 983px —
 * on a demo workspace of three projects. On a real one they are longer.
 *
 * What went wrong is not length as such: a menu was carrying two different
 * things. Commands — add a sub-page, archive, delete — and *values* out of
 * lists that grow with the workspace. The second kind now lives in drawers
 * (`MenuGroup`), and this holds the line: **a menu's top level fits.**
 *
 * Deliberately not a count. `CLAUDE.md` asks for named exceptions rather than
 * counted thresholds, and "no more than twenty rows" is exactly a budget
 * somebody spends — twenty-one rows is not the failure, a menu that hides half
 * of itself is. So the question asked here is the one the reader experiences:
 * does the thing that opened scroll? A drawer inside it may; a hundred labels
 * have to live somewhere.
 *
 * Run it against a seeded instance, like the other browser scripts:
 *   KOLIBRI_URL=http://localhost:4400 node scripts/menus.mjs
 */
import { chromium } from 'playwright';
import { walkable } from './walk.mjs';
import { crowd } from './crowd-fixture.mjs';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';

/*
 * A tall window on purpose.
 *
 * The cap on a menu is the room below the button, so a short window makes
 * every menu "too long" and a tall one forgives everything. 900px is the
 * ordinary laptop this app is used on, and the height `check:responsive` and
 * `check:a11y` already walk with — one answer about what "a window" is.
 */
const VIEWPORT = { width: 1400, height: 900 };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: VIEWPORT });
const page = await ctx.newPage();

const SCREENS = await walkable(page, base);

/*
 * And then make the workspace big enough for the question to mean anything.
 *
 * A seeded demo has three projects and four labels, which fit any menu — flat
 * or not — so this check against it would have been a green light for the very
 * shape that was reported. `crowd` builds the workspace the report came from.
 */
const built = await crowd(page, base);
console.log(`crowded to ${built.projects} projects and ${built.labels} labels (${built.made} new)\n`);

/**
 * What opens a menu: a button that says it has a popup.
 *
 * `aria-haspopup` rather than a class, because that is the promise the button
 * makes to a screen reader — a menu this cannot find is a menu a blind reader
 * cannot find either, which would be a second finding rather than a gap in
 * this one.
 */
const TRIGGERS = 'button[aria-haspopup="menu"]';

let failures = 0;
let checked = 0;

for (const [name, path, prepare] of SCREENS) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  // The first-run tour sits over everything until it is dismissed.
  await page.keyboard.press('Escape');
  if (prepare) await prepare(page);
  await page.waitForTimeout(400);

  const found = [];
  const total = await page.locator(TRIGGERS).count();
  for (let at = 0; at < total; at++) {
    const trigger = page.locator(TRIGGERS).nth(at);
    let label = '?';
    try {
      label = ((await trigger.getAttribute('aria-label', { timeout: 1200 }))
        || (await trigger.innerText({ timeout: 1200 })) || '?').replace(/\s+/g, ' ').trim().slice(0, 30);
      await trigger.click({ timeout: 1200 });
    } catch {
      // A trigger that cannot be clicked is behind something or gone from the
      // DOM since it was counted; neither is this check's finding to report.
      continue;
    }
    await page.waitForTimeout(220);

    const menu = page.locator('[role=menu]').first();
    if (await menu.count()) {
      const seen = await menu.evaluate((el) => ({
        rows: el.querySelectorAll('[role=menuitem]').length,
        over: el.scrollHeight - el.clientHeight,
        height: Math.round(el.getBoundingClientRect().height),
      }));
      checked += 1;
      if (seen.over > 2) {
        failures += 1;
        found.push(`${label}: ${seen.rows} rows, ${seen.over}px of it out of sight`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
  }

  if (found.length) {
    console.log(`FAIL ${name}`);
    for (const one of found) console.log(`       ${one}`);
  } else {
    console.log(`OK   ${name}`);
  }
}

await browser.close();

console.log('');
if (failures) {
  console.log(`${failures} menu(s) hide part of themselves.`);
  console.log('');
  console.log('A list that grows with the workspace belongs in a drawer — a `MenuGroup`');
  console.log('in `design-system/ui.tsx` — rather than poured into the menu in front of it.');
  process.exit(1);
}
console.log(`every one of ${checked} menus fits the window it opens in`);
