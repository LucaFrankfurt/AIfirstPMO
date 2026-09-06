/**
 * The Hierarchy explainer, in either shape.
 *
 * Words plus one animated widget per beat, so the whole difference between 16:9
 * and 9:16 lives inside `<Beat>` and the scenes only say how big the widget is.
 */
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import '../../fonts';
import { window as beatWindow, starts } from './timing';
import { open, close } from './copy';
import { Backdrop, Corner, type Mood } from '../../components/Backdrop';
import { Opening, Closing } from '../../components/Bookend';
import { type Shape } from '../../components/Beat';
import { STACKED, type Stacked } from '../../components/Layout';
import { Tree } from './scenes/Tree';
import { Ident } from './scenes/Ident';
import { NestingBeat } from './scenes/NestingBeat';
import { SpanningBeat } from './scenes/SpanningBeat';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'high', 'right', 'right', 'right', 'brand'];

export const HierarchySpot: React.FC<{ shape: Shape }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Opening shape={shape} life={beatWindow.open.durationInFrames} {...open} />
    </Sequence>
    <Sequence {...beatWindow.tree}>
      <Tree shape={shape} life={beatWindow.tree.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.identifier}>
      <Ident shape={shape} life={beatWindow.identifier.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.nesting}>
      <NestingBeat shape={shape} life={beatWindow.nesting.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.spanning}>
      <SpanningBeat shape={shape} life={beatWindow.spanning.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Closing shape={shape} life={beatWindow.close.durationInFrames} {...close} />
    </Sequence>

    <Corner
      from={beatWindow.tree.from + 16}
      until={beatWindow.close.from - 14}
      top={shape === 'wide' ? 62 : STACKED[shape as Stacked].lockup}
      centred={shape !== 'wide'}
    />
  </AbsoluteFill>
);

/*
 * Named rather than inlined at the registration site: Remotion remounts a
 * composition whose component identity changes, and an arrow function written
 * into JSX is a new identity on every render.
 */
export const HierarchyWide: React.FC = () => <HierarchySpot shape="wide" />;
export const HierarchyTall: React.FC = () => <HierarchySpot shape="tall" />;
export const HierarchyFeed: React.FC = () => <HierarchySpot shape="feed" />;
