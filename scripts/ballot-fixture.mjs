/**
 * The setup the three browser checks need before a decision screen exists.
 *
 * The mail fixture next door explains why this file has to exist at all: a
 * seeded workspace has every switch **off**, so a feature-gated screen left out
 * of a fixture is not merely unchecked — it is unreachable, and all three
 * checks pass without ever rendering it. That is how the mailbox editor shipped
 * with its host field squeezed to two pixels.
 *
 * A ballot is worth the second fixture rather than a line in the first, because
 * of what is on it: a hand-written toggle carrying `aria-pressed`, a mark drawn
 * out of a border and a background rather than a native checkbox, a muted count
 * beside a bar, and a caption under it. Between them that is every rule the
 * contrast and a11y checks have — a control that must be named and focusable, a
 * colour that must clear the floor, and a row that must not come apart at
 * 340px.
 *
 * Idempotent, for the reason the mail one is: CI runs the walkthroughs first
 * and somebody running `npm run check:a11y` by hand starts from nothing.
 */

/**
 * Switch decisions on for the signed-in person's first workspace and leave one
 * open ballot in it, with two options and a vote on the first.
 *
 * Runs inside the page, which is what holds the session cookie.
 */
export async function switchOnDecisions(page) {
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
      body: JSON.stringify({ features: { decisions: true } }),
    });

    // A bare array, not `{ decisions: [...] }` — the generic collection route
    // answers with the rows themselves, unlike the mailboxes one next door.
    // Reading the wrong shape here is idempotent in name only: it left a second
    // pair of ballots behind on every run, and by the third check the screen was
    // a wall of identical questions.
    const answer = await (await fetch(`/api/workspaces/${workspace}/decisions`)).json();
    if (Array.isArray(answer) && answer.length) return workspace;

    // One of each state, because they render differently and the closed one
    // carries the caption under the bars that nothing else does.
    const open = await post(`/api/workspaces/${workspace}/decisions`, {
      question: 'Which hosting for the new environment?',
      description: 'Two shapes, one bill. Pick the one you would rather be on call for.',
      mode: 'single',
      visibility: 'open',
    });
    const options = [];
    for (const label of ['One box we run ourselves', 'Managed, and twice the price']) {
      options.push(await post(`/api/workspaces/${workspace}/decision-options`, {
        decision_id: open.id, label,
      }));
    }
    // A vote, so a bar has something in it and the mark has a ticked state.
    await post(`/api/workspaces/${workspace}/decision-votes`, {
      id: `${open.id}.${options[0].id}.${session.user.id}`,
      decision_id: open.id,
      option_id: options[0].id,
    });

    const secret = await post(`/api/workspaces/${workspace}/decisions`, {
      question: 'Should we move the all-hands to Thursday?',
      mode: 'multiple',
      visibility: 'anonymous',
      status: 'closed',
    });
    for (const label of ['Thursday', 'Leave it on Monday']) {
      await post(`/api/workspaces/${workspace}/decision-options`, { decision_id: secret.id, label });
    }
    return workspace;
  });
}
