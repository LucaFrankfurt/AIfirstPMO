/** The invite beat. The animation itself is `components/InviteLink.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { InviteLink } from '../../../components/InviteLink';

export const Invite: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.invite}
      wide={{ width: 1010, height: 380 }}
      tall={{ width: 1000, height: 400 }}
    >
      <InviteLink
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
