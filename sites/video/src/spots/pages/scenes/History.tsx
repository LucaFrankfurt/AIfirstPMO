/** The history beat. The animation itself is `components/Diff.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { Diff } from '../../../components/Diff';

export const History: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.history}
      wide={{ width: 1010, height: 400 }}
      tall={{ width: 1000, height: 610 }}
    >
      <Diff
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        stacked={!wide}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
