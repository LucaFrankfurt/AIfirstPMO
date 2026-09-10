/**
 * The setup the three browser checks need before a vault screen exists.
 *
 * `mail-fixture.mjs` explains why these files have to exist at all: a seeded
 * workspace has every switch off, so a feature-gated screen left out of a
 * fixture is not merely unchecked — it is unreachable, and all three checks
 * pass without ever rendering it. `/secrets` had been in that position since it
 * was written.
 *
 * What is on it, and why it is worth the third fixture: a table of rows each
 * carrying a strength pill, a rotation state and an icon button; a filter bar
 * of toggles and a `<select>` that only exists once the vault holds something;
 * and the reveal control, which is the one place in the product where pressing
 * a button puts a credential on screen. Between them that is every rule the
 * contrast and a11y checks have.
 *
 * Idempotent, for the reason the other two are: CI runs the walkthroughs first
 * and somebody running `npm run check:a11y` by hand starts from nothing.
 */

/**
 * Switch the vault on for the signed-in person's first workspace and leave a
 * few secrets in it, one per environment.
 *
 * Runs inside the page, which is what holds the session cookie.
 */
export async function switchOnVault(page) {
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
      body: JSON.stringify({ features: { secrets: true } }),
    });

    const held = await (await fetch(`/api/workspaces/${workspace}/secrets`)).json();
    if (Array.isArray(held) && held.length) return workspace;

    const environments = await (await fetch(`/api/workspaces/${workspace}/environments`)).json();
    /*
     * One per environment, and deliberately not all the same shape: the row
     * renders a strength pill and a rotation state, and a vault of four
     * identical rows would check one of each. `rotate_after_days` with a
     * `rotated_at` far enough back is the overdue case, which is the only
     * colour on this screen that is not the default one.
     */
    const shapes = [
      { kind: 'password', value: 'correct horse battery staple', rotate_after_days: 90 },
      { kind: 'api_key', value: 'sk-live-2f9c41aa8b7e', rotate_after_days: 30 },
      { kind: 'token', value: 'ghp_shortish', rotate_after_days: null },
      { kind: 'certificate', value: '-----BEGIN CERTIFICATE-----', rotate_after_days: 365 },
    ];
    for (const [index, environment] of (environments ?? []).entries()) {
      const shape = shapes[index % shapes.length];
      await post(`/api/workspaces/${workspace}/secrets`, {
        name: `${environment.name} database`,
        description: 'Kept here rather than in the handbook.',
        access: 'workspace',
        environment_id: environment.id,
        ...shape,
      });
    }
    return workspace;
  });
}
