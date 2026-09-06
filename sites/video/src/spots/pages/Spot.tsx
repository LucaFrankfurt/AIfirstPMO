/**
 * The Pages explainer, in either shape.
 *
 * Same construction as the Tasks one: every beat is words plus one animated
 * widget, so the whole difference between 16:9 and 9:16 lives inside `<Beat>`.
 */
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import '../../fonts';
import { window as beatWindow, starts } from './timing';
import { open, close } from './copy';
import { Backdrop, Corner, type Mood } from '../../components/Backdrop';
import { Opening, Closing } from '../../components/Bookend';
import { type Shape } from '../../components/Beat';
import { EditorBeat } from './scenes/EditorBeat';
import { Links } from './scenes/Links';
import { Collaboration } from './scenes/Collaboration';
import { Comments } from './scenes/Comments';
import { History } from './scenes/History';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'right', 'high', 'right', 'right', 'brand'];

export const PagesSpot: React.FC<{ shape: Shape }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Opening shape={shape} life={beatWindow.open.durationInFrames} {...open} />
    </Sequence>
    <Sequence {...beatWindow.editor}>
      <EditorBeat shape={shape} life={beatWindow.editor.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.links}>
      <Links shape={shape} life={beatWindow.links.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.collab}>
      <Collaboration shape={shape} life={beatWindow.collab.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.comments}>
      <Comments shape={shape} life={beatWindow.comments.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.history}>
      <History shape={shape} life={beatWindow.history.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Closing shape={shape} life={beatWindow.close.durationInFrames} {...close} />
    </Sequence>

    <Corner
      from={beatWindow.editor.from + 16}
      until={beatWindow.close.from - 14}
      top={shape === 'tall' ? 84 : 62}
      centred={shape === 'tall'}
    />
  </AbsoluteFill>
);

export const PagesWide: React.FC = () => <PagesSpot shape="wide" />;
export const PagesTall: React.FC = () => <PagesSpot shape="tall" />;
