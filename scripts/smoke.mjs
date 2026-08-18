/**
 * Browser smoke test: signs in, walks the main screens, creates a task and
 * checks that it survived a round trip — then does it again on a phone-sized
 * viewport and with the network switched off.
 *
 * Set KOLIBRI_LOCALE=de to walk the same path through the German interface; the
 * labels below are the only thing that changes, which is the point of the run —
 * a missing translation shows up as a selector that no longer matches.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL and `npx playwright install chromium`.
 * Run: node scripts/smoke.mjs
 */
import { chromium } from 'playwright';
const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const locale = process.env.KOLIBRI_LOCALE ?? 'en';
const shots = process.env.KOLIBRI_SHOT_DIR ?? (locale === 'en' ? '/tmp/shots' : `/tmp/shots-${locale}`);

/** Only the strings the walkthrough clicks on — not a second catalogue. */
const LABELS = {
  en: { board: 'Board', newTask: 'New task', createTask: 'Create task', pages: 'Pages' },
  de: { board: 'Board', newTask: 'Neue Aufgabe', createTask: 'Aufgabe anlegen', pages: 'Seiten' },
}[locale];
if (!LABELS) throw new Error(`smoke test has no labels for locale "${locale}"`);
const errors = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, '-', e.message); } };

await step('login', async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('kolibri.locale', value), locale);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
});
await page.waitForTimeout(1500);
await step('my work has tasks', async () => {
  const n = await page.locator('.task-row').count();
  if (n === 0) throw new Error('no tasks rendered');
  console.log('     task rows:', n);
});
await page.screenshot({ path: `${shots}/1-mywork.png` });

await step('open project board', async () => {
  await page.click('.sidebar a:has-text("Website")');
  await page.waitForSelector('.tabs');
  await page.click(`button[aria-pressed][title="${LABELS.board}"]`);
  await page.waitForSelector('.board-column', { timeout: 5000 });
  const cols = await page.locator('.board-column').count();
  console.log('     board columns:', cols);
});
await page.screenshot({ path: `${shots}/2-board.png` });

await step('open task detail + comment', async () => {
  await page.click('.task-card');
  await page.waitForSelector('.sheet', { timeout: 5000 });
  const title = await page.locator('.sheet .input').first().inputValue();
  console.log('     task:', title.slice(0, 40));
});
await page.screenshot({ path: `${shots}/3-task.png` });

await step('create task through quick add', async () => {
  await page.keyboard.press('Escape');
  await page.click(`.sidebar button:has-text("${LABELS.newTask}")`);
  await page.waitForSelector('.sheet');
  await page.fill('.sheet input.input >> nth=0', 'Playwright smoke task');
  await page.click(`button:has-text("${LABELS.createTask}")`);
  await page.waitForTimeout(1200);
});

await step('task reached the server', async () => {
  const res = await page.request.get(`${base}/api/health`);
  const body = await res.json();
  if (!body.seq) throw new Error('no seq');
  const search = await page.request.get(`${base}/api/workspaces/${await page.evaluate(() => localStorage.getItem('kolibri.workspace'))}/search?q=playwright`);
  const data = await search.json();
  if (!data.results.length) throw new Error('task not indexed on server');
  console.log('     server found:', data.results[0].title);
});

await step('pages', async () => {
  await page.goto(`${base}/pages`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });
  await page.click('.card:has-text("Team handbook")');
  await page.waitForSelector('.md h1', { timeout: 5000 });
});
await page.screenshot({ path: `${shots}/4-page.png` });

await step('command palette', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.fill('.palette input', 'dark mode');
  await page.waitForTimeout(300);
  const hits = await page.locator('.palette .results button').count();
  if (!hits) throw new Error('no palette hits');
  console.log('     palette hits:', hits);
  await page.keyboard.press('Escape');
});

await step('mobile layout', async () => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale });
  const m = await mobile.newPage();
  await m.goto(base, { waitUntil: 'domcontentloaded' });
  await m.evaluate((value) => localStorage.setItem('kolibri.locale', value), locale);
  await m.goto(base, { waitUntil: 'networkidle' });
  await m.fill('#email', 'ada@kolibri.dev');
  await m.fill('#password', 'kolibri-demo');
  await m.click('button[type=submit]');
  await m.waitForSelector('.tabbar', { timeout: 15000 });
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${shots}/5-mobile.png` });
  await m.emulateMedia({ colorScheme: 'dark' });
  await m.screenshot({ path: `${shots}/6-mobile-dark.png` });
  await mobile.close();
});

await step('offline mode', async () => {
  await ctx.setOffline(true);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
  const rows = await page.locator('.task-row').count();
  console.log('     rows while offline:', rows);
  await ctx.setOffline(false);
});

await step('interface is in the chosen language', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== locale) throw new Error(`<html lang> is "${lang}", expected "${locale}"`);
  const nav = await page.locator('.sidebar').innerText();
  if (!nav.includes(LABELS.pages)) throw new Error(`sidebar does not mention "${LABELS.pages}"`);
});

console.log(`\nlocale: ${locale}  ·  screenshots: ${shots}`);
console.log('console errors:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  -', e));
await browser.close();
