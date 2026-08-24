/**
 * Where the buttons on this page go, and who signs in with what.
 *
 * All of it comes from the environment at build time, because the page and the
 * instance it fronts are two deployments that do not have to be on the same
 * domain — and because a fork should be able to point this at their own demo
 * without editing markup. `PUBLIC_` is Astro's prefix for a variable that may
 * be inlined into the output, which is exactly what these are.
 *
 * The demo credentials are in this file on purpose. They are the *point* of a
 * public demo: an account anybody may use, on an instance that is wiped on a
 * schedule and holds nothing real. Nothing here is a secret, and if it ever
 * needs to be, this is the wrong file and that is the wrong instance.
 */
export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? 'https://app.demo.kolibri.day';
export const DOCS_URL = import.meta.env.PUBLIC_DOCS_URL ?? 'https://docs.kolibri.day';
export const REPO_URL =
  import.meta.env.PUBLIC_REPO_URL ?? 'https://github.com/LucaFrankfurt/AIfirstPMO';

/** Seeded by `npm run seed` — see `packages/server/src/lib/demo.ts`. */
export const DEMO_EMAIL = import.meta.env.PUBLIC_DEMO_EMAIL ?? 'ada@kolibri.dev';
export const DEMO_PASSWORD = import.meta.env.PUBLIC_DEMO_PASSWORD ?? 'kolibri-demo';

/** How often the demo instance is wiped back to its seed. Prose, not a cron. */
export const RESET_EVERY = import.meta.env.PUBLIC_RESET_EVERY ?? 'every night';
