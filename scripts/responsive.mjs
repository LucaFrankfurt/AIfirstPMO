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
 *  - does a header scroll sideways on a screen that is not compact
 *  - has the screen's title been squeezed to nothing
 *  - has a field been squeezed to nothing
 *  - does any box scroll by a sliver on an axis nobody meant it to have
 *  - is anything absolute inside a scroller that does not hold it
 *  - does a board that should fill the screen leave `#content` anything to scroll
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
import { walkable } from './walk.mjs';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const STEP = Number(process.env.KOLIBRI_STEP ?? 20);
const widths = [];
for (let width = 340; width <= 1600; width += STEP) widths.push(width);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

// Signing in, the feature switches and the screen list live in `walk.mjs`,
// because `menus.mjs` walks exactly the same app and a second copy of this list
// would stop matching the first time somebody added a screen.
const SCREENS = await walkable(page, base);

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
 * **And a chasm**, which is the half this was missing. Anything over three
 * pixels was read as deliberate and waved through, so boxes scrolled sideways
 * with every check green: the wiki's aside by 49px, because `overflow-y: auto`
 * had quietly made its other axis `auto` too and a tree row was wider than the
 * column; `main` by 124px on a 340px phone, because the "recently edited" cards
 * are grid items, whose automatic minimum is their content — the title inside
 * truncated and the card did not; and `main` again by 4px with the mailbox
 * editor open, one pixel past the window above. None of them is a rounding
 * error and none of them showed up here.
 *
 * So sideways is reported at any size now, and the boxes that really do scroll
 * sideways are named rather than inferred from how far they scroll — which is
 * what `CLAUDE.md` asks for anyway: named exceptions, never counted
 * thresholds. The window above survives on the vertical axis, where the tab
 * strips it was written for still live.
 *
 * **The tab you are on.** A strip that scrolls can hold the active tab off the
 * end of itself: on a phone `?tab=settings` opened with the strip at zero, the
 * settings page below and no underline anywhere on screen.
 *
 * **Something absolute that a scroller does not hold.** An absolutely
 * positioned box is clipped by, and scrolls with, only the scrollers between
 * it and its containing block — the nearest positioned ancestor. A scroller
 * that is not positioned itself lets it straight through: it sits where it
 * would have been in the list, unclipped and unscrolled, and stretches
 * whichever scroller *does* hold it. That is how the board left the window.
 * The visually hidden "Overdue" on a card's date had `#content` for its
 * containing block, two scrollers out; forty overdue cards in one column made
 * a 700px screen 5219px tall, and scrolling the column to its end carried on
 * into `#content` and lifted the board off the top.
 *
 * Asked of the structure rather than of the damage, because the damage needs
 * data: the same card at the top of a column does no harm at all, and the
 * seed's columns are short. A box that is absolute inside a scroller which
 * does not hold it is reported wherever it stands.
 */
const oddities = () => {
  const out = [];
  /* The boxes that scroll sideways because somebody decided they should, each
     with the decision written beside its rule in `app.css`: a tab strip too
     long for a phone; a table, "the one layout that may be wider than the
     screen"; the planner's grid, which is a timeline; the header, which "on
     narrow screens scrolls instead of squeezing the title away" and hides its
     own scrollbar to do it; and the task board, whose columns are as many as
     the project has states and which snaps from one to the next. Found by
     measuring rather than guessed — anything not on this list scrolling
     sideways is a finding, however far it goes. */
  const MEANT_TO = ['tabs', 'table-wrap', 'planner-scroll', 'header', 'board'];
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const name = (el) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => '.' + c).join('')}`;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const y = el.scrollHeight - el.clientHeight;
    const x = el.scrollWidth - el.clientWidth;
    // #content is the page's vertical scroller; content a few px taller than the window is legitimate there.
    if (scrolls(cs.overflowY) && y > 0 && y <= 3 && el.id !== 'content') out.push(`${name(el)} scrolls ${y}px vertically`);
    if (scrolls(cs.overflowX) && x > 0 && !MEANT_TO.some((c) => el.classList.contains(c))) {
      out.push(`${name(el)} scrolls ${x}px sideways`);
    }
  }

  /* What makes a box a containing block for an absolute one: being positioned,
     and the handful of properties that make a box one without positioning it.
     A transform is the one this app actually uses. */
  const holds = (cs) => cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none'
    || cs.perspective !== 'none' || /layout|paint|strict|content/.test(cs.contain)
    || /transform|perspective|filter/.test(cs.willChange);
  for (const el of document.querySelectorAll('*')) {
    if (getComputedStyle(el).position !== 'absolute') continue;
    for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
      const cs = getComputedStyle(box);
      if (holds(cs)) break;
      if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) {
        out.push(`${name(el)} is absolute inside ${name(box)}, which scrolls but is not its containing block`);
        break;
      }
    }
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
  // Only #content scrolls; a scrolling document means a second scrollbar.
  if (doc.scrollHeight > doc.clientHeight + 1) out.push(`page scrolls vertically by ${doc.scrollHeight - doc.clientHeight}px (second scrollbar)`);

  const content = document.querySelector('#content');
  // A board is the screen it is on: it takes what `#content` has left, so
  // there is nothing over for `#content` to scroll. The board was sized from the
  // window rather than from `#content`, and ran 28px past it above a phone's tab
  // bar — enough that every column scrolled to its end took the board with it.
  if (content?.querySelector(':scope > .board-screen') && content.scrollHeight > content.clientHeight + 1) {
    out.push(`#content scrolls ${content.scrollHeight - content.clientHeight}px under a board that should fill it`);
  }

  // Anything sticky in #content must stop below its sticky header, not slide under it.
  const head = content?.querySelector(':scope > .header');
  if (head) {
    for (const el of content.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (el === head || cs.position !== 'sticky') continue;
      let box = el.parentElement;
      while (box && box !== content && !/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      if (box === content && parseFloat(cs.top) < head.offsetHeight - 0.5) {
        out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} sticks at ${cs.top}, under the ${head.offsetHeight}px header`);
      }
    }
  }

  const header = document.querySelector('.header');
  if (header) {
    const box = header.getBoundingClientRect();
    let content = 0;
    for (const child of header.children) content = Math.max(content, child.getBoundingClientRect().bottom - box.top);
    if (content > box.height + 2) out.push(`header is ${Math.round(content - box.height)}px taller than its own row`);

    const title = header.querySelector('h1');
    if (title && title.getBoundingClientRect().width < 8) out.push('title squeezed to nothing');

    /*
     * A header that scrolls where it was never meant to.
     *
     * The header is allowed to scroll sideways — on a phone, where its labels
     * have already turned into icons and there is still not room. Everywhere
     * else a header that scrolls is a header carrying too much, and the title
     * rule above cannot see it: the title has a 72px floor, so it is never
     * "nothing", only "Websit". Three screens did exactly this at 1024px — the
     * project, My work and the wiki, up to 347px past their room in German, and
     * 182px in English, which is what this walks in — with every check green.
     *
     * "Compact" is asked of the stylesheet rather than written down here: a
     * probe carrying `hide-sm` is hidden exactly where the container query
     * behind it says the screen is compact, so this cannot drift from the
     * threshold the app actually uses.
     */
    const main = document.querySelector('.main');
    if (main && header.scrollWidth > header.clientWidth + 1) {
      const probe = document.createElement('span');
      probe.className = 'hide-sm';
      main.appendChild(probe);
      const compact = getComputedStyle(probe).display === 'none';
      probe.remove();
      if (!compact) out.push(`header runs ${header.scrollWidth - header.clientWidth}px past its room on a screen that is not compact`);
    }

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
