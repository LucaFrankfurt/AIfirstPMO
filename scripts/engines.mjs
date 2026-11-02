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
 *   - boards too wide for a phone, four ways — fixed columns, placed by position, a line that
 *     never wraps, a layout of display: table — reflow to it, in the app and through a shared link;
 *   - boards whose script measured them before they were fitted — a chart drawn to its box, a
 *     bar sized from its box — are drawn again, fitted from the start: in the app, in a shared
 *     link's frame, opened on their own as a downloaded board page is, and in a `srcdoc` frame
 *     as a downloaded canvas holds them;
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

/** Boards written for a wide screen and nothing else, each a different way of running off a phone. */
const doc = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Wide</title></head>
<body style="margin: 0; font-family: system-ui, sans-serif"><div style="padding: 24px"><h1 style="margin: 0 0 12px">Wide</h1>${body}</div></body></html>`;
const WIDE = {
  'a grid of eight fixed columns': doc(`<div id="t" style="display: grid; grid-template-columns: repeat(8, minmax(140px, 1fr)); gap: 12px">
${Array.from({ length: 8 }, (_, at) => `<div style="padding: 12px; border: 1px solid #ddd">Stage ${at + 1}</div>`).join('')}</div>`),
  'a layout placed by position': doc(`<div id="t" style="position: relative; width: 1200px; height: 400px">
<div style="position: absolute; left: 0; top: 0; width: 300px">First</div><div style="position: absolute; left: 800px; top: 0; width: 300px">Second</div></div>`),
  'a line that never wraps': doc(`<p id="t" style="white-space: nowrap">A long line of words its author told never to break, running far past the edge of any phone there is.</p>`),
  'a layout of display: table': doc(`<div id="t" style="display: table; width: 900px"><div style="display: table-row">
${Array.from({ length: 4 }, (_, at) => `<div style="display: table-cell; padding: 8px">Cell ${at + 1}</div>`).join('')}</div></div>`),
};
const CRAMPED = WIDE['a grid of eight fixed columns'];
/**
 * Boards too wide for a phone whose script measures them as they load: once
 * fitted afterwards, the chart is a picture shrunk to the width and the bar
 * shows a share of the wrong whole. Fitted from the start, both come out right.
 */
const SCRIPTED = {
  'a chart drawn to its box': doc(`<div id="t" style="display: grid; grid-template-columns: repeat(3, 400px); gap: 12px">
<div><canvas id="c" height="160"></canvas></div><div>Second</div><div>Third</div></div>
<script>const c = document.getElementById('c'); c.width = c.parentElement.clientWidth;
const g = c.getContext('2d'); g.fillStyle = '#2f6fed'; [40, 90, 60, 120].forEach((v, i) => g.fillRect(8 + i * c.width / 4, 150 - v, c.width / 4 - 16, v));</script>`),
  'a bar sized from its box': doc(`<div id="t" style="width: 1200px; background: #e8eaee"><div id="fill" style="height: 16px; background: #2f6fed"></div></div>
<p>Sixty per cent done.</p><script>document.getElementById('fill').style.width = Math.round(document.getElementById('t').clientWidth * 0.6) + 'px';</script>`),
};
/** In the board: whether what its script drew matches what is shown — read in the page, so self-contained. */
const redrawn = () => {
  const t = document.getElementById('t');
  if (!t) return null;
  const root = document.documentElement;
  const cut = Math.max(root.scrollWidth - root.clientWidth, Math.round(t.getBoundingClientRect().right - root.clientWidth));
  const c = document.getElementById('c');
  const fill = document.getElementById('fill');
  if (c) {
    const shown = Math.round(c.getBoundingClientRect().width);
    // A chart drawn at no width matches being shown at none, and is no chart.
    return { cut, drawn: c.width, shown, ok: cut <= 1 && shown > 100 && Math.abs(c.width - shown) <= 2 };
  }
  if (!fill) return null;
  const part = Math.round((fill.getBoundingClientRect().width / t.getBoundingClientRect().width) * 100) / 100;
  return { cut, part, ok: cut <= 1 && Math.abs(part - 0.6) < 0.05 };
};
/** Ask `redrawn` until it holds or time is up — the second drawing comes a moment after the first. */
async function untilRedrawn(page) {
  let state = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    state = await fromFrames(page, redrawn, 2);
    if (state?.ok) break;
    await page.waitForTimeout(250);
  }
  return state;
}
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

    // Boards written for a wide screen and nothing else reflow to the phone,
    // at their own size: nothing cut, nothing shrunk. One board page each.
    const make = (title, html) => desk.evaluate(async ([ws, name, content]) => {
      const made = await (await fetch(`/api/workspaces/${ws}/pages`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: name, format: 'board' }),
      })).json();
      await fetch(`/api/workspaces/${ws}/artboards`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page_id: made.id, title: name, content, w: 1280, h: 600 }),
      });
      return made.id;
    }, [seeded.ws, title, html]);
    let cramped = null;
    for (const [what, html] of Object.entries(WIDE)) {
      const id = await make(what, html);
      if (html === CRAMPED) cramped = id;
      await phone.goto(`${base}/pages/${id}`);
      await phone.waitForSelector('.board-sheet iframe', { timeout: 10000 });
      let state = null;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await phone.waitForTimeout(250);
        const drawn = await phone.locator('.board-sheet-inner').evaluate((el) => ({ w: el.offsetWidth, t: el.style.transform }));
        const cut = await fromFrames(phone, () => (document.getElementById('t')
          ? Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth,
            Math.round(document.getElementById('t').getBoundingClientRect().right - document.documentElement.clientWidth))
          : null), 2);
        state = { ...drawn, cut };
        if (cut !== null && cut <= 1 && drawn.t === 'scale(1)') break;
      }
      check(name, !!state && state.cut !== null && state.cut <= 1 && state.w < 400 && state.t === 'scale(1)',
        `${what}, too wide for a phone, reflows to it at its own size (${JSON.stringify(state)})`);
    }

    // Boards whose script measured them: drawn again, fitted from the start.
    const scripted = [];
    for (const [what, html] of Object.entries(SCRIPTED)) {
      const id = await make(what, html);
      scripted.push([what, id]);
      await phone.goto(`${base}/pages/${id}`);
      await phone.waitForSelector('.board-sheet iframe', { timeout: 10000 });
      const state = await untilRedrawn(phone);
      check(name, !!state?.ok, `${what}, measured by its script, is drawn again to fit the phone (${JSON.stringify(state)})`);
    }

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
    // The too-wide board, shared: no script around it to scale it, so it fits from inside.
    await stranger.goto(`${base}/s/${await share(cramped)}`);
    const sharedFit = await fromFrames(stranger, () => (document.getElementById('t')
      ? document.documentElement.scrollWidth - document.documentElement.clientWidth : null));
    check(name, sharedFit !== null && sharedFit <= 1, `a shared board too wide for a phone fits it too (${sharedFit}px cut)`);
    // The same, with no app around it: shared, on its own as a downloaded board
    // page opens, and in a `srcdoc` frame as a downloaded canvas holds it.
    for (const [what, id] of scripted) {
      const token = await share(id);
      await stranger.goto(`${base}/s/${token}`);
      const framed = await untilRedrawn(stranger);
      const board = await stranger.evaluate(() => document.querySelector('iframe')?.getAttribute('src') ?? null);
      await stranger.goto(`${base}${board}`);
      const alone = await untilRedrawn(stranger);
      const source = await (await fetch(`${base}${board}`)).text();
      const quoted = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      await stranger.setContent(`<!doctype html><body style="margin: 0"><iframe sandbox="allow-scripts allow-popups" srcdoc="${quoted}" style="width: 100%; height: 700px; border: 0"></iframe></body>`);
      const held = await untilRedrawn(stranger);
      check(name, !!framed?.ok && !!alone?.ok && !!held?.ok,
        `and ${what}, shared, opened on its own and held in a srcdoc frame (${JSON.stringify([framed, alone, held])})`);
    }
  } catch (error) {
    check(name, false, `stopped: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

for (const name of wanted) await walk(name);
console.log(failed ? `\n${failed} thing(s) did not hold` : `\nboards hold in ${wanted.join(' and ')}`);
process.exit(failed ? 1 : 0);
