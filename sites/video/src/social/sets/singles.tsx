/**
 * Nine posts that stand on their own.
 *
 * An account cannot post a carousel every day, and the gaps are what actually
 * decide whether anybody is still following in a month. These are the gaps: one
 * claim, one picture, one post — meetable cold, in a feed, by somebody who has
 * never heard of any of it.
 *
 * `series: false` is the whole difference from a carousel. No counter, because
 * a "4 / 9" on a post somebody found on its own promises eight more that are
 * not there; and no chevron, because there is nothing to swipe to. They are one
 * composition and one folder for the same reason the carousels are — a render
 * is a bundle, and nine of them is nine bundles.
 *
 * Two widgets appear here and nowhere else — the query box and the state flow —
 * because a set of singles that repeats the carousels' pictures is a set of
 * singles nobody needs.
 */
import { colour } from '../../theme';
import { command } from '../../product';
import { screen } from '../../assets';
import { beats as taskBeats } from '../../spots/tasks/copy';
import { Screenshot } from '../../components/Screenshot';
import { Outbox } from '../../components/Outbox';
import { QuickAddField } from '../../components/QuickAddField';
import { QueryBox } from '../../components/QueryBox';
import { StateFlow } from '../../components/StateFlow';
import { ToolCall } from '../../components/ToolCall';
import { TaskCard } from '../../components/ui';
import type { Carousel } from '../slide';

const W = 912;

export const singles: Carousel = {
  id: 'SocialSingles',
  about: 'nine standalone feed posts, for the days between carousels',
  series: false,
  slides: [
    {
      kind: 'cover',
      kicker: 'The second conviction',
      headline: 'Self-hosting should be boring.',
      sub: 'One command brings up a complete, self-configuring stack. The app is one Node process and a SQLite file you can copy.',
      chips: ['No Postgres', 'No Redis', 'No worker queue'],
    },
    {
      kind: 'point',
      kicker: 'One set of tasks',
      headline: 'Five layouts, one filter.',
      sub: 'List, board, table, calendar and timeline, sharing your filters and your grouping.',
      visual: {
        height: 714,
        node: (
          <Screenshot
            screen={screen.board}
            crop={{ x: 420, y: 0, w: 1600, h: 1020 }}
            width={1120}
            height={714}
            style={{ left: -104, top: 0 }}
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Quick add',
      headline: 'A whole task on one line.',
      sub: 'The sigils become fields as you type.',
      visual: {
        height: 370,
        node: (
          <>
            <QuickAddField frame={140} width={W} size={24} style={{ left: 0, top: 0 }} />
            <div style={{ position: 'absolute', left: 76, top: 215 }}>
              <TaskCard
                id="WEB-2"
                title="Redraw the empty state"
                priority={3}
                chips={[
                  { label: 'High', dot: colour.danger },
                  { label: 'Website', dot: colour.accent },
                  { label: 'design', dot: colour.brand },
                  { label: 'Sep 11' },
                ]}
                avatar={{ initials: 'AL', fill: colour.ok }}
                width={760}
              />
            </div>
          </>
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Offline-first',
      headline: 'Three changes, waiting for the wifi.',
      sub: 'You kept working. They queue, and merge field by field when you come back.',
      visual: {
        height: 292,
        node: <Outbox frame={100} scale={W / 566} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...taskBeats.query,
      visual: {
        /*
         * Frame 210: past every clause, so the eight rows the query started
         * with have become the three it keeps. The point of the picture is the
         * three, not the collapsing.
         */
        height: 340,
        node: <QueryBox frame={210} width={W} size={22} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...taskBeats.workflow,
      visual: {
        /*
         * Frame 120 rather than the end of the beat, and 800 wide rather than
         * the band's 912. Both for the same reason: this widget draws the card
         * and the column's rule *centred on* the state they belong to, so at
         * Done — the last column — each of them hangs about six type-sizes past
         * the right-hand end. The film gets away with it because the card is
         * only there for a moment and the frame is moving. A still does not.
         *
         * So the card is caught at In Review, mid-refusal: inside the widget by
         * a wide margin, and the more useful of the two states anyway, because
         * the refusal is what the headline is about.
         *
         * 720 rather than 800 is the second correction. The rule chip is a
         * nowrap inline-flex inside a `size * 13` box, so it is wider than the
         * box that positions it — at 800 its last two words were off the frame
         * entirely. The track is narrower than the band as a result, which is
         * the right trade: a shorter line reads fine, and a sentence with its
         * end cut off does not.
         */
        height: 310,
        node: <StateFlow frame={120} width={720} size={22} style={{ left: 60, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'MCP-native',
      headline: 'An assistant files it the way you would.',
      sub: 'Same workspace, same permissions, same audit trail — and the same parser behind the tool as behind the field.',
      visual: {
        height: 350,
        node: <ToolCall frame={110} width={W} size={21} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'The stack',
      headline: 'The server has no dependencies.',
      sub: 'Not “few”. Its package.json lists one, and that one is this repository’s own shared package. SQLite is built into Node 22, and the server runs TypeScript directly.',
      code: '"dependencies": { "@kolibri/shared": "*" }',
    },
    {
      kind: 'close',
      kicker: 'MIT',
      headline: 'Open source projects, tasks and pages.',
      sub: 'Offline-first, self-hosted, MCP-native. Try it before you install it.',
      code: command,
    },
  ],
};
