/**
 * Every screen, at every width, looking for a layout that has come apart.
 *
 * A screenshot proves one width. This walks from a small phone to a wide
 * desktop in 20px steps and asks four questions the eye would have to catch by
 * accident:
 *
 *  - does the page scroll sideways
 *  - is a bar that is one row tall taller than itself
 *  - does anything in the header reach down over the tab strip
 *  - has the screen's title been squeezed to nothing
 *
 * The bug that prompted it lived between 900 and 940 pixels — the band where
 * the sidebar has appeared and taken 248px but the header still thought it had
 * a whole window. The controls wrapped onto a second row and drew over the
 * tabs, and the title collapsed to zero. Nobody would find that by resizing.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL.
 * Run: node scripts/responsive.mjs
 */
import { chromium } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const STEP = Number(process.env.KOLIBRI_STEP ?? 20);
const widths = [];
for (let width = 340; width <= 1600; width += STEP) widths.push(width);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

await page.goto(base, { waitUntil: 'networkidle' });
await page.fill('#email', 'ada@kolibri.dev');
await page.fill('#password', 'kolibri-demo');
await page.click('button[type=submit]');
await page.waitForSelector('.sidebar', { timeout: 15000 });
await page.keyboard.press('Escape');

const project = await page.evaluate(async () => {
  const workspace = localStorage.getItem('kolibri.workspace');
  const body = await (await fetch(`/api/workspaces/${workspace}/projects`, { credentials: 'include' })).json();
  return (body.projects ?? body)[0]?.id;
});

const SCREENS = [
  ['my work', '/'],
  ['project', `/projects/${project}`],
  ['inbox', '/inbox'],
  ['chat', '/chat'],
  ['pages', '/pages'],
  ['teams', '/teams'],
  ['planner', '/planner'],
  ['portfolio', '/portfolio'],
  ['projects', '/projects'],
  ['settings', '/settings'],
  ['settings: members', '/settings?tab=members'],
  ['settings: data', '/settings?tab=data'],
  ['guide', '/guide'],
];

/** Runs in the page. Returns the complaints, or an empty list. */
const inspect = () => {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);

  const header = document.querySelector('.header');
  if (header) {
    const box = header.getBoundingClientRect();
    let content = 0;
    for (const child of header.children) content = Math.max(content, child.getBoundingClientRect().bottom - box.top);
    if (content > box.height + 2) out.push(`header is ${Math.round(content - box.height)}px taller than its own row`);

    const title = header.querySelector('h1');
    if (title && title.getBoundingClientRect().width < 8) out.push('title squeezed to nothing');

    // A screen can carry its tabs *inside* the header — the inbox's
    // unread/all switch does — and a header child sitting on top of another
    // header child is not the failure being looked for.
    const tabs = document.querySelector('.tabs');
    if (tabs && !header.contains(tabs)) {
      const top = tabs.getBoundingClientRect().top;
      for (const child of header.children) {
        const rect = child.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > top + 2) { out.push('a header control reaches over the tab strip'); break; }
      }
    }
  }
  return out;
};

let failures = 0;
for (const [name, path] of SCREENS) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.keyboard.press('Escape');
  const bad = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // Long enough for a media or container query to settle and React to paint.
    await page.waitForTimeout(60);
    const complaints = await page.evaluate(inspect);
    if (complaints.length) bad.push(`${width}px: ${complaints.join('; ')}`);
  }
  if (bad.length) {
    failures += bad.length;
    // Only the ends of a run matter; a hundred consecutive bad widths is one bug.
    const shown = bad.length > 6 ? [...bad.slice(0, 3), `… ${bad.length - 6} more …`, ...bad.slice(-3)] : bad;
    console.log(`FAIL ${name}\n       ${shown.join('\n       ')}`);
  } else {
    console.log(`OK   ${name} — ${widths[0]}px to ${widths.at(-1)}px`);
  }
}

await browser.close();
console.log(failures ? `\n${failures} broken width(s)` : `\nevery screen holds together at every width from ${widths[0]}px to ${widths.at(-1)}px`);
process.exit(failures ? 1 : 0);
