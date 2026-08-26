/**
 * Can every word actually be read — in both themes, on a phone and on a desktop.
 *
 * Colour is the one part of an interface where "it looks fine to me" is worth
 * nothing: the person who picked the grey could read it, and roughly one reader
 * in twenty could not. So this measures rather than looks. For every element
 * that renders text it computes the real background — walking up through
 * transparency and blending as it goes — and the WCAG contrast against it.
 *
 * What it found the first time it ran, all of it there since long before:
 *
 *  - `--fg-muted` at 3.20 on white and 2.88 on a hovered row. That is most of
 *    the secondary text in the app, including tab labels.
 *  - The status colours never re-stepped for dark. Red was 3.06 against the
 *    dark page, green 3.92 — inherited straight from the light theme.
 *  - Avatar initials at a fixed 52% lightness: 6.7:1 on a blue avatar and
 *    1.6:1 on a yellow-green one, from the same line of code.
 *  - White text on `var(--accent)`, which is 5.4 in light and 3.5 in dark.
 *
 * A note for whoever changes this next: `color-mix()` computes to
 * `color(srgb 1 1 1 / .88)`, whose channels run 0..1 rather than 0..255. Read
 * as bytes, white becomes near-black — this probe "found" twenty unreadable
 * headings that way before the parser learned the difference.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL.
 * Run: node scripts/contrast.mjs
 */
import { chromium, devices } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';

/**
 * Runs in the page. Returns one line per element under the floor.
 *
 * The floor is WCAG AA: 4.5:1 for body text, 3:1 for large text — 24px, or
 * 18.66px when it is bold.
 */
const PROBE = () => {
  const parse = (c) => {
    if (!c || c === 'transparent') return null;
    const m = c.match(/[\d.]+/g);
    if (!m) return null;
    // `color-mix()` computes to `color(srgb 1 1 1 / .88)` — channels 0..1, not
    // 0..255. Reading those as bytes turns white into near-black, which is how
    // this probe first "found" twenty unreadable headings that were fine.
    const unit = c.startsWith('color(') ? 255 : 1;
    return { r: +m[0] * unit, g: +m[1] * unit, b: +m[2] * unit, a: m[3] === undefined ? 1 : +m[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const backdrop = (el) => {
    let node = el, acc = null;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return acc; }
      node = node.parentElement;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, root) : root;
  };

  const out = [];
  for (const el of document.querySelectorAll('*')) {
    // Only elements that themselves render text.
    const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = backdrop(el);
    const r = ratio(over(fg, bg), bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    if (r < need) {
      out.push(`${r.toFixed(2)} (needs ${need}) · ${cs.fontSize} ${cs.color} on ${`rgb(${Math.round(bg.r)} ${Math.round(bg.g)} ${Math.round(bg.b)})`} · <${el.tagName.toLowerCase()} class="${el.className.toString().slice(0, 44)}"> "${text.slice(0, 34)}"`);
    }
  }
  return [...new Set(out)];
};

const MODES = [
  ['desktop light', { viewport: { width: 1400, height: 950 }, colorScheme: 'light' }],
  ['desktop dark', { viewport: { width: 1400, height: 950 }, colorScheme: 'dark' }],
  ['mobile light', { ...devices['iPhone 13'], colorScheme: 'light' }],
  ['mobile dark', { ...devices['iPhone 13'], colorScheme: 'dark' }],
];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;

for (const [label, options] of MODES) {
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });

  /*
   * The sign-in screen, before signing in.
   *
   * Every walk in this file used to start by getting past this page, which
   * made it the one screen a stranger sees and the one screen nothing checked.
   * That mattered little while it was a white card; it matters now that it
   * carries a panel whose colours are fixed rather than tokenised — those are
   * not covered by re-stepping a token, so they have to be read off the pixels
   * like everything else.
   *
   * Both modes it can be in: the form as it opens, and the form with the other
   * one showing, because the register side has fields and a hint the sign-in
   * side does not.
   */
  const auth = new Map();
  for (const hit of await page.evaluate(PROBE)) if (!auth.has(hit)) auth.set(hit, '/login');
  const swap = page.locator('.auth-switch').first();
  if (await swap.count()) {
    await swap.click();
    await page.waitForTimeout(300);
    for (const hit of await page.evaluate(PROBE)) if (!auth.has(hit)) auth.set(hit, '/login (register)');
    await page.locator('.auth-switch').first().click();
    await page.waitForTimeout(300);
  }
  if (auth.size) {
    failures += auth.size;
    console.log(`FAIL ${label} /login — ${auth.size} below the floor`);
    for (const [hit, where] of [...auth].sort()) console.log(`       ${hit}\n           ${where}`);
  }

  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.header', { timeout: 20000 });
  await page.keyboard.press('Escape');

  const project = await page.evaluate(async () => {
    const workspace = localStorage.getItem('kolibri.workspace');
    const body = await (await fetch(`/api/workspaces/${workspace}/projects`, { credentials: 'include' })).json();
    return (body.projects ?? body)[0]?.id;
  });

  const found = new Map();
  for (const path of ['/', `/projects/${project}`, '/inbox', '/search?q=design', '/chat', '/pages', '/teams', '/planner',
    '/portfolio', '/settings', '/settings?tab=members', '/settings?tab=data', '/guide']) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    for (const hit of await page.evaluate(PROBE)) if (!found.has(hit)) found.set(hit, path);
  }

  if (found.size) {
    failures += found.size;
    console.log(`FAIL ${label} — ${found.size} below the floor`);
    for (const [hit, where] of [...found].sort()) console.log(`       ${hit}\n           ${where}`);
  } else {
    console.log(`OK   ${label}`);
  }
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} unreadable place(s)` : '\nevery word clears the contrast floor, in both themes, on both sizes');
process.exit(failures ? 1 : 0);
