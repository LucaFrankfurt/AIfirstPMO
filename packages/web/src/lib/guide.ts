/**
 * Where the guide can be pointed at from the rest of the app.
 *
 * An empty screen is the moment somebody most wants an explanation, so every
 * empty state links to the card that explains it rather than to the top of a
 * manual they then have to search. The link is `/guide?to=<target>`; the guide
 * switches to the right section and scrolls the card into view.
 */
export type GuideTarget =
  | 'overview' | 'hierarchy' | 'shortcuts'
  | 'capture' | 'views' | 'planning' | 'sync' | 'pages' | 'collab' | 'teams' | 'automation' | 'assistant';

export type GuideSection = 'overview' | 'hierarchy' | 'features' | 'shortcuts';

/** Targets that are a section of their own; everything else is a feature card. */
const SECTIONS: Record<string, GuideSection> = {
  overview: 'overview',
  hierarchy: 'hierarchy',
  shortcuts: 'shortcuts',
};

export const sectionFor = (target: string): GuideSection => SECTIONS[target] ?? 'features';

/** The DOM id a feature card carries, so the guide can scroll to it. */
export const cardId = (target: string): string => `guide-${target}`;

export const guideHref = (target: GuideTarget): string => `/guide?to=${target}`;
