/**
 * The three questions a built site has to answer before it is deployed.
 *
 * These exist for the same reason `scripts/responsive.mjs`, `contrast.mjs` and
 * `unstyled.mjs` exist in this repository: "the grey is fine" and "it looks
 * right on my screen" are both claims that have been wrong here, and neither
 * can be settled by reading the source. So each is asked of a real browser
 * against the real output.
 *
 *   node sites/check.mjs docs/dist                 links only, no browser needed
 *   node sites/check.mjs docs/dist http://…        + widths and contrast
 *
 * 1. **Links.** Every internal href resolves to a file that exists. A docs
 *    site whose cross-references 404 is worse than one with fewer pages.
 * 2. **Widths.** 340px to 1600px in 20px steps, looking for a page that
 *    scrolls sideways. The repository's own check found a layout that came
 *    apart between 880 and 940 — a window nobody happened to open.
 * 3. **Contrast.** Every element that renders text, in both themes, against
 *    the real background — walked up through transparency and blended as it
 *    goes. The floor is 4.5:1, or 3:1 for large text.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const origin = process.argv[3] ?? '';
if (!existsSync(dist)) {
  console.error(`No such directory: ${dist}`);
  process.exit(2);
}

const pages = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.html')) pages.push(path);
  }
})(dist);

const route = (file) => file.slice(dist.length).replace(/\/index\.html$/, '/').replace(/^$/, '/');
let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`  ✗ ${message}`);
};

/* ------------------------------------------------------------------ links */

console.log(`\nLinks — ${pages.length} pages`);
const broken = new Set();
for (const file of pages) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/href="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) {
    const href = match[1];
    if (href.startsWith('/_astro/') || href.startsWith('/pagefind/')) continue;
    const target = join(dist, href);
    if (existsSync(target) || existsSync(`${target}.html`) || existsSync(join(target, 'index.html'))) {
      continue;
    }
    broken.add(`${route(file)} → ${href}`);
  }
}
for (const one of broken) fail(one);
if (!broken.size) console.log(`  ✓ every internal link resolves`);

/* Everything below needs a browser and a server. */
if (!origin) {
  console.log('\nNo origin given — skipping the browser checks.');
  console.log('  Serve the directory and pass its URL:  node sites/check.mjs dist http://127.0.0.1:4300');
  process.exit(failures ? 1 : 0);
}

/*
 * Playwright is loaded here rather than at the top, and that is the whole
 * reason the link check above can run on its own.
 *
 * A static `import` is hoisted and resolved before any of this file executes,
 * so a top-level one made "links only" a lie: CI runs that mode first,
 * deliberately, before anything installs a browser — and the step died on a
 * package it never uses. The failure named `playwright` while the check that
 * failed had nothing to do with a browser, which is the kind of error message
 * that costs somebody twenty minutes.
 */
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('\nThe browser checks need Playwright:  npm install --no-save playwright');
  console.error('Or drop the origin argument to run the link check on its own.');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

/* ----------------------------------------------------------------- widths */

console.log(`\nWidths — 340px to 1600px in 20px steps`);
{
  const page = await browser.newPage();
  for (const file of pages) {
    const url = origin.replace(/\/$/, '') + route(file);
    await page.goto(url, { waitUntil: 'networkidle' });
    for (let width = 340; width <= 1600; width += 20) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) {
        // Name the widest element sticking out, or the report is a number
        // nobody can act on.
        const culprit = await page.evaluate(() => {
          const limit = document.documentElement.clientWidth;
          for (const element of document.querySelectorAll('body *')) {
            const box = element.getBoundingClientRect();
            if (box.right > limit + 1 && box.width > 0) {
              return `${element.tagName.toLowerCase()}.${(element.className || '').toString().split(' ')[0]} (right ${Math.round(box.right)})`;
            }
          }
          return 'nothing measurable';
        });
        fail(`${route(file)} scrolls sideways at ${width}px by ${overflow}px — ${culprit}`);
        break;
      }
    }
  }
  await page.close();
  if (!failures) console.log(`  ✓ nothing scrolls sideways`);
}

/* --------------------------------------------------------------- contrast */

console.log(`\nContrast — light and dark, floor 4.5:1 (3:1 for large text)`);
const before = failures;
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('kolibri-theme', value);
      localStorage.setItem('starlight-theme', value);
    } catch {
      /* A browser with site data blocked still gets the attribute below. */
    }
  }, theme);

  for (const file of pages) {
    await page.goto(origin.replace(/\/$/, '') + route(file), { waitUntil: 'networkidle' });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);

    const bad = await page.evaluate(() => {
      const linear = (channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]) =>
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      /* Normalise any CSS colour by painting it, rather than by parsing the
         string. `getComputedStyle` hands back whatever syntax the value was
         written in — `rgba(…)` for a plain colour but `color(srgb 1 1 1 /
         0.88)` for a `color-mix`, whose channels are 0–1 rather than 0–255.
         Read as the former, the site's own header came back as near-black and
         this check reported five failures that were its own. The canvas is the
         browser's colour parser, so there is no second implementation to be
         wrong. */
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const cache = new Map();
      const parse = (value) => {
        if (!value) return null;
        if (cache.has(value)) return cache.get(value);
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        // An unparseable value leaves fillStyle at the previous one; a fully
        // transparent one paints nothing, which reads back as alpha 0.
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        /* `getImageData` is specified to return *non*-premultiplied channels,
           so they are already the colour as written and dividing by alpha
           would over-correct. Read the other way round, a 12%-alpha tint over
           a dark aside came back as a light grey background, and this check
           reported five pieces of perfectly legible text as invisible. */
        const out = [r, g, b, a / 255];
        cache.set(value, out);
        return out;
      };
      /* The real background: walk up through anything transparent, blending
         as it goes, because `contrast against rgba(0,0,0,0)` is meaningless. */
      const backgroundOf = (element) => {
        let stack = [255, 255, 255];
        const chain = [];
        for (let node = element; node; node = node.parentElement) chain.unshift(node);
        for (const node of chain) {
          const colour = parse(getComputedStyle(node).backgroundColor);
          if (!colour || colour[3] === 0) continue;
          const alpha = colour[3];
          stack = stack.map((base, i) => colour[i] * alpha + base * (1 - alpha));
        }
        return stack;
      };
      const ratio = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };

      const found = [];
      for (const element of document.querySelectorAll('body *')) {
        const text = [...element.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join('');
        if (!text) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height) continue;

        const colour = parse(style.color);
        if (!colour || colour[3] === 0) continue;
        const background = backgroundOf(element);
        // Text with its own alpha is blended onto that background too.
        const ink = colour.slice(0, 3).map((c, i) => c * colour[3] + background[i] * (1 - colour[3]));

        const size = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const floor = large ? 3 : 4.5;
        const value = ratio(ink, background);
        if (value < floor) {
          found.push({
            text: text.slice(0, 44),
            ratio: Math.round(value * 100) / 100,
            floor,
            selector: `${element.tagName.toLowerCase()}.${(element.className || '').toString().split(' ')[0]}`,
          });
        }
      }
      return found;
    });

    for (const one of bad) {
      fail(`${theme} ${route(file)} — ${one.ratio}:1 (needs ${one.floor}) on ${one.selector} "${one.text}"`);
    }
  }
  await page.close();
}
if (failures === before) console.log(`  ✓ every piece of text clears the floor`);

await browser.close();
console.log(failures ? `\n${failures} problem(s).` : `\nAll clear.`);
process.exit(failures ? 1 : 0);
