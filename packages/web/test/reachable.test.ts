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
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DESTINATIONS } from '../src/lib/nav.ts';

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
};

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
      ['components/AppShell.tsx', 'WORKSPACE_DESTINATIONS'],
      ['components/AppShell.tsx', 'PLANNING_DESTINATIONS'],
      ['routes/personal.tsx', 'DESTINATIONS'],
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
    for (const file of ['components/AppShell.tsx', 'routes/personal.tsx']) {
      const body = src(file);
      for (const path of paths) {
        assert.ok(
          !body.includes(`to="${path}"`),
          `${file} hard-codes a link to ${path}; it is in lib/nav.ts and both navigations render that`,
        );
      }
    }
  });
});
