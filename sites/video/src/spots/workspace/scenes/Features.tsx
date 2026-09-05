/** The features beat. The animation itself is `components/FeatureSwitches.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { FeatureSwitches } from '../../../components/FeatureSwitches';

export const Features: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.features}
      wide={{ width: 1030, height: 430 }}
      tall={{ width: 1010, height: 620 }}
    >
      <FeatureSwitches
        frame={frame}
        width={wide ? 1030 : 1010}
        size={wide ? 21 : 21}
        stacked={!wide}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
