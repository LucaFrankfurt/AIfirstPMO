/**
 * The palette, the type ramp and the two easing curves the whole spot uses.
 *
 * The colours are not invented here. They are the dark theme of the product,
 * copied from `sites/demo/src/styles/site.css` — a marketing video whose indigo
 * is a shade off the indigo in the screenshots beside it looks like a mock-up
 * of the product rather than the product, and that is the one thing a spot made
 * of real screenshots must not look like.
 */
export const colour = {
  /** One step darker than the app's `--bg`, so a screenshot of the app lifts off it. */
  bg: '#08090d',
  bgRaised: '#15181e',
  line: '#22262f',
  lineStrong: '#2e333e',

  fg: '#f2f4f8',
  fgSoft: '#a7adba',
  fgMuted: '#7d838f',

  accent: '#7c7cf0',
  accentDeep: '#5b5bd6',
  accentSoft: '#1d1f3d',
  accentText: '#bcbcf9',

  ok: '#26a27c',
  warn: '#d97706',
  danger: '#e06d6e',

  /**
   * The second person's blue.
   *
   * Grace's avatar, the team row in the tree, the row the query drops because
   * it is not assigned to me — everywhere the spot needs "somebody who is not
   * you" it is this, and it was six copies of `#4aa3df` in six files until the
   * social sheets wanted a seventh.
   */
  info: '#4aa3df',

  /**
   * The mark's teal, lifted two steps. The bird's own `#3f8f8b` is a fill colour
   * and all but vanishes as 16px type on `#08090d`, which is what the `*design`
   * caption in the quick-add beat is.
   */
  brand: '#54bdb6',
} as const;

export const font = {
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/**
 * Two curves, and no third.
 *
 * `enter` is the one everything arrives on: fast out of the gate, long settle,
 * no overshoot — at 30fps an overshoot on large type reads as a wobble rather
 * than as bounce. `exit` is symmetrical and quicker, because a viewer has
 * already read the thing that is leaving.
 */
export const ease = {
  enter: [0.16, 1, 0.3, 1] as const,
  exit: [0.7, 0, 0.84, 0] as const,
  linear: [0, 0, 1, 1] as const,
};

/** The one shadow. A screenshot sits on the page; nothing else casts. */
export const shadow =
  '0 60px 120px -40px rgba(0,0,0,0.85), 0 12px 40px -12px rgba(0,0,0,0.6)';
