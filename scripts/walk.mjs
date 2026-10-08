/**
 * Signing in, switching the optional features on, and the list of screens.
 *
 * Extracted because two checks walk the same app: `responsive.mjs` asks whether
 * every screen holds together at every width, and `menus.mjs` asks whether the
 * menus on it fit. Written twice, the two lists would have drifted the first
 * time somebody added a screen — and the one that is never updated is the one
 * that silently stops checking the new thing.
 *
 * The fixtures are not optional furniture. Mail, decisions, the vault and the
 * catalogue are switched off in a seeded workspace, so without them those
 * screens do not merely go unchecked: they do not exist.
 */
import { switchOnMail, openMailboxEditor } from './mail-fixture.mjs';
import { switchOnDecisions } from './ballot-fixture.mjs';
import { switchOnVault } from './vault-fixture.mjs';
import { switchOnProducts } from './catalogue-fixture.mjs';

/** Sign in, switch everything on, and say what there is to walk. */
export async function walkable(page, base) {
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
  await switchOnDecisions(page);
  await switchOnVault(page);
  await switchOnProducts(page);

  /*
   * A product to open, because `/products` alone was never enough.
   *
   * The list is one table; the *detail* is four more — prices, costs, parts and
   * the people on it — and each carries the column you act from. None of them
   * had ever been walked at any width, which is how six tables shipped with
   * their Edit and Delete buttons cut off on a phone and every check still
   * green. A screen nobody measures is a screen nobody has checked.
   */
  const productId = await page.evaluate(async () => {
    const workspace = localStorage.getItem('kolibri.workspace');
    const body = await (await fetch(`/api/workspaces/${workspace}/products`, { credentials: 'include' })).json();
    return (body.products ?? body)[0]?.id;
  });
  if (!productId) throw new Error('no product to open — the catalogue fixture found nothing to walk');

  /* The package is a different product from the first one, and its own tab: the
     parts table plus the per-period comparison, which only renders for a package
     billed more than one way. See `catalogue-fixture.mjs`. */
  const packageId = await page.evaluate(async () => {
    const workspace = localStorage.getItem('kolibri.workspace');
    const body = await (await fetch(`/api/workspaces/${workspace}/products`, { credentials: 'include' })).json();
    return (body.products ?? body).find((row) => row.kind === 'bundle')?.id;
  });
  if (!packageId) throw new Error('no package to open — the catalogue fixture built none');

  /*
   * A page to open, because the *detail* is the screen that grew an aside.
   *
   * From 1280px the tree sits beside the text, which is a flex row holding a
   * fixed column and a measured one — and the whole promise of it is that the
   * reading column is not narrowed to make room. That promise is a width
   * question, so it belongs to this script rather than to a walkthrough that
   * only ever opens one size.
   */
  const pageId = await page.evaluate(async () => {
    const workspace = localStorage.getItem('kolibri.workspace');
    const body = await (await fetch(`/api/workspaces/${workspace}/pages`, { credentials: 'include' })).json();
    return (body.pages ?? body)[0]?.id;
  });
  if (!pageId) throw new Error('no page to open — the seed built none');

  const SCREENS = [
    ['my work', '/'],
    ['project', `/projects/${project}`],
    // The last tab of the widest strip: where the active one goes off the end.
    ['project: settings', `/projects/${project}?tab=settings`],
    ['inbox', '/inbox'],
    ['search', '/search?q=design'],
    ['chat', '/chat'],
    ['pages', '/pages'],
    // Four counts in a row, a path beside every title, and a bar that may be up:
    // the densest row this wiki draws, and the one most likely to come apart.
    ['pages: tidying up', '/pages/tidy'],
    ['page', `/pages/${pageId}`],
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
    // Behind the decisions switch, and reached only because the fixture above
    // turned it on. The ballot is a row that has to hold a mark, a label that can
    // wrap, and a count — at 340px, where a label of any length is the thing that
    // pushes the count off the edge.
    // Behind the products switch, and reached only because the fixture above
    // turned it on. The catalogue is the widest table in the app — a name, a
    // chip, a price, a cost, a margin, a break-even and a standing pill — which
    // at 340px is the case that decides which columns survive and which fold.
    ['products', '/products'],
    // The packages, which are the catalogue's other half: same table, two more
    // columns, and the rows that carry the most chips.
    ['products: packages', '/products?tab=packages'],
    // And the densest form anywhere here: six numeric fields in one row, which
    // is where a `field-row` either wraps or squeezes each box to nothing.
    ['products: simulation', '/products?tab=scenarios'],
    // The vocabulary, whose two widest columns are lists of product names that
    // grow with the catalogue rather than with the design.
    ['products: capabilities', '/products?tab=capabilities'],
    // The two detail tabs that carry rows *and* the column you act from. Prices
    // is the widest of them — a name, a kind, an amount, a threshold, a period,
    // a term and a window before the buttons even start.
    ['product: prices', `/products/${productId}?tab=prices`],
    ['product: costs', `/products/${productId}?tab=costs`],
    // The package tab, whose per-period table compares one billing period at a
    // time — four money columns, two of which a phone drops.
    ['product: package', `/products/${packageId}?tab=package`],
    ['decisions', '/decisions'],
    // Behind the secrets switch, and the widest row on any screen: a name, an
    // environment, a strength pill, a rotation state and two icon buttons, which
    // at 340px is the case that decides whether a table folds or overflows.
    ['secrets', '/secrets'],
    ['guide', '/guide'],
  ];

  return SCREENS;
}
