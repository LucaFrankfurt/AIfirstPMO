/**
 * The two stacked cuts — 9:16 and 4:5 — from one set of layouts.
 *
 * They share everything that carries meaning: `copy.ts`, `timing.ts`, the
 * widgets, the backdrop. What the wide cut does not share is where things go,
 * which is why `scenes/tall/` exists at all — a vertical version made by
 * letterboxing the wide one would be a picture of a wide video.
 *
 * 4:5 does not need a third set. It is the same 1080 pixels across, so every
 * screenshot crop, every widget and every measurement holds; only the height
 * changes, and the scenes take that as a shape rather than as a rewrite. Where
 * something genuinely cannot fit — the board window in the offline beat, the
 * collage in the close — the scene says so in its own file.
 */
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import '../../fonts';
import { window as beatWindow, starts } from './timing';
import { Backdrop, Corner, type Mood } from '../../components/Backdrop';
import { STACKED, type Stacked } from '../../components/Layout';
import { OpenTall } from './scenes/tall/Open';
import { OfflineTall } from './scenes/tall/Offline';
import { LayoutsTall } from './scenes/tall/Layouts';
import { QuickAddTall } from './scenes/tall/QuickAdd';
import { DependenciesTall } from './scenes/tall/Dependencies';
import { AssistantTall } from './scenes/tall/Assistant';
import { CloseTall } from './scenes/tall/Close';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'high', 'right', 'high', 'right', 'brand'];

export const SpotStacked: React.FC<{ shape: Stacked }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <OpenTall shape={shape} life={beatWindow.open.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.offline}>
      <OfflineTall shape={shape} life={beatWindow.offline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.layouts}>
      <LayoutsTall shape={shape} life={beatWindow.layouts.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.quickAdd}>
      <QuickAddTall shape={shape} life={beatWindow.quickAdd.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.timeline}>
      <DependenciesTall shape={shape} life={beatWindow.timeline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.assistant}>
      <AssistantTall shape={shape} life={beatWindow.assistant.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <CloseTall shape={shape} life={beatWindow.close.durationInFrames} />
    </Sequence>

    {/* Centred, because a stacked frame has no comfortable corner to sit in. */}
    <Corner
      from={beatWindow.offline.from + 16}
      until={beatWindow.close.from - 14}
      top={STACKED[shape].lockup}
      centred
    />
  </AbsoluteFill>
);

export const SpotTall: React.FC = () => <SpotStacked shape="tall" />;
export const SpotFeed: React.FC = () => <SpotStacked shape="feed" />;
