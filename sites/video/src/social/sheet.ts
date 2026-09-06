/**
 * The two still formats, and the room each of them actually has.
 *
 * A carousel is not a short film with the motion taken out. It is read, at
 * arm's length, one thumb-swipe at a time — so the numbers here are not the
 * spot's numbers scaled down. Three things differ and all three are budgets
 * rather than layouts, for the same reason `STACKED` in `components/Layout.tsx`
 * is: seven slides with seven ideas about where the floor is read as seven
 * pictures, and a carousel has to read as one.
 *
 * Everything else — the palette, the two curves, the widgets, the facts — is
 * the spots', unchanged. A post whose indigo is a shade off the video above it
 * in the same feed is the one thing this folder must not produce.
 */

/**
 * The feed post: 4:5, the tallest thing Instagram shows without cropping, and
 * the shape every slide of a carousel has to share.
 */
export const POST = {
  width: 1080,
  height: 1350,

  /** The side gutter. Everything is inside it; nothing bleeds in a still. */
  margin: 84,

  /** The header row's top edge, and where the footer row sits. */
  head: 66,
  foot: 1222,

  /** The band the words and the picture live in, between those two rows. */
  top: 196,
  bottom: 1180,

  kicker: 21,
  headline: 50,
  sub: 25,
  gap: 46,
} as const;

/**
 * The square the profile grid crops a 4:5 post to.
 *
 * Instagram shows a carousel whole in the feed and as a centre-cropped square
 * on the grid, which means 135 pixels off the top and 135 off the bottom of
 * every post — and the grid is where somebody who has just found the account
 * looks first. The inner slides can spend the full height; the **cover cannot**,
 * because the cover is the thumbnail. `Cover` composes inside this and nothing
 * else has to think about it.
 */
export const SQUARE = {
  top: (POST.height - POST.width) / 2,
  bottom: (POST.height + POST.width) / 2,
} as const;

/**
 * There is deliberately no story format here.
 *
 * 9:16 is the one shape this folder already covers properly: six thirty-second
 * spots are rendered in it, and a story is a place a *video* plays. A still
 * card in that slot would be a worse version of a file that already exists, and
 * the second one somebody had to remember to re-render. If a static story is
 * ever genuinely wanted, it wants its own safe area — roughly 220 pixels of
 * profile row at the top and 320 of reply field at the bottom — and that number
 * belongs here beside `POST`, not guessed at in a scene.
 */
