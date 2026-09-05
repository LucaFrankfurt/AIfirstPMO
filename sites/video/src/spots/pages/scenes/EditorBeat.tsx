/** The editor beat. The animation itself is `components/Editor.tsx`. */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { Beat, type Shape } from '../../../components/Beat';
import { Editor } from '../../../components/Editor';

export const EditorBeat: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const wide = shape === 'wide';
  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.editor}
      wide={{ width: 1010, height: 400 }}
      tall={{ width: 1000, height: 520 }}
    >
      <Editor
        frame={frame}
        width={wide ? 1010 : 1000}
        size={wide ? 21 : 21}
        stacked={!wide}
        style={{ left: 0, top: 0 }}
      />
    </Beat>
  );
};
