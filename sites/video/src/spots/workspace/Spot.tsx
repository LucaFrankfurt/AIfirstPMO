/**
 * The Workspace explainer, in either shape.
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
import { Switcher } from './scenes/Switcher';
import { Roles } from './scenes/Roles';
import { Features } from './scenes/Features';
import { Teams } from './scenes/Teams';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'high', 'right', 'right', 'brand'];

export const WorkspaceSpot: React.FC<{ shape: Shape }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Opening shape={shape} life={beatWindow.open.durationInFrames} {...open} />
    </Sequence>
    <Sequence {...beatWindow.switcher}>
      <Switcher shape={shape} life={beatWindow.switcher.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.roles}>
      <Roles shape={shape} life={beatWindow.roles.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.features}>
      <Features shape={shape} life={beatWindow.features.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.teams}>
      <Teams shape={shape} life={beatWindow.teams.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Closing shape={shape} life={beatWindow.close.durationInFrames} {...close} />
    </Sequence>

    <Corner
      from={beatWindow.switcher.from + 16}
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
export const WorkspaceWide: React.FC = () => <WorkspaceSpot shape="wide" />;
export const WorkspaceTall: React.FC = () => <WorkspaceSpot shape="tall" />;
export const WorkspaceFeed: React.FC = () => <WorkspaceSpot shape="feed" />;
