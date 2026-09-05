/**
 * The line typed, then parsed, then filed. The field itself — and every number
 * in its animation — lives in `components/QuickAddField.tsx`.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour } from '../../../theme';
import { presence, ramp, span } from '../../../components/anim';
import { Headline, Kicker, Rise, Sub } from '../../../components/Type';
import { TextColumn } from '../../../components/Layout';
import { QuickAddField, QUICK_ADD } from '../../../components/QuickAddField';
import { TaskCard } from '../../../components/ui';

export const QuickAdd: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TextColumn width={620}>
        <Rise at={4}>
          <Kicker>{beats.quickAdd.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.quickAdd.headline}</Headline>
        </Rise>
        <Rise at={18}>
          <Sub width={600}>{beats.quickAdd.sub}</Sub>
        </Rise>
      </TextColumn>

      <QuickAddField frame={frame} width={1000} size={26} style={{ left: 806, top: 372 }} />

      {/* And the task it files. */}
      <div
        style={{
          position: 'absolute',
          left: 806,
          top: 540,
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
          width={700}
        />
      </div>
    </AbsoluteFill>
  );
};
