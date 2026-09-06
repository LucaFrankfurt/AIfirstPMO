/**
 * What Kolibri is, in eight swipes.
 *
 * This is the one somebody sees first, so it is the one that has to survive
 * being read at arm's length with the sound off and the caption collapsed.
 * Each middle slide makes exactly one claim and shows the thing that claim is
 * about — the outbox with three changes in it, the line being parsed, the bar
 * that has already moved. A claim with no picture beside it is a claim, and a
 * claim with the wrong picture beside it is worse.
 *
 * Every line is the flagship spot's own, out of `spots/kolibri/copy.ts`, for
 * the reason that file gives: a sentence with two copies is a sentence that
 * drifts. The two slides the spot does not have — the stack and the licence —
 * quote the README's quick start instead.
 */
import { colour } from '../../theme';
import { claims, command } from '../../product';
import { screen } from '../../assets';
import { beats, close } from '../../spots/kolibri/copy';
import { Screenshot } from '../../components/Screenshot';
import { Outbox } from '../../components/Outbox';
import { QuickAddField } from '../../components/QuickAddField';
import { Gantt } from '../../components/Gantt';
import { TaskCard } from '../../components/ui';
import { ToolCall } from '../../components/ToolCall';
import type { Carousel } from '../slide';

/** The band a still may use: the sheet's width less its two margins. */
const W = 912;

export const pitch: Carousel = {
  id: 'SocialPitch',
  about: 'the pitch — offline-first, five layouts, one line, dependencies, MCP, one command',
  slides: [
    {
      kind: 'cover',
      kicker: 'Open source',
      headline: 'Projects, tasks and pages that never wait for the network.',
      sub: 'A work OS you run yourself. One command to install it, and nothing to configure afterwards.',
      chips: claims,
    },
    {
      kind: 'point',
      ...beats.offline,
      visual: {
        height: 292,
        /*
         * Frame 100 is the middle of the offline beat: the connection has been
         * gone for seventy frames and all three edits are sitting in the queue.
         * The merge is what the *next* carousel shows — a set of stills has the
         * reader's thumb where a film has a clock.
         *
         * 1.61 is 912/566, the outbox's own width taken to the band's. It is
         * written as the division rather than as `1.61` so that a change to
         * either number cannot leave the panel a few pixels off the margin.
         */
        node: <Outbox frame={100} scale={W / 566} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...beats.layouts,
      visual: {
        height: 714,
        node: (
          <Screenshot
            screen={screen.board}
            /*
             * The layouts beat's own crop: cropped to the sidebar's edge and
             * the toolbar's far corner, and no further, because the view
             * switcher lives in that corner and this is the slide that claims
             * there are five of them. A tighter crop of the cards alone shows
             * a board and makes no argument.
             */
            crop={{ x: 420, y: 0, w: 1600, h: 1020 }}
            width={1120}
            height={714}
            /*
             * Forty pixels off each edge of the frame, not of the band. A
             * desktop UI letterboxed politely inside a phone-shaped post reads
             * as a screenshot of a screenshot; one that runs off both sides
             * reads as a screen. `-104` is that bleed less the band's margin.
             */
            style={{ left: -104, top: 0 }}
          />
        ),
      },
    },
    {
      kind: 'point',
      ...beats.quickAdd,
      visual: {
        /* 140 is twenty frames after the task is filed: parsed, labelled, settled. */
        height: 420,
        node: (
          <>
            <QuickAddField frame={140} width={W} size={24} style={{ left: 0, top: 0 }} />
            {/* The task the line filed, with the fields the sigils became. */}
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
      ...beats.timeline,
      visual: {
        height: 376,
        /*
         * After the drop at frame 62, so both bars have already moved and the
         * pointer that moved them has gone — a still with a cursor in it looks
         * like a screenshot somebody took mid-gesture.
         *
         * The grid is rebuilt from `day` rather than scaled, and the day is 14
         * because `labelWidth + 45 * day` has to fit inside the band. At 18 it
         * did not, and the dependency arrow — the only thing this slide is
         * about — ran off the right edge with the bar it points at.
         */
        node: (
          <Gantt
            frame={110}
            labelWidth={250}
            day={14}
            rowHeight={74}
            headHeight={62}
            labelSize={18}
            /* 250 + 45 × 14 = 880, and the 32 left over is split so the grid
             * sits on the band's centre line rather than against its left. */
            style={{ left: 16, top: 0 }}
          />
        ),
      },
    },
    {
      kind: 'point',
      ...beats.assistant,
      visual: {
        height: 350,
        node: <ToolCall frame={110} width={W} size={21} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'Self-hosted',
      headline: 'One Node process and a SQLite file you can copy.',
      sub: 'No Postgres, no Redis, no worker queue — and no third-party dependency in the server at all. SQLite is built into Node, and the server runs TypeScript directly.',
      code: command,
    },
    {
      kind: 'close',
      kicker: 'MIT',
      headline: close.headline,
      sub: 'Node 22.18 and up, or Docker with Compose v2. Nothing else.',
      code: command,
    },
  ],
};
