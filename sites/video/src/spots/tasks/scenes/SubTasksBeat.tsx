/** A sub-task typed, filed, and given an identifier of its own. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { SubTasks } from '../../../components/SubTasks';

export const SubTasksBeat: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.subtasks}
      wide={{ width: 1010, height: 380 }}
      tall={{ width: 1000, height: 400 }}
    >
      <SubTasks
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 22 : 22}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
