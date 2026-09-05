/**
 * The emoji a project, a page or a template may wear.
 *
 * Separate from the picker that draws them for the reason `reaction-set.ts` is
 * separate from `reactions.tsx`: this is the part with a decision in it, and it
 * can be checked without a DOM.
 *
 * The decision is **which** emoji, and it is about other people's devices. The
 * field was a text box that took any four characters, so an icon chosen on a
 * new phone could arrive on a colleague's older laptop as an empty rectangle —
 * or, worse, as three separate emoji, which is what a ZWJ sequence like 👨‍💻
 * degrades into when the system does not know that combination. Neither failure
 * is visible to the person who chose it, and the icon exists precisely to be
 * recognised by everybody else at a glance.
 *
 * So the set is drawn only from emoji that shipped in **Unicode 6.0 (October
 * 2010)** — the run that iOS 5, Android 4.1 and Windows 8 all carry, and that
 * every system since has kept. `SAFE_RANGES` below is the mechanical half of
 * that promise and `emoji.test.ts` holds it; picking the useful ones out of
 * those ranges is the half that is judgement.
 *
 * It is deliberately about sixty, not a full picker. An icon is here to make
 * one row findable at a glance, and a thousand choices make that harder rather
 * than easier — the same argument `REACTIONS` makes for six.
 */

/**
 * Code point ranges whose emoji are old enough to be everywhere, each with the
 * Unicode release it arrived in.
 *
 * Narrower than the blocks they sit in, on purpose. The Miscellaneous Symbols
 * and Pictographs block runs to U+1F5FF, but its tail — U+1F5A5 🖥, U+1F5C2 🗂,
 * the rest of the Webdings imports — came in Unicode 7.0 (2014) and is exactly
 * the sort of thing that renders as a box on a machine somebody has not
 * replaced. The ranges stop before it.
 */
export const SAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x231a, 0x231b], // watch, hourglass — Unicode 6.0
  [0x23e9, 0x23fa], // media controls, alarm clock, hourglass flowing — 6.0
  [0x2600, 0x27bf], // Miscellaneous Symbols and Dingbats — 1.1 to 4.1
  [0x2b00, 0x2bff], // arrows and stars — 4.0 to 5.1
  [0x1f300, 0x1f53d], // Miscellaneous Symbols and Pictographs, the 6.0 run
  [0x1f550, 0x1f567], // clock faces — 6.0
  [0x1f600, 0x1f64f], // Emoticons, all of it — 6.0
  [0x1f680, 0x1f6c5], // Transport and Map, the 6.0 run
];

/**
 * The choices, in the order they are drawn.
 *
 * Grouped by what somebody is naming rather than by code point — documents,
 * then tools, then the things that mean "look at this", then places and people,
 * then money and time, then getting about. No headings in the picker: sixty
 * cells read as one grid, and six labels over rows of eight is more furniture
 * than the grid is content.
 */
export const ICON_CHOICES: readonly string[] = [
  // documents and the work in them
  '📄', '📋', '📊', '📈', '📉', '📝', '📅', '📌', '📎', '📁', '📂',
  '📖', '📚', '📕', '📗', '📘', '📙',
  // tools
  '💻', '📱', '⚙️', '🔧', '🔨', '🔌', '🔋', '💾', '🔒', '🔑', '🔍', '🔗',
  // things that mean look here
  '⭐', '✨', '🔥', '💡', '🎯', '⚡', '⚠️', '✅', '❌', '❗', '❓', '🚧', '🏁',
  // places and people
  '👥', '🏠', '🏢', '🏭', '🌍', '🌱', '🎨', '🎬', '🎉', '🏆',
  // money and time
  '💰', '💳', '💶', '🏦', '⏰', '⌛', '⏳', '🔁',
  // getting about, and getting through the afternoon
  '✉️', '📧', '📢', '☎️', '🚀', '✈️', '🚗', '🚚', '☕',
];

/** The variation selector that asks for the coloured form of an older symbol. */
const VARIATION = 0xfe0f;

/**
 * Whether this string is one emoji from the safe ranges.
 *
 * This is the rule `ICON_CHOICES` is held to, and `emoji.test.ts` is what holds
 * it. It is deliberately **not** the question the picker asks: that one is "do
 * I offer this", which is narrower. 🌐 and 🚨 pass here and are not in the list,
 * and a picker that confused the two would drop them.
 */
export function isSafeEmoji(value: string): boolean {
  const points = [...value];
  if (!points.length || points.length > 2) return false;
  if (points.length === 2 && points[1].codePointAt(0) !== VARIATION) return false;
  const code = points[0].codePointAt(0) ?? 0;
  return SAFE_RANGES.some(([from, to]) => code >= from && code <= to);
}
