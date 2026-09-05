/**
 * Every word the spot says, and every address it points at.
 *
 * It is one file for the same reason `sites/demo/src/consts.ts` is one file:
 * the sentences on screen are the product's claims, and a claim that has drifted
 * from the README is worse than one that was never made. Each line below is
 * either lifted from `README.md` / the demo site's tour, or is a shorter form of
 * one — and where a line names a feature, the feature is one this repository
 * actually ships. Nothing here is aspirational.
 *
 * The lines are short on purpose. A beat lasts four seconds and a viewer reads
 * roughly three words a second, so a headline over eight words is a headline
 * nobody finishes.
 */
export const url = {
  demo: 'demo.kolibri.day',
  repo: 'github.com/LucaFrankfurt/AIfirstPMO',
  docs: 'docs.kolibri.day',
} as const;

export const open = {
  wordmark: 'Kolibri',
  tagline: 'Projects, tasks and pages that never wait for the network.',
} as const;

export const beats = {
  offline: {
    kicker: 'Offline-first',
    headline: 'It never waits for the network.',
    sub: 'Every screen reads from a copy of the workspace in your browser. Changes queue, and merge field by field when you come back.',
  },
  layouts: {
    kicker: 'One set of tasks',
    headline: 'Five layouts, one filter.',
    sub: 'List, board, table, calendar and timeline — sharing your filters and your grouping.',
  },
  quickAdd: {
    kicker: 'Quick add',
    headline: 'A whole task on one line.',
    sub: 'The sigils become fields as you type. A token nothing answers to stays in the title rather than vanishing.',
    /** Verbatim from the docblock of `packages/shared/src/modules/work/quickadd.ts`. */
    line: 'Redraw the empty state !high @ada #WEB *design due:friday',
    /** `QUICK_ADD_SYNTAX` from the same file — the hint the real field shows. */
    syntax: '!high  @name  #PROJECT  *label  due:friday  every:weekly',
  },
  timeline: {
    kicker: 'Dependencies',
    headline: 'Move a task. Everything it blocks moves too.',
    sub: 'Counted in the days the project actually works.',
  },
  assistant: {
    kicker: 'MCP-native',
    headline: 'An assistant is a first-class user.',
    sub: 'Read the backlog, file issues, move them through the workflow — with exactly the permissions you grant.',
  },
} as const;

export const close = {
  /** The README's one-line description, split so each half can land on its own. */
  claims: ['Offline-first', 'Self-hosted', 'MCP-native', 'MIT'] as const,
  headline: 'Open source projects, tasks and pages.',
  /** The whole install, and it really is the whole install. */
  command: 'docker compose up -d --build',
} as const;
