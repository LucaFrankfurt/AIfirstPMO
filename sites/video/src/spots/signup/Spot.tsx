/**
 * The Signup explainer, in either shape.
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
import { Account } from './scenes/Account';
import { Invite } from './scenes/Invite';
import { Sso } from './scenes/Sso';
import { TwoFactorBeat } from './scenes/TwoFactorBeat';
import { Sessions } from './scenes/Sessions';

/** One per beat: where the light sits while that beat is on screen. */
const MOODS: Mood[] = ['brand', 'right', 'right', 'high', 'right', 'right', 'brand'];

export const SignupSpot: React.FC<{ shape: Shape }> = ({ shape }) => (
  <AbsoluteFill>
    <Backdrop shape={shape} starts={starts} moods={MOODS} />

    <Sequence {...beatWindow.open}>
      <Opening shape={shape} life={beatWindow.open.durationInFrames} {...open} />
    </Sequence>
    <Sequence {...beatWindow.account}>
      <Account shape={shape} life={beatWindow.account.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.invite}>
      <Invite shape={shape} life={beatWindow.invite.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.sso}>
      <Sso shape={shape} life={beatWindow.sso.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.twoFactor}>
      <TwoFactorBeat shape={shape} life={beatWindow.twoFactor.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.sessions}>
      <Sessions shape={shape} life={beatWindow.sessions.durationInFrames} />
    </Sequence>
    <Sequence {...beatWindow.close}>
      <Closing shape={shape} life={beatWindow.close.durationInFrames} {...close} />
    </Sequence>

    <Corner
      from={beatWindow.account.from + 16}
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
export const SignUpWide: React.FC = () => <SignupSpot shape="wide" />;
export const SignUpTall: React.FC = () => <SignupSpot shape="tall" />;
export const SignUpFeed: React.FC = () => <SignupSpot shape="feed" />;
