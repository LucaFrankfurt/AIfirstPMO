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
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = join(ROOT, 'packages');

/* --------------------------------------------------------------- the map */

/**
 * Which module owns which files, in the three rings `docs/modules.md`
 * describes.
 *
 * - `kernel`     — always present. Nothing works without it, nothing switches
 *                  it off, and every capability is allowed to depend on it.
 * - `capability` — a thing the product does. Some carry a workspace switch
 *                  already (`flag`); the rest could.
 * - `adapter`    — an edge facing something outside the process: a protocol, a
 *                  provider, a file format. Replaceable by definition.
 * - `shell`      — composition: the entry points that wire the other three
 *                  together and own no domain of their own.
 *
 * First match wins, so order matters where a prefix would otherwise swallow a
 * file that belongs elsewhere.
 */
const MODULES = [
  /* ------------------------------------------------------------- kernel */
  {
    name: 'platform',
    ring: 'kernel',
    what: 'The floor: process configuration, the database handle, the router, ids, the in-process bus.',
    files: [
      'server/src/env.ts', 'server/src/db/index.ts',
      'server/src/lib/http.ts', 'server/src/lib/ids.ts', 'server/src/lib/bus.ts',
      'server/src/lib/origin.ts', 'server/src/lib/csp.ts', 'server/src/lib/features.ts',
      'server/src/lib/settings.ts', 'server/src/routes/settings.ts',
    ],
  },
  {
    name: 'registry',
    ring: 'kernel',
    what: 'The entity registry and the vocabulary every other module is written in.',
    files: [
      'shared/src/entities.ts', 'shared/src/types.ts', 'shared/src/index.ts',
      'shared/src/hlc.ts', 'shared/src/order.ts', 'shared/src/scope.ts',
    ],
  },
  {
    name: 'write-path',
    ring: 'kernel',
    what: 'The one way a row changes: merge, invariants, side effects, search index, visibility.',
    files: ['server/src/lib/repo.ts', 'server/src/lib/bootstrap.ts', 'server/src/routes/entities.ts'],
  },
  {
    name: 'sync',
    ring: 'kernel',
    what: 'Delta pull, push, the change stream, and the client mirror they feed.',
    files: [
      'server/src/routes/sync.ts',
      'web/src/lib/sync.ts', 'web/src/lib/idb.ts', 'web/src/lib/store.ts', 'web/src/lib/mutations.ts',
      'web/src/lib/api.ts',
    ],
  },
  {
    name: 'identity',
    ring: 'kernel',
    what: 'Who is asking: accounts, sessions, tokens, roles, rate limits, second factors.',
    files: [
      'server/src/lib/auth.ts', 'server/src/lib/totp.ts', 'server/src/lib/ratelimit.ts',
      'server/src/routes/auth.ts',
      'web/src/routes/Login.tsx', 'web/src/components/AuthLayout.tsx',
      'web/src/components/security.tsx', 'web/src/session.tsx',
    ],
  },
  {
    name: 'files',
    ring: 'kernel',
    what: 'Content-addressed uploads, and the two backends behind one interface.',
    files: [
      'server/src/lib/storage.ts', 'server/src/lib/mime.ts', 'server/src/lib/imagesize.ts',
      'server/src/lib/uploads.ts', 'server/src/routes/files.ts',
    ],
  },
  {
    name: 'search',
    ring: 'kernel',
    what: 'FTS5 across everything, maintained in the same transaction as the row.',
    files: [
      'server/src/lib/search.ts', 'server/src/routes/search.ts',
      'web/src/routes/search.tsx', 'web/src/lib/search-query.ts', 'web/src/lib/recents.ts',
    ],
  },
  {
    name: 'i18n',
    ring: 'kernel',
    what: 'One catalogue per language, on both sides, each recipient in their own.',
    files: [
      'server/src/lib/i18n.ts',
      'web/src/lib/i18n.ts', 'web/src/locales/en.ts', 'web/src/locales/de.ts', 'web/src/locales/fr.ts',
    ],
  },
  {
    name: 'design-system',
    ring: 'kernel',
    what: 'The primitives every screen is built from, and the furniture around them.',
    files: [
      'web/src/components/ui.tsx', 'web/src/components/ui/',
      'web/src/components/AppShell.tsx', 'web/src/components/CommandPalette.tsx',
      'web/src/lib/cn.ts', 'web/src/lib/format.ts', 'web/src/lib/text.ts', 'web/src/lib/drag.ts',
      'web/src/lib/nav.ts', 'web/src/lib/navigation.ts', 'web/src/lib/tab-strip.ts',
      'web/src/lib/task-stack.ts', 'web/src/lib/active-project.ts', 'web/src/lib/family.ts',
    ],
  },

  /* --------------------------------------------------------- capabilities */
  {
    name: 'work',
    ring: 'capability',
    what: 'Projects, tasks, states, labels, relations, custom fields, saved views.',
    files: [
      'shared/src/quickadd.ts', 'shared/src/query.ts', 'shared/src/fields.ts',
      'shared/src/duration.ts', 'shared/src/relocate.ts',
      'server/src/lib/viewquery.ts', 'server/src/lib/tasks-csv.ts',
      'web/src/components/views.tsx', 'web/src/components/task-parts.tsx',
      'web/src/components/TaskDetail.tsx', 'web/src/components/QuickAdd.tsx',
      'web/src/components/query-box.tsx', 'web/src/components/fields.tsx',
      'web/src/components/Relations.tsx', 'web/src/components/selection.tsx',
      'web/src/components/selection-bar.tsx', 'web/src/components/saved-views.tsx',
      'web/src/components/comments.tsx', 'web/src/components/reactions.tsx',
      'web/src/lib/reactions.ts', 'web/src/lib/overview.ts',
      'web/src/routes/personal.tsx', 'web/src/routes/teams.tsx',
    ],
  },
  {
    name: 'planning',
    ring: 'capability',
    what: 'Cycles, modules, baselines, the timeline, the portfolio, the planner, templates.',
    files: [
      'shared/src/schedule.ts',
      'server/src/lib/copy.ts', 'server/src/lib/archive.ts',
      'web/src/routes/projects.tsx',
      'web/src/components/gantt.tsx', 'web/src/components/planner.tsx',
      'web/src/components/portfolio.tsx', 'web/src/components/insights.tsx',
      'web/src/components/copy-project.tsx', 'web/src/components/hierarchy.tsx',
    ],
  },
  {
    name: 'pages',
    ring: 'capability',
    what: 'The nested wiki: markdown, the text CRDT, revisions, anchored comments.',
    files: [
      'shared/src/markdown.ts', 'shared/src/editor.ts', 'shared/src/anchor.ts',
      'shared/src/text-crdt.ts', 'shared/src/diff.ts',
      'web/src/routes/pages.tsx', 'web/src/components/page-parts.tsx',
      'web/src/components/Markdown.tsx', 'web/src/components/annotate.tsx',
      'web/src/lib/pagetree.ts', 'web/src/lib/collab.ts', 'web/src/lib/mermaid.ts',
    ],
  },
  {
    name: 'chat',
    ring: 'capability',
    what: 'Channels and direct messages made of the same synced rows as everything else.',
    files: [
      'shared/src/chat.ts',
      'server/src/lib/presence.ts',
      'web/src/routes/chat.tsx', 'web/src/lib/presence.ts',
    ],
  },
  {
    name: 'time',
    ring: 'capability',
    flag: 'time',
    what: 'Logged time, the timesheet, dated rates, and what an hour cost.',
    files: [
      'shared/src/rates.ts', 'server/src/lib/rules/rates.ts',
      'server/src/lib/personal.ts',
      'web/src/routes/timesheet.tsx', 'web/src/components/time.tsx', 'web/src/components/rates.tsx',
    ],
  },
  {
    name: 'budgets',
    ring: 'capability',
    flag: 'budget',
    what: 'Planned against actual, split across the projects that pay for it.',
    files: [
      'shared/src/budget.ts', 'server/src/lib/rules/budgets.ts',
      'web/src/routes/budgets.tsx', 'web/src/components/budget.tsx',
    ],
  },
  {
    name: 'kpis',
    ring: 'capability',
    flag: 'kpi',
    what: 'Numbers somebody has undertaken to watch, and by which milestone.',
    files: [
      'shared/src/kpi.ts', 'server/src/lib/rules/kpis.ts',
      'web/src/routes/kpis.tsx', 'web/src/components/kpi.tsx',
    ],
  },
  {
    name: 'infrastructure',
    ring: 'capability',
    flag: 'infrastructure',
    what: 'Vendors, what runs where, and the moves between one landscape and the next.',
    files: [
      'shared/src/landscape.ts', 'server/src/lib/rules/infrastructure.ts',
      'web/src/routes/infrastructure.tsx', 'web/src/components/landscape.tsx',
    ],
  },
  {
    name: 'automation',
    ring: 'capability',
    what: 'Templates, repeats, and rules that file work when something happens.',
    files: [
      'server/src/lib/automation.ts', 'server/src/lib/scheduler.ts',
      'web/src/routes/automation.tsx',
    ],
  },
  {
    name: 'notifications',
    ring: 'capability',
    what: 'Writing a notification, and every channel that has to hear about it.',
    files: ['server/src/lib/notify.ts'],
  },
  {
    name: 'ai-review',
    ring: 'capability',
    flag: 'ai',
    what: 'Asking a model to read a task back. Manual, off by default.',
    files: [
      'server/src/lib/review.ts', 'server/src/routes/ai.ts',
      'web/src/components/task-review.tsx',
    ],
  },
  {
    name: 'intake',
    ring: 'capability',
    what: 'A link that is a form, for people who have no account and should not need one.',
    files: ['web/src/components/intake.tsx'],
  },
  {
    name: 'trash',
    ring: 'capability',
    what: 'Tombstones, what may be restored from them, and when they are purged.',
    files: ['server/src/lib/trash.ts', 'web/src/components/trash.tsx'],
  },
  {
    name: 'guide',
    ring: 'capability',
    what: 'The manual, built as the app rather than filmed: stages, scenes, the tour.',
    files: [
      'web/src/routes/help.tsx', 'web/src/components/explain.tsx',
      'web/src/components/diagrams.tsx', 'web/src/components/tour.tsx', 'web/src/lib/guide.ts',
    ],
  },
  {
    name: 'operations',
    ring: 'capability',
    what: 'Snapshots, restore, rehydration, maintenance, provisioning, the demo workspace.',
    files: [
      'server/src/lib/backups.ts', 'server/src/lib/restore.ts', 'server/src/lib/rehydrate.ts',
      'server/src/lib/maintenance.ts', 'server/src/lib/provision.ts', 'server/src/lib/demo.ts',
      'web/src/components/admin.tsx', 'web/src/components/instance.tsx',
      'web/src/routes/settings.tsx',
    ],
  },

  /* -------------------------------------------------------------- adapters */
  {
    name: 'adapter/mcp',
    ring: 'adapter',
    what: 'The assistant\'s way in: JSON-RPC over HTTP, and a stdio bridge to it.',
    files: [
      'server/src/lib/mcp/index.ts', 'server/src/lib/mcp/kit.ts',
      'server/src/lib/mcp/tools/', 'server/src/routes/mcp.ts', 'mcp/src/index.ts',
    ],
  },
  {
    name: 'adapter/oauth',
    ring: 'adapter',
    what: 'The instance as an authorization server, and as a client of a directory.',
    files: ['server/src/lib/oidc.ts', 'server/src/routes/oauth.ts'],
  },
  {
    name: 'adapter/mail',
    ring: 'adapter',
    what: 'Batching, the queue, SMTP by hand, and knowing an address from a bounce.',
    files: [
      'server/src/lib/mail.ts', 'server/src/lib/smtp.ts', 'server/src/lib/address.ts',
      'server/src/lib/delivery.ts', 'server/src/lib/scaleway.ts',
    ],
  },
  {
    name: 'adapter/push',
    ring: 'adapter',
    what: 'Web push, sent with no payload.',
    files: ['server/src/lib/push.ts', 'web/src/components/push.tsx'],
  },
  {
    name: 'adapter/telegram',
    ring: 'adapter',
    what: 'The bot: long-polled updates, single-use link codes, delivery.',
    files: ['server/src/lib/telegram.ts', 'web/src/components/telegram.tsx'],
  },
  {
    name: 'adapter/webhooks',
    ring: 'adapter',
    what: 'Signed outgoing calls with a delivery log, and incoming ones that name a task.',
    files: [
      'server/src/lib/webhooks.ts', 'server/src/lib/outbound.ts', 'server/src/routes/inbound.ts',
      'shared/src/foreign.ts',
    ],
  },
  {
    name: 'adapter/calendar',
    ring: 'adapter',
    what: 'A subscribable .ics per person or per saved view.',
    files: ['server/src/lib/ical.ts', 'server/src/routes/calendar.ts'],
  },
  {
    name: 'adapter/share',
    ring: 'adapter',
    what: 'Read-only links to a page or a view, for somebody with no account.',
    files: ['server/src/routes/share.ts', 'web/src/components/share.tsx'],
  },
  {
    name: 'adapter/transfer',
    ring: 'adapter',
    what: 'Getting it in and out: CSV, the foreign readers, JSON round trips, zip.',
    files: [
      'shared/src/csv.ts', 'shared/src/import.ts',
      'server/src/lib/import.ts', 'server/src/lib/transfer.ts',
      'server/src/lib/workspace-transfer.ts', 'server/src/lib/zip.ts',
      'server/src/routes/export.ts',
      'web/src/components/import.tsx', 'web/src/components/data.tsx',
    ],
  },
  {
    name: 'adapter/s3',
    ring: 'adapter',
    what: 'SigV4 signed by hand, so an object store needs no SDK.',
    files: ['server/src/lib/s3.ts'],
  },
  {
    name: 'adapter/ai',
    ring: 'adapter',
    what: 'Three companies answering the same question three ways.',
    files: [
      'server/src/lib/ai.ts', 'server/src/lib/ai-anthropic.ts',
      'server/src/lib/ai-gemini.ts', 'server/src/lib/ai-openrouter.ts',
    ],
  },

  /* ----------------------------------------------------------------- shell */
  {
    name: 'shell',
    ring: 'shell',
    what: 'Composition only: what starts, in what order, wired to what.',
    files: [
      'server/src/index.ts', 'server/src/cli.ts', 'server/src/seed.ts',
      'server/src/lib/wiring.ts',
      'web/vite.config.ts',
      'web/src/App.tsx', 'web/src/main.tsx',
    ],
  },
];

/* ---------------------------------------------------------------- the rules */

/**
 * Layering violations, each one named. There are none.
 *
 * `lib/` is below `routes/`: a route composes what the libraries do, and a
 * library that reaches back up has made the route impossible to replace. There
 * were two, both `mcp.ts` wanting a function that happened to live in a route
 * file, and both were fixed the right way round — `storeFile` and
 * `searchWorkspace` moved down into `lib/uploads.ts` and `lib/search.ts`, where
 * the route and the MCP tool are equal callers of one implementation.
 *
 * An empty list is worth more than a short one: there is no grandfathering
 * left, so the next import from `lib/` into `routes/` fails the build with
 * nothing to point at as precedent.
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

/** Which module claims a file, or undefined. A trailing `/` claims a directory. */
const owner = (file) =>
  MODULES.find((module) =>
    module.files.some((claim) => (claim.endsWith('/') ? file.startsWith(claim) : claim === file)),
  );

/** Relative imports, resolved to a path under `packages/`. Bare specifiers are edges out. */
function importsOf(file) {
  const text = readFileSync(join(PACKAGES, file), 'utf8');
  const here = file.split('/').slice(0, -1);
  const out = [];
  for (const [, spec] of text.matchAll(/(?:^|\n)(?:import|export)[\s\S]*?from '([^']+)'/g)) {
    if (!spec.startsWith('.')) {
      out.push({ external: spec });
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
    if (resolved) out.push({ file: resolved });
  }
  return out;
}

const graph = new Map(sources.map((file) => [file, importsOf(file)]));
const pkg = (file) => file.split('/')[0];

/* ------------------------------------------------------------- the checks */

const problems = [];

/* 1. Every file belongs to exactly one module. */
const unclaimed = sources.filter((file) => !owner(file));
for (const file of unclaimed) {
  problems.push(`unclaimed: ${file} belongs to no module. Add it to MODULES in scripts/modules.mjs.`);
}
for (const module of MODULES) {
  for (const claim of module.files) {
    const matched = claim.endsWith('/')
      ? sources.some((file) => file.startsWith(claim))
      : sources.includes(claim);
    if (!matched) problems.push(`stale claim: ${module.name} claims ${claim}, which no longer exists.`);
  }
}
const claimedTwice = sources.filter(
  (file) => MODULES.filter((m) => m.files.some((c) => (c.endsWith('/') ? file.startsWith(c) : c === file))).length > 1,
);
for (const file of claimedTwice) problems.push(`claimed twice: ${file} is in more than one module.`);

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
const layering = [];
for (const [file, deps] of graph) {
  if (!file.startsWith('server/src/lib/')) continue;
  for (const dep of deps) {
    if (dep.file?.startsWith('server/src/routes/')) layering.push(`${file} -> ${dep.file}`);
  }
}
for (const edge of layering) {
  if (!KNOWN_LAYERING.includes(edge)) problems.push(`layering: ${edge} (lib may not import routes)`);
}
for (const edge of KNOWN_LAYERING) {
  if (!layering.includes(edge)) problems.push(`fixed: "${edge}" no longer happens — delete it from KNOWN_LAYERING.`);
}

/* 4. No import knots. Tarjan, so every knot is found rather than the first lap
      out of whichever file the search entered from. */
const knots = [];
(function findKnots() {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let next = 0;
  const visit = (file) => {
    index.set(file, next);
    low.set(file, next);
    next += 1;
    stack.push(file);
    onStack.add(file);
    for (const dep of graph.get(file) ?? []) {
      if (!dep.file) continue;
      if (!index.has(dep.file)) {
        visit(dep.file);
        low.set(file, Math.min(low.get(file), low.get(dep.file)));
      } else if (onStack.has(dep.file)) {
        low.set(file, Math.min(low.get(file), index.get(dep.file)));
      }
    }
    if (low.get(file) !== index.get(file)) return;
    const group = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      group.push(member);
    } while (member !== file);
    if (group.length > 1) knots.push(group.sort().join(' + '));
  };
  for (const file of sources) if (!index.has(file)) visit(file);
})();
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
  const own = sources.filter((file) => owner(file) === module);
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
  `(${KNOWN_LAYERING.length} layering and ${KNOWN_KNOTS.length} knot exceptions, all named).`,
);
