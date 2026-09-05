/** The tree beat. The animation itself is `components/HierarchyTree.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { HierarchyTree } from '../../../components/HierarchyTree';

export const Tree: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.tree}
      wide={{ width: 1030, height: 560 }}
      tall={{ width: 1010, height: 580 }}
    >
      <HierarchyTree
        frame={frame}
        width={wide ? 1030 : 1010}
        size={wide ? 21 : 21}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
