/**
 * Things the product says, quoted rather than paraphrased.
 *
 * These are not copy — they are facts about Kolibri that more than one spot puts
 * on screen, each lifted from the file that defines it. A marketing video whose
 * example syntax has drifted from the parser is worse than one that never showed
 * the syntax, so the quote and its source are written down together and the
 * comment says where to look when one of them changes.
 */

/** `sites/demo/src/consts.ts`. */
export const url = {
  demo: 'demo.kolibri.day',
  repo: 'github.com/LucaFrankfurt/AIfirstPMO',
  docs: 'docs.kolibri.day',
} as const;

export const quickAdd = {
  /** Verbatim from the docblock of `packages/shared/src/modules/work/quickadd.ts`. */
  line: 'Redraw the empty state !high @ada #WEB *design due:friday',
  /** `QUICK_ADD_SYNTAX` from the same file — the hint the real field shows. */
  syntax: '!high  @name  #PROJECT  *label  due:friday  every:weekly',
} as const;

/**
 * From the docblock of `packages/shared/src/modules/work/query.ts`: "the one
 * thing people leaving Jira ask for by name".
 */
export const query = {
  line: 'assignee = me AND priority in (urgent, high) AND state != Done',
} as const;

/** `[[Title]]`, per `packages/shared/src/modules/pages/links.ts` — by title, never by id. */
export const wikiLink = { open: '[[', close: ']]' } as const;

/**
 * How much of the product the MCP surface is, counted rather than claimed.
 *
 * This is a *figure* in the sense `scripts/figures.mjs` means it: claimed here,
 * counted from `packages/server/src/adapters/mcp/tools/` by the tree, and
 * rewritten by `node scripts/figures.mjs --fix` when the two disagree. It is
 * written down rather than derived because this folder is not part of the
 * workspace and must not learn to import out of `packages/` — and being checked
 * is what stops that from being an excuse.
 *
 * A number on a *slide* is the worst place for a stale count to hide: nothing
 * downstream of it compiles, and the file that carries it is a PNG. So the
 * source is checked, and re-rendering is what a change to it costs.
 */
export const tools = { count: 88, prompts: 6 } as const;

/**
 * What the README's one-line description claims, split so each half can land on
 * its own, and the whole install — which really is the whole install.
 */
export const claims = ['Offline-first', 'Self-hosted', 'MCP-native', 'MIT'] as const;
export const command = 'docker compose up -d --build';
