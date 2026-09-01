/**
 * The setup the three browser checks need before a mail screen exists at all.
 *
 * `responsive.mjs`, `contrast.mjs` and `a11y.mjs` each walk a list of paths
 * against a seeded instance. A seeded workspace has mail switched **off**, so
 * for as long as those lists were the whole story the mail screens were not
 * merely unchecked — they were unreachable, and every one of the three passed
 * without ever rendering them. That is how the mailbox editor shipped with its
 * host field squeezed to two pixels by a `<select>` sharing its row: nothing
 * had opened the screen.
 *
 * This lives in one file rather than in three because the fragile half is the
 * two API calls, not the walking. A body the write path stops accepting, or a
 * feature key renamed, should break in one place.
 *
 * It is deliberately **idempotent**: CI runs the walkthroughs before these
 * checks and the walkthrough leaves both the switch and a mailbox behind, while
 * somebody running `npm run check:contrast` by hand starts from neither.
 */

/**
 * Switch mail on for the signed-in person's first workspace, and leave one
 * mailbox in it. Returns the workspace id.
 *
 * Runs inside the page because that is what holds the session cookie — the same
 * reason the three checks already read their project id that way.
 */
export async function switchOnMail(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;

    // Merged server-side, so this cannot switch off a feature it has not heard
    // of — which matters because the walkthrough may have left others on.
    await fetch(`/api/workspaces/${workspace}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: { mail: true } }),
    });

    const answer = await (await fetch(`/api/workspaces/${workspace}/mailboxes`)).json();
    if (!(answer.mailboxes ?? []).length) {
      // The same shape the screen's own form creates, because a row that
      // differs from what a person would make is a row that proves less. No
      // password is set: "needs a credential" is the state a new mailbox is
      // really in, and it is the one with the most to render.
      await fetch(`/api/workspaces/${workspace}/mailboxes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: 'checks@example.com',
          name: '',
          host: 'imap.example.com',
          port: 993,
          encryption: 'tls',
          username: 'checks@example.com',
          access: 'workspace',
          members: [],
          enabled: 1,
          sync_days: 365,
        }),
      });
    }
    return workspace;
  });
}

/**
 * Open the first mailbox row, so the fields below it are on the screen.
 *
 * Without this the mailboxes tab is a closed summary line, and the row that
 * shipped broken is the one *inside* the editor — a check that stopped at the
 * summary would have watched the same bug go past.
 *
 * The row's title is a button that toggles the editor, and it is picked
 * structurally rather than by its label: these three checks run in whatever
 * language the instance defaults to, and a selector spelled "Edit" would go
 * quietly green the moment that stopped being the word. `button.text-left`
 * alone is not it — the sidebar's own buttons carry `text-left` in the middle
 * of a long utility string, and there are three of them before the first
 * mailbox. If these classes are ever reshuffled this throws rather than
 * skipping, which is the failure worth having.
 */
export async function openMailboxEditor(page) {
  const row = page.locator('button.flex-1.min-w-0.text-left').first();
  if (!(await row.count())) throw new Error('the mailboxes tab has no mailbox row to open');
  // Already open — the walkthrough leaves nothing open, but a retry might.
  if (!(await page.locator('input[type=number]').count())) {
    await row.click();
    await page.waitForSelector('input[type=number]', { timeout: 5000 });
  }
  // The fields mount with the row; give React the paint before anything measures.
  await page.waitForTimeout(200);

  /*
   * Hand the browser back to the keyboard.
   *
   * This looks like a stray keystroke and is not. Chromium decides whether
   * `:focus-visible` matches from the last input modality, so after a *mouse*
   * click a script's own `el.focus()` no longer draws a focus ring — and
   * `a11y.mjs` checks exactly that, by focusing every control and reading its
   * outline. Measured on this screen: 0 of 33 controls looked focus-invisible
   * after a keypress, 33 of 34 after the click above, 0 again after this line.
   *
   * Without it this fixture reports the whole sidebar as an accessibility
   * failure — thirty-odd findings that are an artefact of how the screen was
   * opened, on a screen that is fine. It belongs here rather than in the three
   * callers because the click is here: whatever clicks owes the cleanup.
   */
  await page.keyboard.press('Escape');
}
