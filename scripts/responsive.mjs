/**
 * Every screen, at every width, looking for a layout that has come apart.
 *
 * A screenshot proves one width. This walks from a small phone to a wide
 * desktop in 20px steps and asks the questions the eye would only catch by
 * accident — the list said "four" while carrying six, so it now carries no
 * count to go stale:
 *
 *  - does the page scroll sideways
 *  - is a bar that is one row tall taller than itself
 *  - does anything in the header reach down over the tab strip
 *  - has the screen's title been squeezed to nothing
 *  - has a field been squeezed to nothing
 *  - does any box scroll by a sliver on an axis nobody meant it to have
 *  - can you see which tab you are on
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
import { switchOnMail, openMailboxEditor } from './mail-fixture.mjs';

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

// Mail is off in a seeded workspace, so its two screens are not merely
// unchecked without this — they do not exist. See `mail-fixture.mjs`.
await switchOnMail(page);

const SCREENS = [
  ['my work', '/'],
  ['project', `/projects/${project}`],
  // The last tab of the widest strip: where the active one goes off the end.
  ['project: settings', `/projects/${project}?tab=settings`],
  ['inbox', '/inbox'],
  ['search', '/search?q=design'],
  ['chat', '/chat'],
  ['pages', '/pages'],
  ['teams', '/teams'],
  ['planner', '/planner'],
  ['portfolio', '/portfolio'],
  ['projects', '/projects'],
  ['settings', '/settings'],
  ['settings: members', '/settings?tab=members'],
  ['settings: data', '/settings?tab=data'],
  ['settings: server', '/settings?tab=instance'],
  // Behind the mail switch, and reached only because the fixture above turned
  // it on. The third entry is what to do once the screen has loaded: the
  // mailbox editor is a fold, and the row that came apart at 900px — a
  // `<select>` growing to "STARTTLS (143)" and squeezing the host field to two
  // pixels — is inside it. Checking the closed summary would have proved
  // nothing about the thing that broke.
  ['mail', '/mail'],
  ['settings: mailboxes', '/settings?tab=mailboxes', openMailboxEditor],
  ['guide', '/guide'],
];

/**
 * Runs in the page. Two questions that do not depend on the width, so they are
 * asked at a handful of them rather than at all sixty-four.
 *
 * **A sliver.** `overflow-x: auto` computes the other axis from `visible` to
 * `auto`, so a box that overflows by one pixel on an axis it was never meant to
 * scroll gets a full scrollbar. Every tab strip in the app had one, at every
 * width, desktop included — a pixel of the active underline hanging past the
 * box was enough. Three pixels is the line between "someone meant this" and
 * "something rounded wrong".
 *
 * **The tab you are on.** A strip that scrolls can hold the active tab off the
 * end of itself: on a phone `?tab=settings` opened with the strip at zero, the
 * settings page below and no underline anywhere on screen.
 */
const oddities = () => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const scrolls = (v) => v === 'auto' || v === 'scroll';
    const name = () => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => '.' + c).join('')}`;
    const y = el.scrollHeight - el.clientHeight;
    const x = el.scrollWidth - el.clientWidth;
    if (scrolls(cs.overflowY) && y > 0 && y <= 3) out.push(`${name()} scrolls ${y}px vertically`);
    if (scrolls(cs.overflowX) && x > 0 && x <= 3) out.push(`${name()} scrolls ${x}px sideways`);
  }

  for (const strip of document.querySelectorAll('.tabs')) {
    const active = strip.querySelector('.active');
    if (!active) continue;
    const box = strip.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.right < box.left + 1 || tab.left > box.right - 1) out.push(`the active tab "${active.textContent.trim()}" is outside its own strip`);
  }
  return [...new Set(out)];
};

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

  /*
   * A field squeezed to nothing.
   *
   * The title rule above has been here since the header bug and it only ever
   * looked at the `h1`. Nothing looked at a form control — and a form control
   * is where it happened next. The mailbox editor shipped with its host input
   * 22px wide, which is 10px of padding either side and a pixel of border
   * either side: a content box of exactly zero. This file walked that screen
   * and called it fine, because nothing overflowed.
   *
   * So this is a measurement rather than a threshold. A field with less room
   * inside it than one character of its own text is a field nobody can read
   * what they typed into. Measured across the app the narrowest legitimate
   * field has 40px of room against a 13.5px character, so there is no line here
   * to tune — only a floor nothing sound goes near.
   */
  for (const field of document.querySelectorAll('input, select, textarea')) {
    const type = (field.getAttribute('type') ?? '').toLowerCase();
    // Controls that are meant to be small and hold no text of their own.
    if (['checkbox', 'radio', 'color', 'range', 'hidden', 'file'].includes(type)) continue;
    const cs = getComputedStyle(field);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const box = field.getBoundingClientRect();
    // A box with no size at all is a control being hidden on purpose — the
    // trick behind every custom file picker — not one that came apart.
    if (box.width < 1 || box.height < 1) continue;
    const room = field.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (room < parseFloat(cs.fontSize)) {
      // Named, because a screen has many fields and "an input is too narrow"
      // sends whoever reads this to look for it by hand.
      const label = field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.getAttribute('name');
      out.push(`${field.tagName.toLowerCase()} ${label ? `"${label}"` : `[type=${type || 'text'}]`} has ${Math.round(room)}px of room inside it`);
    }
  }
  return out;
};

let failures = 0;
for (const [name, path, prepare] of SCREENS) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.keyboard.press('Escape');
  // Opened once, at the widest size, and left open: what follows only resizes,
  // so the fold stays unfolded across every width below.
  if (prepare) await prepare(page);
  const bad = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // Long enough for a media or container query to settle and React to paint.
    await page.waitForTimeout(60);
    const complaints = await page.evaluate(inspect);
    if (complaints.length) bad.push(`${width}px: ${complaints.join('; ')}`);
  }
  // The width-independent pair, asked where the layout actually changes shape.
  for (const width of [widths[0], 900, widths.at(-1)]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(80);
    for (const complaint of await page.evaluate(oddities)) bad.push(`${width}px: ${complaint}`);
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
