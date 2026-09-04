# Kolibri, for an agent starting here

An offline-first, self-hosted work OS: projects, tasks, cycles, pages, chat, time, budgets, KPIs,
an infrastructure register, and an MCP surface over most of it. One npm workspace, four packages,
**no runtime dependencies on the server** — Node 22 runs TypeScript directly and `node:sqlite` is
the database. Keep it that way; adding a server dependency is a decision, not a convenience.

```
packages/shared   types, the entity registry, pure domain logic — imports neither of the others
packages/server   the API, the write path, the adapters
packages/web      the client (React, Vite)
packages/mcp      the stdio bridge
sites/            the marketing and docs sites, built separately
```

## Where code lives

Since the modular refactor the **path is the claim**:

```
packages/{package}/src/{ring}/{module}/…
```

`{ring}` is one of three directories, and the directory *is* the ring:

| directory   | ring         | what it means |
|-------------|--------------|---------------|
| `kernel/`   | kernel       | always present; nothing switches it off |
| `modules/`  | capability   | one area of the product, and whatever leans on it |
| `adapters/` | adapter      | an edge facing outside the process — a protocol, a provider, a format |

Anything not under one of those is **shell** (composition), and shell files are named one by one in
`scripts/modules.mjs`. A new file outside the shape fails the build, which is deliberate: it forces
"which capability is this?" while somebody still knows.

**To find a thing**, run `npm run modules` — the inventory on the terminal, with every module, its
size and its largest file. The same tables live in `docs/modules.md`, generated. Don't grep blind.

## The seven rules

`npm run check:modules` enforces the seven rules, and regenerates the tables in `docs/modules.md`
and `docs/module-map.html` (it fails if they have drifted). Read them before writing code, not after
CI says no:

1. **Every source file belongs to exactly one module.** The path decides.
2. **Packages point one way.** `shared` imports neither of the others; `web` never imports `server`.
3. **A module's `routes/` is its top.** Only the shell may import a route file.
4. **No import knots.** No file may be reachable from a file it imports.
5. **The rings point one way.** A capability may lean on the kernel, an adapter on both, and nothing
   leans outward.
6. **Module dependencies are acyclic**, in every ring — rule 4 one floor up, and not implied by it.
7. **Every port is filled, and from further out.**

Two things deliberately do **not** count against rules 3 and 5:

- **A `routes/` file composes.** A kernel route may reach for a capability the way the shell does.
  Do not "fix" that — it is what a route is.
- **An `import type` is erased.** It couples the build, not the run. It is also not a loophole: if
  you need the value, you need the dependency.

**All three allowlists (`KNOWN_LAYERING`, `KNOWN_KNOTS`, `KNOWN_OUTWARD`) are empty.** Never add an
entry to go green. An exception is named by whoever cannot fix it today and deleted by whoever can —
adding one to get past a rule is spending a budget the repository does not keep.

## Before you push

In this order, because each is cheaper than the next:

```bash
npm run typecheck        # strict; noUnusedLocals is on
npm run check:modules    # the seven rules and the generated tables
npm run check:figures    # every number in prose, against the tree
npm run check:openapi    # docs/openapi.json, against the registry and the routes
npm test                 # server, web, and the checks' own suite
npm run check:css        # every class the source uses is defined
npm run check:compose    # every documented env var is reachable
npm run build
```

CI runs all of those plus a browser job: both smoke walkthroughs (English and German) against a
seeded server, then `check:responsive`, `check:contrast` and `check:a11y`.

To run the browser scripts locally you need a seeded instance:

```bash
KOLIBRI_DATA_DIR=/tmp/k npm run seed
KOLIBRI_DATA_DIR=/tmp/k PORT=4400 npm start &
KOLIBRI_URL=http://localhost:4400 node scripts/smoke.mjs
```

In a sandbox where Playwright's bundled browser is missing, point `CHROMIUM_PATH` at the one that is
there — every browser script honours it.

## Traps that have cost real time

Each of these passed the typechecker and the suites and was still wrong.

- **Paths resolved at runtime.** `env.ts` finds the workspace root by walking up for `packages/`;
  `db/index.ts` reads `schema.sql` with `join(here, …)`. Move either and everything compiles, every
  test passes, and the server serves no web build. `packages/server/test/paths.test.ts` pins the
  three that are computed rather than configured — if you move a file that reads something beside
  itself, add it there.
- **`.ts` and `.tsx` with the same basename in one directory.** `./reactions` resolves the `.ts`
  first, so every importer of the component silently gets the helper. No error anywhere. Rename one.
- **Generated blocks are compared byte for byte.** In `docs/modules.md` and `docs/module-map.html`,
  anything between `<!-- generated: … -->` and `<!-- end -->` (or the `/* generated: … */` markers
  inside the page's script) is written by `modules.mjs`. Never hand-edit — run
  `npm run modules -- --fix`.
- **Numbers in prose rot silently.** Every bolded number in those two documents must be either a
  *figure* — claimed in `scripts/figures.mjs`, checked against the tree, rewritten by `--fix` — or a
  *record*, listed in that file's `HISTORY` as something the tree said once and cannot be recounted.
  One that is neither is reported by name and fails the build. This exists because the documents had
  drifted in six places at once while looking perfectly confident.
- **`noUnusedParameters` is off on purpose.** An unused argument is usually the shape of a callback.
  `noUnusedLocals` is on; an import you stop using breaks the build.
- **Never skip, disable or quarantine a test to get green**, and never push an empty commit to kick
  CI. If a check is wrong, fix the check and add a case to `scripts/checks.test.mjs`.

## Adding things

**A capability.** Make `packages/{pkg}/src/modules/{name}/`, add one line to `ABOUT` in
`scripts/modules.mjs` saying what it is for (and the workspace flag it answers to, if any), then
`npm run modules -- --fix`. A module directory nothing describes fails the build.

**An adapter that fills a port.** Write it under `adapters/{name}/`, and register it in
`packages/server/src/wiring.ts` or `packages/web/src/wiring.ts` — the shell is the only place that
knows every part. On the client, `packages/web/test/wiring.test.ts` asserts that every installer the
wiring calls is imported, exists and is exported under that name; the server has no equivalent yet,
so check that one by running it.

**A port.** When an inner ring needs something an outer ring has, it declares the shape and a
registration function and tags it:

```ts
/** @port a channel a notification is carried on */
export function onNotification(deliver: Delivery): void { … }
```

Rule 7 then requires that somebody further out fills it. The generated table in `docs/modules.md`
shows who asks for what and who supplies it — a port nobody fills renders as **nobody** and fails.

**A route.** Nothing to do beyond writing it — but run `npm run openapi`, because
`docs/openapi.json` is generated from the routes and CI compares it byte for byte. A path built at
runtime rather than written as a literal is refused: the document has to be all of them or it is
worth nothing.

**A number in prose.** Decide which kind it is before you write it. If the tree can count it, add a
claim to `FIGURES`; if it is a measurement of a past state, add a `HISTORY` entry saying what of.

## Conventions

- **Comments say why, not what.** The docblocks here are long on purpose and often carry the scar
  behind a decision — the bug that made a check exist, the earlier version that was wrong. Match
  that; a comment restating the code is worse than none.
- **Named exceptions, never counted thresholds.** A count is a budget somebody will spend.
- **One number, one source.** If two places state the same figure, one of them is generated.
- **Prefer moving the shared thing down** over rearranging its callers. Every layering violation
  this repository has had came apart that way.

## Where to read more

| file | what it holds |
|---|---|
| `docs/modules.md` | the module map in full: the rings, the seven rules, the findings behind them, the ladder they were fixed in, and the honest limits |
| `docs/module-map.html` | the same argument, illustrated |
| `docs/architecture.md` | the layers, the request path, the process |
| `docs/sync.md` | the offline mirror, the outbox, the cursor |
| `docs/security.md` | sessions, permissions, what a share link is |
| `docs/api.md`, `docs/mcp.md` | the two surfaces, in prose |
| `docs/openapi.json` | the REST surface as a machine reads it — generated, never hand-edited |
| `TODO.md` | what is deliberately not built, with the reason |

## Working with the maintainer

Writes German and expects German back. Asks for measurement rather than assertion, and asks "what is
still open?" until the answer is honest — so say what you did *not* do, and say when a number is a
guess. If you claim something is fixed, show the command that proves it.
