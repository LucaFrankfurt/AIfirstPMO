/**
 * The 9:16 cut: the same seven beats, on the same frames, re-laid-out.
 *
 * It shares everything that carries meaning — `copy.ts`, `timing.ts`, the
 * widgets, the backdrop — and duplicates only the thing that genuinely differs
 * between a wide frame and a tall one, which is where things go. A vertical
 * version made by letterboxing this spot would be a picture of a wide video;
 * these are seven layouts composed for a phone.
 */
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import './fonts';
import { window as beatWindow } from './timing';
import { Backdrop, Corner } from './components/Backdrop';
import { OpenTall } from './scenes/tall/Open';
import { OfflineTall } from './scenes/tall/Offline';
import { LayoutsTall } from './scenes/tall/Layouts';
import { QuickAddTall } from './scenes/tall/QuickAdd';
import { DependenciesTall } from './scenes/tall/Dependencies';
import { AssistantTall } from './scenes/tall/Assistant';
import { CloseTall } from './scenes/tall/Close';

export const SpotTall: React.FC = () => (
  <AbsoluteFill>
    <Backdrop shape="tall" />

    <Sequence {...beatWindow.open}>
      <OpenTall life={beatWindow.open.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.offline}>
      <OfflineTall life={beatWindow.offline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.layouts}>
      <LayoutsTall life={beatWindow.layouts.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.quickAdd}>
      <QuickAddTall life={beatWindow.quickAdd.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.timeline}>
      <DependenciesTall life={beatWindow.timeline.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.assistant}>
      <AssistantTall life={beatWindow.assistant.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <CloseTall life={beatWindow.close.durationInFrames} />
    </Sequence>

    {/* Centred, because a vertical frame has no comfortable corner to sit in. */}
    <Corner top={84} centred />
  </AbsoluteFill>
);
