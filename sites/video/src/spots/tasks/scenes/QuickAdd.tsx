/**
 * The signature animation of the whole series: a line typed, parsed into fields,
 * and filed. The field itself is `components/QuickAddField.tsx`; this decides
 * only how big it is in each shape.
 */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour } from '../../../theme';
import { ramp, span } from '../../../components/anim';
import { Beat, type Shape } from '../../../components/Beat';
import { QuickAddField, QUICK_ADD } from '../../../components/QuickAddField';
import { TaskCard } from '../../../components/ui';

const SIZE = { wide: { field: 1000, type: 26, card: 700, drop: 210 }, tall: { field: 1000, type: 22, card: 880, drop: 180 } };

export const QuickAdd: React.FC<{ shape: Shape; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const s = SIZE[shape];

  return (
    <Beat
      shape={shape}
      life={life}
      words={beats.quickAdd}
      wide={{ width: 1010, height: 420 }}
      tall={{ width: 1000, height: 420 }}
    >
      <QuickAddField frame={frame} width={s.field} size={s.type} style={{ left: 0, top: 0 }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: s.drop,
          opacity: ramp(frame, QUICK_ADD.filed, 16),
          transform: `translateY(${span(frame, QUICK_ADD.filed, 22, 26, 0)}px)`,
        }}
      >
        <TaskCard
          id="WEB-2"
          title="Redraw the empty state"
          priority={3}
          chips={[
            { label: 'High', dot: colour.danger },
            { label: 'Website', dot: colour.accent },
            { label: 'design', dot: colour.brand },
            { label: 'Sep 11' },
          ]}
          avatar={{ initials: 'AL', fill: '#26a27c' }}
          width={s.card}
        />
      </div>
    </Beat>
  );
};
