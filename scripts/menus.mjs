/**
 * Every menu in the app, every drawer in it, and whether any of it fits.
 *
 * This exists because of a screenshot: three pictures of the *same* menu at
 * three scroll positions, with eight rows all called "Bug" and the commands
 * somewhere above the fold. What went wrong is not length as such — a menu was
 * carrying two different things. Commands — add a sub-page, archive, delete —
 * and *values* out of lists that grow with the workspace. The second kind
 * lives in drawers (`MenuGroup`), and this holds the line.
 *
 * Then a second screenshot arrived, of the fixed menu on a phone, with a
 * drawer's search box cut in half by the left edge of the glass. This check
 * had certified that build, and the reason it could is worth more than the
 * bug: **it only ever asked the easy question.** One window, 1400×900, where
 * everything fits; and it never opened a drawer, so the one thing the change
 * had introduced was the one thing it did not look at. Measured afterwards,
 * all nineteen drawers in the app opened outside a 390px window, between 35px
 * and 147px past its left edge. Nineteen out of nineteen, under a green check.
 *
 * So it now walks two windows and opens everything:
 *
 *   - **the top level fits**, where a menu hangs off its button. This is the
 *     original rule, and deliberately not a count: `CLAUDE.md` asks for named
 *     exceptions rather than counted thresholds, and "no more than twenty
 *     rows" is exactly a budget somebody spends. Twenty-one rows is not the
 *     failure; a menu that hides half of itself is.
 *   - **nothing is outside the window** — not the menu, not a drawer. This is
 *     the rule the phone needed, and the one no amount of re-positioning can
 *     satisfy when a menu and a drawer cannot fit side by side at all.
 *
 * A sheet is allowed to scroll, and only a sheet. On a phone eighteen commands
 * cannot be shown at once by any arrangement, and a sheet standing on the
 * bottom edge at full width is a thing people scroll without being told. A
 * dropdown that scrolls is the original bug.
 *
 * Run it against a seeded instance, like the other browser scripts:
 *   KOLIBRI_URL=http://localhost:4400 node scripts/menus.mjs
 */
import { chromium } from 'playwright';
import { walkable } from './walk.mjs';
import { crowd } from './crowd-fixture.mjs';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';

/*
 * Two windows, because one of them was the whole gap.
 *
 * 1400×900 is the ordinary laptop, and the height `check:responsive` and
 * `check:a11y` already walk with. 390×844 is a phone — the size the report
 * came from, and the size at which "open it beside" stops being possible
 * rather than merely tight.
 */
const WINDOWS = [
  { name: 'laptop', width: 1400, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/**
 * What opens a menu: a button that says it has a popup.
 *
 * `aria-haspopup` rather than a class, because that is the promise the button
 * makes to a screen reader — a menu this cannot find is a menu a blind reader
 * cannot find either, which would be a second finding rather than a gap in
 * this one.
 */
const TRIGGERS = 'button[aria-haspopup="menu"]';

/**
 * What opens a drawer, in both of the shapes a drawer has.
 *
 * On a laptop it is a Radix sub-trigger and opens beside; on a phone it is an
 * ordinary row and opens into the menu. `data-drawer` is on both, put there so
 * this check cannot quietly go back to seeing only the desktop one — which is
 * the exact shape of the miss that let the phone bug ship.
 */
const DRAWERS = '[data-drawer]';

/**
 * A menu that is *open*, rather than one that happens to be in the document.
 *
 * `[role=menu]` alone was the bug underneath a bug. A menu Radix is animating
 * shut is still in the DOM for the length of its exit, and it is portalled
 * earlier than the one that replaced it — so `[role=menu]` taken in document
 * order hands back the pane that is leaving. Its rows are the old drawer's,
 * which carry no `data-drawer`, so the next drawer is simply not there and the
 * click waits out its timeout.
 *
 * On a laptop this costs nothing while the machine is quick enough that the
 * exit has finished before the next look. On a CI runner it does not: seven
 * drawers across three screens went unopened, and before the shortfall was
 * made a finding they went unopened *silently*. Reproduced here by throttling
 * the browser's CPU eightfold, which turns it from a thing that happens on
 * somebody else's machine into a thing that happens on this one.
 *
 * `data-state` is Radix's own answer to the question, and the same attribute
 * the stylesheet animates on.
 */
const OPEN_MENU = '[role=menu][data-state=open]';

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
/*
 * Signed in wide, then narrowed.
 *
 * `walkable` waits for the sidebar, which a phone does not show — signing in
 * at 390px simply times out. The app is a single page, so the resize is the
 * phone as far as everything after it is concerned.
 */
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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

/** Everything the browser can tell us about an open menu, in one round trip. */
const read = (pane) => pane.evaluate((el) => {
  const box = el.getBoundingClientRect();
  return {
    rows: el.querySelectorAll('[role=menuitem]').length,
    over: el.scrollHeight - el.clientHeight,
    sheet: el.classList.contains('menu-sheet'),
    outLeft: Math.round(Math.max(0, -box.left)),
    outRight: Math.round(Math.max(0, box.right - innerWidth)),
    outTop: Math.round(Math.max(0, -box.top)),
    outBottom: Math.round(Math.max(0, box.bottom - innerHeight)),
  };
});

/**
 * What is wrong with it, in the words the reader would use.
 *
 * Two things may scroll and one may not. A **drawer** may: a hundred labels
 * have to live somewhere, and that was the point of putting them in one. A
 * **sheet** may: on a phone eighteen commands cannot be shown at once by any
 * arrangement, and a sheet at full width on the bottom edge is a thing people
 * scroll without being told. A **menu hanging off its button** may not — that
 * one is the original bug, 195 rows in a box eleven rows tall.
 *
 * Standing outside the window is nobody's licence. That one is always a fault.
 */
function faults(seen, kind) {
  const out = [];
  const outside = [
    seen.outLeft && `${seen.outLeft}px past the left edge`,
    seen.outRight && `${seen.outRight}px past the right edge`,
    seen.outTop && `${seen.outTop}px above the window`,
    seen.outBottom && `${seen.outBottom}px below the window`,
  ].filter(Boolean);
  if (outside.length) out.push(outside.join(', '));
  const mayScroll = kind === 'drawer' || seen.sheet;
  if (!mayScroll && seen.over > 2) out.push(`${seen.rows} rows, ${seen.over}px of it out of sight`);
  return out;
}

/** Escape as often as there are levels to leave, so the next menu starts clean. */
async function shut(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }
}

let failures = 0;
let menus = 0;
let drawers = 0;
/* Every drawer this walk *should* have opened, so a count that quietly comes
   out short is visible beside the one that did. */
let expected = 0;

for (const window of WINDOWS) {
  await page.setViewportSize({ width: window.width, height: window.height });
  console.log(`— ${window.name} (${window.width}×${window.height}) —`);

  for (const [name, path, prepare] of SCREENS) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    // The first-run tour sits over everything until it is dismissed.
    await page.keyboard.press('Escape');
    if (prepare) await prepare(page);
    await page.waitForTimeout(400);

    const found = [];
    const total = await page.locator(TRIGGERS).count();

    for (let at = 0; at < total; at++) {
      const open = async () => {
        const trigger = page.locator(TRIGGERS).nth(at);
        try {
          await trigger.click({ timeout: 1200 });
        } catch {
          // A trigger that cannot be clicked is behind something or gone from
          // the DOM since it was counted; neither is this check's finding.
          return null;
        }
        await page.waitForTimeout(200);
        const pane = page.locator(OPEN_MENU).first();
        return (await pane.count()) ? pane : null;
      };

      let pane = await open();
      if (!pane) continue;

      /*
       * The button's name is read only when there is something to report.
       *
       * It is two round trips to the browser, and at 310 menus across 29
       * screens on two windows that is most of the run — paid on every menu to
       * be used on almost none. A check nobody waits for is a check that gets
       * taken out of CI.
       */
      const name = async () => {
        try {
          const trigger = page.locator(TRIGGERS).nth(at);
          return ((await trigger.getAttribute('aria-label', { timeout: 1000 }))
            || (await trigger.innerText({ timeout: 1000 })) || '?').replace(/\s+/g, ' ').trim().slice(0, 30);
        } catch {
          // The name is for the report; its absence is not the finding.
          return '?';
        }
      };

      menus += 1;
      const wrong = faults(await read(pane), 'menu');
      if (wrong.length) {
        const label = await name();
        for (const fault of wrong) {
          failures += 1;
          found.push(`${label}: ${fault}`);
        }
      }

      const inside = await pane.locator(DRAWERS).count();
      expected += inside;

      /*
       * One step out per drawer, rather than closing and starting again.
       *
       * Escape leaves a drawer and leaves the menu standing — beside it on a
       * laptop, and on a phone, where the drawer *is* the menu, back on the
       * level it came from. That makes two windows affordable, and it means
       * the way out is walked as often as the way in: a back row that stopped
       * working would strand this check, and it says so rather than passing.
       *
       * Re-opened from the button whenever the step out did not land back on
       * the top level — a cheap guard against a drawer that takes the whole
       * menu with it, and against reading the rows of a level this is not on.
       *
       * The shortfall is a finding rather than a `continue`, because it was
       * one: the first CI run opened 33 drawers where the same tree opened 38
       * here, and said nothing. Five unchecked drawers under a green tick is
       * the exact failure this whole change is about.
       */
      let missed = 0;
      for (let d = 0; d < inside; d++) {
        const standing = (await pane.isVisible().catch(() => false))
          && (await pane.locator(DRAWERS).count()) === inside;
        if (!standing) {
          await shut(page);
          pane = await open();
          if (!pane) break;
        }
        const row = pane.locator(DRAWERS).nth(d);
        try {
          await row.click({ timeout: 2000 });
        } catch {
          missed += 1;
          continue;
        }
        await page.waitForTimeout(200);

        /*
         * The last pane on the screen is the drawer — beside the menu on a
         * laptop, and the menu itself on a phone, where stepping in replaces
         * what the menu was showing.
         */
        const panes = page.locator(OPEN_MENU);
        const opened = panes.nth((await panes.count()) - 1);
        if (await opened.count()) {
          drawers += 1;
          const bad = faults(await read(opened), 'drawer');
          if (bad.length) {
            const drawer = (await row.innerText().catch(() => '?')).replace(/\s+/g, ' ').trim().slice(0, 24);
            const label = await name();
            for (const fault of bad) {
              failures += 1;
              found.push(`${label} ▸ ${drawer}: ${fault}`);
            }
          }
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
      }
      if (missed) {
        failures += 1;
        found.push(`${await name()}: ${missed} of ${inside} drawers could not be opened, so they went unchecked`);
      }
      await shut(page);
    }

    if (found.length) {
      console.log(`FAIL ${name}`);
      for (const one of found) console.log(`       ${one}`);
    } else {
      console.log(`OK   ${name}`);
    }
  }
  console.log('');
}

await browser.close();

if (failures) {
  console.log(`${failures} menu(s) hide part of themselves, or stand outside the window.`);
  console.log('');
  console.log('A list that grows with the workspace belongs in a drawer — a `MenuGroup`');
  console.log('in `design-system/ui.tsx` — rather than poured into the menu in front of it.');
  console.log('A drawer that lands outside the window is a window with no room beside the');
  console.log('menu: that is what `useNarrow` and `.menu-sheet` are for.');
  process.exit(1);
}
console.log(`every one of ${menus} menus fits the window it opens in, and so does each of their ${drawers} drawers (${expected} to open)`);
