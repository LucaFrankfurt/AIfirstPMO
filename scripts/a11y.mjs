/**
 * Can the interface be operated by somebody who is not using it the way it was
 * designed to be used.
 *
 * The three ways that goes wrong, and all three are here:
 *
 *  - **No name.** A button that is only an icon says nothing to a screen
 *    reader. `<button><Icon name="trash" /></button>` looks complete and reads
 *    as "button", which is the accessible-name failure that outnumbers every
 *    other one in every audit of every app.
 *  - **No keyboard.** A `<div onClick>` is a control the mouse can use and the
 *    keyboard cannot. Tab never lands on it, Enter never fires it, and there is
 *    nothing on screen to say so.
 *  - **No focus.** A control you *can* tab to, whose focus you cannot see, is a
 *    control you have lost track of. `outline: none` with nothing in its place
 *    is the whole of that bug.
 *
 * Everything measured here is measured in a real browser against the real
 * computed styles, for the same reason `contrast.mjs` is: "it has an aria-label
 * somewhere" is a claim about source, and what matters is what the accessibility
 * tree actually ends up holding.
 *
 * Deliberately not an axe-core wrapper. This project ships no runtime
 * dependencies and the checks worth having here are a page of code — and the
 * ones that matter for *this* app (an icon-button-dense project tool) are a
 * narrower and stricter set than a generic ruleset would apply.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL.
 * Run: node scripts/a11y.mjs
 */
import { chromium, devices } from 'playwright';
import { switchOnMail, openMailboxEditor } from './mail-fixture.mjs';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';

/**
 * Runs in the page. One line per problem, already deduplicated by shape.
 *
 * The accessible name is computed the way the spec computes it, in the order
 * the spec computes it: `aria-labelledby`, then `aria-label`, then the native
 * label or contents, then `title`. Short of that, an element with no name is
 * reported — and an element that is *hidden* from the tree is not, because
 * `aria-hidden` on a decorative icon is the correct answer rather than a bug.
 */
const PROBE = () => {
  const seen = new Set();
  const out = [];
  const say = (rule, el, detail) => {
    const where = `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? ` class="${el.className.slice(0, 52)}"` : ''}>`;
    const line = `${rule} · ${where}${detail ? ` · ${detail}` : ''}`;
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  /** Hidden from assistive technology on purpose, by itself or by an ancestor. */
  const hidden = (el) => {
    for (let node = el; node; node = node.parentElement) {
      if (node.getAttribute?.('aria-hidden') === 'true') return true;
      if (node.hasAttribute?.('inert')) return true;
    }
    return false;
  };

  const textOf = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  /** The name the accessibility tree would hold, near enough for this purpose. */
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf);
      if (parts.join(' ').trim()) return parts.join(' ').trim();
    }
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();

    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.id) {
        const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (tag && textOf(tag)) return textOf(tag);
      }
      const wrapping = el.closest('label');
      if (wrapping && textOf(wrapping)) return textOf(wrapping);
      const placeholder = el.getAttribute('placeholder');
      // A placeholder is a *fallback* name and disappears the moment somebody
      // types, so it counts as named-but-badly rather than named.
      if (placeholder && placeholder.trim()) return `placeholder:${placeholder.trim()}`;
    }

    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      return alt === null ? '' : alt.trim() || 'ALT-EMPTY';
    }

    // Contents, minus anything hidden from the tree — which is exactly the
    // decorative `<svg aria-hidden>` inside an icon button.
    const clone = el.cloneNode(true);
    for (const gone of clone.querySelectorAll('[aria-hidden="true"], svg, .sr-only + *')) {
      if (gone.getAttribute?.('aria-hidden') === 'true' || gone.tagName === 'svg') gone.remove();
    }
    const contents = textOf(clone);
    if (contents) return contents;

    const title = el.getAttribute('title');
    if (title && title.trim()) return `title:${title.trim()}`;
    return '';
  };

  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"]';

  /* ------------------------------------------------- 1. an accessible name */

  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el) || hidden(el)) continue;
    if (el.type === 'hidden') continue;
    const name = nameOf(el);
    if (!name) {
      say('unnamed', el, `role=${el.getAttribute('role') ?? el.tagName.toLowerCase()}`);
    } else if (name.startsWith('placeholder:')) {
      say('named only by its placeholder', el, name.slice(12).slice(0, 40));
    } else if (name.startsWith('title:')) {
      say('named only by its title attribute', el, name.slice(6).slice(0, 40));
    }
  }

  for (const el of document.querySelectorAll('img')) {
    if (!visible(el) || hidden(el)) continue;
    if (el.getAttribute('alt') === null) say('image with no alt attribute', el, (el.getAttribute('src') ?? '').slice(0, 40));
  }

  /* ---------------------------------------------- 2. reachable by keyboard */

  for (const el of document.querySelectorAll('[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="option"]')) {
    if (!visible(el) || hidden(el)) continue;
    if (el.matches('button, a[href], input, select, textarea')) continue;
    const index = el.getAttribute('tabindex');
    if (index === null) say('a control the keyboard cannot reach', el, `role=${el.getAttribute('role')}, no tabindex`);
  }

  // A positive tabindex reorders the whole document around one element, and
  // whoever added it almost never meant to.
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) say('positive tabindex', el, `tabindex=${el.getAttribute('tabindex')}`);
  }

  /* --------------------------------------------------- 3. visible on focus */

  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el) || hidden(el)) continue;
    if (el.getAttribute('tabindex') === '-1') continue;
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) continue;
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const ring = cs.boxShadow && cs.boxShadow !== 'none';
    if (!outline && !ring) say('focused and invisible', el, nameOf(el).slice(0, 36));
  }
  document.activeElement?.blur?.();

  /* ------------------------------------------------------ 4. the structure */

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((el) => visible(el) && !hidden(el));
  const levels = headings.map((el) => Number(el.tagName[1]));
  if (headings.length && !levels.includes(1)) out.push('no h1 · the page has headings but nothing at the top of them');
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      say('heading level skipped', headings[i], `h${levels[i - 1]} then h${levels[i]}: "${textOf(headings[i]).slice(0, 36)}"`);
    }
  }

  if (!document.querySelector('main, [role="main"]')) out.push('no main landmark · nothing says where the page content starts');
  if (!document.documentElement.getAttribute('lang')) out.push('no lang on <html> · a screen reader cannot choose a voice');

  const mains = document.querySelectorAll('main, [role="main"]');
  if (mains.length > 1) out.push(`${mains.length} main landmarks · there can be only one`);

  // Two landmarks of one kind need telling apart, or the rotor lists "navigation"
  // twice and neither entry says which.
  for (const kind of ['nav', 'aside']) {
    const all = [...document.querySelectorAll(kind)].filter(visible);
    if (all.length > 1) {
      for (const el of all) {
        if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
          say('one of several landmarks, unlabelled', el, kind);
        }
      }
    }
  }

  /* ----------------------------------------------------------- 5. the form */

  for (const el of document.querySelectorAll('label[for]')) {
    const id = el.getAttribute('for');
    if (id && !document.getElementById(id)) say('label points at nothing', el, `for="${id}"`);
  }

  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) if (count > 1) out.push(`duplicate id "${id}" · ${count} elements · a label can only reach one of them`);

  for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      const value = el.getAttribute(attribute);
      if (!value) continue;
      for (const id of value.split(/\s+/)) {
        if (id && !document.getElementById(id)) say(`${attribute} points at nothing`, el, id);
      }
    }
  }

  /* ------------------------------------------------------ 6. state and ARIA */

  const ALLOWED = {
    'aria-expanded': ['true', 'false'],
    'aria-pressed': ['true', 'false', 'mixed'],
    'aria-selected': ['true', 'false'],
    'aria-checked': ['true', 'false', 'mixed'],
    'aria-current': ['true', 'false', 'page', 'step', 'location', 'date', 'time'],
    'aria-hidden': ['true', 'false'],
    'aria-modal': ['true', 'false'],
    'aria-required': ['true', 'false'],
    'aria-invalid': ['true', 'false', 'grammar', 'spelling'],
    'aria-live': ['off', 'polite', 'assertive'],
  };
  for (const el of document.querySelectorAll('*')) {
    for (const [attribute, values] of Object.entries(ALLOWED)) {
      const value = el.getAttribute?.(attribute);
      if (value !== null && value !== undefined && !values.includes(value)) {
        say('ARIA attribute with a value that is not one of its values', el, `${attribute}="${value}"`);
      }
    }
  }

  // Focus inside something hidden from the tree is focus nobody can account for.
  for (const el of document.querySelectorAll('[aria-hidden="true"]')) {
    for (const inner of el.querySelectorAll(INTERACTIVE)) {
      if (visible(inner) && inner.getAttribute('tabindex') !== '-1' && !inner.disabled) {
        say('focusable inside aria-hidden', inner, nameOf(inner).slice(0, 30));
      }
    }
  }

  return out;
};

/** Big enough to hit. WCAG 2.2 AA says 24×24 as a minimum, and means it. */
const TARGETS = () => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    let box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    // Inline links inside a sentence are exempt in the spec, and rightly:
    // padding a link out to 24px tall would break the paragraph around it.
    if (el.tagName === 'A' && cs.display.startsWith('inline') && el.closest('p, li, .md')) continue;

    // The target is what you can hit, not what is drawn. A 15px checkbox in a
    // 24px wrapper that carries the click is a 24px target — measuring the
    // input alone would report a problem the spec does not have, and would
    // push somebody into drawing a bigger box to satisfy a script.
    const wrapper = el.parentElement;
    if (wrapper && getComputedStyle(wrapper).cursor === 'pointer' && wrapper.childElementCount === 1) {
      const outer = wrapper.getBoundingClientRect();
      if (outer.width <= 48 && outer.height <= 48) box = outer;
    }

    if (box.width < 24 || box.height < 24) {
      const line = `${Math.round(box.width)}×${Math.round(box.height)} · <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 48)}"> "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 26)}"`;
      if (!seen.has(line)) { seen.add(line); out.push(line); }
    }
  }
  return out;
};

/**
 * Tab all the way round and report what happened.
 *
 * Two questions, and the second is the one people never ask: does focus reach
 * anything at all, and — once a dialog is open — does it stay inside. Focus that
 * escapes a modal into the page behind it is a keyboard user reading a form they
 * cannot see and cannot get back out of.
 */
async function tabOrder(page) {
  const problems = [];
  const stops = [];
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className ?? '').slice(0, 40),
        name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none'),
        offscreen: el.getBoundingClientRect().bottom < 0 || el.getBoundingClientRect().top > innerHeight * 3,
      };
    });
    if (!at) break;
    stops.push(at);
  }
  if (!stops.length) problems.push('tab reached nothing at all');
  const blind = stops.filter((stop) => !stop.ring);
  if (blind.length) {
    problems.push(`${blind.length} of ${stops.length} tab stops show no focus ring`);
    for (const stop of blind.slice(0, 6)) problems.push(`    <${stop.tag} class="${stop.cls}"> "${stop.name}"`);
  }
  return problems;
}

/* ------------------------------------------------------------------ driver */

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const MODES = [
  ['desktop', { viewport: { width: 1400, height: 950 } }],
  ['mobile', { ...devices['iPhone 13'] }],
  // A short window, because height is what makes a column run out of room and
  // every flex child shrinks by default. The sidebar squashed its *New task*
  // button to 20px once a workspace had enough projects to overflow — a bug
  // that only shows on a laptop with a lot of projects, or on any laptop with
  // the window pulled up. This size finds it without needing either.
  ['short window', { viewport: { width: 1400, height: 560 } }],
];

let failures = 0;

for (const [label, options] of MODES) {
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });

  // The sign-in form is a screen too, and the first one anybody meets.
  const signIn = await page.evaluate(PROBE);
  if (signIn.length) {
    failures += signIn.length;
    console.log(`FAIL ${label} /login — ${signIn.length}`);
    for (const line of signIn.sort()) console.log(`       ${line}`);
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

  // Mail is off in a seeded workspace, so its two screens are unreachable
  // rather than merely unchecked. See `mail-fixture.mjs`.
  await switchOnMail(page);

  /*
   * A screen is a path, or a path and what to do once it has loaded.
   *
   * The second form exists for one screen. The mailbox editor is a fold, and
   * what this file looks for lives inside it: seven fields whose only name is
   * an `aria-label`, and a row of icon buttons — the exact shape that fails
   * the name rule most often, sitting behind one click nothing was making.
   */
  const SCREENS = ['/', `/projects/${project}`, '/inbox', '/search', '/chat', '/pages', '/teams', '/planner',
    '/portfolio', '/settings', '/settings?tab=members', '/settings?tab=data', '/settings?tab=instance',
    '/mail', ['/settings?tab=mailboxes', openMailboxEditor], '/guide'];

  const found = new Map();
  const small = new Map();

  for (const screen of SCREENS) {
    const [path, prepare] = Array.isArray(screen) ? screen : [screen];
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.keyboard.press('Escape');
    if (prepare) await prepare(page);
    await page.waitForTimeout(350);
    for (const hit of await page.evaluate(PROBE)) if (!found.has(hit)) found.set(hit, path);
    for (const hit of await page.evaluate(TARGETS)) if (!small.has(hit)) small.set(hit, path);
  }

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const order = await tabOrder(page);

  const total = found.size + small.size + order.length;
  failures += total;
  if (total) {
    console.log(`FAIL ${label} — ${found.size} tree, ${small.size} target, ${order.length} keyboard`);
    for (const [hit, where] of [...found].sort()) console.log(`       ${hit}\n           ${where}`);
    for (const [hit, where] of [...small].sort()) console.log(`       small target · ${hit}\n           ${where}`);
    for (const line of order) console.log(`       ${line}`);
  } else {
    console.log(`OK   ${label}`);
  }
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} accessibility problem(s)` : `\nnamed, reachable, and visible when focused — at all ${MODES.length} sizes`);
process.exit(failures ? 1 : 0);
