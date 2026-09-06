/**
 * The field, and the task it files, stacked under the words.
 *
 * At 22px the fifty-seven-character line is 807px wide including padding, which
 * fits a 1000px field with room to spare — the only measurement in the vertical
 * cut that had to be solved rather than chosen, because a monospace line either
 * fits or wraps and a wrapped quick-add line is not a quick-add line.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../../copy';
import { colour } from '../../../../theme';
import { presence, ramp, span } from '../../../../components/anim';
import { Slot, TallStack } from '../../../../components/Layout';
import { QuickAddField, QUICK_ADD } from '../../../../components/QuickAddField';
import { TaskCard } from '../../../../components/ui';
import { Words } from './Words';

export const QuickAddTall: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack gap={72}>
        <Words {...beats.quickAdd} />

        <Slot width={1000} height={140}>
          <QuickAddField frame={frame} width={1000} size={22} style={{ left: 0, top: 0 }} />
        </Slot>

        <div
          style={{
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
            width={880}
          />
        </div>
      </TallStack>
    </AbsoluteFill>
  );
};
