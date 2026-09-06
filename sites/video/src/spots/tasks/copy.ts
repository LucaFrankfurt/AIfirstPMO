/**
 * What the Tasks explainer says.
 *
 * Same rule as the flagship spot's copy: every line is either lifted from the
 * README and the demo site's tour or is a shorter form of one, and where a line
 * names a behaviour, the behaviour is one this repository ships. The syntax, the
 * query and the addresses are not here — they are product facts, and they live
 * in `src/product.ts` where all three spots quote the same copy of them.
 */
export const open = {
  section: 'Tasks',
  tagline: 'One line to file it. Every field it needs. Its own place on the board.',
} as const;

export const beats = {
  quickAdd: {
    kicker: 'Quick add',
    headline: 'A whole task on one line.',
    sub: 'The sigils become fields as you type. A token nothing answers to stays in the title rather than vanishing.',
  },
  fields: {
    kicker: 'One panel',
    headline: 'State, priority, people, dates.',
    sub: 'Every field is editable where it is shown. Change one and the board, the timeline and the reports have already changed.',
  },
  subtasks: {
    kicker: 'Sub-tasks',
    headline: 'A sub-task is a whole task.',
    sub: 'Its own identifier, its own assignee, its own due date — and its own card on the board. Not a checklist item.',
  },
  workflow: {
    kicker: 'Workflow',
    headline: 'Your states, and your rules.',
    sub: 'Every project defines its own columns, and a column can say who is allowed to move work into it.',
  },
  query: {
    kicker: 'Query',
    headline: 'A filter you can write down.',
    sub: 'Text rather than dropdowns, so a filter can be pasted into a message, kept in a page and diffed against last week’s.',
  },
} as const;

export const close = {
  headline: 'Every task, on your own server, and instant with the wifi off.',
} as const;
