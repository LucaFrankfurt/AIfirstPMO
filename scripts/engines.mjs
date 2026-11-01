/**
 * Boards in the engines nobody here runs: Firefox's and Safari's (WebKit).
 *
 * Everything about a board that could differ between browsers is the part no
 * unit test sees — a sandboxed frame with an opaque origin, a policy delivered
 * as a header, a handshake by `postMessage`, a frame measuring itself and the
 * page growing to it, two policies nested in a shared link. All of it was
 * written and measured in Chromium, and "runs in Chromium" is not "runs in
 * Safari", which is what half the phones that open a shared link are. So this
 * walks those things in each engine it is given and says which held:
 *
 *   - a board on the seeded canvas draws, and its script runs;
 *   - the editor's frame answers a click with a selection;
 *   - the seeded board page grows to its board, with nothing scrolling inside;
 *   - at phone width it reflows, and its pin sits on what it was put on;
 *   - a shared canvas and a shared board page work for a stranger.
 *
 * Run against a seeded instance, like the smoke walkthrough:
 *
 *   KOLIBRI_URL=http://localhost:4400 node scripts/engines.mjs
 *
 * `KOLIBRI_ENGINES` picks the engines, comma-separated — `firefox,webkit`
 * unless said. CI runs it inside Playwright's own image, which carries both
 * with the libraries they need (see `ci.yml`); a sandbox with only Chromium
 * can still check the script itself with `KOLIBRI_ENGINES=chromium`, which
 * honours `CHROMIUM_PATH` like every browser script here.
 */
import { chromium, devices, firefox, webkit } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const wanted = (process.env.KOLIBRI_ENGINES ?? 'firefox,webkit').split(',').map((name) => name.trim()).filter(Boolean);
const ENGINES = { chromium, firefox, webkit };
const results = [];
let failed = 0;

const check = (engine, ok, what) => {
  if (!ok) failed += 1;
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${engine.padEnd(8)} ${what}`);
  console.log(results[results.length - 1]);
};

/** Read something from whichever frame of the page has it — boards are frames of their own. */
async function fromFrames(page, read, tries = 24) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    for (const frame of page.frames()) {
      const value = await frame.evaluate(read).catch(() => null);
      if (value !== null && value !== undefined) return value;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(`${base}/`);
  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#email', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 5000 }).catch(() => null);
  return page;
}

async function walk(name) {
  const engine = ENGINES[name];
  if (!engine) {
    check(name, false, 'is not an engine Playwright has');
    return;
  }
  const options = name === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  const browser = await engine.launch(options);
  try {
    const desk = await signIn(await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' }));
    const seeded = await desk.evaluate(async () => {
      const ws = localStorage.getItem('kolibri.workspace');
      const pages = await (await fetch(`/api/workspaces/${ws}/pages?limit=500`, { credentials: 'include' })).json();
      const rows = pages.items ?? pages;
      const boards = await (await fetch(`/api/workspaces/${ws}/artboards?limit=500`, { credentials: 'include' })).json();
      const one = rows.find((row) => row.format === 'board');
      return {
        ws,
        canvas: rows.find((row) => row.format === 'canvas')?.id,
        one: one?.id,
        h: (boards.items ?? boards).find((row) => row.page_id === one?.id)?.h,
      };
    });
    if (!seeded.canvas || !seeded.one) throw new Error('the seed has no canvas or board page');

    // A board on the canvas: the frame, its policy and the handshake.
    await desk.goto(`${base}/pages/${seeded.canvas}`);
    const total = await fromFrames(desk, () => document.getElementById('total')?.textContent ?? null);
    check(name, total === '€155k', `a board on the canvas draws and its script runs (${total})`);

    // The editor: edit mode's own runtime, and a click coming back as a selection.
    await desk.locator('.canvas-board', { hasText: 'Pipeline' }).locator('.canvas-hit').dblclick();
    await desk.waitForSelector('.artboard-editor iframe', { timeout: 10000 });
    let selected = false;
    for (let attempt = 0; attempt < 20 && !selected; attempt += 1) {
      for (const frame of desk.frames()) {
        if (!frame.url().includes('artboard.html')) continue;
        const clicked = await frame.locator('h1').first().click({ timeout: 1000 }).then(() => true).catch(() => false);
        if (clicked) break;
      }
      await desk.waitForTimeout(300);
      selected = await desk.getByRole('textbox', { name: 'Font size' }).isVisible().catch(() => false);
    }
    check(name, selected, 'the editor selects what is clicked inside the board');
    await desk.keyboard.press('Escape');

    // The board page: measured and grown to.
    await desk.goto(`${base}/pages/${seeded.one}`);
    await desk.waitForSelector('.board-sheet iframe', { timeout: 10000 });
    let tall = 0;
    for (let attempt = 0; attempt < 24 && tall <= seeded.h; attempt += 1) {
      tall = await desk.locator('.board-sheet-inner').evaluate((el) => el.offsetHeight);
      if (tall <= seeded.h) await desk.waitForTimeout(250);
    }
    check(name, tall > seeded.h, `a board page grows past its ${seeded.h}px frame to its board (${tall}px)`);

    // At phone width: reflowed, and the pin found on what it was put on.
    const phoneOptions = name === 'webkit'
      ? { ...devices['iPhone 13'], locale: 'en-US' }
      : { viewport: { width: 390, height: 844 }, locale: 'en-US' };
    const phone = await signIn(await browser.newContext(phoneOptions));
    await phone.goto(`${base}/pages/${seeded.one}`);
    await phone.waitForSelector('.board-sheet iframe', { timeout: 10000 });
    await phone.waitForTimeout(2500);
    const reflowed = await phone.locator('.board-sheet-inner').evaluate((el) => ({ w: el.offsetWidth, t: el.style.transform }));
    check(name, reflowed.w < 400 && reflowed.t === 'scale(1)', `a board page reflows at phone width (${reflowed.w}px, ${reflowed.t})`);
    const pinned = await phone.locator('.board-sheet .canvas-pin').count();
    check(name, pinned >= 1, `its pin is found on the reflowed board (${pinned})`);

    // A stranger with the links.
    const share = (page) => desk.evaluate(async ([ws, id]) => {
      const made = await (await fetch(`/api/workspaces/${ws}/shares`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'page', page_id: id }),
      })).json();
      return made.token;
    }, [seeded.ws, page]);
    const stranger = await (await browser.newContext(phoneOptions)).newPage();
    await stranger.goto(`${base}/s/${await share(seeded.canvas)}`);
    const shared = await fromFrames(stranger, () => document.getElementById('total')?.textContent ?? null);
    check(name, shared === '€155k', `a stranger opening a shared canvas sees its boards working (${shared})`);
    await stranger.goto(`${base}/s/${await share(seeded.one)}`);
    // By its words: the share document around it has an `h1` of its own, the page's title.
    const heading = await fromFrames(stranger, () => [...document.querySelectorAll('h1')].find((one) => one.textContent === 'Q3 in one page')?.textContent ?? null);
    const wide = await stranger.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(name, heading === 'Q3 in one page' && wide <= 0, `and a shared board page, on a phone, with nothing off the side (${heading}, ${wide}px)`);
  } catch (error) {
    check(name, false, `stopped: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

for (const name of wanted) await walk(name);
console.log(failed ? `\n${failed} thing(s) did not hold` : `\nboards hold in ${wanted.join(' and ')}`);
process.exit(failed ? 1 : 0);
