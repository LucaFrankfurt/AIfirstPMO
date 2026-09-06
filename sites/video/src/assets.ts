/**
 * Every file the spot pulls in, resolved in one place.
 *
 * The screenshots are imported out of `sites/docs` rather than copied into a
 * `public/` folder here, and that is deliberate: they are the *product's* real
 * screens, regenerated when the UI changes, and a fourth copy of a binary is a
 * fourth thing to forget. If a screen is ever re-shot, this spot picks it up
 * with no step in between.
 *
 * Keeping them behind named exports also means a renamed screen is a build
 * error in one file instead of a black rectangle three scenes in.
 */
import boardDark from '../../docs/src/assets/screens/board-dark.webp';
import chatDark from '../../docs/src/assets/screens/chat-dark.webp';
import insightsDark from '../../docs/src/assets/screens/insights-dark.webp';
import listDark from '../../docs/src/assets/screens/list-dark.webp';
import mobileDark from '../../docs/src/assets/screens/mobile-dark.webp';
import myWorkDark from '../../docs/src/assets/screens/my-work-dark.webp';
import pagesDark from '../../docs/src/assets/screens/pages-dark.webp';
import taskDark from '../../docs/src/assets/screens/task-dark.webp';
import timelineDark from '../../docs/src/assets/screens/timeline-dark.webp';
import mark from '../../../assets/brand/kolibri-mark-1024.png';

/**
 * The intrinsic size of each screen, because a crop expressed in pixels of the
 * source is the only kind that survives a re-shoot at a different scale. All
 * the wide screens are 2720×1400 except the timeline, which is shorter.
 */
export const screen = {
  board: { src: boardDark, w: 2720, h: 1400 },
  chat: { src: chatDark, w: 2720, h: 1400 },
  insights: { src: insightsDark, w: 2720, h: 1400 },
  list: { src: listDark, w: 2720, h: 1400 },
  myWork: { src: myWorkDark, w: 2720, h: 1400 },
  pages: { src: pagesDark, w: 2720, h: 1400 },
  task: { src: taskDark, w: 2720, h: 1400 },
  timeline: { src: timelineDark, w: 2720, h: 1020 },
  mobile: { src: mobileDark, w: 780, h: 1440 },
} as const;

export type ScreenName = keyof typeof screen;

export { mark };
