/**
 * Inter and JetBrains Mono, bundled rather than fetched.
 *
 * Two things went wrong before this file existed, and both are the reason it
 * looks like this rather than like a `<link>` to Google Fonts:
 *
 * 1. **A render is not a browser session.** The headless Chrome that renders a
 *    frame starts cold, and `font-display: swap` means frame 0 is drawn in the
 *    fallback face at fallback metrics. On a headless Linux box that fallback is
 *    DejaVu Sans, which is half a beat wider — so the headline that fitted in
 *    the studio wrapped in the output. `delayRender` below holds frame 0 until
 *    the faces are actually decoded.
 * 2. **A render should not need the network.** The faces come from
 *    `@fontsource/*` in `node_modules`, so `npm ci && npm run build` produces the
 *    same file on a machine with no DNS as on one with.
 *
 * The catch is deliberate too: a font that cannot be loaded should cost the spot
 * its typography, not its render. Timing out here would fail the build twenty
 * seconds in with a message about a handle rather than about a font.
 */
import { continueRender, delayRender } from 'remotion';

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

/**
 * `document.fonts.ready` on its own resolves immediately when nothing on the
 * page has asked for a face yet — which, at module scope, is always. So each
 * weight is requested by hand first, against a string that covers every glyph
 * the spot draws, because a subsetted face only loads the subset it is asked for.
 */
const GLYPHS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  ' .,:;!?@#*/\\|()[]{}<>+-=_~—–·×✓→←"\'&%$';

const SPECS = [
  '400 1em Inter',
  '500 1em Inter',
  '600 1em Inter',
  '700 1em Inter',
  '800 1em Inter',
  "400 1em 'JetBrains Mono'",
  "500 1em 'JetBrains Mono'",
  "700 1em 'JetBrains Mono'",
];

const handle = delayRender('Decoding Inter and JetBrains Mono');

Promise.all(SPECS.map((spec) => document.fonts.load(spec, GLYPHS)))
  .then(() => document.fonts.ready)
  .catch(() => undefined)
  .then(() => continueRender(handle));

/** Imported for its side effect; the export exists so the import is not elided. */
export const fontsRequested = SPECS.length;
