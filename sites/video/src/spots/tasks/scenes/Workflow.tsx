/** A task walking its project's states, and being stopped at the last door. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { StateFlow } from '../../../components/StateFlow';

export const Workflow: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.workflow}
      wide={{ width: 1010, height: 350 }}
      tall={{ width: 1000, height: 360 }}
    >
      <StateFlow
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 24 : 24}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
