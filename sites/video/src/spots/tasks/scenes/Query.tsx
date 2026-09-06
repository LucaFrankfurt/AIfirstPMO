/** The query typed, and the list shrinking under it clause by clause. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { QueryBox } from '../../../components/QueryBox';

export const Query: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.query}
      wide={{ width: 1010, height: 600 }}
      tall={{ width: 1000, height: 600 }}
    >
      <QueryBox
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 22 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
