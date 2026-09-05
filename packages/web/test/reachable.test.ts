/**
 * Can a phone get there?
 *
 * This reads the source rather than running it, for the same reason
 * `forms.test.ts` does: the failure is invisible at runtime. Nothing throws,
 * no route 404s, the screen renders perfectly if you type the address — there
 * is simply no link to it on the device most people are holding.
 *
 * It has happened twice. Chat was desktop-only for a while. Then budgets, the
 * timesheet and the infrastructure register shipped, were switched on in a
 * real workspace, appeared in the sidebar, and were reported missing from the
 * phone the same day — because the sidebar and the "More" screen were two
 * hand-written lists of JSX and only one of them had been remembered.
 *
 * So `lib/nav.ts` holds the set and both navigations render it, and this test
 * holds the line: every top-level route the router registers is either in that
 * list, in the phone's bottom bar, or named below with the reason it is
 * reached some other way. Adding a screen without a way to it now fails here
 * rather than in somebody's hand.
 *
 * The second half of this file asks the mirror question, and it was added
 * because the answer was no six times over. A project, a cycle, a milestone, a
 * KPI, a budget and a page could each be opened from a link, a search result or
 * a bookmark, and none of them said where it sat or offered a way back to its
 * list — the only route out was the sidebar, which on a phone means opening the
 * menu to leave a document. Six screens with one gap is a missing piece of
 * furniture rather than six oversights, so there is a `Trail` now, and this is
 * what keeps the seventh screen from shipping without one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DESTINATIONS } from '../src/kernel/design-system/nav.ts';

const src = (file: string): string =>
  readFileSync(new URL(`../src/${file}`, import.meta.url).pathname, 'utf8');

/** The five things the bottom bar has room for. */
const TAB_BAR = ['/', '/inbox', '/chat', '/search', '/more'];

/**
 * Routes reached some other way, each with the way written down.
 *
 * A short list on purpose. "It is linked from somewhere" is the excuse that
 * lets the next screen through, so an entry here has to name the somewhere.
 */
const REACHED_ELSEWHERE: Record<string, string> = {
  '/portfolio': 'both navigations, but only where there is more than one project',
  '/projects': 'the guide links to it twice; the navigations list the projects themselves',
  '/projects/new': 'the More screen and the sidebar’s + beside the projects heading',
  '/settings/*': 'the More screen and the account menu',
  '/pages/new': 'a `[[link]]` to a page nobody has written, and the wiki index’s list of those',
};

/**
 * Detail screens that get out some other way, each with the way written down.
 *
 * The same rule as `REACHED_ELSEWHERE` above: an entry has to name the
 * somewhere, because "it is reachable somehow" is the excuse that lets the next
 * dead end through.
 */
const LEAVES_ELSEWHERE: Record<string, string> = {
  '/chat/:id': 'a back arrow in its own header, and from 900px the channel list is beside it',
  '/t/:id': 'a sheet over whatever you were reading, closed rather than navigated away from',
  '/pages/new': 'never rendered — it creates the page and redirects in an effect',
  '/invite/:code': 'signed out, where there is nowhere else to be',
};

/** Every `<Route path="/x/:id" element={<Component />}>` the router registers. */
function details(): { path: string; component: string }[] {
  return [...src('App.tsx').matchAll(/<Route\s+path="([^"]*\/(?::\w+|new))"\s+element=\{<(\w+)/g)]
    .map((match) => ({ path: match[1], component: match[2] }));
}

/**
 * The file a route component comes from.
 *
 * Two shapes, because the router uses both: a plain import for the screens the
 * first paint needs, and `lazy(() => import(…))` for the ones behind a feature
 * switch. Looking for only the first is how this test spent its first run
 * insisting that `App.tsx` does not import `KpiDetail`.
 */
function fileOf(component: string): string {
  const app = src('App.tsx');
  const lazily = new RegExp(`const ${component} = lazy\\(\\(\\) => import\\('\\./([^']+)'`).exec(app);
  const plainly = new RegExp(`import \\{[^}]*\\b${component}\\b[^}]*\\} from '\\./([^']+)'`).exec(app);
  const found = lazily ?? plainly;
  assert.ok(found, `App.tsx does not import ${component}`);
  return `${found![1]}.tsx`;
}

/** Every `path="…"` the signed-in router registers. */
function routes(): string[] {
  const app = src('App.tsx');
  return [...app.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => path !== '*' && !path.includes(':'));
}

describe('every screen has a way to it', () => {
  it('finds the router, so a rename cannot make this test vacuous', () => {
    const found = routes();
    assert.ok(found.length > 10, `expected the route table, found ${found.length} paths`);
    assert.ok(found.includes('/budgets'), 'expected /budgets among the routes');
  });

  it('reaches every top-level route from the phone', () => {
    const linked = new Set([...TAB_BAR, ...DESTINATIONS.map((item) => item.to)]);
    const orphans = routes().filter((path) => !linked.has(path) && !(path in REACHED_ELSEWHERE));
    assert.deepEqual(
      orphans,
      [],
      `no link on a phone to: ${orphans.join(', ')}. Add it to WORKSPACE_DESTINATIONS or `
      + 'PLANNING_DESTINATIONS in lib/nav.ts — both navigations render those — or to '
      + 'REACHED_ELSEWHERE in this test, with the way it is reached.',
    );
  });

  it('renders the shared list on both navigations rather than repeating it', () => {
    // The two surfaces are allowed to differ in shape and order. What they are
    // not allowed to do is decide for themselves what is in the app.
    for (const [file, list] of [
      ['AppShell.tsx', 'WORKSPACE_DESTINATIONS'],
      ['AppShell.tsx', 'PLANNING_DESTINATIONS'],
      ['modules/work/routes/personal.tsx', 'DESTINATIONS'],
    ] as const) {
      assert.match(src(file), new RegExp(`\\b${list}\\b`), `${file} should render ${list}`);
    }
  });

  it('does not hard-code a destination that the list already carries', () => {
    /*
     * The regression this file exists for, stated directly: a `to="/budgets"`
     * typed into one navigation and not the other. Anything in the shared list
     * has to come *from* the shared list on both surfaces.
     */
    /* The bottom bar's five are exempt: they are a fixed set with their own
       short labels and unread dots, hard-coded because they are the one part
       of the navigation that cannot grow. */
    const paths = DESTINATIONS.map((item) => item.to).filter((path) => !TAB_BAR.includes(path));
    for (const file of ['AppShell.tsx', 'modules/work/routes/personal.tsx']) {
      const body = src(file);
      for (const path of paths) {
        assert.ok(
          !body.includes(`to="${path}"`),
          `${file} hard-codes a link to ${path}; it is in kernel/design-system/nav.ts and both navigations render that`,
        );
      }
    }
  });
});

/**
 * Can it get back?
 *
 * Asserted over the source for the same reason as everything above: a detail
 * screen with no way out renders perfectly, throws nothing, and is only found
 * by somebody stuck on it. The check is coarse on purpose — that the file
 * renders a `Trail` at all — because the alternative is asserting about JSX
 * structure, which breaks on every refactor and teaches people to delete the
 * test rather than fix the screen.
 */
describe('every detail screen has a way back', () => {
  it('finds the detail routes, so a rename cannot make this vacuous', () => {
    const found = details().map((one) => one.path);
    assert.ok(found.length > 4, `expected the detail routes, found ${found.join(', ')}`);
    assert.ok(found.includes('/pages/:id'), 'expected /pages/:id among them');
  });

  it('draws a trail on each of them', () => {
    const missing = details()
      .filter((one) => !(one.path in LEAVES_ELSEWHERE))
      .filter((one) => !src(fileOf(one.component)).includes('<Trail'))
      .map((one) => `${one.path} (${one.component})`);
    assert.deepEqual(
      missing,
      [],
      `no way back from: ${missing.join(', ')}. Render a <Trail> from `
      + 'kernel/design-system/chrome, or add the route to LEAVES_ELSEWHERE in this test '
      + 'with the way it is left.',
    );
  });

  it('offers the way out on the screen for a thing that is gone, too', () => {
    // A deleted project, cycle, milestone, KPI, budget or page still opens from
    // a bookmark or somebody else's link, and every one of those screens was a
    // dead end: an emoji, a sentence, and nothing to press.
    for (const { path, component } of details()) {
      if (path in LEAVES_ELSEWHERE) continue;
      const source = src(fileOf(component));
      const notFound = [...source.matchAll(/<Empty\b[\s\S]{0,400}?\/>/g)]
        .filter((match) => /🕳️|notFound|\.gone/.test(match[0]));
      assert.ok(notFound.length, `${component} has no "it is gone" screen to check`);
      for (const match of notFound) {
        assert.match(match[0], /action=/, `${component}: an empty screen for a missing thing needs a way out`);
      }
    }
  });
});
