/**
 * Browser smoke test: signs in, walks the main screens, creates a task and
 * checks that it survived a round trip — then does it again on a phone-sized
 * viewport and with the network switched off.
 *
 * Set KOLIBRI_LOCALE to `de` or `fr` to walk the same path through that
 * interface; the labels below are the only thing that changes, which is the
 * point of the run — a missing translation shows up as a selector that no
 * longer matches.
 *
 * Prerequisites: a seeded instance on KOLIBRI_URL and `npx playwright install chromium`.
 * Run: node scripts/smoke.mjs
 */
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
/**
 * The two figures TODO.md quotes about the guide.
 *
 * They live here because this is the only place that can count them — both are
 * what a browser renders rather than what the source lists, and the two
 * disagree. Change the guide, watch this fail, and change the sentence in
 * TODO.md that says the same number. `scripts/figures.mjs` does this job for
 * every figure that can be counted without a browser.
 */
const GUIDE = { steps: 41, nodes: 24 };

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const locale = process.env.KOLIBRI_LOCALE ?? 'en';
const shots = process.env.KOLIBRI_SHOT_DIR ?? (locale === 'en' ? '/tmp/shots' : `/tmp/shots-${locale}`);

/** Only the strings the walkthrough clicks on — not a second catalogue. */
const LABELS = {
  en: {
    board: 'Board', newTask: 'New task', createTask: 'Create task', pages: 'Pages',
    guide: 'Guide', welcome: 'Welcome', log: 'Log',
    chat: 'Chat', newChannel: 'New channel', createChannel: 'Create channel', send: 'Send',
    findPerson: 'Find somebody', preview: 'Preview', write: 'Write',
    newProject: 'New project', createProject: 'Create project', save: 'Save',
    taskLabels: 'Labels',
    taskParent: 'Parent',
    reviewSection: 'Review', reviewFeature: 'Task reviews',
    filter: 'Filter', module: 'Module', cycle: 'Cycle', cycles: 'Cycles', openCycle: 'Open cycle',
    moveColumn: 'Move column', moveLeft: 'Move left', moveRight: 'Move right',
    addSubtask: 'Add a sub-task',
    mailFeature: 'Connected mailboxes', mailboxesTab: 'Mailboxes', edit: 'Edit',
  },
  de: {
    board: 'Board', newTask: 'Neue Aufgabe', createTask: 'Aufgabe anlegen', pages: 'Seiten',
    guide: 'Anleitung', welcome: 'Willkommen', log: 'Protokoll',
    chat: 'Chat', newChannel: 'Neuer Kanal', createChannel: 'Kanal anlegen', send: 'Senden',
    findPerson: 'Jemanden suchen', preview: 'Vorschau', write: 'Schreiben',
    newProject: 'Neues Projekt', createProject: 'Projekt anlegen', save: 'Speichern',
    taskLabels: 'Labels',
    taskParent: 'Übergeordnet',
    reviewSection: 'Review', reviewFeature: 'Aufgaben-Reviews',
    filter: 'Filter', module: 'Modul', cycle: 'Zyklus', cycles: 'Zyklen', openCycle: 'Zyklus öffnen',
    moveColumn: 'Spalte verschieben', moveLeft: 'Nach links', moveRight: 'Nach rechts',
    addSubtask: 'Teilaufgabe hinzufügen',
    mailFeature: 'Verbundene Postfächer', mailboxesTab: 'Postfächer', edit: 'Bearbeiten',
  },
  fr: {
    board: 'Tableau', newTask: 'Nouvelle tâche', createTask: 'Créer la tâche', pages: 'Pages',
    guide: 'Guide', welcome: 'Bienvenue', log: 'Journal',
    chat: 'Discussion', newChannel: 'Nouveau salon', createChannel: 'Créer le salon', send: 'Envoyer',
    findPerson: 'Trouver quelqu', preview: 'Aperçu', write: 'Écrire',
    newProject: 'Nouveau projet', createProject: 'Créer le projet', save: 'Enregistrer',
    taskLabels: 'Étiquettes',
    taskParent: 'Tâche parente',
    reviewSection: 'Relecture', reviewFeature: 'Relectures de tâches',
    filter: 'Filtrer', module: 'Module', cycle: 'Cycle', cycles: 'Cycles', openCycle: 'Ouvrir le cycle',
    moveColumn: 'Déplacer la colonne', moveLeft: 'Vers la gauche', moveRight: 'Vers la droite',
    addSubtask: 'Ajouter une sous-tâche',
    mailFeature: 'Boîtes mail connectées', mailboxesTab: 'Boîtes mail', edit: 'Modifier',
  },
}[locale];

/**
 * Close whatever sheets are open, however many deep.
 *
 * A task opened from a task is a stack, so one Escape pops one level rather
 * than clearing the screen — and a step that leaves a sheet up hands the next
 * one a sidebar it cannot click.
 */
const closeSheets = async (target) => {
  for (let depth = 0; depth < 6 && (await target.locator('.sheet').count()); depth++) {
    await target.keyboard.press('Escape');
    await target.waitForTimeout(200);
  }
};

/** The first-run tour opens over everything; every later step needs it gone. */
const closeTour = async (target) => {
  if (await target.locator('.sheet:has(.tour-h)').count()) {
    await target.keyboard.press('Escape');
    await target.waitForTimeout(250);
  }
};
if (!LABELS) throw new Error(`smoke test has no labels for locale "${locale}"`);
const errors = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

/**
 * Run one step, and remember if it failed.
 *
 * Every step is attempted even after one fails — a walkthrough that stops at
 * the first problem tells you about one problem — but the failures are counted,
 * and the script exits non-zero at the end. It used to swallow them and exit 0,
 * which meant the CI job could not go red no matter what the app did.
 */
const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log('OK  ', name);
  } catch (e) {
    console.log('FAIL', name, '-', e.message);
    failures.push(`${name}: ${e.message}`);
  }
};

await step('login', async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('kolibri.locale', value), locale);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
});

await step('first-run tour greets a new device and can be dismissed', async () => {
  await page.waitForSelector('.sheet:has(.tour-h)', { timeout: 6000 });
  const heading = await page.locator('.sheet header').innerText();
  if (!heading.includes(LABELS.welcome)) throw new Error(`tour title was "${heading}"`);
  const steps = (await page.locator('.sheet footer span').first().innerText()).match(/\d+$/)?.[0];
  console.log('     tour steps for an owner:', steps);
  if (steps !== '5') throw new Error(`expected 5 steps, got ${steps}`);
  await closeTour(page);
  if (await page.locator('.sheet').count()) throw new Error('tour did not close');
  // Dismissed for good: a reload must not bring it back.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  if (await page.locator('.sheet:has(.tour-h)').count()) throw new Error('tour reopened after a reload');
});
await page.waitForTimeout(1500);
await step('my work has tasks', async () => {
  const n = await page.locator('.task-row').count();
  if (n === 0) throw new Error('no tasks rendered');
  console.log('     task rows:', n);
});
await page.screenshot({ path: `${shots}/1-mywork.png` });

/**
 * What My work opens with.
 *
 * Three things that break quietly, because none of them throws when it goes: a
 * greeting that says the reader's name, four figures counted over everything
 * assigned to them rather than over whatever the current view happens to be
 * showing, and the projects they were last in.
 *
 * The last has a rule worth pinning down. A task sheet is not a visit: `/t/…`
 * opens *over* the screen you were on rather than taking you anywhere, and
 * recording it would rearrange the strip behind the sheet while nobody was
 * looking at it. Nothing else can notice that going wrong.
 *
 * Both assertions are on seed data — a person's name and a project's — rather
 * than on any translated string. Matching a word from the interface here is how
 * a step ends up proving that English works and calling it three languages.
 */
await step('my work opens with where you stand and where you were', async () => {
  const greeting = await page.locator('.greeting').innerText();
  if (!greeting.includes('Ada')) throw new Error(`the greeting reads "${greeting}"`);

  const figures = await page.locator('.kpi-row .stat-value').allInnerTexts();
  if (figures.length !== 4) throw new Error(`expected four figures, got ${figures.length}`);
  if (figures.some((value) => !/^\d+$/.test(value))) throw new Error(`a figure read ${JSON.stringify(figures)}`);
  console.log('     open / next 7 days / undated / finished:', figures.join(' '));

  // Nothing has been opened yet on this device, so there is nothing to offer.
  if (await page.locator('.recents').count()) throw new Error('a fresh device claims a history');

  await page.click('.sidebar a:has-text("Website")');
  await page.waitForSelector('.tabs');
  // A full reload, not a click back: the history lives in localStorage, and
  // this is the half of that which a same-page navigation would not exercise.
  await page.goto(base, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.waitForSelector('.recent-card', { timeout: 8000 });
  const seen = await page.locator('.recent-name').allInnerTexts();
  if (seen[0] !== 'Website') throw new Error(`recently viewed reads ${JSON.stringify(seen)}`);

  await page.locator('.task-row').first().click();
  await page.waitForSelector('.sheet', { timeout: 5000 });
  const after = await page.locator('.recent-name').allInnerTexts();
  await page.keyboard.press('Escape');
  if (after.join() !== seen.join()) throw new Error(`opening a task rewrote the history: ${JSON.stringify(after)}`);

  await page.goto(base, { waitUntil: 'networkidle' });
  await closeTour(page);
});

/**
 * A figure is a door, and it has to open onto what it counted.
 *
 * The point of pressing every tile rather than one: the seven-day bucket was
 * declared in the query language, parsed, accepted and shown as a chip, and
 * nothing anywhere ever applied it — so the filter was on and every task was
 * still on screen. Comparing the number on the tile against the rows it opens
 * is the only check that notices that, and it notices it for all three at once.
 */
await step('a figure on My work opens the rows it counted', async () => {
  const tiles = page.locator('.kpi-row button.stat');
  const pressable = await tiles.count();
  if (pressable !== 3) throw new Error(`expected three pressable figures, got ${pressable}`);
  // The last seven days is a window the list cannot express, so that tile is a
  // figure and nothing more. If it ever becomes a button, this says so.
  if (await page.locator('.kpi-row .stat:not(button)').count() !== 1) {
    throw new Error('the finished figure is pressable and would open a set it did not count');
  }

  const rows = page.locator('.my-work-list .task-row');
  for (let i = 0; i < pressable; i += 1) {
    const tile = tiles.nth(i);
    const label = (await tile.locator('.stat-label').innerText()).trim();
    const counted = Number(await tile.locator('.stat-value').innerText());
    await tile.click();
    await page.waitForTimeout(500);
    if (await tile.getAttribute('aria-pressed') !== 'true') throw new Error(`${label} did not stay pressed`);
    const shown = await rows.count();
    if (shown !== counted) throw new Error(`${label} counts ${counted} and opened ${shown}`);
    console.log(`     ${label}: counted ${counted}, opened ${shown}`);
  }

  // Pressing the one that is already on goes back to everything open, so the
  // row is a toggle rather than a trap.
  await tiles.nth(pressable - 1).click();
  await page.waitForTimeout(400);
  if (await tiles.nth(0).getAttribute('aria-pressed') !== 'true') {
    throw new Error('pressing the pressed figure did not return to everything open');
  }
});

await step('open project board', async () => {
  await page.click('.sidebar a:has-text("Website")');
  await page.waitForSelector('.tabs');
  await page.click(`button[aria-pressed][title="${LABELS.board}"]`);
  await page.waitForSelector('.board-column', { timeout: 5000 });
  const cols = await page.locator('.board-column').count();
  console.log('     board columns:', cols);
});
await page.screenshot({ path: `${shots}/2-board.png` });

/**
 * The two things a card owes the board about the plan it belongs to: naming it,
 * and standing aside when the filter names another one. Both chips are read the
 * same way because they are the same promise — every third seeded task carries
 * "<project> v2", and the work in flight carries the running cycle.
 */
for (const kind of ['cycle', 'module']) {
  await step(`${kind} shows on the card and filters the board`, async () => {
    const title = LABELS[kind];
    const chip = page.locator(`.task-card span[title="${title}"]`).first();
    await chip.waitFor({ timeout: 5000 });
    const named = (await chip.innerText()).trim();
    const all = await page.locator('.task-card').count();

    await page.click(`button:has-text("${LABELS.filter}")`);
    await page.getByRole('menuitem', { name: named }).click();
    await page.waitForTimeout(600);
    const kept = await page.locator('.task-card').count();
    const chips = await page.locator(`.task-card span[title="${title}"]`).count();
    if (!kept || kept >= all) throw new Error(`filtering on ${named} kept ${kept} of ${all} cards`);
    if (chips !== kept) throw new Error(`${kept} cards passed the filter but ${chips} carry the ${kind}`);

    // The same click takes it off again, so the rest of the run reads a whole board.
    await page.click(`button:has-text("${LABELS.filter}")`);
    await page.getByRole('menuitem', { name: named }).click();
    await page.waitForTimeout(400);
    if (await page.locator('.task-card').count() !== all) throw new Error('clearing the filter did not restore the board');
    console.log(`     ${named}: ${kept} of ${all} cards`);
  });
}

/**
 * And the chip knows where it is. A cycle's own board is every task in that
 * cycle, so naming it on all of them is a column of the same word — the card
 * that carried the chip on the project board carries none here, which is a
 * different thing from the chip being broken.
 */
await step('a cycle board does not repeat the cycle on every card', async () => {
  const carded = page.locator(`.task-card:has(span[title="${LABELS.cycle}"])`).first();
  const named = (await carded.locator(`span[title="${LABELS.cycle}"]`).innerText()).trim();
  const identifier = (await carded.locator('.mono').innerText()).trim();

  await page.click(`.tabs button:has-text("${LABELS.cycles}")`);
  await page.locator('.grid > div').filter({ hasText: named }).first()
    .getByRole('button', { name: LABELS.openCycle }).click();
  await page.click(`button[aria-pressed][title="${LABELS.board}"]`);
  await page.waitForSelector('.task-card', { timeout: 5000 });

  const here = await page.locator(`.task-card span[title="${LABELS.cycle}"]`).count();
  if (here) throw new Error(`${named}'s own board names the cycle on ${here} cards`);
  const same = page.locator(`.task-card:has(.mono:text-is("${identifier}"))`);
  if (!(await same.count())) throw new Error(`${identifier} is in ${named} and is not on its board`);
  console.log(`     ${identifier} says "${named}" on the project board and nothing here`);

  // Back where the walkthrough was, so the steps after this one read the
  // project's board rather than one cycle's slice of it.
  await page.click('.sidebar a:has-text("Website")');
  await page.click(`button[aria-pressed][title="${LABELS.board}"]`);
  await page.waitForSelector('.board-column', { timeout: 5000 });
});

/**
 * Columns move — through the header menu, which is the same move the drag
 * makes and the only one a script (or a phone) can perform honestly. Right,
 * check, left, check: the board ends the step in the order it began.
 */
await step('reorder board columns and put them back', async () => {
  const names = () => page.locator('.board-column header span.truncate').allInnerTexts();
  const before = await names();
  if (before.length < 2) throw new Error('one column proves nothing');

  await page.locator(`.board-column header button[title="${LABELS.moveColumn}"]`).first().click();
  await page.getByRole('menuitem', { name: LABELS.moveRight }).click();
  await page.waitForTimeout(700);
  const after = await names();
  if (after[0] !== before[1] || after[1] !== before[0]) {
    throw new Error(`moving right: expected ${before[1]} first, saw ${after.slice(0, 2).join(', ')}`);
  }

  await page.locator(`.board-column header button[title="${LABELS.moveColumn}"]`).nth(1).click();
  await page.getByRole('menuitem', { name: LABELS.moveLeft }).click();
  await page.waitForTimeout(700);
  const restored = await names();
  if (restored.join('|') !== before.join('|')) throw new Error('moving back did not restore the order');
  console.log(`     ${before[0]} ⇄ ${before[1]} and back`);
});

await step('open task detail + comment', async () => {
  await page.click('.task-card');
  await page.waitForSelector('.sheet', { timeout: 5000 });
  const title = await page.locator('.sheet input[type=text], .sheet input:not([type])').first().inputValue();
  console.log('     task:', title.slice(0, 40));
});
await page.screenshot({ path: `${shots}/3-task.png` });

await step('create task through quick add', async () => {
  await page.keyboard.press('Escape');
  await page.click(`.sidebar button:has-text("${LABELS.newTask}")`);
  await page.waitForSelector('.sheet');
  await page.fill('.sheet input >> nth=0', 'Playwright smoke task');
  await page.click(`button:has-text("${LABELS.createTask}")`);
  await page.waitForTimeout(1200);
});

/**
 * A card dropped onto a project in the sidebar.
 *
 * A sidebar row used to accept the drop and then do nothing with it: both a
 * card and a project handed over `text/plain`, so the row could not tell them
 * apart, called the reparent path, found no project being dragged and returned.
 * It looked like it would work for as long as the pointer was down.
 *
 * Driven with a real drag rather than by calling the handler, because the half
 * that was broken was `dataTransfer` — a test that dispatched the drop directly
 * would have passed against the bug.
 *
 * The task is made here rather than borrowed. Moving one is the whole point of
 * the step, and a step that consumes what a later one reads is a step that
 * passes once.
 */
await step('a card dragged onto a project in the sidebar is filed there', async () => {
  await page.keyboard.press('Escape');
  await page.click('.sidebar a:has-text("Website")');
  await page.waitForSelector('.tabs');
  await page.click(`button[aria-pressed][title="${LABELS.board}"]`);
  await page.waitForSelector('.board-column', { timeout: 6000 });

  await page.click(`.sidebar button:has-text("${LABELS.newTask}")`);
  await page.waitForSelector('.sheet');
  await page.fill('.sheet input >> nth=0', 'Smoke: filed elsewhere');
  await page.click(`button:has-text("${LABELS.createTask}")`);
  await page.waitForTimeout(1400);

  const onBoard = () => page.locator('.task-card').filter({ hasText: 'Smoke: filed elsewhere' });
  await onBoard().first().waitFor({ timeout: 6000 });

  await onBoard().first().dragTo(page.locator('.sidebar .nav-project:has-text("Public API")').first());
  await page.waitForTimeout(1500);

  if (await onBoard().count()) throw new Error('the card is still on the board it was dragged off');

  // And the server agrees — the half a purely local move cannot prove, and the
  // half that decides whether the column it landed in actually exists there.
  const landed = await page.evaluate(async () => {
    const ws = localStorage.getItem('kolibri.workspace');
    const json = async (url) => (await fetch(url, { credentials: 'include' })).json();
    const tasks = await json(`/api/workspaces/${ws}/tasks?limit=200`);
    const task = (tasks.tasks ?? tasks).find((one) => one.title === 'Smoke: filed elsewhere');
    if (!task) return null;
    const projects = await json(`/api/workspaces/${ws}/projects`);
    const states = await json(`/api/workspaces/${ws}/states`);
    const state = (states.states ?? states).find((one) => one.id === task.state_id);
    return {
      identifier: task.identifier,
      project: (projects.projects ?? projects).find((one) => one.id === task.project_id)?.name ?? '(gone)',
      stateBelongsHere: !!state && state.project_id === task.project_id,
    };
  });
  if (!landed) throw new Error('the task is not on the server at all');
  if (landed.project !== 'Public API') throw new Error(`it was filed under ${landed.project}`);
  if (!landed.stateBelongsHere) throw new Error('it landed in a column belonging to the project it left');
  // The address somebody may already have pasted somewhere does not change.
  if (!/^WEB-/.test(landed.identifier)) throw new Error(`the identifier became ${landed.identifier}`);
  console.log('     ', landed.identifier, 'is now in', landed.project, 'and in a column that project has');

  /*
   * And no card is left looking disabled.
   *
   * The board dimmed the card being dragged and cleared that only when one
   * landed in one of its own columns. Every other ending — a project in the
   * sidebar, a row that refused it, a release over nothing, Escape — left the
   * card sitting at 45% opacity until the board was rebuilt, which reads as a
   * task that has been switched off. `dragend` is the event that fires for all
   * of them, and this is the check that says so.
   */
  const faded = () => page.locator('.task-card').evaluateAll(
    (nodes) => nodes.filter((node) => getComputedStyle(node).opacity !== '1')
      .map((node) => node.querySelector('.mono')?.textContent?.trim() ?? '?'));
  if ((await faded()).length) throw new Error(`greyed out after the move: ${(await faded()).join(', ')}`);

  // The ending that reproduced it: a drop the row declines, because the task is
  // already filed there.
  await page.locator('.task-card').first().dragTo(page.locator('.sidebar .nav-project:has-text("Website")').first());
  await page.waitForTimeout(900);
  const stuck = await faded();
  if (stuck.length) throw new Error(`greyed out after a refused drop: ${stuck.join(', ')}`);
  if (await page.locator('.drop-line').count()) throw new Error('a drop line outlived the drag');
});

/**
 * The way back up from a sub-task.
 *
 * A task sheet has always listed what is under it and never said what it was
 * under: the link ran one way, so from a child the only way to the parent was
 * remembering which one it was. Three things have to hold — the trail is there,
 * it goes somewhere, and the field that sets it refuses the choices that would
 * make a loop.
 *
 * The loop half is worth a browser rather than a unit test: `family.test.ts`
 * proves the arithmetic, and this proves the menu is actually built from it.
 */
await step('a sub-task can find its way back to its parent', async () => {
  await page.keyboard.press('Escape');
  await page.click('.sidebar a:has-text("Website")');
  await page.waitForSelector('.tabs');
  await page.waitForTimeout(600);
  // Either layout: an earlier step leaves this project on the board, and which
  // view a device last chose is not what this step is about.
  await page.locator('.task-card, .task-row').first().click();
  await page.waitForSelector('.sheet', { timeout: 6000 });
  await page.waitForTimeout(500);

  const parent = (await page.locator('.sheet .mono').first().innerText()).trim();
  if (!/^WEB-\d+$/.test(parent)) throw new Error(`opened something that is not a task: ${parent}`);
  if (await page.locator('.sheet .parent-trail').count()) throw new Error('a task with no parent drew a trail anyway');

  await page.getByPlaceholder(LABELS.addSubtask).fill('Smoke: a part of something');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.locator('.sheet button', { hasText: 'Smoke: a part of something' }).first().click();
  await page.waitForTimeout(900);

  const trail = page.locator('.sheet .parent-trail');
  if (!(await trail.count())) throw new Error('the sub-task shows no way up');
  const shown = await trail.innerText();
  if (!shown.includes(parent)) throw new Error(`the trail says "${shown.replace(/\n/g, ' ')}", not ${parent}`);

  const child = (await page.locator('.sheet .mono').first().innerText()).trim();
  await trail.locator('button').first().click();
  await page.waitForTimeout(900);
  const landed = (await page.locator('.sheet .mono').first().innerText()).trim();
  if (landed !== parent) throw new Error(`the trail led to ${landed} rather than ${parent}`);

  // And the field cannot be used to make a circle.
  await page.locator(`.sheet button[title="${LABELS.taskParent}"]`).first().click();
  await page.waitForTimeout(400);
  const offered = await page.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  if (offered.some((one) => one.includes(parent))) throw new Error('a task is offered as its own parent');
  if (offered.some((one) => one.includes(child))) throw new Error('a task is offered its own child as a parent');
  if (!offered.length) throw new Error('the parent menu is empty, so it proves nothing');
  console.log(`     ${child} leads back to ${parent}, and neither is offered as its parent (${offered.length} that are)`);
  // Opened a task from a task, so this is a stack rather than one sheet.
  await closeSheets(page);
});

/**
 * What a task is, said at the moment it is made.
 *
 * This step used to be about work item types: the create form offered a
 * project, a state, a priority, an assignee, a due date and a template, and no
 * type at all, while the task's own sheet had a picker for one. Types are gone
 * — a task carries labels and nothing else answers that question — and the
 * check that matters is the same one it always was: what the form says on the
 * way in has to be what the server stored on the way out.
 */
await step('a task can be told what it is on the way in', async () => {
  await page.keyboard.press('Escape');
  await page.click(`.sidebar button:has-text("${LABELS.newTask}")`);
  await page.waitForSelector('.sheet');
  // `*label` is the quick-add syntax the form advertises in its own help.
  await page.fill('.sheet input >> nth=0', 'Smoke: labelled on creation *bug');
  // The line is parsed as it is typed, and the form is what carries the result
  // into the task. Clicking create in the same tick as the fill submits what
  // the box said before anything had read it.
  await page.waitForTimeout(400);
  // What the form says it understood, kept for the failure message: "no label
  // arrived" and "the line was never read" are different bugs.
  const understood = (await page.locator('.sheet').innerText()).split('\n').slice(0, 6).join(' / ');
  await page.click(`button:has-text("${LABELS.createTask}")`);
  await page.waitForTimeout(1500);

  const carried = await page.evaluate(async () => {
    const ws = localStorage.getItem('kolibri.workspace');
    const json = async (url) => (await fetch(url, { credentials: 'include' })).json();
    const tasks = await json(`/api/workspaces/${ws}/tasks?limit=200`);
    const task = (tasks.tasks ?? tasks).find((one) => one.title.startsWith('Smoke: labelled on creation'));
    if (!task) return null;
    const labels = await json(`/api/workspaces/${ws}/labels`);
    const all = labels.labels ?? labels;
    return (task.labels ?? []).map((id) => all.find((one) => one.id === id)?.name ?? '(gone)');
  });
  if (carried === null) throw new Error('the task never reached the server');
  if (!carried.some((name) => /bug/i.test(name))) {
    throw new Error(`typed *bug, server stored ${JSON.stringify(carried)} — the form said: ${understood}`);
  }
  console.log(`     chosen on creation and kept: ${carried.join(', ')}`);
});

await step('task reached the server', async () => {
  const res = await page.request.get(`${base}/api/health`);
  const body = await res.json();
  if (!body.seq) throw new Error('no seq');
  const search = await page.request.get(`${base}/api/workspaces/${await page.evaluate(() => localStorage.getItem('kolibri.workspace'))}/search?q=playwright`);
  const data = await search.json();
  if (!data.results.length) throw new Error('task not indexed on server');
  console.log('     server found:', data.results[0].title);
});

/**
 * A label deleted out from under the tasks that carry it.
 *
 * A task stores label ids, and deleting a label does not go and edit every task
 * holding it — so a stale id is a normal state, not a corrupt one. Every place
 * that shows labels resolves the id and skips what is gone; the count on the
 * task's own label button did not, and went on reporting "1 label" over a menu
 * with nothing ticked and a row of chips showing none.
 *
 * It is asserted here rather than in a unit test because the whole of it is the
 * round trip: a real delete, a real sync, and a real render afterwards.
 *
 * The label is made here rather than borrowed from the project's own. The first
 * draft took the first one it found, and since the step's whole job is to
 * delete it, a second run ate the next one and a fourth run failed for having
 * nothing left. A step that consumes what it depends on passes exactly once.
 */
await step('a deleted label stops being counted on the tasks that had it', async () => {
  const ws = await page.evaluate(() => localStorage.getItem('kolibri.workspace'));
  const made = await page.evaluate(async (workspace) => {
    const json = async (url, init) => (await fetch(url, { credentials: 'include', ...init })).json();
    const projects = await json(`/api/workspaces/${workspace}/projects`);
    const project = (projects.projects ?? projects)[0];
    const label = await json(`/api/workspaces/${workspace}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, name: 'smoke-throwaway', color: '#f59e0b' }),
    }).then((made) => made.label ?? made);
    if (!label?.id) return null;
    const task = await json(`/api/workspaces/${workspace}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke: stale label', project_id: project.id, labels: [label.id] }),
    });
    return { label: label.id, name: label.name, task: (task.task ?? task).id };
  }, ws);
  if (!made) throw new Error('could not create a label to delete');

  /**
   * What the task's own label button says about itself.
   *
   * Found by its title, which is translated — so the title comes from the table
   * above rather than from a word in this file. The first version matched
   * `/label/i` and passed in English and German for the same reason: both
   * translations happen to be the English word. French says Étiquettes, found
   * nothing, and read the empty string as "the label was never applied".
   */
  const counted = async () => {
    await page.goto(`${base}/t/${made.task}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    return page.evaluate((title) => {
      const button = [...document.querySelectorAll('button')]
        .find((one) => (one.getAttribute('title') ?? '') === title);
      return button ? button.textContent.trim() : null;
    }, LABELS.taskLabels);
  };

  const before = await counted();
  // `null` and "no digits" are different failures and were reported as one.
  if (before === null) throw new Error(`no button titled "${LABELS.taskLabels}" on the task`);
  if (!/\d/.test(before)) throw new Error(`the label was not applied — button reads "${before}"`);

  await page.evaluate(async (id) => {
    await fetch(`/api/labels/${id}`, { method: 'DELETE', credentials: 'include' });
  }, made.label);
  await page.waitForTimeout(1500);

  const after = await counted();
  if (after === null) throw new Error(`the label button vanished after the delete`);
  if (/\d/.test(after)) throw new Error(`still counting a label that was deleted: "${after}"`);
  console.log(`     "${made.name}" deleted — button went from "${before}" to "${after}"`);
});

/**
 * A project, made the way somebody makes one.
 *
 * This walkthrough visited every screen and created a task, a channel, a page
 * and a comment — and never once created a project, which is why *Create
 * project* could sit there doing nothing for four commits. The button was not
 * disabled and threw no error: the port had turned it into `type="button"`
 * inside a `<form onSubmit>`, so clicking it submitted nothing at all.
 *
 * The assertion is therefore not "the form is there" but "the server has it":
 * a screen that looks right is exactly what this bug looked like.
 */
await step('a project can be created, and the server ends up with it', async () => {
  await page.goto(`${base}/projects/new`, { waitUntil: 'networkidle' });
  await closeTour(page);
  const key = `S${Date.now().toString().slice(-4)}`;
  await page.fill('#p-name', `Smoke ${locale} ${key}`);
  await page.fill('#p-key', key);
  await page.click(`form button:has-text("${LABELS.createProject}")`);
  // Landing on the project is the only proof the submit ran at all — the form
  // stays put, silently, when it does not.
  await page.waitForURL(/\/projects\/[0-9a-f-]{8}/, { timeout: 8000 });
  const workspace = await page.evaluate(() => localStorage.getItem('kolibri.workspace'));
  const list = await (await page.request.get(`${base}/api/workspaces/${workspace}/projects`)).json();
  const made = (list.projects ?? list).find?.((project) => project.key === key);
  if (!made) throw new Error(`the project reached no server row (key ${key})`);
  console.log('     project created:', made.name, `(${made.key})`);
});

await step('pages', async () => {
  await page.goto(`${base}/pages`, { waitUntil: 'networkidle' });
  await page.waitForSelector('a[href^="/pages/"]', { timeout: 5000 });
  await page.click('a:has-text("Team handbook")');
  await page.waitForSelector('.md h1', { timeout: 5000 });
});
await page.screenshot({ path: `${shots}/4-page.png` });

/**
 * Selecting a passage in a page leaves the passage selected.
 *
 * A regression test for something no unit test can see. Selecting text sets
 * state — that is what offers the comment button — and the render that follows
 * used to rebuild the whole rendered body: `dangerouslySetInnerHTML={{ … }}` is
 * a fresh object every time, React diffs props by reference, and the update it
 * commits for that prop replaces every node under the div without ever
 * comparing the markup. A Selection points at text nodes, so replacing them
 * collapsed it, and relaying every block moved the page at the same moment.
 *
 * What made it hard to notice from the outside is that the *offer* survived:
 * the comment button had already read the range, so commenting still worked
 * and only the highlight vanished. So this checks all three of the things that
 * went wrong, not just the one that showed.
 */
await step('selecting a passage in a page keeps it selected', async () => {
  await page.goto(`${base}/pages`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.click('a:has-text("Team handbook")');
  await page.waitForSelector('.md', { timeout: 5000 });
  await page.waitForTimeout(400);

  const result = await page.evaluate(async () => {
    const body = document.querySelector('.md');
    // Any text node long enough to select a phrase inside.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.data.trim().length < 40) node = walker.nextNode();
    if (!node) return { skipped: 'no passage long enough to select' };

    let replaced = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) if (record.type === 'childList') replaced += record.removedNodes.length;
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });

    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 32);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const wanted = selection.toString();

    // What a pointer does at the end of a drag, and what the app listens for.
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((done) => setTimeout(done, 600));
    observer.disconnect();

    return {
      wanted,
      kept: selection.isCollapsed ? '' : selection.toString(),
      replaced,
    };
  });

  if (result.skipped) {
    console.log('     skipped:', result.skipped);
    return;
  }
  if (result.replaced) {
    throw new Error(`selecting text rebuilt ${result.replaced} nodes of the page body`);
  }
  if (result.kept !== result.wanted) {
    throw new Error(`the selection did not survive: wanted "${result.wanted}", kept "${result.kept}"`);
  }
  console.log('     selection survived:', JSON.stringify(result.kept.slice(0, 32)));
  console.log('     body nodes replaced:', result.replaced);
});

await step('chat: a channel, a message, and a badge that clears', async () => {
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await closeTour(page);
  // A fresh name each run: the walkthrough runs three times against one
  // instance, and a channel that already exists is refused by name.
  const name = `smoke ${locale} ${Date.now()}`;
  await page.click(`button:has-text("${LABELS.newChannel}")`);
  await page.waitForSelector('.sheet input');
  await page.fill('.sheet input', name);
  await page.click(`button:has-text("${LABELS.createChannel}")`);
  await page.waitForSelector('.chat-header', { timeout: 5000 });

  await page.fill('.chat-composer textarea', 'Hello from the walkthrough.');
  await page.click(`.chat-composer button:has-text("${LABELS.send}")`);
  await page.waitForSelector('.chat-message', { timeout: 5000 });
  const said = await page.locator('.chat-message .body').last().innerText();
  if (!said.includes('Hello from the walkthrough')) throw new Error(`message did not appear: "${said}"`);
  console.log('     messages in the new channel:', await page.locator('.chat-message').count());

  // Reading is what marks it read, so the badge must not be left behind.
  await page.waitForTimeout(600);
  const badge = await page.locator('.sidebar a[href="/chat"] .count').count();
  if (badge) throw new Error('the unread badge stayed up on a conversation just read');

  // And a direct conversation names the other person rather than showing a key.
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await page.locator('.chat-list .chat-row, .chat-list .chat-person').last().click();
  await page.waitForSelector('.chat-header', { timeout: 5000 });
  const title = await page.locator('.chat-header strong').innerText();
  if (!title.trim() || title.includes('.')) throw new Error(`direct conversation titled "${title}"`);
  console.log('     direct conversation with:', title);
});

await step('chat: a picture, a reaction, and a member list that can be added to', async () => {
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.locator('.chat-list .chat-row').first().click();
  await page.waitForSelector('.chat-composer textarea', { timeout: 5000 });

  // A screenshot, pasted the way somebody pastes one. Generated here rather
  // than checked in, so the test carries no binary.
  await page.locator('.chat-composer textarea').click();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4f46e5'; ctx.fillRect(0, 0, 120, 60);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
    document.querySelector('.chat-composer textarea')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(2500);
  if (!/!\[.*\]\(.*\)/.test(await page.locator('.chat-composer textarea').inputValue())) {
    throw new Error('pasting an image put nothing in the box');
  }
  await page.click(`.chat-composer button:has-text("${LABELS.send}")`);
  await page.waitForSelector('.chat-stream img', { timeout: 6000 });
  await page.waitForTimeout(1200);
  // Rendered, not merely referenced: a broken image has no natural size.
  const drawn = await page.locator('.chat-stream img').last()
    .evaluate((img) => img.naturalWidth > 0 && img.naturalHeight > 0);
  if (!drawn) throw new Error('the pasted image did not render');

  await page.locator('.chat-message').first().hover();
  await page.locator('.chat-message .chat-actions button').first().click();
  // Six emoji in a row rather than a column of menu rows: a picker is a
  // different shape from a list of commands, so it is a popover of plain
  // buttons and not `role=menuitem` under `role=menu`.
  await page.waitForSelector('.reaction-pick', { timeout: 3000 });
  await page.locator('.reaction-pick').first().click();
  await page.waitForTimeout(500);
  const chips = await page.locator('.chat-stream .reaction').count();
  if (!chips) throw new Error('reacting left no chip');
  console.log('     reaction chips:', chips);
});
await page.screenshot({ path: `${shots}/4c-chat-rich.png` });
await page.screenshot({ path: `${shots}/4b-chat.png` });

/**
 * Presence, with two people actually in the room.
 *
 * The only way to test this is with two browsers: a dot that lights up for
 * yourself proves nothing, and the whole feature is one person seeing another
 * person's state. Grace opens a direct conversation with Ada and starts typing;
 * Ada, who is already looking at it, has to see both the dot and the line —
 * and has to see the line go away when Grace stops.
 */
await step('chat: a dot says who is here, and a line says who is typing', async () => {
  const second = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale });
  const other = await second.newPage();
  try {
    await other.goto(base, { waitUntil: 'domcontentloaded' });
    await other.evaluate((value) => localStorage.setItem('kolibri.locale', value), locale);
    await other.goto(base, { waitUntil: 'networkidle' });
    await other.fill('#email', 'grace@kolibri.dev');
    await other.fill('#password', 'kolibri-demo');
    await other.click('button[type=submit]');
    await other.waitForSelector('.sidebar', { timeout: 15000 });
    await closeTour(other);

    // Grace opens the conversation with Ada. The id is derived, so this is the
    // same row Ada will open from her side.
    await other.goto(`${base}/chat`, { waitUntil: 'networkidle' });
    await closeTour(other);
    // Matched on the *title*, not the row.
    //
    // Either shape will do — somebody you have never written to is a name
    // under "People", and somebody you have is a conversation row — but a
    // conversation row also carries the last thing said in it, so a channel
    // where somebody mentioned Ada matches "Ada" just as well as Ada does,
    // and sorts above her when it is the more recent. Clicking the title
    // reaches the row: the span is inside the button.
    await other.locator('.chat-list .chat-row-title, .chat-list .chat-person')
      .filter({ hasText: 'Ada' }).first().click();
    await other.waitForSelector('.chat-composer textarea', { timeout: 5000 });

    await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
    await closeTour(page);
    await page.locator('.chat-list .chat-row-title, .chat-list .chat-person')
      .filter({ hasText: 'Grace' }).first().click();
    await page.waitForSelector('.chat-composer textarea', { timeout: 5000 });

    // The dot: Grace is here, and Ada's copy of the header says so.
    await page.waitForSelector('.chat-header [role=img]', { timeout: 8000 });
    console.log('     presence dots on Ada\'s screen:', await page.locator('.chat-list [role=img], .chat-header [role=img]').count());

    // The line: Grace types, Ada reads it within a second or two.
    await other.locator('.chat-composer textarea').fill('writing something…');
    await page.waitForFunction(
      () => (document.querySelector('.chat-composer [aria-live]')?.textContent ?? '').trim().length > 0,
      null,
      { timeout: 8000 },
    );
    const line = (await page.locator('.chat-composer [aria-live]').innerText()).trim();
    console.log('     typing line:', JSON.stringify(line));
    if (!line.includes('Grace')) throw new Error(`typing line did not name Grace: "${line}"`);

    // And it goes away again: an emptied composer is not "still typing".
    await other.locator('.chat-composer textarea').fill('');
    await page.waitForFunction(
      () => (document.querySelector('.chat-composer [aria-live]')?.textContent ?? '').trim().length === 0,
      null,
      { timeout: 8000 },
    );
  } finally {
    await second.close();
  }
});

/**
 * References to work, written in a chat line.
 *
 * The half that matters is the half that must *not* link: the renderer is told
 * which project keys exist rather than given a pattern, because `[A-Z]+-\d+`
 * also matches `UTF-8` and a conversation about an encoding should not fill up
 * with links to tasks nobody has.
 */
await step('chat: a message can point at a task and a project', async () => {
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.locator('.chat-list .chat-row, .chat-list .chat-person').last().click();
  await page.waitForSelector('.chat-composer textarea');

  // The `#` menu offers projects and tasks, and puts in the bare token.
  await page.locator('.chat-composer textarea').fill('');
  await page.locator('.chat-composer textarea').type('Look at #WEB-3', { delay: 20 });
  await page.waitForSelector('.mention-menu button', { timeout: 5000 });
  const offered = await page.locator('.mention-menu button').first().innerText();
  await page.keyboard.press('Enter');
  const typed = await page.locator('.chat-composer textarea').inputValue();
  if (!typed.includes('WEB-3')) throw new Error(`the menu put in "${typed}"`);
  if (typed.includes('](')) throw new Error('a reference went in as a link, not as what somebody would type');

  await page.locator('.chat-composer textarea').type('and #WEB, but not UTF-8 or NOPE-1.', { delay: 5 });
  await page.click(`.chat-composer button:has-text("${LABELS.send}")`);
  await page.waitForTimeout(900);
  const said = page.locator('.chat-message').last();
  const refs = await said.locator('a.md-ref').evaluateAll((links) => links.map((a) => `${a.textContent}→${a.getAttribute('href')}`));
  if (refs.length !== 2) throw new Error(`expected a task and a project, got ${JSON.stringify(refs)}`);
  if (!refs[0].startsWith('WEB-3→/t/WEB-3')) throw new Error(`the task reference is ${refs[0]}`);
  if (!refs[1].startsWith('#WEB→/projects/')) throw new Error(`the project reference is ${refs[1]}`);
  const html = await said.locator('.body').innerHTML();
  if (!html.includes('UTF-8') || !html.includes('NOPE-1')) throw new Error('the message lost some of its text');
  if (/href="\/t\/(UTF-8|NOPE-1)"/.test(html)) throw new Error('something that is not a task was linked');
  console.log('     references:', refs.join('  '), '· offered:', offered.replace(/\n/g, ' '));

  // And following one opens the task over the conversation rather than reloading.
  await said.locator('a.md-ref').first().click();
  await page.waitForTimeout(900);
  if (!page.url().endsWith('/t/WEB-3')) throw new Error(`clicking the reference went to ${page.url()}`);
  await page.waitForSelector('.sheet', { timeout: 5000 });
  await page.keyboard.press('Escape');
});

/**
 * Starting a conversation with somebody who is not beside you in the sidebar.
 *
 * The People list is the workspace's members, which is the right shortcut and
 * the wrong answer to "can I write to this colleague at all" — a direct
 * conversation belongs to no workspace, so it needs none in common. The
 * cross-workspace rules are proved in `test/chat.test.ts`; what this walks is
 * the way in, which no server test can see.
 */
await step('chat: anybody on the instance can be written to', async () => {
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.click(`.chat-list button:has-text("${LABELS.findPerson}")`);
  await page.waitForSelector('#find-person', { timeout: 5000 });
  await page.fill('#find-person', 'grace');
  await page.waitForTimeout(700);
  const found = await page.locator('.sheet button').allInnerTexts();
  if (!found.some((row) => /grace/i.test(row))) throw new Error(`the search offered ${JSON.stringify(found)}`);
  await page.locator('.sheet button').first().click();
  await page.waitForSelector('.chat-composer textarea', { timeout: 5000 });
  const title = await page.locator('.chat-header strong').innerText();
  if (!/grace/i.test(title)) throw new Error(`opened a conversation with "${title}"`);
  console.log('     opened a conversation with:', title);
});

/**
 * The four that were broken, and are not allowed to break again.
 *
 * Every one of these lived in the screen rather than in the model, which is
 * why a thorough set of unit tests never saw them: the history could not be
 * scrolled, a draft followed you into the next conversation and sat one click
 * from the wrong audience, a batch of messages could read out of order, and
 * Enter did not send. They are here rather than beside the other chat steps
 * because they are not a feature — they are four assertions standing over
 * four specific holes.
 *
 * Set up through the API rather than by typing thirty messages: this is about
 * what the screen does with a conversation, not about how it got one, and a
 * walkthrough that spends forty seconds sending is a walkthrough people turn
 * off.
 */
await step('chat: history, drafts, order and Enter — the four that were broken', async () => {
  const stamp = `${locale} ${Date.now()}`;
  const rooms = await page.evaluate(async (mark) => {
    const ws = localStorage.getItem('kolibri.workspace');
    const make = async (name) => (await (await fetch(`/api/workspaces/${ws}/channels`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json()).id;
    const long = await make(`long ${mark}`);
    const other = await make(`other ${mark}`);
    for (let i = 1; i <= 40; i++) {
      await fetch(`/api/workspaces/${ws}/messages`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel_id: long, body: `line ${String(i).padStart(2, '0')}` }),
      });
    }
    return { long, other };
  }, stamp);

  await page.goto(`${base}/chat/${rooms.long}`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.waitForSelector('.chat-message', { timeout: 8000 });
  await page.waitForTimeout(600);

  // The order the lines were written in is the order they read in. A batch
  // like this one lands inside a millisecond or two, so a sort on the
  // timestamp alone decides these by whatever the store happened to return.
  const order = await page.locator('.chat-message .body').allInnerTexts();
  const numbers = order.map((line) => Number(line.match(/line (\d+)/)?.[1])).filter(Number.isFinite);
  const ascending = numbers.every((n, i) => i === 0 || numbers[i - 1] < n);
  if (numbers.length < 20) throw new Error(`only ${numbers.length} of the 40 lines were drawn`);
  if (!ascending) throw new Error(`the conversation reads out of order: ${numbers.slice(0, 12).join(', ')}…`);

  // The history can be reached. A stream that bottom-aligns itself with
  // `justify-content` looks identical to one that does not, right up until the
  // messages outgrow the box and everything above the fold becomes unreachable.
  const reachable = await page.evaluate(async () => {
    const stream = document.querySelector('.chat-stream');
    if (stream.scrollHeight <= stream.clientHeight) return 'the conversation is not tall enough to test';
    stream.scrollTop = 0;
    await new Promise((done) => setTimeout(done, 400));
    if (stream.scrollTop !== 0) return 'the stream refused to scroll up';
    // Reaching the top may draw older messages; either way the first line
    // drawn must now be inside the box rather than clipped above it.
    const first = stream.querySelector('.chat-message');
    return first.getBoundingClientRect().top >= stream.getBoundingClientRect().top - 2
      ? null
      : 'the oldest message drawn is still above the top of the stream';
  });
  if (reachable) throw new Error(reachable);

  // A draft belongs to the conversation it was written in, and stays there.
  // Switched by clicking rather than by navigating: the leak this is standing
  // over was one React component being reused across conversations, which a
  // full page load would tear down and hide. Drafts live in memory for the
  // session, so a reload here would prove nothing either way.
  await page.evaluate(() => { document.querySelector('.chat-stream').scrollTop = 1e6; });
  const secret = `draft that must not follow me ${stamp}`;
  await page.fill('.chat-composer textarea', secret);
  await page.waitForTimeout(250);

  const openRow = async (prefix) => {
    await page.locator('.chat-list .chat-row-title').filter({ hasText: prefix }).first().click();
    await page.waitForSelector('.chat-composer textarea', { timeout: 8000 });
    await page.waitForTimeout(300);
  };
  await openRow(`other-${locale}-`);
  const carried = await page.locator('.chat-composer textarea').inputValue();
  if (carried.trim()) throw new Error(`the draft followed into another conversation: "${carried}"`);

  await openRow(`long-${locale}-`);
  const kept = await page.locator('.chat-composer textarea').inputValue();
  if (kept !== secret) throw new Error(`the draft was not waiting where it was written: "${kept}"`);

  // ...and Enter sends it, on a pointer that has a keyboard behind it.
  const before = await page.locator('.chat-message').count();
  await page.locator('.chat-composer textarea').click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const after = await page.locator('.chat-message').count();
  if (after !== before + 1) throw new Error(`Enter did not send: ${before} messages, then ${after}`);
  if ((await page.locator('.chat-composer textarea').inputValue()).trim()) {
    throw new Error('Enter sent the message and left it in the box');
  }
  console.log('     40 lines in order, history reachable, draft kept, Enter sends');
});

/**
 * The editor's conveniences, and a checkbox that can actually be ticked.
 *
 * `shared/src/modules/pages/editor.ts` is tested as what it is — pure rewrites of a string —
 * so what is left for a browser is the wiring: that Enter reaches the rewrite
 * at all, and that a box ticked in the preview changes the *markdown* rather
 * than only the pixel.
 */
await step('editor: Enter continues a list, and a box can be ticked', async () => {
  await page.goto(`${base}/chat`, { waitUntil: 'networkidle' });
  await closeTour(page);
  await page.locator('.chat-list .chat-row, .chat-list .chat-person').last().click();
  await page.waitForSelector('.chat-composer textarea');
  const box = page.locator('.chat-composer textarea');
  // Typed as fast as the browser will accept, deliberately. Restoring the caret
  // one animation frame after the rewrite instead of in the same commit loses
  // whatever is typed inside that frame — 10 of 12 runs came out as `- [ ] wo`
  // with the `t` somewhere further down — and nobody pauses after Enter.
  await box.fill('');
  await box.type('- [ ] one', { delay: 0 });
  await page.keyboard.press('Enter');
  await box.type('two', { delay: 0 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await box.type('nested', { delay: 0 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const typed = await box.inputValue();
  if (typed !== '- [ ] one\n- [ ] two\n  - [ ] nested\n') throw new Error(`Enter produced ${JSON.stringify(typed)}`);

  await page.click(`.chat-composer button:has-text("${LABELS.preview}")`);
  await page.waitForSelector('.editor .md input[type=checkbox]');
  const boxes = page.locator('.editor .md input[type=checkbox]');
  if (await boxes.first().isDisabled()) throw new Error('the preview offers a checkbox nobody can tick');
  await boxes.nth(1).click();
  await page.waitForTimeout(300);
  await page.click(`.chat-composer button:has-text("${LABELS.write}")`);
  const ticked = await box.inputValue();
  if (!ticked.includes('- [x] two')) throw new Error(`ticking the second box left ${JSON.stringify(ticked)}`);
  if (ticked.includes('- [x] one')) throw new Error('ticking one box ticked another');
  console.log('     the list wrote itself, and the box that was clicked is the box that changed');
  await box.fill('');
});

/**
 * Signing in an assistant that cannot hold a header.
 *
 * `test/oauth.test.ts` proves the protocol — discovery, PKCE, single-use codes,
 * rotation. What only a browser can prove is that somebody can actually press
 * the button: the instance sends `form-action 'self'` on everything, and a
 * browser applies that to where a form's *redirect* lands, so the consent page
 * silently refused to submit until its policy named the client. Nothing on the
 * server could see that.
 */
await step('a connector can be authorised in a browser', async () => {
  const redirect = 'https://claude.example/callback';
  const verifier = 'smoke-verifier-that-is-long-enough-to-be-one';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const client = await (await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Smoke', redirect_uris: [redirect] }),
  })).json();

  const query = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write', state: 'smoke',
  });

  // A fresh context carrying the signed-in session, the way a connector's popup
  // arrives once somebody is already signed in here.
  const popup = await browser.newContext({ viewport: { width: 900, height: 800 }, locale, storageState: await ctx.storageState() });
  const view = await popup.newPage();
  let code = '';
  await view.route(`${redirect}*`, (route) => {
    code = new URL(route.request().url()).searchParams.get('code') ?? '';
    route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
  });
  try {
    await view.goto(`${base}/oauth/authorize?${query}`);
    await view.waitForSelector('.box form', { timeout: 10000 });
    await view.locator('button.primary').click();
    await view.waitForTimeout(1200);
    if (!code) throw new Error('pressing Allow produced no code — check the page\'s form-action policy');

    const granted = await (await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: client.client_id,
        redirect_uri: redirect, code_verifier: verifier,
      }).toString(),
    })).json();
    if (granted.token_type !== 'Bearer') throw new Error(`the token endpoint said ${JSON.stringify(granted)}`);

    const call = await (await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${granted.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).json();
    const tools = call.result?.tools?.length ?? 0;
    if (tools < 10) throw new Error(`the granted token reached ${tools} tools`);
    console.log('     authorised in a browser, and the token reaches', tools, 'tools');
  } finally {
    await popup.close();
  }
});

await step('command palette', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.fill('.palette input', 'dark mode');
  await page.waitForTimeout(300);
  const hits = await page.locator('.palette .results button').count();
  if (!hits) throw new Error('no palette hits');
  console.log('     palette hits:', hits);
  await page.keyboard.press('Escape');
});

await step('search: prose finds work, and @ offers the people', async () => {
  await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input');
  const box = page.locator('input').first();
  await box.click();
  // The whole point of the box: a character nobody had to be told about opens
  // a list of real names. If the list is empty the feature is decoration.
  await box.type('@');
  await page.waitForSelector('#search-suggestions [role=option]', { timeout: 5000 });
  const offered = await page.locator('#search-suggestions [role=option]').count();
  if (offered < 2) throw new Error(`the @ list offered ${offered} people`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const picked = await box.inputValue();
  if (!/^@\S/.test(picked)) throw new Error(`picking a name left "${picked}" in the box`);
  console.log('     picked:', picked.trim());
  // And prose on its own still answers.
  await box.fill('');
  await box.type('the');
  await page.waitForTimeout(1200);
  const rows = await page.locator('.task-row').count();
  if (!rows) throw new Error('typing words found nothing at all');
  console.log('     rows for a plain word:', rows);
});

await step('the server\'s own settings are editable, and stick', async () => {
  await page.goto(`${base}/settings?tab=instance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('label:has-text("KOLIBRI_MAIL_FROM_NAME")');
  // The variable's own name is on screen beside every field, which is also
  // what makes this findable in three languages.
  const named = await page.locator('label:has-text("KOLIBRI_")').count();
  if (named < 10) throw new Error(`only ${named} settings on the screen`);
  console.log('     settings on the screen:', named);

  const field = page.locator('label:has-text("KOLIBRI_MAIL_FROM_NAME") input');
  await field.fill('Smoke test');
  await page.locator('section:has-text("KOLIBRI_MAIL_FROM_NAME")').getByRole('button', { name: LABELS.save }).click();
  await page.waitForTimeout(600);

  // Written, and read back by a fresh load rather than by the form it was
  // typed into: the point of the screen is that the running server changed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('label:has-text("KOLIBRI_MAIL_FROM_NAME")');
  const back = page.locator('label:has-text("KOLIBRI_MAIL_FROM_NAME") input');
  if ((await back.inputValue()) !== 'Smoke test') throw new Error('the setting did not survive a reload');

  // And handed back to the environment again, so the run leaves nothing behind.
  await page.locator('label:has-text("KOLIBRI_MAIL_FROM_NAME")').getByRole('button').click();
  await page.locator('section:has-text("KOLIBRI_MAIL_FROM_NAME")').getByRole('button', { name: LABELS.save }).click();
  await page.waitForTimeout(600);
  console.log('     saved, read back, and cleared again');
});

await step('mobile layout', async () => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale });
  const m = await mobile.newPage();
  await m.goto(base, { waitUntil: 'domcontentloaded' });
  await m.evaluate((value) => localStorage.setItem('kolibri.locale', value), locale);
  await m.goto(base, { waitUntil: 'networkidle' });
  await m.fill('#email', 'ada@kolibri.dev');
  await m.fill('#password', 'kolibri-demo');
  await m.click('button[type=submit]');
  await m.waitForSelector('.tabbar', { timeout: 15000 });
  await closeTour(m);
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${shots}/5-mobile.png` });
  await m.emulateMedia({ colorScheme: 'dark' });
  await m.screenshot({ path: `${shots}/6-mobile-dark.png` });
  await m.emulateMedia({ colorScheme: 'light' });

  /*
   * Everything the sidebar reaches, a phone reaches too.
   *
   * The bottom bar holds a handful and the sidebar holds a dozen, so "More"
   * is the rest of the app rather than a convenience — anything the sidebar
   * has and this screen has not is *unreachable* on a phone. Chat was, and
   * nobody noticed until somebody tried to use it on a phone; it has a slot
   * of its own in the bar now, and is still listed here too. So the desktop
   * sidebar is read for its destinations and this screen is asked for the
   * same ones, instead of a list here that has to be remembered when the
   * sidebar grows.
   */
  const wanted = await page.locator('.sidebar a[href]').evaluateAll((links) => [...new Set(links
    .map((a) => a.getAttribute('href'))
    .filter((href) => href && href !== '/' && !href.startsWith('/t/')))]);
  await m.click('.tabbar a[href="/more"]');
  // Waited for by the screen's own content rather than by a link that happens
  // to be on it: `a[href="/chat"]` was the marker until chat earned a place in
  // the bar as well, at which point it matched before this screen had drawn
  // anything and every destination came back missing.
  await m.waitForURL(/\/more(\?|$)/, { timeout: 5000 });
  await m.waitForFunction(
    () => document.querySelectorAll('main.content a[href]').length > 3,
    null,
    { timeout: 5000 },
  );
  const reachable = new Set(await m.evaluate(() => [...document.querySelectorAll('a[href]')]
    .filter((a) => a.offsetParent !== null)
    .map((a) => a.getAttribute('href'))));
  const missing = wanted.filter((href) => !reachable.has(href));
  if (missing.length) throw new Error(`the sidebar reaches these and a phone does not: ${missing.join(', ')}`);
  console.log('     reachable on a phone:', wanted.length, 'of', wanted.length, 'sidebar destinations');
  await m.screenshot({ path: `${shots}/7-mobile-more.png` });
  await mobile.close();
});

await step('offline mode', async () => {
  await ctx.setOffline(true);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
  const rows = await page.locator('.task-row').count();
  console.log('     rows while offline:', rows);
  await ctx.setOffline(false);
});

await step('setup checklist reflects the workspace, empty screens offer help', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.setup', { timeout: 5000 });
  const rows = await page.locator('.setup-item').count();
  const done = await page.locator('.setup-item.done').count();
  console.log('     checklist:', `${done}/${rows} already true of the seeded workspace`);
  if (rows < 3) throw new Error(`checklist has only ${rows} items`);
  // The demo workspace has projects, tasks and pages, so those must read as done.
  if (done < 3) throw new Error(`expected the seeded work to tick at least 3, got ${done}`);

  // Settings always carries a hint, so this is the deterministic end of the
  // mechanism: click it and the guide must open on that card, scrolled to it.
  await page.goto(`${base}/settings?tab=api`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.guide-hint', { timeout: 5000 });
  await page.click('.guide-hint');
  await page.waitForSelector('#guide-assistant');
  await page.waitForTimeout(1100);
  const placed = await page.evaluate(() => {
    const box = document.getElementById('guide-assistant')?.getBoundingClientRect();
    return box ? box.top > -60 && box.top < 420 : false;
  });
  if (!placed) throw new Error('the linked card was not scrolled into view');

  // The empty screens that do have something to explain carry one too. The
  // demo workspace is not empty everywhere, so this counts rather than demands.
  let offered = 0;
  for (const path of ['/teams', '/pages', '/inbox']) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    if (await page.locator('.empty .guide-hint').count()) offered++;
  }
  console.log('     empty screens offering help:', offered, 'of 3 visited');

  // And a checklist button lands on the tab it names.
  await page.goto(`${base}/settings?tab=members`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabs button.active');
  const tab = await page.locator('.tabs button.active').innerText();
  console.log('     settings deep link opened:', tab);
});

await step('templates and rules are set up and readable', async () => {
  await page.goto(`${base}/settings?tab=automation`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.auto-row', { timeout: 5000 });
  const templates = await page.locator('.auto-row .auto-glyph').count();
  const rules = await page.locator('.auto-switch').count();
  console.log('     templates:', templates, ' rules:', rules);
  if (!templates || !rules) throw new Error('the seeded template or rule is missing');
  if (!await page.locator('.auto-switch.on').count()) throw new Error('the seeded rule is off');

  // The log opens and says something, even before the rule has ever fired.
  await page.locator(`.auto-row button:has-text("${LABELS.log}")`).first().click();
  await page.waitForSelector('.sheet');
  const log = await page.locator('.sheet .body').innerText();
  if (/auto\.[a-z]|tpl\.[a-z]/i.test(log)) throw new Error(`untranslated key in the log: ${log.slice(0, 60)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // The rule editor opens with its recipient rows.
  await page.locator('.auto-row').last().locator('button').last().click();
  await page.waitForSelector('#rule-name', { timeout: 5000 });
  const recipients = await page.locator('.auto-recipient').count();
  if (!recipients) throw new Error('the rule editor shows no recipients');
  console.log('     recipient rows in the editor:', recipients);
  await page.keyboard.press('Escape');
});
await page.screenshot({ path: `${shots}/8-automation.png` });

await step('guide opens, explains itself, and leaks no keys', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  await page.keyboard.press('Shift+Slash');            // the `?` shortcut
  await page.waitForSelector('.guide', { timeout: 5000 });
  if (!page.url().endsWith('/guide')) throw new Error(`? went to ${page.url()}`);

  const tabs = await page.locator('.tabs button').count();
  if (tabs !== 4) throw new Error(`expected 4 sections, found ${tabs}`);

  // Walk every section and make sure no raw translation key reached the screen.
  for (let index = 0; index < tabs; index++) {
    await page.locator('.tabs button').nth(index).click();
    await page.waitForTimeout(150);
    const text = await page.locator('.guide').innerText();
    const leak = text.match(/guide\.[\w.]+/);
    if (leak) throw new Error(`untranslated key on screen: ${leak[0]}`);
  }

  // Every step of every animation has to say something.
  await page.locator('.tabs button').nth(2).click();
  await page.waitForSelector('.guide-feature .stage');
  const stages = page.locator('.stage');
  let steps = 0;
  for (let index = 0; index < await stages.count(); index++) {
    const stage = stages.nth(index);
    const dots = await stage.locator('.dots button').count();
    for (let dot = 0; dot < dots; dot++) {
      await stage.locator('.dots button').nth(dot).click();
      const caption = (await stage.locator('.caption').innerText()).trim();
      if (caption.length < 25) throw new Error(`stage ${index} step ${dot} has no narration`);
      steps++;
    }
  }
  console.log('     narrated animation steps:', steps);
  // Asserted and not only counted, because TODO.md quotes this figure and a
  // logged number nobody reads is how it came to say 32 when it was 41.
  if (steps !== GUIDE.steps) {
    throw new Error(`${steps} narrated animation steps, TODO.md says ${GUIDE.steps} — one of the two is wrong`);
  }

  // Every node of the hierarchy has to explain itself.
  await page.locator('.tabs button').nth(1).click();
  await page.waitForSelector('.gx-hierarchy');
  const nodes = page.locator('.gx-node');
  for (let index = 0; index < await nodes.count(); index++) {
    await nodes.nth(index).click();
    const detail = await page.locator('.gx-detail').innerText();
    if (detail.length < 90) throw new Error(`hierarchy node ${index} is not explained`);
  }
  const nodeCount = await nodes.count();
  console.log('     hierarchy nodes explained:', nodeCount);
  if (nodeCount !== GUIDE.nodes) {
    throw new Error(`${nodeCount} hierarchy nodes, TODO.md says ${GUIDE.nodes} — one of the two is wrong`);
  }
});
await page.screenshot({ path: `${shots}/7-guide.png` });

/**
 * The one combination nobody tries: an OS set to dark, the app pinned to light.
 *
 * Native controls — a checkbox, a date picker, an input with no background of
 * its own — follow `color-scheme`, not the app's variables. Declaring
 * `light dark` and leaving it there means a pinned theme never reaches them, so
 * choosing light on a dark machine gave white dialogs full of dark boxes. It
 * was reported from a real screen, not caught here, which is why it is here now.
 */
await step('a pinned theme reaches the controls the browser paints itself', async () => {
  // The session is carried over rather than signed in for again. Sign-in is
  // rate-limited per account, and this walk already runs three times against one
  // instance — two more logins a run was enough to trip it in the third.
  const session = await ctx.storageState();
  for (const [os, pinned] of [['dark', 'light'], ['light', 'dark']]) {
    const themed = await browser.newContext({
      viewport: { width: 1280, height: 900 }, colorScheme: os, locale, storageState: session,
    });
    const view = await themed.newPage();
    try {
      await view.goto(base, { waitUntil: 'domcontentloaded' });
      await view.evaluate(([t, l]) => {
        localStorage.setItem('kolibri.theme', t);
        localStorage.setItem('kolibri.locale', l);
      }, [pinned, locale]);
      await view.goto(`${base}/chat`, { waitUntil: 'networkidle' });
      await view.waitForSelector('.sidebar', { timeout: 15000 });
      await closeTour(view);
      await view.click(`button:has-text("${LABELS.newChannel}")`);
      await view.waitForSelector('.sheet input', { timeout: 5000 });
      await view.waitForTimeout(300);

      const seen = await view.evaluate(() => {
        const luma = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.round(0.2126*r + 0.7152*g + 0.0722*b); };
        const sheet = document.querySelector('.sheet');
        return {
          scheme: getComputedStyle(document.documentElement).colorScheme,
          sheet: luma(getComputedStyle(sheet).backgroundColor),
          field: luma(getComputedStyle(sheet.querySelector('input')).backgroundColor),
        };
      });
      if (seen.scheme !== pinned) throw new Error(`pinned ${pinned} but color-scheme is "${seen.scheme}"`);
      if (Math.abs(seen.sheet - seen.field) > 90) {
        throw new Error(`OS ${os} + pinned ${pinned}: sheet ${seen.sheet}, field ${seen.field} — a dark box in a light dialog`);
      }
      console.log(`     OS ${os} + pinned ${pinned}: color-scheme ${seen.scheme}, sheet ${seen.sheet}, field ${seen.field}`);
    } finally {
      await themed.close();
    }
  }
});

/**
 * A device that already had the database from an older build.
 *
 * IndexedDB only runs `onupgradeneeded` when the version number goes up, and
 * the version used to be a constant a person had to remember to bump. Chat was
 * added and it was not bumped, so every browser that had ever opened the app
 * before was missing three stores — and the way that showed up was not an error
 * dialog but a channel that appeared, vanished a few seconds later, and came
 * back on the next tab switch: the pull could apply its changes to memory and
 * then fail to save them, so the cursor was never written, so the next pull
 * started from zero and the snapshot that came back emptied the tables first.
 *
 * The version is derived from the store list now. This walks the case that
 * cannot happen on a fresh browser, which is exactly why nothing caught it.
 */
await step('a database from an older build gets the stores it is missing', async () => {
  const session = await ctx.storageState();
  const aged = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale, storageState: session });
  const view = await aged.newPage();
  const faults = [];
  view.on('pageerror', (e) => faults.push(e.message));
  view.on('console', (m) => { if (m.type() === 'error') faults.push(m.text()); });
  try {
    // Let the app build the database first — a signed-in context carries
    // cookies, not IndexedDB, so without this there is nothing to age and the
    // step passes while testing an empty database.
    await view.goto(base, { waitUntil: 'networkidle' });
    await view.waitForSelector('.sidebar', { timeout: 15000 });
    await closeTour(view);
    await view.waitForTimeout(1500);
    // Then somewhere on the origin that is not the app: a page holding a
    // connection blocks `deleteDatabase` for ever, and the app opens one on load.
    await view.goto(`${base}/icon.svg`);
    const rewound = await view.evaluate(async () => {
      const read = await new Promise((res) => { const r = indexedDB.open('kolibri'); r.onsuccess = () => res(r.result); });
      const version = read.version;
      // Any three stores would simulate an older build equally well; these are
      // the three the incident was actually about.
      const all = [...read.objectStoreNames];
      const older = all.filter((n) => !['channel', 'message', 'channelRead'].includes(n));
      read.close();
      await new Promise((res) => {
        const gone = indexedDB.deleteDatabase('kolibri');
        gone.onsuccess = gone.onerror = gone.onblocked = () => res();
      });
      await new Promise((res) => {
        const open = indexedDB.open('kolibri', version);
        open.onupgradeneeded = () => {
          for (const name of older) open.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
        };
        open.onsuccess = () => { open.result.close(); res(); };
      });
      return { version, stores: older.length, dropped: all.length - older.length };
    });

    faults.length = 0;
    await view.goto(base, { waitUntil: 'networkidle' });
    await view.waitForSelector('.sidebar', { timeout: 15000 });
    await closeTour(view);
    await view.goto(`${base}/chat`, { waitUntil: 'networkidle' });
    await view.waitForTimeout(2500);

    const now = await view.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('kolibri'); r.onsuccess = () => res(r.result); });
      const missing = ['channel', 'message', 'channelRead'].filter((n) => !db.objectStoreNames.contains(n));
      // The sync cursor is only written once a pull has saved its rows, so this
      // is the difference between "opened" and "actually usable".
      const cursor = await new Promise((res) => {
        const get = db.transaction('meta', 'readonly').objectStore('meta').get('sync');
        get.onsuccess = () => res(get.result?.value?.cursor ?? 0);
        get.onerror = () => res(0);
      });
      const version = db.version;
      db.close();
      return { missing, cursor, version };
    });

    if (rewound.dropped !== 3) throw new Error(`nothing was aged — the database had ${rewound.stores} stores, so this proved nothing`);
    if (now.missing.length) throw new Error(`still missing: ${now.missing.join(', ')}`);
    if (!now.cursor) throw new Error('the sync cursor was never written — a pull applied rows it could not save');
    if (faults.length) throw new Error(`the app complained: ${faults[0]}`);
    console.log(`     aged to ${rewound.stores} stores at version ${rewound.version}, reopened at ${now.version}, cursor ${now.cursor}`);
  } finally {
    await aged.close();
  }
});

/**
 * A feature that is off leaves no trace.
 *
 * CI runs with no model configured, which is the state almost every instance
 * is in, and that state has one job: look like an app that simply does not
 * have this. Not a disabled button, not a tooltip explaining what somebody
 * else would have to configure — nothing on the task at all. The switch in
 * settings is the one place it is mentioned, and it says who has to act.
 */
await step('with no model configured, reviews leave no trace', async () => {
  await page.goto(`${base}/settings?tab=workspace`, { waitUntil: 'networkidle' });
  const row = page.locator('.check-row').filter({ hasText: LABELS.reviewFeature });
  if (!(await row.count())) throw new Error('the workspace settings never mention reviews');
  const box = row.locator('input[type=checkbox]');
  if (!(await box.isDisabled())) throw new Error('a switch that would do nothing is offered anyway');

  // And nothing of it reaches a task.
  await page.goto(`${base}/t/WEB-1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sheet', { timeout: 5000 });
  if (await page.locator('.review').count()) throw new Error('a task shows a review panel with no model configured');
  const headings = await page.locator('.sheet strong').allInnerTexts();
  if (headings.some((one) => one.trim() === LABELS.reviewSection)) {
    throw new Error('a task offers a review with no model configured');
  }
  console.log('     settings say who configures it; the task says nothing');
  await closeSheets(page);
});

/**
 * A screen behind a feature switch, walked the way a person walks it.
 *
 * This step exists because two bugs shipped through everything else in this
 * repository, and both were invisible to every check that already ran.
 *
 * The **feature-switched screens are not in any of the browser scripts' lists**
 * — a seeded instance has budgets, KPIs, the timesheet and mail switched off,
 * so `responsive.mjs`, `contrast.mjs` and this walkthrough all stopped at the
 * door. The mailbox editor shipped with its host field squeezed to two pixels
 * by a `<select>` sharing its row, and nothing noticed, because nothing had
 * opened it.
 *
 * And **a field is only fair to test at typing speed**. `fill()` sets a value
 * in one assignment; a person presses one key at a time. Every box here was
 * written straight through to the synced store on each keystroke, so React put
 * the previous value back between the press and the render: typing `587` into
 * the port produced `57`, and 57 is what the server stored. A `fill()` test
 * passed the whole time.
 *
 * So: switch it on, make one, reload — the state where a stale snapshot can
 * overwrite an edit — then type into it like a person and check that what is on
 * screen, and what the server has, is what was typed.
 */
await step('a feature-switched screen can be opened, filled in and typed into', async () => {
  await page.goto(`${base}/settings?tab=workspace`, { waitUntil: 'networkidle' });
  const row = page.locator('label.check-row', { hasText: LABELS.mailFeature });
  if (!(await row.count())) throw new Error(`no "${LABELS.mailFeature}" switch on the workspace tab`);
  const box = row.locator('input[type=checkbox]');
  if (!(await box.isChecked())) {
    // A plain click, not `check()`: the box is controlled by the workspace row
    // and only flips once the request has come back, which `check()` reads as a
    // failure to change the state.
    await box.click();
    await page.waitForSelector(`.tabs button:has-text("${LABELS.mailboxesTab}")`, { timeout: 15000 });
  }

  /*
   * Start from no mailbox, every run.
   *
   * The first version of this step reused whatever the last run left behind,
   * and the last run left a mailbox on port 587 — so typing 587 into a box that
   * kept snapping back to 587 looked exactly like success. It passed with the
   * bug deliberately put back, which is the only thing worse than not having
   * the step at all.
   */
  const workspace = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const id = session.workspaces[0].id;
    const answer = await (await fetch(`/api/workspaces/${id}/mailboxes`)).json();
    for (const one of answer.mailboxes) {
      if (one.address === 'smoke@example.com') await fetch(`/api/mailboxes/${one.id}`, { method: 'DELETE' });
    }
    return id;
  });

  await page.goto(`${base}/settings?tab=mailboxes`, { waitUntil: 'networkidle' });
  const address = page.locator('input[placeholder="support@example.com"]');
  await address.waitFor({ timeout: 10000 });
  await address.fill('smoke@example.com');
  await page.locator('form button[type=submit]').last().click();
  await page.waitForTimeout(1200);

  // Reloaded on purpose: a mailbox made in this session is not in the credential
  // snapshot the screen fetches on mount, so every edit sticks whether or not
  // the bug is there. Only a row that was already present when the screen
  // loaded can show it.
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('button', { hasText: new RegExp(`^${LABELS.edit}$`) }).first().click();
  await page.waitForTimeout(600);

  const port = page.locator('input[type=number]').first();
  const before = await port.inputValue();
  // The assertion below only means something if the box does not already hold
  // what is about to be typed into it.
  if (before === '587') throw new Error('the new mailbox already had port 587 — this step would prove nothing');

  await port.click();
  await page.keyboard.press('Control+a');
  for (const key of '587') {
    await page.keyboard.type(key);
    // A quarter of a second between keys, which is roughly how fast a person
    // types and is the whole point of the pause. The first version of this used
    // 80ms and passed with the bug deliberately put back: React batches
    // keystrokes that close together, so the stale value lands after all three
    // rather than between them. A test faster than a human is the same mistake
    // as one gentler than a human — `fill()` was the other half of it.
    await page.waitForTimeout(250);
  }
  const typed = await port.inputValue();
  if (typed !== '587') throw new Error(`the port box lost keystrokes: shows "${typed}" after typing 587 over ${before}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(1200);
  const kept = await port.inputValue();
  if (kept !== '587') throw new Error(`the port reverted to "${kept}" after leaving the field`);

  const stored = await page.evaluate(async (id) => {
    const answer = await (await fetch(`/api/workspaces/${id}/mailboxes`)).json();
    return answer.mailboxes.find((one) => one.address === 'smoke@example.com')?.port;
  }, workspace);
  if (stored !== 587) throw new Error(`the server stored port ${stored}, not 587`);
});

await step('interface is in the chosen language', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== locale) throw new Error(`<html lang> is "${lang}", expected "${locale}"`);
  const nav = await page.locator('.sidebar').innerText();
  for (const label of [LABELS.pages, LABELS.guide]) {
    if (!nav.includes(label)) throw new Error(`sidebar does not mention "${label}"`);
  }
});

console.log(`\nlocale: ${locale}  ·  screenshots: ${shots}`);
// Reported, not fatal: an unauthenticated probe on load answers 401, and the
// offline step disconnects the network on purpose. Both are console errors and
// neither is a fault.
console.log('console errors:', errors.length);
errors.slice(0, 8).forEach((e) => console.log('  -', e));
await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} step(s) failed in ${locale}:`);
  failures.forEach((f) => console.log('  -', f));
  process.exit(1);
}
