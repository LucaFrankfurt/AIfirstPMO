/** The collab beat. The animation itself is `components/Collab.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { Collab } from '../../../components/Collab';

export const Collaboration: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.collab}
      wide={{ width: 1010, height: 360 }}
      tall={{ width: 1000, height: 400 }}
    >
      <Collab
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
