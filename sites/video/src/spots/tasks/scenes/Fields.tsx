/** Everything a task carries, arriving one field at a time. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { FieldRow } from '../../../components/FieldRow';

export const Fields: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.fields}
      wide={{ width: 1030, height: 290 }}
      tall={{ width: 1010, height: 330 }}
    >
      <FieldRow
        frame={frame}
        width={wide ? 1030 : 1010}
        size={wide ? 20 : 20}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
