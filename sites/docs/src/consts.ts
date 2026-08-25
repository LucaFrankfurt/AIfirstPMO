/**
 * The two addresses this site points at.
 *
 * Both are read from the environment at build time so a fork, a staging
 * deployment or somebody running the whole thing on their own domain does not
 * have to edit a component to change where a button goes. `PUBLIC_` is
 * Astro's prefix for a variable that may be inlined into the output — which is
 * exactly what these are, and why neither may ever hold a secret.
 */
export const DEMO_URL = import.meta.env.PUBLIC_DEMO_URL ?? 'https://demo.kolibri.day';
export const REPO_URL =
  import.meta.env.PUBLIC_REPO_URL ?? 'https://github.com/LucaFrankfurt/AIfirstPMO';
