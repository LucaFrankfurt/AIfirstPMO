/**
 * The seven beats of the wide cut, in order, over one continuous background.
 *
 * The 9:16 cut is `VideoTall.tsx` and shares everything except this file and
 * the seven layouts it names: the same copy, the same beat table, the same
 * widgets, the same backdrop.
 */
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import '../../fonts';
import { window as beatWindow, starts } from './timing';
import { Backdrop, Corner, type Mood } from '../../components/Backdrop';
import { Open } from './scenes/Open';
import { Offline } from './scenes/Offline';
import { Layouts } from './scenes/Layouts';
import { QuickAdd } from './scenes/QuickAdd';
import { Dependencies } from './scenes/Dependencies';
import { Assistant } from './scenes/Assistant';
import { Close } from './scenes/Close';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'high', 'right', 'high', 'right', 'brand'];

export const Spot: React.FC = () => (
  <AbsoluteFill>
    <Backdrop shape="wide" starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Open life={beatWindow.open.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.offline}>
      <Offline life={beatWindow.offline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.layouts}>
      <Layouts life={beatWindow.layouts.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.quickAdd}>
      <QuickAdd life={beatWindow.quickAdd.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.timeline}>
      <Dependencies life={beatWindow.timeline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.assistant}>
      <Assistant life={beatWindow.assistant.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Close life={beatWindow.close.durationInFrames} />
    </Sequence>

    <Corner from={beatWindow.offline.from + 16} until={beatWindow.close.from - 14} top={62} />
  </AbsoluteFill>
);
