/**
 * Two devices that disagree about what time it is, editing the same field.
 *
 * This is the one thing about clock skew that could not be tested anywhere
 * else. The unit tests can prove the arithmetic and the client tests can prove
 * the wiring, but both of them run in a single process with a single clock —
 * and the failure being guarded against only exists when two machines really
 * do disagree. So one of the two browsers here has a system clock five minutes
 * fast, faked the only way a browser's clock can be faked from outside: `Date`
 * is replaced before any of the app's code runs, and everything downstream of
 * it — the app, the stamps it makes, the ages it draws — believes it.
 *
 * Three claims, one experiment:
 *
 *  - **The later edit wins.** The fast device writes first and the correct one
 *    writes afterwards; the server has to end up with the second. Before the
 *    stamps were made on the server's clock, the fast device's write sat five
 *    minutes in the future and the *later* edit was dropped as stale — for five
 *    minutes, against everybody.
 *  - **What the fast device reads is true.** A change it has just made says
 *    "now" on its own screen, not "5 minutes ago".
 *  - **It says which clock is wrong.** Silently correcting a machine that needs
 *    winding would be its own kind of lie, so the sync pill on the wrong device
 *    says so, and the one on the right device says nothing.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL, in English.
 * Run: node scripts/clocks.mjs
 */
import { chromium } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const SKEW_MS = 5 * 60 * 1000;

/**
 * A wrong system clock, as the page sees it.
 *
 * `Date.now()` and a bare `new Date()` move; a `new Date(value)` does not,
 * because a timestamp out of the database is an instant rather than a reading
 * of this machine's clock. That is exactly the distinction a wrong clock makes
 * in the field, and getting it backwards here would fake a bug rather than a
 * machine.
 */
const wrongClock = (skew) => `
  (() => {
    const Real = Date;
    const realNow = Real.now;
    globalThis.Date = new Proxy(Real, {
      construct: (target, args) => (args.length ? new target(...args) : new target(realNow() + ${skew})),
      get: (target, prop) => (prop === 'now' ? () => realNow() + ${skew} : Reflect.get(target, prop)),
    });
  })();
`;

const failures = [];
const check = (ok, label, detail) => {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.log(`FAIL ${label}\n       ${detail}`);
    failures.push(label);
  }
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** A signed-in browser, optionally one whose clock is wrong. */
async function device(skew) {
  const context = await browser.newContext();
  if (skew) await context.addInitScript(wrongClock(skew));
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  // The first-run tour stands in front of everything on a fresh device.
  for (let i = 0; i < 8; i++) {
    if (!(await page.locator('.sheet').count())) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  return page;
}

/** What the server holds for this task, asked as the signed-in person. */
const onServer = (page, id) =>
  page.evaluate(async (taskId) => {
    const response = await fetch(`/api/tasks/${taskId}`, { credentials: 'include' });
    return response.json();
  }, id);

/** Wait for a title to reach the server, or give up and say what is there. */
async function settledTitle(page, id, wanted) {
  for (let i = 0; i < 20; i++) {
    const row = await onServer(page, id);
    if (row.title === wanted) return row.title;
    await page.waitForTimeout(500);
  }
  return (await onServer(page, id)).title;
}

async function retitle(page, title) {
  const box = page.locator('.sheet input, .task-detail input').first();
  await box.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(title);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
}

const fast = await device(SKEW_MS);
const right = await device(0);

const believed = await fast.evaluate(() => Date.now());
check(
  Math.abs(believed - Date.now() - SKEW_MS) < 30_000,
  `one device's clock is ${Math.round(SKEW_MS / 60_000)} minutes fast`,
  `it is ${Math.round((believed - Date.now()) / 1000)}s off, and should be ${SKEW_MS / 1000}s`,
);

// Both open the same task, the fast device by clicking and the other by URL.
await fast.locator('.task-row').first().click();
await fast.waitForSelector('.sheet input, .task-detail input', { timeout: 15000 });
const url = fast.url();
const id = url.split('/t/')[1];
await right.goto(url, { waitUntil: 'networkidle' });
await right.waitForSelector('.sheet input, .task-detail input', { timeout: 15000 });

// The fast device writes first. Three seconds is far less than the five
// minutes its clock is out by, which is the whole point of the interval.
await retitle(fast, 'From the fast device');
await settledTitle(fast, id, 'From the fast device');
await fast.waitForTimeout(3000);
await retitle(right, 'From the correct one, later');

const kept = await settledTitle(right, id, 'From the correct one, later');
check(
  kept === 'From the correct one, later',
  'the later edit wins, whichever device is fast',
  `the server kept "${kept}" — a stamp made on the browser's own clock beat a write made after it`,
);

await fast.reload({ waitUntil: 'networkidle' });
await fast.waitForSelector('.sheet input, .task-detail input', { timeout: 15000 });
// The task's own footer line — "Created 11 Sept · updated now" — and not the
// "Created by you" in the activity trail above it, which says no age at all.
const stamp = await fast.getByText(/· updated /).first().innerText().catch(() => '(no timestamp on screen)');
const age = stamp.split('· updated').pop().split('\n')[0].trim();
check(
  age === 'now',
  'a change the fast device just made reads as just made',
  `it reads "${age}" — the age is being counted on the browser's clock rather than the server's`,
);

const wrongPill = await fast.locator('.status-pill').first().getAttribute('title');
const rightPill = await right.locator('.status-pill').first().getAttribute('title');
check(
  /clock is .* ahead of the server/.test(wrongPill ?? ''),
  'the wrong device says so',
  `its sync pill reads ${JSON.stringify(wrongPill)}`,
);
check(
  !/clock is/.test(rightPill ?? ''),
  'and the right one says nothing',
  `its sync pill reads ${JSON.stringify(rightPill)}`,
);

await browser.close();
console.log(failures.length
  ? `\n${failures.length} of 5 claims failed`
  : '\ntwo clocks five minutes apart, and the workspace cannot tell');
process.exit(failures.length ? 1 : 0);
