/**
 * What the model actually writes when a board is asked to fit a phone —
 * measured, not assumed.
 *
 * Everything else about boards on phones is checked against boards written
 * here, which say exactly what they were written to say. Two things are not:
 * *Make it fit phones*, which hands a board to the model with an instruction
 * and puts back what comes out, and the phone rule in the system prompt every
 * drawing is made under. Both are a promise about what a model does with
 * words, and no unit test can keep it. So this asks the real one, through the
 * same route the app uses, and measures every answer in a browser at a
 * phone's width — **without** the fitting the app adds, because the question
 * is what the model wrote, not what we can repair afterwards:
 *
 *   - four boards too wide for a phone, each a different way, are asked to fit
 *     one with the very sentence the button sends (read from the English
 *     locale, so this asks what a reader asks);
 *   - one board is drawn from a sentence at desktop width, as a new board is;
 *
 * and each answer must: run off neither a 390px screen nor a 1280px one; keep
 * its text at 11px or more (fitting by shrinking is not fitting); keep what
 * the board said (nine words in ten of the original, for a redraw); and ask
 * the network for nothing, because a board is drawn where there is none.
 *
 * It needs a running, seeded instance with a model — the key belongs to the
 * server, never to this script — and switches Claude on for the seeded
 * workspace, as its admin would:
 *
 *   ANTHROPIC_API_KEY=… KOLIBRI_DATA_DIR=/tmp/k PORT=4400 npm start &
 *   KOLIBRI_URL=http://localhost:4400 npm run check:model
 *
 * It spends real tokens — five boards, a few cents to a few dimes — which is
 * why CI runs it only when somebody asks (`model.yml`, by hand). An instance
 * with no model says so and stops with exit code 2: nothing was measured, and
 * that is not a pass.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const PHONE = 390;
const WIDE_SCREEN = 1280;

/** The instruction *Make it fit phones* sends, as a reader's app sends it. */
function makeFitAsk() {
  const source = readFileSync(new URL('../packages/web/src/kernel/i18n/locales/en.ts', import.meta.url), 'utf8');
  const found = /'board\.makeFitAsk':\s*'((?:[^'\\]|\\.)*)'/.exec(source);
  if (!found) throw new Error('board.makeFitAsk is missing from the English locale');
  return found[1].replace(/\\'/g, "'");
}

const doc = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Wide</title></head>
<body style="margin: 0; font-family: system-ui, sans-serif"><div style="padding: 24px"><h1 style="margin: 0 0 12px">Quarterly pipeline</h1>${body}</div></body></html>`;
/** The same four ways of running off a phone `check:engines` walks, with words worth keeping. */
const WIDE = {
  'a grid of eight fixed columns': doc(`<div style="display: grid; grid-template-columns: repeat(8, 160px); gap: 12px">
${['Lead', 'Qualified', 'Demo', 'Proposal', 'Negotiation', 'Contract', 'Won', 'Onboarding'].map((stage, at) => `<div style="padding: 12px; border: 1px solid #d0d4dc; border-radius: 8px"><strong>${stage}</strong><p>${(at + 2) * 3} deals</p></div>`).join('')}</div>`),
  'a layout placed by position': doc(`<div style="position: relative; width: 1200px; height: 420px">
<div style="position: absolute; left: 0; top: 0; width: 360px">Revenue this quarter is 1.2 million euros, ahead of plan.</div>
<div style="position: absolute; left: 420px; top: 0; width: 360px">Twelve new customers signed, three of them in Austria.</div>
<div style="position: absolute; left: 840px; top: 0; width: 340px">Churn stayed under two per cent for the fourth month.</div></div>`),
  'a line that never wraps': doc(`<p style="white-space: nowrap">The renewal of the Hamburg contract moves to October because legal wants another review of the data processing terms.</p>`),
  'a table of six wide columns': doc(`<table style="width: 1100px; border-collapse: collapse"><thead><tr>${['Customer', 'Owner', 'Stage', 'Value', 'Close date', 'Next step'].map((head) => `<th style="text-align: left; padding: 8px; border-bottom: 2px solid #333">${head}</th>`).join('')}</tr></thead>
<tbody>${[['Nordlicht GmbH', 'Ada', 'Proposal', '€84,000', '12 Nov', 'Pricing call'], ['Brightwater', 'Lin', 'Negotiation', '€120,000', '30 Nov', 'Legal review'], ['Kestrel AG', 'Sam', 'Demo', '€46,000', '15 Dec', 'Second demo']].map((row) => `<tr>${row.map((cell) => `<td style="padding: 8px; border-bottom: 1px solid #ddd">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`),
};
const DRAW = 'A sales dashboard: four figures across the top (revenue, deals won, average deal size, win rate), '
  + 'a bar chart of revenue for the last six months, the pipeline as six stages with the number of deals in each, '
  + 'and a table of the eight largest open deals with customer, owner, stage, value and close date.';

let failed = 0;
const lines = [];
const report = (ok, what, detail) => {
  if (!ok) failed += 1;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${what} — ${detail}`);
  console.log(lines[lines.length - 1]);
};

/** Words a reader sees, for "did the redraw keep what the board said". */
const words = (text) => new Set((text.toLowerCase().match(/[a-zäöüß0-9€.,]+/g) ?? []).map((word) => word.replace(/[.,]+$/, '')).filter((word) => word.length > 2));

/**
 * The answer, drawn on its own at a width, with nothing of ours in it. Every
 * request it makes is refused and counted — a board is drawn where there is
 * no network — and its text is read as a reader would see it.
 */
async function measure(browser, html, width) {
  const page = await (await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })).newPage();
  const asked = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url === 'about:blank') return route.continue();
    asked.push(url);
    return route.abort();
  });
  await page.setContent(html, { waitUntil: 'load' }).catch(() => null);
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => {
    const root = document.documentElement;
    let smallest = Infinity;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || !node.parentElement) continue;
      const box = node.parentElement.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      smallest = Math.min(smallest, parseFloat(getComputedStyle(node.parentElement).fontSize) || Infinity);
    }
    return { over: root.scrollWidth - root.clientWidth, smallest: Number.isFinite(smallest) ? smallest : 0, text: document.body.innerText };
  });
  await page.context().close();
  return { ...seen, asked };
}

async function signIn(browser) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/`);
  await page.fill('#email', 'ada@kolibri.dev');
  await page.fill('#password', 'kolibri-demo');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#email', { state: 'detached', timeout: 20000 });
  return page;
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const app = await signIn(browser);
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => app.evaluate(async ([path, body, method]) => {
    const response = await fetch(path, {
      method, credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [path, body, method]);

  /**
   * Ask for a board. The route is rate-limited per person, as every model
   * route is; a run that comes back too soon after the last one is told how
   * long to wait, and waits — a refusal to answer yet is not an answer.
   */
  const draft = async (page, body) => {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await call(`/api/pages/${page}/boards/draft`, body);
      if (answer.status !== 429 || attempt === 3) return answer;
      const seconds = Number(/(\d+) seconds?/.exec(answer.body?.message ?? '')?.[1] ?? 20);
      console.log(`  (asked too soon — waiting ${seconds}s, as the server says)`);
      await app.waitForTimeout((seconds + 1) * 1000);
    }
  };

  const config = await call('/api/config');
  if (!config.body?.ai?.provider) {
    console.log('This instance has no model — start it with ANTHROPIC_API_KEY (or KOLIBRI_AI_API_KEY) set. Nothing was measured.');
    process.exit(2);
  }
  // The workspace the app opened, as `check:engines` finds it.
  await app.waitForFunction(() => !!localStorage.getItem('kolibri.workspace'), null, { timeout: 20000 }).catch(() => null);
  const ws = await app.evaluate(() => localStorage.getItem('kolibri.workspace'));
  if (!ws) throw new Error('no workspace to draw in — is the instance seeded?');
  // Claude is a workspace's own choice, and the seeded one has not made it:
  // switched on here, as its admin would.
  const switched = await call(`/api/workspaces/${ws}`, { features: { ai: true } }, 'PATCH');
  if (switched.status !== 200) throw new Error(`could not switch Claude on for the workspace (${switched.status})`);
  console.log(`asking the ${config.body.ai.provider} model configured at ${base}\n`);
  let model = '';
  const answered = (body) => { if (!model && body?.model) { model = body.model; console.log(`the model asked for: ${model}\n`); } };

  const board = async (title, content) => {
    const page = await call(`/api/workspaces/${ws}/pages`, { title, format: 'board' });
    const made = await call(`/api/workspaces/${ws}/artboards`, { page_id: page.body.id, title, content, w: WIDE_SCREEN, h: 800 });
    return { page: page.body.id, board: made.body.id };
  };
  const judge = async (what, html, original) => {
    if (!/^\s*<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html)) {
      report(false, what, `not one whole document (${html.slice(0, 60).replace(/\s+/g, ' ')}…)`);
      return;
    }
    const phone = await measure(browser, html, PHONE);
    const wide = await measure(browser, html, WIDE_SCREEN);
    const problems = [];
    if (phone.over > 1) problems.push(`${phone.over}px off a ${PHONE}px screen`);
    if (wide.over > 1) problems.push(`${wide.over}px off a ${WIDE_SCREEN}px screen`);
    if (phone.smallest < 11) problems.push(`text down to ${phone.smallest}px on the phone`);
    if (phone.asked.length) problems.push(`asked the network for ${phone.asked.length} thing(s): ${phone.asked[0]}`);
    let kept = '';
    if (original) {
      const before = words((await measure(browser, original, WIDE_SCREEN)).text);
      const after = words(phone.text);
      const share = [...before].filter((word) => after.has(word)).length / Math.max(1, before.size);
      kept = `, ${Math.round(share * 100)}% of its words kept`;
      if (share < 0.9) problems.push(`kept only ${Math.round(share * 100)}% of what it said`);
    }
    report(!problems.length, what, problems.length ? problems.join('; ')
      : `${phone.over}px over at ${PHONE}px, ${wide.over}px at ${WIDE_SCREEN}px, smallest text ${phone.smallest}px${kept}`);
  };

  const ask = makeFitAsk();
  for (const [what, html] of Object.entries(WIDE)) {
    const { page, board: id } = await board(what, html);
    const answer = await draft(page, { instruction: ask, board: id, match: false });
    answered(answer.body);
    if (answer.status !== 200 || typeof answer.body?.html !== 'string') {
      report(false, `make it fit phones: ${what}`, `the route answered ${answer.status}: ${answer.body?.message ?? answer.body?.error ?? '—'}`);
      continue;
    }
    await judge(`make it fit phones: ${what}`, answer.body.html, html);
  }

  const { page } = await board('Drawn from a sentence', '');
  const drawn = await draft(page, { instruction: DRAW, w: WIDE_SCREEN, h: 900, match: false });
  answered(drawn.body);
  if (drawn.status !== 200 || typeof drawn.body?.html !== 'string') {
    report(false, 'a board drawn from a sentence', `the route answered ${drawn.status}: ${drawn.body?.message ?? drawn.body?.error ?? '—'}`);
  } else {
    await judge('a board drawn from a sentence, at desktop width, read on a phone', drawn.body.html, null);
  }
} catch (error) {
  report(false, 'the walk', `stopped: ${String(error?.message ?? error).split('\n')[0]}`);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} answer(s) did not fit` : '\nevery answer fits a phone as written');
process.exit(failed ? 1 : 0);
