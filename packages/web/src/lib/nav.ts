/**
 * Every top-level place in the app, in one list.
 *
 * There are two navigations here — the sidebar on a desktop and the "More"
 * screen on a phone — and for a long time they were two hand-written lists of
 * JSX. Which is a arrangement that works right up until somebody adds a
 * feature, remembers one of them, and ships a screen that a phone cannot
 * reach. It has now happened twice: chat was desktop-only for a while, and
 * budgets, the timesheet and the infrastructure register were desktop-only
 * from the day they landed. The screens existed, the routes resolved, the
 * feature switch was on — there was simply no link to them on a phone.
 *
 * So the set lives here and both surfaces render it. They still render it
 * differently — the sidebar interleaves the projects and the More screen
 * groups by card — but neither of them decides *what* is in the app, and
 * adding a destination to this list puts it on both.
 *
 * `reachable.test.ts` reads the router and asserts that every top-level route
 * is in this list or in the phone's bottom bar, so the next feature cannot
 * repeat it.
 */
import type { WorkspaceFeatures } from '@kolibri/shared';
import type { IconName } from '../components/ui';
import type { TranslationKey } from './i18n';

export interface Destination {
  to: string;
  icon: IconName;
  label: TranslationKey;
  /**
   * Shown only where the workspace has this switched on. A link to a feature
   * nobody here uses is the clutter the switches exist to prevent — and on a
   * phone, where the list is the whole navigation, it is worse than clutter.
   */
  feature?: keyof WorkspaceFeatures;
}

/**
 * The everyday surfaces: things other people write to, and the reference.
 *
 * The first three are also the phone's bottom bar, which is why this list is
 * split — the More screen would otherwise repeat, one scroll below, the three
 * icons that are already on screen.
 */
export const WORKSPACE_DESTINATIONS: readonly Destination[] = [
  { to: '/chat', icon: 'chat', label: 'nav.chat' },
  { to: '/pages', icon: 'page', label: 'nav.pages' },
  { to: '/teams', icon: 'users', label: 'nav.teams' },
  { to: '/guide', icon: 'help', label: 'nav.guide' },
];

/**
 * The planning surfaces, which sit under the projects on both navigations
 * because that is what they are about: who is doing what, what it costs, and
 * what it runs on.
 *
 * Portfolio is not here — it appears only where there is more than one project
 * to hold a portfolio of, which is a condition about data rather than about a
 * switch, so each surface asks it itself.
 */
export const PLANNING_DESTINATIONS: readonly Destination[] = [
  { to: '/planner', icon: 'users', label: 'nav.planner' },
  { to: '/timesheet', icon: 'calendar', label: 'nav.timesheet', feature: 'time' },
  { to: '/infrastructure', icon: 'stack', label: 'nav.infrastructure', feature: 'infrastructure' },
  { to: '/budgets', icon: 'wallet', label: 'nav.budgets', feature: 'budget' },
];

/** Both lists, for anything that needs the whole set rather than one group. */
export const DESTINATIONS: readonly Destination[] = [
  ...WORKSPACE_DESTINATIONS,
  ...PLANNING_DESTINATIONS,
];

/**
 * Narrow a list to what this workspace has switched on.
 *
 * Takes the predicate rather than calling `useFeature` itself, so the list
 * stays plain data that a test can read without a React tree around it.
 */
export const enabled = (
  destinations: readonly Destination[],
  has: (feature: keyof WorkspaceFeatures) => boolean,
): Destination[] => destinations.filter((item) => !item.feature || has(item.feature));
