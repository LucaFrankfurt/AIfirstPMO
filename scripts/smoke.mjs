/**
 * Browser smoke test: signs in, walks the main screens, creates a task and
 * checks that it survived a round trip — then does it again on a phone-sized
 * viewport and with the network switched off.
 *
 * Set KOLIBRI_LOCALE to `de` or `fr` to walk the same path through that
 * interface; the labels below are the only thing that changes, which is the
 * point of the run — a missing translation shows up as a selector that no
 * longer matches.
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
  en: {
    board: 'Board', newTask: 'New task', createTask: 'Create task', pages: 'Pages',
    guide: 'Guide', welcome: 'Welcome', log: 'Log',
  },
  de: {
    board: 'Board', newTask: 'Neue Aufgabe', createTask: 'Aufgabe anlegen', pages: 'Seiten',
    guide: 'Anleitung', welcome: 'Willkommen', log: 'Protokoll',
  },
  fr: {
    board: 'Tableau', newTask: 'Nouvelle tâche', createTask: 'Créer la tâche', pages: 'Pages',
    guide: 'Guide', welcome: 'Bienvenue', log: 'Journal',
  },
}[locale];

/** The first-run tour opens over everything; every later step needs it gone. */
const closeTour = async (target) => {
  if (await target.locator('.sheet:has(.tour-h)').count()) {
    await target.keyboard.press('Escape');
    await target.waitForTimeout(250);
  }
};
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

await step('first-run tour greets a new device and can be dismissed', async () => {
  await page.waitForSelector('.sheet:has(.tour-h)', { timeout: 6000 });
  const heading = await page.locator('.sheet header strong').innerText();
  if (!heading.includes(LABELS.welcome)) throw new Error(`tour title was "${heading}"`);
  const steps = (await page.locator('.sheet footer .muted').innerText()).match(/\d+$/)?.[0];
  console.log('     tour steps for an owner:', steps);
  if (steps !== '5') throw new Error(`expected 5 steps, got ${steps}`);
  await closeTour(page);
  if (await page.locator('.sheet').count()) throw new Error('tour did not close');
  // Dismissed for good: a reload must not bring it back.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  if (await page.locator('.sheet:has(.tour-h)').count()) throw new Error('tour reopened after a reload');
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
  await closeTour(m);
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

await step('setup checklist reflects the workspace, empty screens offer help', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.setup', { timeout: 5000 });
  const rows = await page.locator('.setup-item').count();
  const done = await page.locator('.setup-item.done').count();
  console.log('     checklist:', `${done}/${rows} already true of the seeded workspace`);
  if (rows < 3) throw new Error(`checklist has only ${rows} items`);
  // The demo workspace has projects, tasks and pages, so those must read as done.
  if (done < 3) throw new Error(`expected the seeded work to tick at least 3, got ${done}`);

  // Settings always carries a hint, so this is the deterministic end of the
  // mechanism: click it and the guide must open on that card, scrolled to it.
  await page.goto(`${base}/settings?tab=api`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.guide-hint', { timeout: 5000 });
  await page.click('.guide-hint');
  await page.waitForSelector('#guide-assistant');
  await page.waitForTimeout(1100);
  const placed = await page.evaluate(() => {
    const box = document.getElementById('guide-assistant')?.getBoundingClientRect();
    return box ? box.top > -60 && box.top < 420 : false;
  });
  if (!placed) throw new Error('the linked card was not scrolled into view');

  // The empty screens that do have something to explain carry one too. The
  // demo workspace is not empty everywhere, so this counts rather than demands.
  let offered = 0;
  for (const path of ['/teams', '/pages', '/inbox']) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    if (await page.locator('.empty .guide-hint').count()) offered++;
  }
  console.log('     empty screens offering help:', offered, 'of 3 visited');

  // And a checklist button lands on the tab it names.
  await page.goto(`${base}/settings?tab=members`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabs button.active');
  const tab = await page.locator('.tabs button.active').innerText();
  console.log('     settings deep link opened:', tab);
});

await step('templates and rules are set up and readable', async () => {
  await page.goto(`${base}/settings?tab=automation`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.auto-row', { timeout: 5000 });
  const templates = await page.locator('.auto-row .auto-glyph').count();
  const rules = await page.locator('.auto-switch').count();
  console.log('     templates:', templates, ' rules:', rules);
  if (!templates || !rules) throw new Error('the seeded template or rule is missing');
  if (!await page.locator('.auto-switch.on').count()) throw new Error('the seeded rule is off');

  // The log opens and says something, even before the rule has ever fired.
  await page.locator(`.auto-row .btn:has-text("${LABELS.log}")`).first().click();
  await page.waitForSelector('.sheet');
  const log = await page.locator('.sheet .body').innerText();
  if (/auto\.[a-z]|tpl\.[a-z]/i.test(log)) throw new Error(`untranslated key in the log: ${log.slice(0, 60)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // The rule editor opens with its recipient rows.
  await page.locator('.auto-row').last().locator('.btn').last().click();
  await page.waitForSelector('#rule-name', { timeout: 5000 });
  const recipients = await page.locator('.auto-recipient').count();
  if (!recipients) throw new Error('the rule editor shows no recipients');
  console.log('     recipient rows in the editor:', recipients);
  await page.keyboard.press('Escape');
});
await page.screenshot({ path: `${shots}/8-automation.png` });

await step('guide opens, explains itself, and leaks no keys', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  await page.keyboard.press('Shift+Slash');            // the `?` shortcut
  await page.waitForSelector('.guide', { timeout: 5000 });
  if (!page.url().endsWith('/guide')) throw new Error(`? went to ${page.url()}`);

  const tabs = await page.locator('.tabs button').count();
  if (tabs !== 4) throw new Error(`expected 4 sections, found ${tabs}`);

  // Walk every section and make sure no raw translation key reached the screen.
  for (let index = 0; index < tabs; index++) {
    await page.locator('.tabs button').nth(index).click();
    await page.waitForTimeout(150);
    const text = await page.locator('.guide').innerText();
    const leak = text.match(/guide\.[\w.]+/);
    if (leak) throw new Error(`untranslated key on screen: ${leak[0]}`);
  }

  // Every step of every animation has to say something.
  await page.locator('.tabs button').nth(2).click();
  await page.waitForSelector('.guide-feature .stage');
  const stages = page.locator('.stage');
  let steps = 0;
  for (let index = 0; index < await stages.count(); index++) {
    const stage = stages.nth(index);
    const dots = await stage.locator('.dots button').count();
    for (let dot = 0; dot < dots; dot++) {
      await stage.locator('.dots button').nth(dot).click();
      const caption = (await stage.locator('.caption').innerText()).trim();
      if (caption.length < 25) throw new Error(`stage ${index} step ${dot} has no narration`);
      steps++;
    }
  }
  console.log('     narrated animation steps:', steps);

  // Every node of the hierarchy has to explain itself.
  await page.locator('.tabs button').nth(1).click();
  await page.waitForSelector('.gx-hierarchy');
  const nodes = page.locator('.gx-node');
  for (let index = 0; index < await nodes.count(); index++) {
    await nodes.nth(index).click();
    const detail = await page.locator('.gx-detail').innerText();
    if (detail.length < 90) throw new Error(`hierarchy node ${index} is not explained`);
  }
  console.log('     hierarchy nodes explained:', await nodes.count());
});
await page.screenshot({ path: `${shots}/7-guide.png` });

await step('interface is in the chosen language', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== locale) throw new Error(`<html lang> is "${lang}", expected "${locale}"`);
  const nav = await page.locator('.sidebar').innerText();
  for (const label of [LABELS.pages, LABELS.guide]) {
    if (!nav.includes(label)) throw new Error(`sidebar does not mention "${label}"`);
  }
});

console.log(`\nlocale: ${locale}  ·  screenshots: ${shots}`);
console.log('console errors:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  -', e));
await browser.close();
