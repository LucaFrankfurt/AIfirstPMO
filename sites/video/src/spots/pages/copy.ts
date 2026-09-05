/**
 * What the Pages explainer says.
 *
 * Four of these lines are near-quotations of the docblocks that describe the
 * behaviour — `text-crdt.ts`, `anchor.ts`, `diff.ts`, `links.ts` — because those
 * docblocks were written to explain the decision to a person, and a marketing
 * line that has to be invented for a feature is usually a feature that does not
 * do very much.
 */
export const open = {
  section: 'Pages',
  tagline: 'A wiki two people can type in at once, and a comment that stays put.',
} as const;

export const beats = {
  editor: {
    kicker: 'Markdown',
    headline: 'What you type is what is stored.',
    sub: 'Plain markdown, nested to any depth, rendered as you go — and stored as the text you wrote, not as somebody’s document format.',
  },
  links: {
    kicker: 'Wiki links',
    headline: 'Link by title, not by id.',
    sub: 'So the line stays readable in the source and survives being pasted into a chat message. Backlinks are counted from the text, not from a table.',
  },
  collab: {
    kicker: 'Two at once',
    headline: 'Both of you keep your sentence.',
    sub: 'A page body is a text CRDT, so two people typing in the same paragraph merge character by character — including when both were offline.',
  },
  comments: {
    kicker: 'Inline comments',
    headline: 'Anchored to the words, not to a line number.',
    sub: 'A comment stores the quote and its surroundings. Edit around it and it follows; delete the sentence and it says it is orphaned rather than guessing.',
  },
  history: {
    kicker: 'History',
    headline: 'What changed, and the way back.',
    sub: 'Every save is a version, with a line diff you can read and a restore that is one click and itself a version.',
  },
} as const;

export const close = {
  headline: 'Pages in Kolibri: your markdown, your server, and no lost paragraphs.',
} as const;
