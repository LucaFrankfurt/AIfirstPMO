/** The nesting beat. The animation itself is `components/Nesting.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { Nesting } from '../../../components/Nesting';

export const NestingBeat: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.nesting}
      wide={{ width: 1010, height: 380 }}
      tall={{ width: 1000, height: 400 }}
    >
      <Nesting
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
