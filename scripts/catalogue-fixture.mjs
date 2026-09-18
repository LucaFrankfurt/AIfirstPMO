/**
 * The setup the three browser checks need before a product screen exists.
 *
 * The ballot fixture next door explains why this file has to exist at all: a
 * seeded workspace has every switch **off**, so a feature-gated screen left out
 * of a fixture is not merely unchecked — it is unreachable, and all three
 * checks pass without ever rendering it. That is how the mailbox editor shipped
 * with its host field squeezed to two pixels.
 *
 * The catalogue is worth a fixture of its own rather than a line in another,
 * because of what is on it: the widest table in the app — a name, a chip, a
 * price, a cost, a margin, a break-even and a standing pill, seven columns that
 * have to decide at 340px which of them survive — and, on the simulation tab, a
 * row of six numeric fields beside each other, which is the densest form
 * anywhere here.
 *
 * Idempotent, for the reason the others are: CI runs the walkthroughs first and
 * somebody running `npm run check:a11y` by hand starts from nothing.
 */

/**
 * Switch products on for the signed-in person's first workspace and leave a
 * small catalogue in it: a grouped product with a price and all three kinds of
 * cost, a package containing it, and one campaign.
 *
 * Runs inside the page, which is what holds the session cookie.
 */
export async function switchOnProducts(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;
    const post = async (path, body) => (await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json();

    // Merged server-side, so this cannot switch off a feature it has not heard
    // of — the walkthrough may have left others on.
    await fetch(`/api/workspaces/${workspace}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: { products: true } }),
    });

    // A bare array, the way the generic collection routes answer. Reading the
    // wrong shape here is idempotent in name only — see the ballot fixture for
    // what that cost when it was got wrong there.
    const already = await (await fetch(`/api/workspaces/${workspace}/products`)).json();
    if (Array.isArray(already) && already.length) return workspace;

    const group = await post(`/api/workspaces/${workspace}/product-groups`, { name: 'Trainings' });
    const seminar = await post(`/api/workspaces/${workspace}/products`, {
      name: 'Projektmanagement-Seminar',
      code: 'SEM-PM-2',
      group_id: group.id,
      status: 'active',
      unit_label: 'Platz',
      scope_amount: 2,
      scope_unit: 'Tage',
      capacity: 12,
    });
    await post(`/api/workspaces/${workspace}/product-prices`, {
      product_id: seminar.id, name: 'List', kind: 'list', amount: 145_000,
    });
    // One of each basis, because the three stat tiles above the table render
    // differently and a zero draws no bar in the category chart below it.
    for (const [name, basis, category, amount] of [
      ['Seminarraum', 'delivery', 'services', 90_000],
      ['Unterlagen', 'unit', 'other', 4_500],
      ['Lernplattform', 'period', 'licences', 25_000],
    ]) {
      await post(`/api/workspaces/${workspace}/product-costs`, {
        product_id: seminar.id, name, basis, category, amount,
      });
    }
    // A person, which is the row with a mail link and two icon buttons on it.
    await post(`/api/workspaces/${workspace}/product-contributors`, {
      product_id: seminar.id,
      name: 'Dr. Irene Müller',
      role: 'Referentin',
      organisation: 'Müller Consulting',
      email: 'irene@example.org',
      fee: 240_000,
      fee_basis: 'delivery',
    });

    // A package, so the Package tab has parts rather than its empty state.
    const bundle = await post(`/api/workspaces/${workspace}/products`, {
      name: 'Komplettpaket', code: 'PKT', kind: 'bundle', status: 'active',
    });
    await post(`/api/workspaces/${workspace}/product-prices`, {
      product_id: bundle.id, name: 'List', kind: 'list', amount: 250_000,
    });
    await post(`/api/workspaces/${workspace}/product-parts`, {
      product_id: bundle.id, part_id: seminar.id, quantity: 2,
    });

    // Live and inside its window, so the phase chip is `running` rather than
    // the draft state every other row would otherwise show.
    await post(`/api/workspaces/${workspace}/promotions`, {
      name: 'Frühbucher Sommer',
      kind: 'percent',
      value: 1500,
      status: 'live',
      products: [seminar.id],
      spend: 350_000,
      uplift_bps: 2500,
    });
    return workspace;
  });
}
