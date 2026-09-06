/** The sso beat. The animation itself is `components/SignInDoor.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { SignInDoor } from '../../../components/SignInDoor';

export const Sso: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.sso}
      wide={{ width: 1010, height: 500 }}
      tall={{ width: 1000, height: 520 }}
    >
      <SignInDoor
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
