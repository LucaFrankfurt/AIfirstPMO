/**
 * The Tasks explainer, in any of the three shapes.
 *
 * One component for all of them, unlike the flagship spot: every beat here is
 * words plus one animated widget, so the whole difference lives inside `<Beat>`
 * and the scenes only have to say how big the widget is.
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
import { QuickAdd } from './scenes/QuickAdd';
import { Fields } from './scenes/Fields';
import { SubTasksBeat } from './scenes/SubTasksBeat';
import { Workflow } from './scenes/Workflow';
import { Query } from './scenes/Query';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'right', 'right', 'high', 'right', 'brand'];

export const TasksSpot: React.FC<{ shape: Shape }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Opening shape={shape} life={beatWindow.open.durationInFrames} {...open} />
    </Sequence>
    <Sequence {...beatWindow.quickAdd}>
      <QuickAdd shape={shape} life={beatWindow.quickAdd.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.fields}>
      <Fields shape={shape} life={beatWindow.fields.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.subtasks}>
      <SubTasksBeat shape={shape} life={beatWindow.subtasks.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.workflow}>
      <Workflow shape={shape} life={beatWindow.workflow.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.query}>
      <Query shape={shape} life={beatWindow.query.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Closing shape={shape} life={beatWindow.close.durationInFrames} {...close} />
    </Sequence>

    <Corner
      from={beatWindow.quickAdd.from + 16}
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
export const TasksWide: React.FC = () => <TasksSpot shape="wide" />;
export const TasksTall: React.FC = () => <TasksSpot shape="tall" />;
export const TasksFeed: React.FC = () => <TasksSpot shape="feed" />;
