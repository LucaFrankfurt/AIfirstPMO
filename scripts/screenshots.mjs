/**
 * The screenshots that go on demo.kolibri.day and docs.kolibri.day.
 *
 * Signs in to a seeded instance, walks the screens that are worth showing, and
 * writes a PNG per screen per theme into `sites/*&#47;src/assets/screens`.
 *
 * Two rules the shots follow, because the first set broke both:
 *
 * 1. **The viewport is sized to the content, not the other way round.** A
 *    board with three columns in a 900px-tall window is a picture that is
 *    two-thirds empty, and on a landing page that reads as an empty product.
 *    Each entry below carries the height its screen actually fills.
 * 2. **Both themes, always.** The sites redraw in the reader's theme, and a
 *    light screenshot on a dark page is a white rectangle shouting.
 *
 * The files are written as WebP, not PNG. Two sites × nine screens × two
 * themes is thirty-six images that live in git forever, and at 2× a PNG
 * screenshot of a mostly-flat interface is around 200kB against WebP's twenty.
 * `sharp` does the encoding and is already a dependency of both sites — it is
 * what Astro itself uses to optimise them at build time — so this reaches into
 * whichever site has it installed rather than adding a dependency at the root.
 * Without it the script writes PNG and says so.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL, and Playwright with a
 * browser at CHROMIUM_PATH (or one it can find itself).
 *
 *   npm run seed && PORT=4400 npm start &
 *   node scripts/screenshots.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = (process.env.KOLIBRI_SHOT_DIRS ?? 'sites/demo/src/assets/screens,sites/docs/src/assets/screens')
  .split(',')
  .map((d) => resolve(root, d.trim()));

/* A device scale of 2 so the images stay sharp on the retina screens most of
   this will be read on. Astro downscales them into the sizes it serves. */
const SCALE = 2;

/** sharp, from whichever site has it. Null means "write PNG and say so". */
const sharp = await (async () => {
  for (const site of ['sites/demo', 'sites/docs']) {
    try {
      const entry = pathToFileURL(resolve(root, site, 'node_modules/sharp/dist/index.mjs')).href;
      return (await import(entry)).default;
    } catch {
      /* Try the next one. */
    }
  }
  console.warn('sharp not found in either site — writing PNG, which is ~10× larger');
  return null;
})();

/**
 * Where to go, what to wait for, and how tall that screen actually is.
 *
 * `view` writes the project's stored view before the app boots, which is how a
 * layout is chosen without clicking through a menu that may be collapsed at
 * the width being captured.
 */
const SHOTS = [
  {
    name: 'board',
    path: (ids) => `/projects/${ids.website}`,
    view: { layout: 'board', groupBy: 'state' },
    size: [1360, 700],
    wait: '.main',
  },
  {
    name: 'list',
    path: (ids) => `/projects/${ids.website}`,
    view: { layout: 'list', groupBy: 'priority' },
    size: [1360, 700],
    wait: '.main',
  },
  {
    name: 'timeline',
    path: (ids) => `/projects/${ids.website}`,
    view: { layout: 'gantt', groupBy: 'none' },
    size: [1360, 510],
    wait: '.main',
  },
  {
    name: 'insights',
    path: (ids) => `/projects/${ids.website}?tab=insights`,
    size: [1360, 700],
    wait: '.main',
  },
  { name: 'my-work', path: () => '/', size: [1360, 700], wait: '.main' },
  // The page *detail*, not the index: a wiki is worth showing as prose with a
  // tree beside it, and an index of three cards is a picture of a filing
  // cabinet.
  { name: 'pages', path: (ids) => `/pages/${ids.page}`, size: [1360, 700], wait: '.main' },
  { name: 'chat', path: (ids) => `/chat/${ids.channel}`, size: [1360, 700], wait: '.main' },
  { name: 'task', path: (ids) => `/t/${ids.task}`, size: [1360, 700], wait: '.sheet' },
  { name: 'mobile', path: () => '/', size: [390, 720], wait: '.main' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

/* One signed-in context per theme. Signing in once per shot would be nine
   logins and nine first-run tours to dismiss. */
async function open(theme) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: SCALE,
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    localStorage.setItem('kolibri.theme', t);
    // The first-run tour opens over everything and would be in every shot.
    localStorage.setItem('kolibri.tour.done', '1');
  }, theme);
  await page.goto(base, { waitUntil: 'networkidle' });

  /* Sign-in is rate limited per account as well as per address, and this
     script signs in twice — after a `demo-extras.mjs` run that signed in eight
     times, that limit is reached, correctly. Waiting it out is the right
     answer; raising it for a screenshot run would be turning off the thing
     being demonstrated. */
  for (let attempt = 1; ; attempt++) {
    await page.fill('#email', 'ada@kolibri.dev');
    await page.fill('#password', 'kolibri-demo');
    await page.click('button[type=submit]');
    try {
      await page.waitForSelector('.sidebar', { timeout: 15000 });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      console.log(`  sign-in refused (attempt ${attempt}) — waiting 35s`);
      await sleep(35_000);
      await page.goto(base, { waitUntil: 'networkidle' });
    }
  }
  // The tour is dismissed by pressing Escape rather than by trusting the key
  // above — the flag's name is an implementation detail and may move.
  for (let i = 0; i < 6 && (await page.locator('.sheet').count()); i++) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
  return { context, page };
}

/** The seeded ids, read from the app's own store rather than guessed. */
async function ids(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('kolibri');
    const db = await new Promise((ok, no) => {
      request.onsuccess = () => ok(request.result);
      request.onerror = () => no(request.error);
    });
    const read = (store) =>
      new Promise((ok) => {
        const t = db.transaction(store, 'readonly').objectStore(store).getAll();
        t.onsuccess = () => ok(t.result ?? []);
        t.onerror = () => ok([]);
      });
    const projects = await read('project');
    const tasks = await read('task');
    const channels = await read('channel');
    const pages = await read('page');
    const website = projects.find((p) => p.key === 'WEB') ?? projects[0];
    // A task with a description, a label and an assignee makes a better
    // picture than whichever one happens to be first.
    const task =
      tasks.find((t) => t.project_id === website?.id && t.description && !t.parent_id) ??
      tasks.find((t) => t.project_id === website?.id) ??
      tasks[0];
    // `scripts/demo-extras.mjs` writes #general. Without it the chat screen is
    // an empty state, which is a true picture of an unseeded instance and a
    // useless one on a landing page.
    const channel = channels.find((c) => c.name === 'general') ?? channels[0];
    // The longest page, which is the one with something on it to read.
    const page = [...pages].sort((a, b) => (b.body ?? '').length - (a.body ?? '').length)[0];
    return {
      website: website?.id,
      task: task?.identifier ?? task?.id,
      channel: channel?.id ?? '',
      page: page?.id ?? '',
    };
  });
}

for (const dir of targets) mkdirSync(dir, { recursive: true });

for (const theme of ['light', 'dark']) {
  const { context, page } = await open(theme);
  const seeded = await ids(page);
  console.log(`${theme}: project ${seeded.website}, task ${seeded.task}`);

  for (const shot of SHOTS) {
    const [width, height] = shot.size;
    await page.setViewportSize({ width, height });
    if (shot.view) {
      await page.evaluate(
        ([key, value]) => localStorage.setItem(key, value),
        [`kolibri.view.${seeded.website}`, JSON.stringify(shot.view)],
      );
    }
    await page.goto(base + shot.path(seeded), { waitUntil: 'networkidle' });
    await page.waitForSelector(shot.wait, { timeout: 15000 }).catch(() => {
      console.warn(`  ${shot.name}: "${shot.wait}" never appeared — shooting anyway`);
    });
    // The charts animate in and the board settles its columns; a shot taken on
    // `networkidle` alone catches both mid-move.
    await sleep(1200);

    /* A task sheet focuses its title on open, and a focused input draws a ring
       and a blue selection over the words. Both are correct behaviour and
       neither belongs in a picture of the product. */
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      window.getSelection()?.removeAllRanges();
    });
    await sleep(150);

    const png = await page.screenshot({ type: 'png' });
    /* Quality 88 rather than lossless: these are flat interface screenshots
       with hard type on them, and the difference at 2× is invisible where the
       difference in bytes is a factor of ten. */
    const bytes = sharp ? await sharp(png).webp({ quality: 88 }).toBuffer() : png;
    const file = `${shot.name}-${theme}.${sharp ? 'webp' : 'png'}`;
    for (const dir of targets) writeFileSync(join(dir, file), bytes);
    console.log(`  ${file}  ${width}×${height}  ${Math.round(bytes.length / 1024)}kB`);
  }

  await context.close();
}

await browser.close();
console.log('done');
