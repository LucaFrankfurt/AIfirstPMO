/**
 * The module map, and the rules that keep it one.
 *
 * `docs/modules.md` says Kolibri is a kernel, a ring of capabilities around it
 * and a ring of adapters around those. That is a claim about every file in the
 * repository, and a claim that size is exactly the kind of thing that is true
 * on the day it is written and quietly false a month later — the same failure
 * mode `figures.mjs` exists for, one floor up: there the number was wrong, here
 * it would be the shape.
 *
 * So the map is data rather than prose, and four rules are checked against it:
 *
 *   1. **Every source file belongs to exactly one module.** A new file that
 *      nothing claims fails the build, which is the whole point: it forces the
 *      question "which capability is this?" at the moment somebody still knows
 *      the answer, rather than two years later from the outside.
 *   2. **Packages point one way.** `shared` imports neither of the others;
 *      `web` never imports `server`; `server` never imports `web`.
 *   3. **Layers point one way.** Inside the server, `lib/` is below `routes/`
 *      and may not import from it.
 *   4. **No import knots.** No file may be reachable from a file it imports.
 *
 * Rules 3 and 4 carry an allowlist rather than a threshold, because a count is
 * a budget somebody will spend. A named exception has to be deleted from a file
 * by the person who fixes it, and cannot be paid for by fixing a different one.
 * Both lists are empty as of this writing, which is worth more than short: a
 * new violation has no precedent to point at.
 *
 *   node scripts/modules.mjs            # check (exit 1 on a violation)
 *   node scripts/modules.mjs --report   # the inventory, as tables on the terminal
 *   node scripts/modules.mjs --fix      # rewrite the tables in docs/modules.md
 *   node scripts/modules.mjs --json     # the same rows, for anything that draws them
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = join(ROOT, 'packages');

/* --------------------------------------------------------------- the map */

/**
 * Which module owns which files — read off the directory, not written down.
 *
 * It used to be a list here, and a list is a second source of truth: a file
 * could be moved without moving what claimed it, and the only thing keeping
 * the two together was somebody remembering. Since step 10 the path *is* the
 * claim — `packages/<pkg>/src/<ring>/<module>/…` — so a file cannot belong to
 * two modules, cannot belong to none without failing the build, and cannot
 * drift from what this says about it.
 *
 * - `kernel`     — always present. Nothing works without it, nothing switches
 *                  it off, and every capability is allowed to depend on it.
 * - `capability` — a thing the product does. Some carry a workspace switch
 *                  already (`flag`); the rest could.
 * - `adapter`    — an edge facing something outside the process: a protocol, a
 *                  provider, a file format. Replaceable by definition.
 * - `shell`      — composition: the entry points that wire the other three
 *                  together and own no domain of their own.
 */
const RING_OF_DIR = { kernel: 'kernel', modules: 'capability', adapters: 'adapter' };

/**
 * What a module is for, and the workspace switch it answers to.
 *
 * The two things a directory cannot say. Everything else about a module — which
 * files, how many lines, which package it spans — comes from the tree.
 */
const ABOUT = {
  'i18n': ['Catalogues, plurals, and the locale a person reads in.'],
  'design-system': ['The shell, the palette, and the parts every screen is built from.'],
  'registry': ['The 42 entities: fields, merge rules, visibility, and what the client mirrors.'],
  'write-path': ['One way in for every write: defaults, invariants, guards, effects, tombstones.'],
  'identity': ['Accounts, sessions, two-factor, workspaces, members and invites.'],
  'platform': ['Configuration, the database handle, the router, ids, the bus.'],
  'sync': ['The cursor, the outbox, the mirror, and what happens with no network.'],
  'search': ['One index over everything, and the query language in front of it.'],
  'files': ['Uploads, thumbnails, and where the bytes actually live.'],
  'work': ['Projects, tasks, states, labels, relations, custom fields, saved views.'],
  'planning': ['Cycles, modules, baselines, the timeline, the portfolio, the planner, templates.'],
  'pages': ['Documents with a CRDT under them, their tree, and what a comment anchors to.'],
  'budgets': ['Plan, spend, variance and who is allowed to see money.', 'budget'],
  'operations': ['Backups, restore, maintenance, provisioning and the instance screens.'],
  'chat': ['Channels, messages, presence, reactions and unread.'],
  'kpis': ['Measures, targets, cadence and the direction that counts as good.', 'kpi'],
  'infrastructure': ['Components, vendors, environments, lifecycles and moves.', 'infrastructure'],
  'guide': ['The tour, the diagrams and the help screens.'],
  'time': ['Timesheets, rates, utilisation and what an hour costs.', 'time'],
  'automation': ['Rules that fire on a write, and the schedule behind them.'],
  'ai-review': ['Asking a model to read a task back. Manual, off by default.', 'ai'],
  'trash': ['Tombstones, restore and the purge.'],
  'intake': ['A form that becomes a task, and the queue in front of it.'],
  'notifications': ['What is worth telling somebody about, once.'],
  'mcp': ['The tool surface an assistant talks to: 72 tools and 5 prompts.'],
  'transfer': ['Import and export, per project and per workspace.'],
  'webhooks': ['Signed outgoing calls with a delivery log, and incoming ones that name a task.'],
  'mail': ['Batching, the queue, SMTP by hand, and knowing an address from a bounce.'],
  'oauth': ['Single sign-on in, and an authorisation server out.'],
  'telegram': ['The bot: long-polled updates, single-use link codes, delivery.'],
  'share': ['A read-only link to one page or board.'],
  'push': ['Web push, sent with no payload.'],
  'ai': ['Three providers behind one call.'],
  'calendar': ['An iCal feed of what is due.'],
  's3': ['Object storage, signed by hand.'],
  'shell': ['Composition only: the entry points that wire the rest together.'],
};

/** `packages/server/src/kernel/identity/auth.ts` -> `{ ring, name }`. */
function placeOf(file) {
  const m = file.match(/^([a-z]+)\/src\/(kernel|modules|adapters)\/([^/]+)\//);
  return m ? { ring: RING_OF_DIR[m[2]], name: m[3] } : { ring: 'shell', name: 'shell' };
}

/* ---------------------------------------------------------------- the rules */

/**
 * Layering violations, each one named.
 *
 * A `routes/` file is the top of its module: it composes what the module does,
 * and only the shell — which composes everything — may reach into one. Anything
 * else importing a route has made that route impossible to replace.
 *
 * The rule used to read `server/src/lib` may not import `server/src/routes`,
 * which was the same idea expressed in the only two directories that then
 * existed. Since step 10 every module keeps its own `routes/`, so the rule is
 * about the directory rather than the path, and it covers the client for the
 * first time — where it immediately found one.
 *
 * There were four when the rule started covering the client, and none of them
 * were new — only the rule was. All four came apart the way the ones before
 * them did, by moving the shared thing down rather than rearranging its
 * callers: `useUnreadMessages` out of the chat screen into `chat/unread.ts`,
 * where the sidebar and *My work* are equal callers; `resourceUrl` out of the
 * OAuth route into `oauth/resource.ts`, where the OAuth metadata and the MCP
 * route are; and `automation.tsx`, which turned out not to be a route at all —
 * nothing navigates to it, it exports a settings panel, and it now sits at
 * `automation/settings.tsx` where that is what it says.
 *
 * An empty list is worth more than a short one: with nothing grandfathered, the
 * next import into a `routes/` file fails the build with no precedent to cite.
 */
const KNOWN_LAYERING = [];

/**
 * Knots of files that import each other, each one named. There are none.
 *
 * Reported as the whole knot rather than as one lap around it, because a cycle
 * printed as a path depends on which file the search happened to enter from,
 * and an exception list that reshuffles when an unrelated file is renamed is an
 * exception list nobody can trust.
 *
 * All three that used to be here came apart the same way, and none of them by
 * rearranging the callers: the shared thing moved to where everyone could reach
 * it. A money widget and a table into `components/ui/`, `useSeesMoney` into
 * `session.tsx`, a view's shape into `task-parts.tsx` — and the last one, the
 * write path calling the rules engine, by `repo` offering `onWrite` and
 * `automation` registering for it. That one is worth remembering as the shape
 * it is *not*: publishing on `lib/bus.ts` would have made the call
 * asynchronous and moved a rule's writes outside the transaction. Inverting an
 * import is not the same as deferring a call.
 *
 * Empty, like `KNOWN_LAYERING`, and for the same reason: there is nothing left
 * to cite as precedent.
 */
const KNOWN_KNOTS = [];

/**
 * A ring reaching outward, each one named. Five, and two arguments.
 *
 * **Configuration.** `env.ts` and `settings.ts` are where configuration is
 * parsed and checked — one place, which is what makes `check:compose` able to
 * prove every documented variable is reachable. Checking `KOLIBRI_SMTP_URL`
 * means knowing what an SMTP URL looks like, and checking `KOLIBRI_MAIL_FROM`
 * means knowing what an email address looks like; both live with mail, because
 * that is where every other reader would look for them. Inverting it would mean
 * a second copy of the parser in the kernel, or configuration parsed lazily by
 * whoever needs it — and the second gives up the property that makes the config
 * check possible.
 *
 * **The share dialog.** `share` is an adapter on the server, where it renders a
 * read-only document for somebody with a link, and a small piece of product UI
 * on the client, where it makes the link and turns it off. Two screens embed
 * the second. Splitting the module in two so the rings agree would put the same
 * name in two rings and make the map harder to read than the edge it removed.
 */
const KNOWN_OUTWARD = [
  'server/src/kernel/platform/env.ts -> server/src/adapters/mail/smtp.ts',
  'server/src/kernel/platform/settings.ts -> server/src/adapters/mail/address.ts',
  'server/src/kernel/platform/settings.ts -> server/src/adapters/mail/smtp.ts',
  'web/src/modules/intake/intake.tsx -> web/src/adapters/share/share.tsx',
  'web/src/modules/work/saved-views.tsx -> web/src/adapters/share/share.tsx',
];

/* -------------------------------------------------------------- the reading */

const sources = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist' && name !== 'test') walk(full);
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      sources.push(relative(PACKAGES, full));
    }
  }
})(PACKAGES);
sources.sort();

const lines = (file) => readFileSync(join(PACKAGES, file), 'utf8').split('\n').length;

/** Every module the tree actually contains, with what `ABOUT` says of it. */
const MODULES = [...new Map(sources.map((file) => {
  const { ring, name } = placeOf(file);
  return [`${ring}/${name}`, { ring, name, what: ABOUT[name]?.[0], flag: ABOUT[name]?.[1] ?? '' }];
})).values()];

const owner = (file) => {
  const { ring, name } = placeOf(file);
  return MODULES.find((m) => m.ring === ring && m.name === name);
};

/** Relative imports, resolved to a path under `packages/`. Bare specifiers are edges out. */
function importsOf(file) {
  const text = readFileSync(join(PACKAGES, file), 'utf8');
  const here = file.split('/').slice(0, -1);
  const out = [];
  for (const match of text.matchAll(/(?:^|\n)(?:import|export)(\s+type)?\s([\s\S]*?)from '([^']+)'/g)) {
    const [, typeKeyword, clause, spec] = match;
    /*
     * `import type` is erased when the file is compiled, so it couples the
     * build and not the run: a ring it crosses is a weaker thing than a call.
     * Rule 5 below cares only about the ones that survive.
     */
    const specifiers = [...clause.matchAll(/(?:^|,|\{)\s*(type\s+)?[A-Za-z_$][\w$]*/g)].map((m) => !!m[1]);
    const typeOnly = !!typeKeyword || (specifiers.length > 0 && specifiers.every(Boolean));
    if (!spec.startsWith('.')) {
      out.push({ external: spec, typeOnly });
      continue;
    }
    const parts = [...here];
    for (const segment of spec.split('/')) {
      if (segment === '.') continue;
      else if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    const target = parts.join('/').replace(/\.tsx?$/, '');
    const resolved = sources.find((s) => s.replace(/\.tsx?$/, '') === target)
      ?? sources.find((s) => s.replace(/\.tsx?$/, '') === `${target}/index`);
    if (resolved) out.push({ file: resolved, typeOnly });
  }
  return out;
}

const graph = new Map(sources.map((file) => [file, importsOf(file)]));
const pkg = (file) => file.split('/')[0];

/* ------------------------------------------------------------- the checks */

const problems = [];

/*
 * 1. Every file belongs to exactly one module.
 *
 * The path is the claim, so belonging to two is now impossible and belonging to
 * none means sitting outside `<ring>/<module>/`. That leaves only the shell,
 * which is composition and is named here rather than inferred — an entry point
 * that quietly grows a domain should have to argue for itself.
 */
const SHELL = new Set([
  'shared/src/index.ts',
  'server/src/index.ts', 'server/src/seed.ts', 'server/src/cli.ts', 'server/src/wiring.ts',
  'web/src/main.tsx', 'web/src/App.tsx', 'web/src/AppShell.tsx',
  'web/src/CommandPalette.tsx', 'web/src/wiring.ts', 'web/vite.config.ts',
  'mcp/src/index.ts',
]);
for (const file of sources) {
  if (placeOf(file).ring !== 'shell') continue;
  if (SHELL.has(file)) continue;
  problems.push(`unplaced: ${file} is not under <ring>/<module>/ and is not named as shell.`);
}
for (const file of SHELL) {
  if (!sources.includes(file)) problems.push(`stale shell entry: ${file} no longer exists.`);
}
for (const module of MODULES) {
  if (module.ring !== 'shell' && !module.what) {
    problems.push(`undescribed: the ${module.name} directory exists but ABOUT says nothing about it.`);
  }
}
for (const name of Object.keys(ABOUT)) {
  if (!MODULES.some((m) => m.name === name)) problems.push(`stale description: ABOUT still describes ${name}.`);
}

/* 2. Packages point one way. */
const FORBIDDEN_PACKAGE = { shared: ['server', 'web', 'mcp'], web: ['server'], server: ['web'] };
for (const [file, deps] of graph) {
  for (const dep of deps) {
    if (!dep.file) continue;
    if (FORBIDDEN_PACKAGE[pkg(file)]?.includes(pkg(dep.file))) {
      problems.push(`package boundary: ${file} -> ${dep.file}`);
    }
  }
}
/* `@kolibri/shared` is the one bare specifier that crosses packages on purpose. */
for (const [file, deps] of graph) {
  for (const dep of deps) {
    if (dep.external?.startsWith('@kolibri/') && dep.external !== '@kolibri/shared') {
      problems.push(`package boundary: ${file} imports ${dep.external}`);
    }
  }
}

/* 3. Layers point one way: lib/ is below routes/. */
const inRoutes = (file) => file.split('/').includes('routes');
const sameModule = (a, b) => placeOf(a).name === placeOf(b).name && placeOf(a).ring === placeOf(b).ring;
const layering = [];
for (const [file, deps] of graph) {
  if (placeOf(file).ring === 'shell') continue;      // composition is the exception
  for (const dep of deps) {
    if (dep.file && inRoutes(dep.file) && !sameModule(file, dep.file)) layering.push(`${file} -> ${dep.file}`);
  }
}
for (const edge of layering) {
  if (!KNOWN_LAYERING.includes(edge)) problems.push(`layering: ${edge} (only the shell may import a routes/ file)`);
}
for (const edge of KNOWN_LAYERING) {
  if (!layering.includes(edge)) problems.push(`fixed: "${edge}" no longer happens — delete it from KNOWN_LAYERING.`);
}

/*
 * 5. The rings point one way.
 *
 * They are only worth drawing if the arrows agree: a capability may lean on the
 * kernel, and an adapter on both, and nothing leans outward. A kernel that
 * leans back on a capability means neither can be understood, tested or
 * replaced without the other; a capability that reaches for an adapter has
 * chosen a provider on everybody's behalf.
 *
 * The way out of both is the same and this repository now does it five times
 * over: the inner ring says what it needs and the outer one registers. `repo`
 * offers `onWrite` and `onCommitted`, `storage` a `Backend`, `notify` a
 * delivery, `ai-review` a model, `sync` a stream and the scheduler a chore.
 *
 * Two things do not count, for reasons rule 3 has already made:
 *
 * - **A `routes/` file composes.** That is what a route is, wherever it sits: a
 *   kernel module's endpoints may reach for a capability the same way the shell
 *   does, and rule 3 is what stops anything reaching back into them.
 * - **An `import type` is erased.** A kernel file naming a capability's *type*
 *   couples the build and not the run. Deleting the capability would break the
 *   typecheck and nothing else — a real cost, and a different one.
 */
const RING_DEPTH = { kernel: 0, capability: 1, adapter: 2, shell: 3 };
const outward = [];
for (const [file, deps] of graph) {
  const from = placeOf(file);
  if (from.ring === 'shell' || inRoutes(file)) continue;
  for (const dep of deps) {
    if (!dep.file || dep.typeOnly) continue;
    const to = placeOf(dep.file);
    if (to.ring === 'shell') continue;
    if (RING_DEPTH[to.ring] > RING_DEPTH[from.ring]) outward.push(`${file} -> ${dep.file}`);
  }
}
for (const edge of outward) {
  if (!KNOWN_OUTWARD.includes(edge)) problems.push(`ring points outward: ${edge}`);
}
for (const edge of KNOWN_OUTWARD) {
  if (!outward.includes(edge)) problems.push(`fixed: "${edge}" no longer happens — delete it from KNOWN_OUTWARD.`);
}

/**
 * Every set of nodes that can all reach each other — Tarjan's algorithm.
 *
 * Reported as the whole set rather than one lap around it, so the output does
 * not reshuffle when an unrelated node is renamed. Used twice: once over files
 * and once over modules, which are different questions with the same shape.
 */
function tarjan(nodes, edgesOf) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const found = [];
  let next = 0;
  const visit = (node) => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of edgesOf(node)) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node), index.get(to)));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const group = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      group.push(member);
    } while (member !== node);
    if (group.length > 1) found.push(group.sort());
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return found.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/*
 * 6. Capability dependencies are acyclic.
 *
 * Capabilities are not independent and pretending otherwise would be a lie
 * about the domain: `planning` imports `work` because a cycle contains tasks,
 * and no amount of inverting changes that. What they can be is *ordered* — a
 * directed graph with no way back — so any one of them can be read knowing only
 * what it depends on, and a module can be deleted from the top of the order
 * without touching anything below it.
 *
 * This is rule 4 one floor up, and it is not implied by it: two modules can
 * each import the other without any single *file* doing so, which is a knot the
 * file-level check walks straight past. Tarjan again, and reported as the whole
 * set for the same reason.
 */
const moduleEdges = new Map();
for (const [file, deps] of graph) {
  const from = placeOf(file);
  if (from.ring !== 'capability' || inRoutes(file)) continue;
  for (const dep of deps) {
    if (!dep.file || dep.typeOnly) continue;
    const to = placeOf(dep.file);
    if (to.ring !== 'capability' || to.name === from.name) continue;
    moduleEdges.set(from.name, [...(moduleEdges.get(from.name) ?? []), to.name]);
  }
}
const moduleKnots = tarjan([...moduleEdges.keys()], (name) => moduleEdges.get(name) ?? []);
for (const knot of moduleKnots) {
  problems.push(`capability cycle: ${knot.join(' <-> ')} — one of them has to come first.`);
}

/* 4. No import knots, between files. */
const knots = tarjan(sources, (file) => (graph.get(file) ?? []).filter((d) => d.file).map((d) => d.file))
  .map((group) => group.join(' + '));
knots.sort();
for (const knot of knots) {
  if (!KNOWN_KNOTS.includes(knot)) problems.push(`import knot: ${knot}`);
}
for (const knot of KNOWN_KNOTS) {
  if (!knots.includes(knot)) problems.push(`untangled — delete it from KNOWN_KNOTS:\n    ${knot}`);
}

/* -------------------------------------------------------------- the report */

/** Every module with its size, biggest file and ring, largest first within a ring. */
const RING_ORDER = { kernel: 0, capability: 1, adapter: 2, shell: 3 };
const rows = MODULES.map((module) => {
  const own = sources.filter((file) => {
    const at = placeOf(file);
    return at.ring === module.ring && at.name === module.name;
  });
  return {
    ring: module.ring,
    name: module.name,
    flag: module.flag ?? '',
    what: module.what,
    files: own.length,
    lines: own.reduce((sum, file) => sum + lines(file), 0),
    biggest: [...own].sort((a, b) => lines(b) - lines(a))[0],
  };
}).sort((a, b) => RING_ORDER[a.ring] - RING_ORDER[b.ring] || b.lines - a.lines);

const total = rows.reduce((sum, row) => sum + row.lines, 0);
const ringLines = (kind) => rows.filter((row) => row.ring === kind).reduce((n, row) => n + row.lines, 0);
/** Thin spaces would be prettier and copy badly; a normal space groups fine. */
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const short = (file) => file?.replace(/^(server|web|shared|mcp)\/src\//, '') ?? '';

/**
 * The same rows as JSON, for anything that draws them rather than reads them.
 *
 * One number, one source: a diagram that embeds its own copy of this table goes
 * stale the first time a file moves, and nothing says so.
 */
if (process.argv.includes('--json')) {
  const rowsOut = rows.map((row) => ({
    ring: row.ring, name: row.name, flag: row.flag, files: row.files, lines: row.lines,
    biggest: short(row.biggest), biggestLines: row.biggest ? lines(row.biggest) : 0,
  }));
  console.log(`[\n${rowsOut.map((row) => JSON.stringify(row)).join(',\n')}\n]`);
}

if (process.argv.includes('--report')) {
  const pad = (text, width) => String(text).padEnd(width);
  const num = (text, width) => String(text).padStart(width);
  console.log(`\n${pad('ring', 11)}${pad('module', 20)}${pad('switch', 16)}${num('files', 6)}${num('lines', 8)}   largest file`);
  console.log('-'.repeat(100));
  let ring = null;
  for (const row of rows) {
    if (row.ring !== ring) {
      if (ring) console.log('');
      ring = row.ring;
    }
    console.log(
      `${pad(row.ring, 11)}${pad(row.name, 20)}${pad(row.flag, 16)}${num(row.files, 6)}${num(row.lines, 8)}` +
      `   ${short(row.biggest)} (${row.biggest ? lines(row.biggest) : 0})`,
    );
  }
  console.log('-'.repeat(100));
  for (const kind of ['kernel', 'capability', 'adapter', 'shell']) {
    console.log(`${pad(kind, 11)}${num(ringLines(kind), 50)}   ${Math.round((ringLines(kind) / total) * 100)}%`);
  }
  console.log(`${pad('total', 11)}${num(total, 50)}   ${sources.length} files\n`);
}

/* ------------------------------------------------------- the same, in the doc */

/**
 * `docs/modules.md` prints these tables too, and a table pasted into prose is
 * the thing `figures.mjs` exists to catch one size up. So the block between the
 * markers is generated rather than written, and checked rather than trusted.
 *
 *   node scripts/modules.mjs --fix   # rewrite it
 */
const DOC = 'docs/modules.md';
const OPEN = '<!-- generated by scripts/modules.mjs — run `npm run modules -- --fix` -->';
const CLOSE = '<!-- end generated -->';

const RING_WHAT = {
  kernel: 'Always present. Nothing works without it and nothing switches it off.',
  capability: 'The things the product does. Five carry a workspace switch; ten could.',
  adapter: 'Edges facing something outside the process: a protocol, a provider, a file format.',
  shell: 'Composition only — what starts, in what order, wired to what.',
};

const table = (kind, withFlag) => [
  withFlag ? '| Module | Files | Lines | Switch | Largest file |' : '| Module | Files | Lines | Largest file |',
  withFlag ? '|---|---:|---:|---|---|' : '|---|---:|---:|---|',
  ...rows.filter((row) => row.ring === kind).map((row) => {
    const size = row.biggest ? ` (${thousands(lines(row.biggest))})` : '';
    const cells = [`\`${row.name}\``, row.files, thousands(row.lines)];
    if (withFlag) cells.push(row.flag ? `\`${row.flag}\`` : '—');
    cells.push(`\`${short(row.biggest)}\`${size}`);
    return `| ${cells.join(' | ')} |`;
  }),
].join('\n');

const generated = [
  OPEN,
  '',
  `${MODULES.length} modules, ${sources.length} source files, ${thousands(total)} lines, in four rings.`,
  '',
  '| Ring | Lines | Share | What it is |',
  '|---|---:|---:|---|',
  ...['kernel', 'capability', 'adapter', 'shell'].map(
    (kind) => `| **${kind}** | ${thousands(ringLines(kind))} | ${Math.round((ringLines(kind) / total) * 100)}% | ${RING_WHAT[kind]} |`,
  ),
  '',
  '### Kernel',
  '',
  table('kernel', false),
  '',
  '### Capabilities',
  '',
  table('capability', true),
  '',
  '### Adapters',
  '',
  table('adapter', false),
  '',
  CLOSE,
].join('\n');

const docPath = join(ROOT, DOC);
const doc = readFileSync(docPath, 'utf8');
const from = doc.indexOf(OPEN);
const to = doc.indexOf(CLOSE);
if (from < 0 || to < 0) {
  problems.push(`${DOC}: the generated block is missing its markers.`);
} else {
  const current = doc.slice(from, to + CLOSE.length);
  if (current !== generated) {
    if (process.argv.includes('--fix')) {
      writeFileSync(docPath, doc.slice(0, from) + generated + doc.slice(to + CLOSE.length));
      console.log(`${DOC}: the module tables were rewritten.`);
    } else {
      problems.push(`${DOC}: the module tables are out of date. Run \`npm run modules -- --fix\`.`);
    }
  }
}

/* --------------------------------------------------------------- the verdict */

if (problems.length) {
  console.error(`\nmodules.mjs: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nSee docs/modules.md for what the rules are and why.\n');
  process.exit(1);
}

console.log(
  `modules.mjs: ${sources.length} files, ${MODULES.length} modules, rules hold ` +
  `(${KNOWN_LAYERING.length} layering, ${KNOWN_KNOTS.length} knot and ${KNOWN_OUTWARD.length} ring exceptions, all named).`,
);
